import type { CloudDocsMeetingViewport } from "@/app/lib/cloud-docs-types";

/** 状态消息名。该消息是 JuggleIM 状态消息：只投在线、不存储、不计数、不进会话。 */
export const MEETING_SHARE_DOCS_MESSAGE = "jw:meeting-share-docs";
/** 状态静止时的重发间隔；接收方 10 秒收不到新状态则提示同步中断。 */
export const SHARE_RESEND_MS = 3_000;
export const SHARE_STALE_MS = 10_000;
export const SHARE_THROTTLE_MS = 200;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 共享人此刻的完整文档与视口状态。每条都是全量，不含动作字段。
 * @param schemaVersion 固定 1
 * @param meetingId     会议 id
 * @param shareId       快照共享槽 id
 * @param sessionId     共享人的参会会话
 * @param seq           同一 shareId 内单调递增，只用于排序
 * @param state         sharing 或 ended；ended 时没有 doc 与 viewport
 * @param doc           共享人当前路由中的文档
 * @param viewport      页面模式的块锚点、白板模式的画布坐标、幻灯片的页 id 或表格的工作表与单元格
 */
export type MeetingShareDocsState = {
  schemaVersion: 1;
  meetingId: string;
  shareId: string;
  sessionId: string;
  seq: number;
  state: "sharing" | "ended";
  doc?: { workspaceId: string; pageId: string; mode: ShareDocMode };
  viewport?: {
    anchor?: { blockId: string; offset: number };
    edgeless?: { centerX: number; centerY: number; zoom: number };
    slides?: { slideId: string; playing?: boolean };
    sheet?: { sheetId: string; row: number; column: number };
  };
};
export type ShareDocMode = "page" | "edgeless" | "slides" | "sheet";
const MODES: readonly string[] = ["page", "edgeless", "slides", "sheet"];

export function buildShareState(
  identity: { meetingId: string; shareId: string; sessionId: string },
  seq: number,
  view: CloudDocsMeetingViewport | null,
): MeetingShareDocsState {
  const base = { schemaVersion: 1 as const, ...identity, seq };
  if (!view) return { ...base, state: "ended" };
  return {
    ...base,
    state: "sharing",
    doc: { workspaceId: view.workspaceId, pageId: view.docId, mode: view.mode },
    viewport: {
      ...(view.anchor ? { anchor: view.anchor } : {}),
      ...(view.edgeless ? { edgeless: view.edgeless } : {}),
      ...(view.slides ? { slides: view.slides } : {}),
      ...(view.sheet ? { sheet: view.sheet } : {}),
    },
  };
}

/** 只接受格式完整的状态；未知版本和越界字段一律丢弃。 */
export function parseShareState(value: unknown): MeetingShareDocsState | null {
  const v = value as Partial<MeetingShareDocsState> | null;
  if (!v || v.schemaVersion !== 1 || typeof v.meetingId !== "string" || typeof v.shareId !== "string" ||
    typeof v.sessionId !== "string" || !Number.isSafeInteger(v.seq) || (v.seq as number) < 0 ||
    (v.state !== "sharing" && v.state !== "ended")) return null;
  if (v.meetingId.length > 128 || v.shareId.length > 128 || v.sessionId.length > 128) return null;
  const parsed = { schemaVersion: 1 as const, meetingId: v.meetingId, shareId: v.shareId, sessionId: v.sessionId, seq: v.seq as number, state: v.state };
  if (v.state === "ended") return parsed;
  const doc = v.doc;
  if (!doc || !ID.test(doc.workspaceId ?? "") || !ID.test(doc.pageId ?? "") || !MODES.includes(doc.mode)) return null;
  const a = v.viewport?.anchor, e = v.viewport?.edgeless, sl = v.viewport?.slides, sh = v.viewport?.sheet;
  if (a && (typeof a.blockId !== "string" || a.blockId.length > 128 || !Number.isFinite(a.offset))) return null;
  if (e && ![e.centerX, e.centerY, e.zoom].every(Number.isFinite)) return null;
  if (sl && !ID.test(sl.slideId ?? "")) return null;
  if (sh && (typeof sh.sheetId !== "string" || sh.sheetId.length > 128 || ![sh.row, sh.column].every((n) => Number.isInteger(n) && n >= 0))) return null;
  return {
    ...parsed,
    doc: { workspaceId: doc.workspaceId, pageId: doc.pageId, mode: doc.mode },
    viewport: { ...(a ? { anchor: { blockId: a.blockId, offset: Math.min(1, Math.max(-20, a.offset)) } } : {}), ...(e ? { edgeless: e } : {}),
      ...(sl ? { slides: { slideId: sl.slideId, ...(sl.playing === true ? { playing: true } : {}) } } : {}),
      ...(sh ? { sheet: { sheetId: sh.sheetId, row: sh.row, column: sh.column } } : {}),
    },
  };
}

export type FollowMode = "following" | "free";
export type ShareSlot = { id: string; userId: string; sessionId: string; kind: "screen" | "doc" } | undefined;

/**
 * 参会者侧状态机：按快照里的共享槽校验消息，只保留最新状态，决定跟随或自由浏览。
 * 不做任何 IO，由调用方负责打开文档和应用视口。
 */
export class ShareFollower {
  mode: FollowMode = "following";
  latest: MeetingShareDocsState | null = null;
  private applied = -1;
  private lastAt = 0;
  private shareId = "";

  /** 共享槽变化：换人或结束时重置序号；换人后回到跟随。 */
  syncSlot(slot: ShareSlot) {
    if (!slot || slot.kind !== "doc") { this.reset(); return; }
    if (slot.id !== this.shareId) {
      this.reset();
      this.shareId = slot.id;
    }
  }

  /** @returns 新状态已被接受时返回它，否则返回 null。 */
  receive(message: MeetingShareDocsState, sender: string, slot: ShareSlot, meetingId: string, now: number) {
    if (!slot || slot.kind !== "doc" || slot.id !== message.shareId || slot.userId !== sender ||
      slot.sessionId !== message.sessionId || message.meetingId !== meetingId) return null;
    if (message.seq <= this.applied) return null;
    this.applied = message.seq;
    this.lastAt = now;
    this.latest = message;
    return message;
  }

  /** 真实用户输入后进入自由浏览。 */
  userScrolled() { if (this.latest?.state === "sharing") this.mode = "free"; }
  follow() { this.mode = "following"; }
  /** 10 秒没有新状态，视为同步中断。 */
  stale(now: number) { return this.latest?.state === "sharing" && now - this.lastAt > SHARE_STALE_MS; }
  /** 当前应当应用到本地视图的状态：只有跟随中才应用。 */
  shouldApply() { return this.mode === "following" && this.latest?.state === "sharing"; }
  reset() { this.mode = "following"; this.latest = null; this.applied = -1; this.lastAt = 0; this.shareId = ""; }
}

/** 共享人侧节流器：变化后最多每 200ms 发一次，静止时每 3 秒重发，seq 单调递增。 */
export class ShareSender {
  private seq = 0;
  private last = 0;
  private pending: CloudDocsMeetingViewport | null = null;
  private current: CloudDocsMeetingViewport | null = null;

  constructor(private readonly send: (seq: number, view: CloudDocsMeetingViewport) => void) {}

  update(view: CloudDocsMeetingViewport, now: number) {
    this.current = view;
    if (now - this.last >= SHARE_THROTTLE_MS) this.flush(now);
    else this.pending = view;
  }
  /** 由定时器调用：发出被节流的最新状态，或在静止满 3 秒时重发。 */
  tick(now: number) {
    if (this.pending && now - this.last >= SHARE_THROTTLE_MS) this.flush(now);
    else if (this.current && now - this.last >= SHARE_RESEND_MS) this.flush(now);
  }
  private flush(now: number) {
    const view = this.pending ?? this.current;
    this.pending = null;
    if (!view) return;
    this.last = now;
    this.send(++this.seq, view);
  }
  nextSeq() { return ++this.seq; }
}
