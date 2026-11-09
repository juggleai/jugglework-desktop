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
function dispose() {
  generation++;
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
      const admitted = await meetingAPI.join(meeting.id);
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
      set({ meeting: current, phase: "joined" });
      try {
        await get().retryChat();
      } catch {
        /* media remains usable; chat exposes retry */
      }
      if (run !== generation) return;
      lastRenewed = Date.now();
      timer = setInterval(() => void refresh(run), 20_000);
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
    const current = lease;
    if (!current) {
      forceMeetingCleanup();
      return;
    }
    // Keep the confirmation window open on rejection; never close with live media.
    const result = await meetingAPI.action(current.meeting.id, end ? "end" : "leave", {
      sessionId: current.sessionId,
    });
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
    const mic = device === "mic" ? !get().mic : get().mic;
    const camera = device === "camera" ? !get().camera : get().camera;
    try {
      await media?.setDevices(mic, camera);
      set({ mic, camera });
    } catch (error) {
      // Audio-only failures leave the existing camera capture untouched.
      if (device === "camera") set({ mic: false, camera: false });
      throw error;
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
    if (id)
      set({ meeting: (await meetingAPI.action(id, action, extra)).meeting });
  },
  async retryChat() {
    if (!lease || chatroom || chatJoining) return;
    const run = generation;
    chatJoining = true;
    try {
      const joined = await joinMeetingChatroom(lease.chatroomId, (message) => {
        if (run === generation) addMessage(message);
      });
      if (run !== generation) {
        await joined.leave();
        return;
      }
      chatroom = joined;
      set({ chatReady: true });
    } catch (error) {
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
    const snapshot = (await meetingAPI.get(lease.meeting.id)).meeting;
    if (run !== generation) return;
    if (meetingClosed(snapshot)) {
      forceMeetingCleanup("主持人已结束会议。");
      return;
    }
    const next = await meetingAPI.join(snapshot.id, lease.sessionId);
    if (run !== generation) return;
    lease = next;
    media?.renew(next.token);
    lastRenewed = Date.now();
    useMeetingStore.setState({ meeting: next.meeting, error: null });
  } catch (error) {
    if (run !== generation) return;
    useMeetingStore.setState({
      error: error instanceof Error ? error.message : "会议连接恢复中。",
    });
    if (Date.now() - lastRenewed > 80_000)
      forceMeetingCleanup("无法续期会议资格，已停止媒体。请重新加入。");
  } finally {
    if (run === generation) refreshing = false;
  }
}
export function forceMeetingCleanup(error: string | null = null) {
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
