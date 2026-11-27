import { create } from "zustand";
import { createDenClient, readDenSettings, readDenUserId } from "@/app/lib/den";
import type { CloudDocsMeetingEvent, CloudDocsMeetingViewport } from "@/app/lib/cloud-docs-types";
import { MEETING_SHARE_DOCS_MESSAGE, SHARE_RESEND_MS, SHARE_STALE_MS, ShareFollower, ShareSender, buildShareState, parseShareState, type FollowMode } from "./doc-share";
import type { Meeting, MeetingShare } from "./types";

/** 文档共享在界面上的状态；与会议快照里的共享槽配合使用。 */
type ShareDocsView =
  | { phase: "idle" }
  | { phase: "opening"; docId: string; workspaceId: string }
  | { phase: "ready"; instanceId: string; docId: string; workspaceId: string }
  | { phase: "denied" };

type Relation = { direction: "above" | "below" | "visible" | "missing"; heading: string };

type DocShareState = {
  view: ShareDocsView;
  mode: FollowMode;
  /** 10 秒没有收到共享人的新状态。 */
  interrupted: boolean;
  relation: Relation | null;
  zoom: number;
  /** 共享人是否已切换到本地没有打开的文档。 */
  sharerElsewhere: boolean;
};

export const useDocShareStore = create<DocShareState>(() => ({
  view: { phase: "idle" }, mode: "following", interrupted: false, relation: null, zoom: 1, sharerElsewhere: false,
}));

/** 控制器依赖的会议侧能力，由 store.ts 注入，避免模块互相引用。 */
export type DocShareHost = {
  meeting: () => Meeting | null;
  self: () => { userId: string; sessionId: string } | null;
  publish: (content: Record<string, unknown>) => Promise<unknown>;
  claim: () => Promise<void>;
  release: () => Promise<void>;
};

const follower = new ShareFollower();
let host: DocShareHost | null = null;
let sender: ShareSender | null = null;
let ticker: ReturnType<typeof setInterval> | undefined;
let stopEvents: (() => void) | undefined;
let lastLocal: CloudDocsMeetingViewport | null = null;
let openToken = 0;
/** 正在进行的打开请求；相同文档的重复请求共用同一个，避免状态消息密集时反复重开。 */
let inflight: { key: string; promise: Promise<void> } | null = null;
/** 已被判定无权限的文档；同一文档不再重试，换文档后才会重新尝试。 */
let deniedKey = "";

const bridge = () => window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
const set = (patch: Partial<DocShareState>) => useDocShareStore.setState(patch);
const isSelfSharing = (share: MeetingShare | undefined) => {
  const self = host?.self();
  return !!share && share.kind === "doc" && share.userId === self?.userId && share.sessionId === self.sessionId;
};

/** 打开或切换会议窗口里的文档视图；同一时刻只处理一个打开请求。 */
function show(workspaceId: string, docId: string): Promise<void> {
  const key = `${workspaceId}/${docId}`;
  if (inflight?.key === key) return inflight.promise;
  const previous = inflight?.promise;
  const promise: Promise<void> = (async () => {
    if (previous) await previous.catch(() => {});
    await openView(workspaceId, docId);
  })().finally(() => { if (inflight?.promise === promise) inflight = null; });
  inflight = { key, promise };
  return promise;
}

/** 同 workspace 内页内跳转，否则重新 launch。 */
async function openView(workspaceId: string, docId: string) {
  const b = bridge();
  const key = `${workspaceId}/${docId}`;
  const current = useDocShareStore.getState().view;
  if (current.phase === "ready" && current.workspaceId === workspaceId) {
    if (current.docId !== docId) {
      b?.meetingCommand?.({ instanceId: current.instanceId, action: "open-page", payload: { docId } });
      set({ view: { ...current, docId }, sharerElsewhere: false });
    }
    return;
  }
  if (deniedKey === key) return;
  const token = ++openToken;
  const settings = readDenSettings();
  const tenantId = settings.activeOrgId, sourceUserId = readDenUserId();
  if (!b?.meetingOpen || !tenantId || !settings.authToken || !sourceUserId) { deniedKey = key; set({ view: { phase: "denied" } }); return; }
  set({ view: { phase: "opening", docId, workspaceId } });
  const instanceId = crypto.randomUUID();
  let off = () => {};
  try {
    const ready = new Promise<"ready" | "denied">(resolve => {
      off = b.onState(state => {
        if (state.instanceId !== instanceId) return;
        if (state.status === "ready") resolve("ready");
        else if (state.status === "error" || state.status === "unauthorized") resolve("denied");
      });
      setTimeout(() => resolve("denied"), 60_000);
    });
    // 以会议组织申请 grant，目标页面由 Docs 自己的 ACL 判定。
    const launch = await createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken })
      .launchCloudDocs({ tenantId, target: { kind: "page", pageId: docId, workspaceId }, presentation: { instanceId, mode: "product" } });
    if (token !== openToken) return;
    await b.meetingOpen({ ...launch, instanceId, sourceServerOrigin: settings.baseUrl, sourceUserId, tenantId, presentation: { instanceId, mode: "product" } });
    const outcome = await ready;
    if (token !== openToken) { void b.close(instanceId).catch(() => {}); return; }
    if (outcome !== "ready") deniedKey = key;
    set({ view: outcome === "ready" ? { phase: "ready", instanceId, docId, workspaceId } : { phase: "denied" } });
  } catch {
    if (token === openToken) { deniedKey = key; set({ view: { phase: "denied" } }); }
  } finally { off(); }
}

/** 关闭文档视图；保存未确认时 Main 会保留视图，界面保持当前状态。 */
async function hide() {
  openToken++;
  deniedKey = "";
  const view = useDocShareStore.getState().view;
  if (view.phase === "ready") await bridge()?.close(view.instanceId).catch(() => {});
  set({ view: { phase: "idle" }, relation: null, sharerElsewhere: false, interrupted: false, zoom: 1 });
}

/** 共享人的显示名，用于文档里的位置标记。 */
function sharerLabel() {
  const meeting = host?.meeting();
  const id = meeting?.share?.userId;
  return (id && meeting?.participants[id]?.name) || "共享人";
}

function applyLatest() {
  const latest = follower.latest;
  if (!latest || latest.state !== "sharing" || !latest.doc) return;
  const { workspaceId, pageId, mode } = latest.doc;
  const view = useDocShareStore.getState().view;
  if (follower.shouldApply()) {
    void show(workspaceId, pageId).then(() => {
      const now = useDocShareStore.getState().view;
      if (now.phase !== "ready" || now.docId !== pageId) return;
      bridge()?.meetingCommand?.({ instanceId: now.instanceId, action: "apply-viewport", payload: { follow: true, sharerName: sharerLabel(), viewport: { workspaceId, docId: pageId, mode, ...latest.viewport } } });
    });
  } else if (view.phase === "ready") {
    const elsewhere = view.docId !== pageId;
    set({ sharerElsewhere: elsewhere });
    // 共享人在别的文档时也下发，页面据此清除旧标记。
    bridge()?.meetingCommand?.({ instanceId: view.instanceId, action: "apply-viewport", payload: { follow: false, sharerName: sharerLabel(), viewport: { workspaceId, docId: pageId, mode, ...latest.viewport } } });
  }
}

function onEvent(event: CloudDocsMeetingEvent) {
  const view = useDocShareStore.getState().view;
  if (view.phase !== "ready" || event.instanceId !== view.instanceId) return;
  if (event.type === "docs.sharer-relation") { set({ relation: event.meeting }); return; }
  const { userInput, ...viewport } = event.meeting;
  lastLocal = viewport;
  if (view.docId !== viewport.docId) set({ view: { ...view, docId: viewport.docId } });
  const meeting = host?.meeting();
  if (isSelfSharing(meeting?.share)) { sender?.update(viewport, Date.now()); return; }
  if (userInput) { follower.userScrolled(); set({ mode: follower.mode }); }
}

function tick() {
  const meeting = host?.meeting();
  if (!meeting) return;
  if (isSelfSharing(meeting.share)) sender?.tick(Date.now());
  else set({ interrupted: follower.stale(Date.now()) });
}

/** 会议快照到达后调用：对齐共享槽，决定打开、关闭文档视图或开始、停止发布。 */
export function reconcileDocShare(meeting: Meeting) {
  const slot = meeting.share;
  const self = host?.self();
  follower.syncSlot(slot && slot.kind === "doc" ? { id: slot.id, userId: slot.userId, sessionId: slot.sessionId, kind: slot.kind } : undefined);
  set({ mode: follower.mode });
  const view = useDocShareStore.getState().view;
  if (!slot || slot.kind !== "doc") {
    sender = null;
    if (view.phase !== "idle") void hide();
    return;
  }
  if (slot.userId === self?.userId && slot.sessionId === self.sessionId) {
    if (!sender) {
      const identity = { meetingId: meeting.id, shareId: slot.id, sessionId: slot.sessionId };
      sender = new ShareSender((seq, viewport) => { void host?.publish(buildShareState(identity, seq, viewport) as unknown as Record<string, unknown>).catch(() => {}); });
      if (lastLocal) sender.update(lastLocal, Date.now());
    }
  } else {
    sender = null;
    if (view.phase === "idle") set({ view: { phase: "opening", docId: "", workspaceId: "" } });
  }
}

/** 收到聊天室状态消息：校验后只保留最新一条。 */
export function receiveShareDocs(message: { sender?: { id?: string }; content?: unknown }) {
  const meeting = host?.meeting();
  const parsed = parseShareState(message.content);
  if (!meeting || !parsed || !message.sender?.id) return;
  const slot = meeting.share && meeting.share.kind === "doc" ? meeting.share : undefined;
  if (isSelfSharing(slot)) return;
  const accepted = follower.receive(parsed, message.sender.id, slot && { ...slot }, meeting.id, Date.now());
  if (!accepted) return;
  set({ interrupted: false });
  if (accepted.state === "ended") { void hide(); return; }
  if (accepted.doc?.mode === "page" || accepted.doc?.mode === "edgeless") applyLatest();
}

/** 共享人选择文档：占用共享槽，在会议窗口中打开，并开始发布状态。 */
export async function startDocShare(workspaceId: string, docId: string) {
  if (!host) throw new Error("会议尚未就绪。");
  await show(workspaceId, docId);
  if (useDocShareStore.getState().view.phase !== "ready") throw new Error("无法打开所选文档。");
  await host.claim();
}

/** 共享人更换文档：同一共享槽内切换，状态消息自然携带新文档。 */
export async function switchDocShare(workspaceId: string, docId: string) {
  await show(workspaceId, docId);
}

export async function stopDocShare() {
  const slot = host?.meeting()?.share;
  if (sender && slot) void host?.publish(buildShareState({ meetingId: host.meeting()!.id, shareId: slot.id, sessionId: slot.sessionId }, sender.nextSeq(), null) as unknown as Record<string, unknown>).catch(() => {});
  sender = null;
  await host?.release();
  await hide();
}

export function followSharer() {
  follower.follow();
  set({ mode: "following", sharerElsewhere: false });
  applyLatest();
}

export function setDocZoom(factor: number) {
  const view = useDocShareStore.getState().view;
  const next = Math.min(3, Math.max(0.5, Math.round(factor * 100) / 100));
  set({ zoom: next });
  if (view.phase === "ready") bridge()?.meetingCommand?.({ instanceId: view.instanceId, action: "zoom", payload: { factor: next } });
}

/** 会议开始时安装，离会时卸载。 */
export function installDocShare(next: DocShareHost) {
  uninstallDocShare();
  host = next;
  stopEvents = bridge()?.onMeetingEvent?.(onEvent);
  ticker = setInterval(tick, Math.min(SHARE_RESEND_MS, 1000));
}

export function uninstallDocShare() {
  stopEvents?.(); stopEvents = undefined;
  clearInterval(ticker); ticker = undefined;
  host = null; sender = null; lastLocal = null;
  follower.reset();
  void hide();
  set({ mode: "following" });
}

export { MEETING_SHARE_DOCS_MESSAGE, SHARE_STALE_MS };
