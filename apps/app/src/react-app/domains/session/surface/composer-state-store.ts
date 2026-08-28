import { create } from "zustand";

import type { ComposerAttachment, ComposerDraft } from "../../../../app/types";
import type { ComposerMentionKind } from "./composer/mention-encoding";
import type { ComposerCapabilityKind } from "./composer/capability-tags";

export type ComposerPastePart = {
  id: string;
  label: string;
  text: string;
  lines: number;
};

/**
 * 一枚能力标签的登记信息
 * @param kind 能力种类
 * @param name 标签内显示的能力名称
 * @param prompt 提交时替换 token 的完整文案
 */
export type ComposerCapabilityPart = {
  kind: ComposerCapabilityKind;
  name: string;
  prompt: string;
};

export type ComposerSessionState = {
  draft: string;
  attachments: ComposerAttachment[];
  mentions: Record<string, ComposerMentionKind>;
  pasteParts: ComposerPastePart[];
  capabilities: ComposerCapabilityPart[];
};

export type QueuedComposerDraft = {
  id: string;
  draft: ComposerDraft;
  enqueuedAt: number;
};

export type ComposerStateStore = {
  sessions: Record<string, ComposerSessionState>;
  queuedDrafts: Record<string, QueuedComposerDraft[]>;
  /**
   * Sent-prompt history per session, oldest first. Kept outside
   * `sessions` because `clearSession` resets the composer after every
   * send and must not wipe the recall history (#2012).
   */
  history: Record<string, string[]>;
  setDraft: (sessionId: string, draft: string) => void;
  setAttachments: (sessionId: string, attachments: ComposerAttachment[]) => void;
  setMentions: (sessionId: string, mentions: Record<string, ComposerMentionKind>) => void;
  setPasteParts: (sessionId: string, pasteParts: ComposerPastePart[]) => void;
  setCapabilities: (sessionId: string, capabilities: ComposerCapabilityPart[]) => void;
  appendHistory: (sessionId: string, text: string) => void;
  appendQueuedDraft: (sessionId: string, draft: ComposerDraft) => QueuedComposerDraft;
  removeQueuedDraft: (sessionId: string, id: string) => QueuedComposerDraft | null;
  restoreQueuedDraft: (sessionId: string, item: QueuedComposerDraft) => void;
  editQueuedDraft: (sessionId: string, id: string) => QueuedComposerDraft | null;
  clearQueuedDrafts: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
};

const EMPTY_ATTACHMENTS: ComposerAttachment[] = [];
const EMPTY_MENTIONS: Record<string, ComposerMentionKind> = {};
const EMPTY_PASTE_PARTS: ComposerPastePart[] = [];
const EMPTY_CAPABILITIES: ComposerCapabilityPart[] = [];
const EMPTY_HISTORY: string[] = [];
const EMPTY_QUEUED_DRAFTS: QueuedComposerDraft[] = [];
const HISTORY_LIMIT = 50;

function createEmptyComposerSession(): ComposerSessionState {
  return {
    draft: "",
    attachments: [],
    mentions: {},
    pasteParts: [],
    capabilities: [],
  };
}

function getWritableSession(state: ComposerStateStore, sessionId: string): ComposerSessionState {
  return state.sessions[sessionId] ?? createEmptyComposerSession();
}

function queuedDraftId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function composerStateFromDraft(draft: ComposerDraft): ComposerSessionState {
  const mentions: Record<string, ComposerMentionKind> = {};
  const pasteParts: ComposerPastePart[] = [];
  const capabilities: ComposerCapabilityPart[] = [];
  for (const part of draft.parts) {
    if (part.type === "capability") {
      capabilities.push({ kind: part.kind, name: part.name, prompt: part.prompt });
    }
    if (part.type === "agent") mentions[part.name] = "agent";
    if (part.type === "file") mentions[part.path] = "file";
    if (part.type === "app") mentions[part.name] = "app";
    if (part.type === "paste") {
      pasteParts.push({
        id: part.id,
        label: part.label,
        text: part.text,
        lines: part.lines,
      });
    }
  }
  return {
    draft: draft.text,
    attachments: draft.attachments,
    mentions,
    pasteParts,
    capabilities,
  };
}

export const useComposerStateStore = create<ComposerStateStore>((set) => ({
  sessions: {},
  queuedDrafts: {},
  history: {},
  setDraft: (sessionId, draft) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.draft === draft) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, draft } } };
  }),
  setAttachments: (sessionId, attachments) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.attachments === attachments) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, attachments } } };
  }),
  setMentions: (sessionId, mentions) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.mentions === mentions) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, mentions } } };
  }),
  setPasteParts: (sessionId, pasteParts) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.pasteParts === pasteParts) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, pasteParts } } };
  }),
  setCapabilities: (sessionId, capabilities) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.capabilities === capabilities) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, capabilities } } };
  }),
  appendHistory: (sessionId, text) => set((state) => {
    const trimmed = text.trim();
    if (!trimmed) return state;
    const current = state.history[sessionId] ?? EMPTY_HISTORY;
    // Skip consecutive duplicates so spamming the same prompt does not
    // fill the recall buffer.
    if (current[current.length - 1] === trimmed) return state;
    const next = [...current, trimmed].slice(-HISTORY_LIMIT);
    return { history: { ...state.history, [sessionId]: next } };
  }),
  appendQueuedDraft: (sessionId, draft) => {
    const item = { id: queuedDraftId(), draft, enqueuedAt: Date.now() };
    set((state) => {
    const current = state.queuedDrafts[sessionId] ?? EMPTY_QUEUED_DRAFTS;
      return { queuedDrafts: { ...state.queuedDrafts, [sessionId]: [...current, item] } };
    });
    return item;
  },
  removeQueuedDraft: (sessionId, id) => {
    let removed: QueuedComposerDraft | null = null;
    set((state) => {
      const current = state.queuedDrafts[sessionId];
      if (!current) return state;
      removed = current.find((item) => item.id === id) ?? null;
      if (!removed) return state;
      const next = current.filter((item) => item.id !== id);
      if (next.length > 0) return { queuedDrafts: { ...state.queuedDrafts, [sessionId]: next } };
      const queuedDrafts = { ...state.queuedDrafts };
      delete queuedDrafts[sessionId];
      return { queuedDrafts };
    });
    return removed;
  },
  restoreQueuedDraft: (sessionId, item) => set((state) => {
    const current = state.queuedDrafts[sessionId] ?? EMPTY_QUEUED_DRAFTS;
    if (current.some((entry) => entry.id === item.id)) return state;
    return { queuedDrafts: { ...state.queuedDrafts, [sessionId]: [item, ...current] } };
  }),
  editQueuedDraft: (sessionId, id) => {
    let edited: QueuedComposerDraft | null = null;
    set((state) => {
      const currentSession = state.sessions[sessionId] ?? createEmptyComposerSession();
      if (currentSession.draft.trim() || currentSession.attachments.length > 0) return state;
      const current = state.queuedDrafts[sessionId];
      if (!current) return state;
      edited = current.find((item) => item.id === id) ?? null;
      if (!edited) return state;
      const next = current.filter((item) => item.id !== id);
      const queuedDrafts = { ...state.queuedDrafts };
      if (next.length) queuedDrafts[sessionId] = next;
      else delete queuedDrafts[sessionId];
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: composerStateFromDraft(edited.draft),
        },
        queuedDrafts,
      };
    });
    return edited;
  },
  clearQueuedDrafts: (sessionId) => set((state) => {
    if (!state.queuedDrafts[sessionId]) return state;
    const queuedDrafts = { ...state.queuedDrafts };
    delete queuedDrafts[sessionId];
    return { queuedDrafts };
  }),
  clearSession: (sessionId) => set((state) => {
    if (!state.sessions[sessionId]) return state;
    const sessions = { ...state.sessions };
    delete sessions[sessionId];
    return { sessions };
  }),
}));

export function getComposerDraft(state: ComposerStateStore, sessionId: string): string {
  return state.sessions[sessionId]?.draft ?? "";
}

export function getComposerAttachments(state: ComposerStateStore, sessionId: string): ComposerAttachment[] {
  return state.sessions[sessionId]?.attachments ?? EMPTY_ATTACHMENTS;
}

export function getComposerMentions(state: ComposerStateStore, sessionId: string): Record<string, ComposerMentionKind> {
  return state.sessions[sessionId]?.mentions ?? EMPTY_MENTIONS;
}

export function getComposerPasteParts(state: ComposerStateStore, sessionId: string): ComposerPastePart[] {
  return state.sessions[sessionId]?.pasteParts ?? EMPTY_PASTE_PARTS;
}

export function getComposerCapabilities(state: ComposerStateStore, sessionId: string): ComposerCapabilityPart[] {
  return state.sessions[sessionId]?.capabilities ?? EMPTY_CAPABILITIES;
}

export function getComposerHistory(state: ComposerStateStore, sessionId: string): string[] {
  return state.history[sessionId] ?? EMPTY_HISTORY;
}

export function getComposerQueuedDrafts(state: ComposerStateStore, sessionId: string): QueuedComposerDraft[] {
  return state.queuedDrafts[sessionId] ?? EMPTY_QUEUED_DRAFTS;
}
