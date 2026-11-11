import { withMeetingDeviceDeadline } from "./device-operation";
import { meetingDiagnostic, meetingDiagnosticError, meetingDiagnosticStep } from "./diagnostics";
import { acceptDeviceState, type MemberDeviceState } from "./device-state";
import { readMeetingDesktopConfig } from "@/app/lib/desktop";
import { create } from "zustand";
import { meetingAPI, meetingScope } from "./api";
import { meetingClosed, type Meeting, type MeetingJoin } from "./types";
import { MeetingMedia, type MediaTile } from "./zego-adapter";
import { joinMeetingChatroom } from "./im-adapter";
import { acquireMediaSession, releaseMediaSession } from "./media-session";
import type { ChatMessage } from "../jugglechat/types";
let media: MeetingMedia | null = null;
let chatroom: Awaited<ReturnType<typeof joinMeetingChatroom>> | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let generation = 0;
let lease: MeetingJoin | null = null;
let activeScope = "";
let refreshing = false;
let lastRenewed = 0;
let chatJoining = false;
let deviceChanging = false;
let signalSeq = 0;
let lastSnapshot = 0;
let stopWake: (() => void) | undefined;
function announceState() {
  if (!lease || !chatroom) return;
  const state = useMeetingStore.getState();
  const signal = { meetingId: lease.meeting.id, sessionId: lease.sessionId,
    seq: ++signalSeq, mic: state.mic, camera: state.camera };
  meetingDiagnostic("signal.send", signal);
  void chatroom.signal(signal).then(() => meetingDiagnostic("signal.sent", { seq: signal.seq }))
    .catch(error => meetingDiagnostic("signal.failed", { seq: signal.seq, ...meetingDiagnosticError(error) }));
}

function dispose() {
  generation++;
  stopWake?.();
  stopWake = undefined;
  deviceChanging = false;
  clearInterval(timer);
  timer = undefined;
  media?.dispose();
  media = null;
  if (chatroom) void chatroom.leave().catch(() => {});
  chatroom = null;
  lease = null;
  activeScope = "";
  refreshing = false;
  chatJoining = false;
  releaseMediaSession("meeting");
}
function addMessage(message: ChatMessage) {
  useMeetingStore.setState((s) => ({
    messages:
      (message.messageId || message.tid) &&
      s.messages.some(
        (m) => (m.messageId || m.tid) === (message.messageId || message.tid),
      )
        ? s.messages
        : [...s.messages, message].slice(-300),
  }));
}
type MeetingState = {
  meeting: Meeting | null;
  phase: "idle" | "joining" | "joined";
  visible: boolean;
  mic: boolean;
  camera: boolean;
  tiles: MediaTile[];
  messages: ChatMessage[];
  chatReady: boolean;
  error: string | null;
  memberDevices: Record<string, MemberDeviceState>;
  join: (meeting: Meeting, mic: boolean, camera: boolean) => Promise<void>;
  leave: (end?: boolean) => Promise<void>;
  toggleDevice: (device: "mic" | "camera") => Promise<void>;
  toggleShare: (devices?: MediaDevices) => Promise<void>;
  send: (text: string) => Promise<void>;
  action: (action: string, extra?: Record<string, unknown>) => Promise<void>;
  retryChat: () => Promise<void>;
};
export const useMeetingStore = create<MeetingState>((set, get) => ({
  meeting: null,
  phase: "idle",
  visible: false,
  mic: false,
  camera: false,
  tiles: [],
  messages: [],
  chatReady: false,
  error: null,
  memberDevices: {},
  async join(meeting, mic, camera) {
    if (get().phase !== "idle") {
      if (get().meeting?.id === meeting.id) {
        set({ visible: true });
        return;
      }
      throw new Error("请先离开当前会议。");
    }
    acquireMediaSession("meeting");
    const run = ++generation;
    meetingDiagnostic("meeting.join", { meetingId: meeting.id, run, mic, camera });
    activeScope = meetingScope();
    set({
      meeting,
      phase: "joining",
      visible: true,
      mic,
      camera,
      error: null,
      messages: [],
      tiles: [],
    });
    try {
      const localConfig = window.__JUGGLEWORK_ELECTRON__?.invokeDesktop
        ? await readMeetingDesktopConfig()
        : null;
      if (localConfig && !localConfig.enabled)
        throw new Error("Desktop 会议配置已禁用会议，请修改 meeting.json。");
      if (run !== generation) return;
      const admitted = await meetingDiagnosticStep("api.join", { meetingId: meeting.id }, () => meetingAPI.join(meeting.id));
      if (run !== generation) return;
      lease = admitted;
      if (localConfig?.appId && localConfig.appId !== admitted.appId)
        throw new Error(
          "Desktop 与 Server 的 ZEGO AppID 不一致，请检查两端配置。",
        );
      media = new MeetingMedia(
        (tile, id) => {
          if (run !== generation) return;
          set((s) => ({
            tiles: [
              ...s.tiles.filter((t) => t.id !== id),
              ...(tile ? [tile] : []),
            ],
          }));
        },
        (error) => {
          if (run === generation) set({ error });
        },
        () => {
          if (run !== generation) return;
          const current = lease;
          forceMeetingCleanup("音视频连接已断开，请重新入会。");
          if (current)
            void meetingAPI
              .action(current.meeting.id, "leave", {
                sessionId: current.sessionId,
              })
              .catch(() => {});
        },
      );
      await media.join(lease, mic, camera);
      if (run !== generation) return;
      let current = lease.meeting;
      if (current.hostId === lease.userId && current.status !== "live")
        current = (
          await meetingAPI.action(current.id, "start", {
            sessionId: lease.sessionId,
          })
        ).meeting;
      if (run !== generation) return;
      set({ meeting: current, phase: "joined", memberDevices: {} });
      // Lifecycle convergence must not wait on IM/chatroom admission.
      lastRenewed = lastSnapshot = Date.now();
      timer = setInterval(() => {
        void refresh(run);
        announceState();
      }, 3_000);
      const wake = () => void refresh(run);
      window.addEventListener("online", wake);
      window.addEventListener("focus", wake);
      stopWake = () => { window.removeEventListener("online", wake); window.removeEventListener("focus", wake); };
      try {
        await get().retryChat();
      } catch {
        /* media remains usable; chat exposes retry */
      }
      if (run !== generation) return;
      announceState();
    } catch (error) {
      if (run !== generation) throw error;
      const captured = lease;
      dispose();
      if (captured)
        void meetingAPI
          .action(captured.meeting.id, "leave", {
            sessionId: captured.sessionId,
          })
          .catch(() => {});
      set({
        phase: "idle",
        meeting: null,
        tiles: [],
        visible: false,
        chatReady: false,
      });
      throw error;
    }
  },
  async leave(end = false) {
    const run = generation;
    const current = lease;
    if (!current) {
      forceMeetingCleanup();
      return;
    }
    // Keep the confirmation window open on rejection; never close with live media.
    const result = await meetingDiagnosticStep("api.leave", { meetingId: current.meeting.id, sessionId: current.sessionId, end }, () => meetingAPI.action(current.meeting.id, end ? "end" : "leave", {
      sessionId: current.sessionId,
    }));
    meetingDiagnostic("meeting.leave.result", { status: result.meeting?.status, leaseReplaced: current !== lease });
    // Renewal replaces the lease object without replacing this meeting session.
    if (run !== generation) return;
    announceState(); // Hint only: peers always verify lifecycle against the server.
    dispose();
    set({
      error: result.cleanupPending ? "会议已结束，本机音视频已停止；服务端正在重试清理远端房间。" : null,
      meeting: null,
      phase: "idle",
      visible: false,
      tiles: [],
      messages: [],
      chatReady: false,
    });
  },
  async toggleDevice(device) {
    if (deviceChanging || get().phase !== "joined" || !media) return;
    deviceChanging = true;
    const run = generation;
    const mic = device === "mic" ? !get().mic : get().mic;
    const camera = device === "camera" ? !get().camera : get().camera;
    try {
      const target = media!;
      await meetingDiagnosticStep("device.toggle", { device, mic, camera }, () => withMeetingDeviceDeadline(
        () => target.setDevices(mic, camera),
        () => {
          if (run !== generation) return;
          const current = lease;
          forceMeetingCleanup("设备切换超时，已停止本机音视频，请重新加入会议。");
          if (current) void meetingAPI.action(current.meeting.id, "leave", { sessionId: current.sessionId }).catch(() => {});
        },
      ));
      if (run !== generation) return;
      set({ mic, camera });
      announceState();
    } catch (error) {
      if (run !== generation) return;
      // Audio-only failures leave the existing camera capture untouched.
      // Failed device operations do not change the other device or advertise success.
      announceState();
      throw error;
    } finally {
      if (run === generation) deviceChanging = false;
    }
  },
  async toggleShare(devices) {
    if (get().tiles.some((t) => t.id === "share")) media?.stopShare();
    else await media?.startShare(devices);
  },
  async send(text) {
    if (!chatroom) throw new Error("聊天室尚未连接。");
    const content = text.trim();
    if (!content || content.length > 2000)
      throw new Error("请输入 1–2000 个字符。");
    addMessage(await chatroom.send(content));
  },
  async action(action, extra) {
    const id = get().meeting?.id;
    const run = generation;
    if (id) {
      const next = (await meetingAPI.action(id, action, extra)).meeting;
      if (run !== generation) return;
      if (meetingClosed(next)) { forceMeetingCleanup("会议已结束。"); return; }
      if (next.version >= (get().meeting?.version ?? 0)) set({ meeting: next });
      announceState();
    }
  },
  async retryChat() {
    if (!lease || chatroom || chatJoining) return;
    const run = generation;
    chatJoining = true;
    try {
      const joined = await joinMeetingChatroom(lease.chatroomId, (message) => {
        if (run === generation) addMessage(message);
      }, (message) => {
        if (run !== generation || !lease) return;
        const content = message.content;
        if (content?.meetingId !== lease.meeting.id) return;
        void refresh(run); // IM is a wake-up hint, never authority to end a meeting.
        const sender = message.sender?.id;
        const participant = sender && get().meeting?.participants[sender];
        if (!sender || !participant) return;
        const next = acceptDeviceState(content, participant.sessionId, get().memberDevices[sender]);
        meetingDiagnostic("signal.receive", { sender, sessionId: typeof content.sessionId === "string" ? content.sessionId : undefined,
          seq: typeof content.seq === "number" ? content.seq : undefined, accepted: !!next,
          mic: typeof content.mic === "boolean" ? content.mic : undefined, camera: typeof content.camera === "boolean" ? content.camera : undefined });
        if (next) set(state => ({ memberDevices: { ...state.memberDevices, [sender]: next } }));
      });
      if (run !== generation) {
        await joined.leave();
        return;
      }
      meetingDiagnostic("chat.joined");
      chatroom = joined;
      set({ chatReady: true });
      announceState();
    } catch (error) {
      meetingDiagnostic("chat.failed", meetingDiagnosticError(error));
      if (run === generation)
        set({
          chatReady: false,
          error: "会议聊天未连接，可重试；音视频不受影响。",
        });
      throw error;
    } finally {
      if (run === generation) chatJoining = false;
    }
  },
}));
async function refresh(run: number) {
  if (!lease || refreshing || run !== generation) return;
  if (activeScope !== meetingScope()) {
    forceMeetingCleanup("组织或账号已切换，会议已断开。");
    return;
  }
  refreshing = true;
  try {
    const snapshot = (await meetingDiagnosticStep("api.snapshot", { meetingId: lease.meeting.id }, () => meetingAPI.get(lease!.meeting.id))).meeting;
    meetingDiagnostic("meeting.snapshot", { meetingId: snapshot.id, version: snapshot.version, status: snapshot.status, participants: Object.entries(snapshot.participants).map(([id, p]) => ({ id, sessionId: p.sessionId })) });
    if (run !== generation) return;
    if (meetingClosed(snapshot)) {
      forceMeetingCleanup("主持人已结束会议。");
      return;
    }
    const participant = snapshot.participants[lease.userId];
    if (!participant || participant.sessionId !== lease.sessionId) {
      forceMeetingCleanup("参会资格已失效或已在其他设备入会。");
      return;
    }
    lastSnapshot = Date.now();
    const existing = useMeetingStore.getState().meeting;
    if (!existing || snapshot.version >= existing.version)
      useMeetingStore.setState({ meeting: snapshot });
    // Read lifecycle frequently; renew admission only at the lease cadence.
    if (Date.now() - lastRenewed >= 20_000) {
      const next = await meetingDiagnosticStep("api.renew", { meetingId: snapshot.id }, () => meetingAPI.join(snapshot.id, lease!.sessionId));
      if (run !== generation) return;
      if (meetingClosed(next.meeting)) { forceMeetingCleanup("主持人已结束会议。"); return; }
      lease = next;
      media?.renew(next.token);
      lastRenewed = Date.now();
    }
    if (!chatroom && !chatJoining) void useMeetingStore.getState().retryChat().catch(() => {});
  } catch (error) {
    if (run !== generation) return;
    useMeetingStore.setState({
      error: error instanceof Error ? error.message : "会议连接恢复中。",
    });
    if (Date.now() - lastSnapshot > 30_000 || Date.now() - lastRenewed > 80_000)
      forceMeetingCleanup("无法续期会议资格，已停止媒体。请重新加入。");
  } finally {
    if (run === generation) refreshing = false;
  }
}
export function forceMeetingCleanup(error: string | null = null) {
  meetingDiagnostic("meeting.cleanup", { reason: error });
  dispose();
  useMeetingStore.setState({
    phase: "idle",
    meeting: null,
    visible: false,
    tiles: [],
    messages: [],
    chatReady: false,
    error,
  });
}
