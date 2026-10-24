import { create } from "zustand";

import type { ComposerAttachment, ComposerDraft } from "../../../../app/types";
import type { ComposerMentionKind } from "./composer/mention-encoding";
import type { ComposerCapabilityKind } from "./composer/capability-tags";
import { officeInstructionToken, type OfficeComposerGroup } from "./composer/office-selection-draft";
import type { OfficeSelectionReference } from "@jugglework/types/office";

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
  officeGroups: OfficeComposerGroup[];
  officeRebind: string | null;
  officeSend: string | null;
};

export type QueuedComposerDraft = {
  id: string;
  draft: ComposerDraft;
  enqueuedAt: number;
  /** 宠物入口加入的普通文本；仍保存在原会话FIFO中。 */
  petWorkspaceId?: string;
  /** 后台发送失败后保留在原队列，必须由用户编辑后重试，不自动重发。 */
  petBlockedReason?: string;
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
  officeEpochs: Record<string, number>;
  /** 发送预检至消息接收期间仍持有的引用，独立于可随时修改的输入栏和队列。 */
  officePendingSubmissions: Record<string, { sessionId: string; referenceIds: string[] }>;
  /** 固定一次提交的引用；完成后返回当前已无其他所有者、可以释放的引用。 */
  holdOfficeSubmission: (sessionId: string, referenceIds: string[]) => () => string[];
  appendOfficeSelection: (input: { sessionId: string; reference: OfficeSelectionReference; instructionId: string; text: string; epoch: number; mode: "add" | "send" }) => void;
  editOfficeInstruction: (sessionId: string, instructionId: string, text: string) => void;
  /** 同步编辑器内的正常文字和原子标签；文字变化不重建节点，已释放引用不会因撤销恢复权限。 */
  syncOfficeEditor: (sessionId: string, draft: string, groups: OfficeComposerGroup[]) => void;
  removeOfficeReference: (sessionId: string, instructionId: string, referenceId: string) => void;
  detachOfficeInstruction: (sessionId: string, instructionId: string) => void;
  rebindOfficeInstruction: (sessionId: string, instructionId: string) => void;
  /** 清理引用；主动删除解除选区绑定，模型失效或切换文件保留重选状态。 */
  clearOfficeReferences: (sessionId: string, epoch: number, referenceIds: string[], reason?: "remove" | "invalidate") => boolean;
  consumeOfficeSend: (sessionId: string, instructionId: string) => void;
  setDraft: (sessionId: string, draft: string) => void;
  setAttachments: (sessionId: string, attachments: ComposerAttachment[]) => void;
  setMentions: (sessionId: string, mentions: Record<string, ComposerMentionKind>) => void;
  setPasteParts: (sessionId: string, pasteParts: ComposerPastePart[]) => void;
  setCapabilities: (sessionId: string, capabilities: ComposerCapabilityPart[]) => void;
  appendHistory: (sessionId: string, text: string) => void;
  appendQueuedDraft: (sessionId: string, draft: ComposerDraft) => QueuedComposerDraft;
  /** 标记后台可接管的宠物普通文本队列项。 */
  markPetQueuedDraft: (sessionId: string, id: string, workspaceId: string) => void;
  removeQueuedDraft: (sessionId: string, id: string) => QueuedComposerDraft | null;
  restoreQueuedDraft: (sessionId: string, item: QueuedComposerDraft, index?: number) => void;
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
const EMPTY_OFFICE_GROUPS: OfficeComposerGroup[] = [];
const HISTORY_LIMIT = 50;

function createEmptyComposerSession(): ComposerSessionState {
  return {
    draft: "",
    attachments: [],
    mentions: {},
    pasteParts: [],
    capabilities: [],
    officeGroups: [], officeRebind: null, officeSend: null,
  };
}

function getWritableSession(state: ComposerStateStore, sessionId: string): ComposerSessionState {
  return { ...createEmptyComposerSession(), ...state.sessions[sessionId] };
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
  const officeGroups: OfficeComposerGroup[] = [];
  for (const part of draft.parts) {
    if (part.type === "office-selection") officeGroups.push({ instruction: structuredClone(part.instruction), references: structuredClone(part.references) });
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
    officeGroups, officeRebind: null, officeSend: null,
  };
}

export const useComposerStateStore = create<ComposerStateStore>((set, get) => ({
  sessions: {},
  queuedDrafts: {},
  history: {},
  officeEpochs: {},
  officePendingSubmissions: {},
  holdOfficeSubmission: (sessionId, referenceIds) => {
    if (!referenceIds.length) return () => [];
    const id = queuedDraftId();
    const ids = [...new Set(referenceIds)];
    set((state) => ({ officePendingSubmissions: { ...state.officePendingSubmissions, [id]: { sessionId, referenceIds: ids } } }));
    return () => {
      if (!get().officePendingSubmissions[id]) return [];
      set((state) => { const pending = { ...state.officePendingSubmissions }; delete pending[id]; return { officePendingSubmissions: pending }; });
      return releasableOfficeReferences(get(), sessionId, ids);
    };
  },
  appendOfficeSelection: (input) => set((state) => {
    const current = getWritableSession(state, input.sessionId);
    if ((state.officeEpochs[input.sessionId] ?? 0) !== input.epoch) throw new Error("文件或草稿已变化，请重新选择");
    if (input.reference.ownerSessionId !== input.sessionId) throw new Error("选区不属于目标聊天");
    if (current.officeGroups.some((group) => group.references.some((ref) => ref.captureId === input.reference.captureId))) return state;
    if (current.officeGroups.some((group) => group.references.some((ref) => ref.documentId !== input.reference.documentId))) throw new Error("请先确认切换文件，再添加新文件的选区");
    const old = current.officeRebind ? current.officeGroups.find((group) => group.instruction.instructionId === current.officeRebind && group.instruction.bindingState === "needs-selection") : null;
    const instructionId = old?.instruction.instructionId ?? input.instructionId;
    const group: OfficeComposerGroup = { references: [structuredClone(input.reference)], instruction: {
      instructionId, text: old && !input.text.trim() ? old.instruction.text : input.text,
      bindingState: "bound", referenceIds: [input.reference.referenceId],
    } };
    const officeGroups = old ? current.officeGroups.map((item) => item === old ? group : item) : [...current.officeGroups, group];
    if (officeGroups.length > 32) throw new Error("修改要求过多，请拆分发送");
    const draft = old ? current.draft : `${current.draft}${current.draft && !current.draft.endsWith("\n") ? "\n" : ""}${officeInstructionToken(instructionId)}\n`;
    return { sessions: { ...state.sessions, [input.sessionId]: { ...current, officeGroups, draft, officeRebind: null, officeSend: input.mode === "send" ? instructionId : current.officeSend } },
      officeEpochs: { ...state.officeEpochs, [input.sessionId]: input.epoch + 1 } };
  }),
  editOfficeInstruction: (sessionId, instructionId, text) => set((state) => {
    const current = getWritableSession(state, sessionId);
    return { sessions: { ...state.sessions, [sessionId]: { ...current, officeGroups: current.officeGroups.map((group) => group.instruction.instructionId === instructionId ? { ...group, instruction: { ...group.instruction, text: text.slice(0, 32_768) } } : group) } } };
  }),
  syncOfficeEditor: (sessionId, draft, officeGroups) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.draft === draft && JSON.stringify(current.officeGroups) === JSON.stringify(officeGroups)) return state;
    const previousRefs = current.officeGroups.flatMap((group) => group.references.map((ref) => ref.referenceId));
    const nextRefs = new Set(officeGroups.flatMap((group) => group.references.map((ref) => ref.referenceId)));
    const removed = previousRefs.some((id) => !nextRefs.has(id));
    return { sessions: { ...state.sessions, [sessionId]: { ...current, draft, officeGroups,
      officeRebind: officeGroups.some((group) => group.instruction.instructionId === current.officeRebind && group.instruction.bindingState === "needs-selection") ? current.officeRebind : null,
      officeSend: removed ? null : current.officeSend } },
      ...(removed ? { officeEpochs: { ...state.officeEpochs, [sessionId]: (state.officeEpochs[sessionId] ?? 0) + 1 } } : {}) };
  }),
  removeOfficeReference: (sessionId, instructionId, referenceId) => {
    const state = get(); const epoch = state.officeEpochs[sessionId] ?? 0;
    const group = state.sessions[sessionId]?.officeGroups.find((group) => group.instruction.instructionId === instructionId);
    if (!group?.references.some((ref) => ref.referenceId === referenceId)) return;
    state.clearOfficeReferences(sessionId, epoch, [referenceId], "remove");
  },
  detachOfficeInstruction: (sessionId, instructionId) => set((state) => {
    const current = getWritableSession(state, sessionId);
    return { sessions: { ...state.sessions, [sessionId]: { ...current, officeGroups: current.officeGroups.map((group) => group.instruction.instructionId === instructionId ? {
      references: [], instruction: { instructionId, text: group.instruction.text, bindingState: "detached", referenceIds: [] },
    } : group), officeRebind: null } }, officeEpochs: { ...state.officeEpochs, [sessionId]: (state.officeEpochs[sessionId] ?? 0) + 1 } };
  }),
  rebindOfficeInstruction: (sessionId, instructionId) => set((state) => {
    const current = getWritableSession(state, sessionId);
    return { sessions: { ...state.sessions, [sessionId]: { ...current, officeRebind: instructionId } } };
  }),
  clearOfficeReferences: (sessionId, epoch, referenceIds, reason = "invalidate") => {
    let cleared = false;
    set((state) => {
      if ((state.officeEpochs[sessionId] ?? 0) !== epoch) return state;
      const current = getWritableSession(state, sessionId);
      const officeGroups = current.officeGroups.map((group): OfficeComposerGroup => {
        const references = group.references.filter((ref) => !referenceIds.includes(ref.referenceId));
        if (references.length === group.references.length) return group;
        return { references, instruction: { instructionId: group.instruction.instructionId, text: group.instruction.text,
          // TIPS: 点击删除即明确取消该选区上下文；系统失效不能被当成用户主动改为普通文字。
          ...(references.length ? { bindingState: "bound" as const, referenceIds: references.map((ref) => ref.referenceId) }
            : { bindingState: reason === "remove" ? "detached" as const : "needs-selection" as const, referenceIds: [] as [] }) } };
      });
      cleared = true;
      const officeRebind = officeGroups.some((group) => group.instruction.instructionId === current.officeRebind && group.instruction.bindingState === "needs-selection") ? current.officeRebind : null;
      return { sessions: { ...state.sessions, [sessionId]: { ...current, officeGroups, officeRebind, officeSend: null } }, officeEpochs: { ...state.officeEpochs, [sessionId]: epoch + 1 } };
    });
    return cleared;
  },
  consumeOfficeSend: (sessionId, instructionId) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.officeSend !== instructionId) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, officeSend: null } } };
  }),
  setDraft: (sessionId, draft) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.draft === draft) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, draft, officeGroups: current.officeGroups.filter((group) => draft.includes(officeInstructionToken(group.instruction.instructionId))) } } };
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
  markPetQueuedDraft: (sessionId, id, workspaceId) => set((state) => ({ queuedDrafts: { ...state.queuedDrafts, [sessionId]: (state.queuedDrafts[sessionId] ?? []).map((item) => item.id === id ? { ...item, petWorkspaceId: workspaceId } : item) } })),
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
  restoreQueuedDraft: (sessionId, item, index = 0) => set((state) => {
    const current = state.queuedDrafts[sessionId] ?? EMPTY_QUEUED_DRAFTS;
    if (current.some((entry) => entry.id === item.id)) return state;
    const insertionIndex = Math.max(0, Math.min(index, current.length));
    const next = [...current];
    next.splice(insertionIndex, 0, item);
    return { queuedDrafts: { ...state.queuedDrafts, [sessionId]: next } };
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
    const sessions = { ...state.sessions };
    delete sessions[sessionId];
    return { sessions, officeEpochs: { ...state.officeEpochs, [sessionId]: (state.officeEpochs[sessionId] ?? 0) + 1 } };
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

/** 仅释放草稿、排队任务和发送中请求均不再持有的引用；已接收轮次由服务端持有独立快照。 */
export function releasableOfficeReferences(state: ComposerStateStore, sessionId: string, ids: string[]): string[] {
  const retained = new Set(getComposerOfficeGroups(state, sessionId).flatMap((group) => group.references.map((ref) => ref.referenceId)));
  for (const pending of Object.values(state.officePendingSubmissions)) {
    if (pending.sessionId === sessionId) for (const id of pending.referenceIds) retained.add(id);
  }
  for (const item of getComposerQueuedDrafts(state, sessionId)) {
    for (const part of item.draft.parts) if (part.type === "office-selection")
      for (const ref of part.references) retained.add(ref.referenceId);
  }
  return [...new Set(ids)].filter((id) => !retained.has(id));
}

/** 读取所属聊天的选区组，不从字符串中的 ID 重建执行引用。 */
export function getComposerOfficeGroups(state: ComposerStateStore, sessionId: string): OfficeComposerGroup[] {
  return state.sessions[sessionId]?.officeGroups ?? EMPTY_OFFICE_GROUPS;
}
