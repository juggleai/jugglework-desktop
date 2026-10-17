import type { ToonModelReference } from "@jugglework/types/toon-factory";

export type ToonQueryScope = {
  endpoint: string;
  workspaceId: string;
};

export function toonQueryScope(endpoint: string, workspaceId: string): ToonQueryScope {
  return {
    endpoint: endpoint.trim().replace(/\/+$/, ""),
    workspaceId: workspaceId.trim(),
  };
}

function root(scope: ToonQueryScope) {
  const normalized = toonQueryScope(scope.endpoint, scope.workspaceId);
  return ["toon-factory", normalized.endpoint, normalized.workspaceId] as const;
}

export const toonProjectsKey = (scope: ToonQueryScope) => [...root(scope), "projects"] as const;
export const toonWorkspaceKey = (scope: ToonQueryScope) => [...root(scope), "workspace"] as const;
export const toonProjectKey = (scope: ToonQueryScope, projectId: string) => [...root(scope), "project", projectId] as const;
export const toonCanvasKey = (scope: ToonQueryScope, projectId: string, canvasId: string) => [...root(scope), "canvas", projectId, canvasId] as const;
export const toonTextKey = (scope: ToonQueryScope, projectId: string, episodeId: string, nodeId: string) => [...root(scope), "text", projectId, episodeId, nodeId] as const;
export const toonTextJobKey = (scope: ToonQueryScope, projectId: string, jobId: string) => [...root(scope), "text-job", projectId, jobId] as const;
export const toonMediaJobsKey = (scope: ToonQueryScope, projectId: string) => [...root(scope), "media-jobs", projectId] as const;
export const toonDeliveryKey = (scope: ToonQueryScope, projectId: string, episodeId: string) => [...root(scope), "delivery", projectId, episodeId] as const;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

export type ToonTextApprovalInput = {
  workspaceId: string;
  projectId: string;
  episodeId: string;
  canvasId: string;
  nodeId: string;
  selectedModel: ToonModelReference;
  action: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
};

export function toonTextRequestFingerprint(input: ToonTextApprovalInput): string {
  return JSON.stringify(stableValue(input));
}

export type ToonRetainedTextDraft = {
  content: string;
  baseRevision: string | null;
  dirty: boolean;
  pendingWorkflowRevision?: string;
};

const DRAFT_PREFIX = "jugglework.toonFactory.textDraft.v1";
const memoryDrafts = new Map<string, ToonRetainedTextDraft>();
const draftFlushers = new Map<string, () => Promise<void>>();
const workspaceFlushers = new Map<string, () => Promise<boolean>>();

export type ToonRecoveryDraft = {
  kind: "canvas" | "document";
  workspaceId: string;
  projectId: string;
  entityId: string;
  revision: string;
  content: unknown;
  updatedAt: string;
};

const RECOVERY_PREFIX = "jugglework.toonFactory.recoveryDraft.v1";
const memoryRecoveryDrafts = new Map<string, ToonRecoveryDraft>();

export type ToonProjectIntentDraft = {
  name: string;
  directory: string;
  prompt: string;
  textModel?: ToonModelReference;
  operation?: ToonProjectIntentOperation;
  completedProjectId?: string;
};

export type ToonProjectIntentOperation = {
  version: 1;
  projectId?: string;
  episodeId: string;
  canvasId: string;
  sourceNodeId: string;
  phase: "project" | "canvas" | "text" | "project-update" | "complete";
};

const INTENT_PREFIX = "jugglework.toonFactory.projectIntent.v1";
const memoryIntents = new Map<string, ToonProjectIntentDraft>();

export function toonProjectIntentDraftKey(scope: ToonQueryScope): string {
  const normalized = toonQueryScope(scope.endpoint, scope.workspaceId);
  return [normalized.endpoint, normalized.workspaceId].map((part) => encodeURIComponent(part)).join(":");
}

function readIntentOperation(value: unknown): ToonProjectIntentOperation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const operation = value as Partial<ToonProjectIntentOperation>;
  if (operation.version !== 1
    || typeof operation.episodeId !== "string"
    || typeof operation.canvasId !== "string"
    || typeof operation.sourceNodeId !== "string"
    || !["project", "canvas", "text", "project-update", "complete"].includes(operation.phase ?? "")) return undefined;
  return {
    version: 1,
    ...(typeof operation.projectId === "string" ? { projectId: operation.projectId } : {}),
    episodeId: operation.episodeId,
    canvasId: operation.canvasId,
    sourceNodeId: operation.sourceNodeId,
    phase: operation.phase!,
  };
}

export function readToonProjectIntentDraft(scope: ToonQueryScope): ToonProjectIntentDraft | null {
  const key = toonProjectIntentDraftKey(scope);
  const retained = memoryIntents.get(key);
  if (retained) return retained;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${INTENT_PREFIX}:${key}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ToonProjectIntentDraft>;
    if (typeof value.name !== "string" || typeof value.directory !== "string" || typeof value.prompt !== "string") return null;
    const operation = readIntentOperation(value.operation);
    const draft: ToonProjectIntentDraft = {
      name: value.name,
      directory: value.directory,
      prompt: value.prompt,
      ...(value.textModel ? { textModel: value.textModel } : {}),
      ...(operation ? { operation } : {}),
      ...(typeof value.completedProjectId === "string" ? { completedProjectId: value.completedProjectId } : {}),
    };
    memoryIntents.set(key, draft);
    return draft;
  } catch {
    return null;
  }
}

export function writeToonProjectIntentDraft(scope: ToonQueryScope, draft: ToonProjectIntentDraft): void {
  const key = toonProjectIntentDraftKey(scope);
  memoryIntents.set(key, draft);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${INTENT_PREFIX}:${key}`, JSON.stringify(draft));
  } catch {
    // The in-memory copy still protects this intent for the current run.
  }
}

export function clearToonProjectIntentDraft(scope: ToonQueryScope): void {
  const key = toonProjectIntentDraftKey(scope);
  memoryIntents.delete(key);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`${INTENT_PREFIX}:${key}`);
  } catch {
    // Ignore storage restrictions after the intent was persisted to the project.
  }
}

export function toonTextDraftKey(workspaceId: string, projectId: string, episodeId: string, nodeId: string): string {
  return [workspaceId, projectId, episodeId, nodeId].map((part) => encodeURIComponent(part)).join(":");
}

function storageKey(key: string): string {
  return `${DRAFT_PREFIX}:${key}`;
}

export function readToonTextDraft(key: string): ToonRetainedTextDraft | null {
  const retained = memoryDrafts.get(key);
  if (retained) return retained;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ToonRetainedTextDraft>;
    if (typeof value.content !== "string" || typeof value.dirty !== "boolean") return null;
    const draft: ToonRetainedTextDraft = {
      content: value.content,
      baseRevision: typeof value.baseRevision === "string" ? value.baseRevision : null,
      dirty: value.dirty,
      ...(typeof value.pendingWorkflowRevision === "string" ? { pendingWorkflowRevision: value.pendingWorkflowRevision } : {}),
    };
    memoryDrafts.set(key, draft);
    return draft;
  } catch {
    return null;
  }
}

export function writeToonTextDraft(key: string, draft: ToonRetainedTextDraft): void {
  memoryDrafts.set(key, draft);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(key), JSON.stringify(draft));
  } catch {
    // The in-memory retained copy still protects navigation within this run.
  }
}

export function clearToonTextDraft(key: string): void {
  memoryDrafts.delete(key);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(key));
  } catch {
    // Ignore storage restrictions after the authoritative save completed.
  }
}

export function registerToonTextDraftFlusher(key: string, flush: () => Promise<void>): () => void {
  draftFlushers.set(key, flush);
  return () => {
    if (draftFlushers.get(key) === flush) draftFlushers.delete(key);
  };
}

export async function flushToonTextDrafts(): Promise<void> {
  for (const flush of [...draftFlushers.values()]) await flush();
}

export function registerToonWorkspaceFlusher(key: string, flush: () => Promise<boolean>): () => void {
  workspaceFlushers.set(key, flush);
  return () => {
    if (workspaceFlushers.get(key) === flush) workspaceFlushers.delete(key);
  };
}

export async function flushToonWorkspaceDrafts(): Promise<boolean> {
  for (const flush of [...workspaceFlushers.values()]) if (!await flush()) return false;
  return true;
}

export async function flushAllToonDrafts(): Promise<boolean> {
  try {
    await flushToonTextDrafts();
    return await flushToonWorkspaceDrafts();
  } catch {
    return false;
  }
}

export function createToonGenerationGuard() {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (generation: number) => generation === current,
    invalidate: () => { current += 1; },
  };
}

function recoveryKey(draft: Pick<ToonRecoveryDraft, "kind" | "workspaceId" | "projectId" | "entityId">): string {
  return [draft.kind, draft.workspaceId, draft.projectId, draft.entityId].map(encodeURIComponent).join(":");
}

export function writeToonRecoveryDraft(draft: ToonRecoveryDraft): void {
  const key = recoveryKey(draft);
  memoryRecoveryDrafts.set(key, draft);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${RECOVERY_PREFIX}:${key}`, JSON.stringify(draft));
  } catch {
    // The retained in-memory draft still protects navigation in this run.
  }
}

export function readToonRecoveryDraft(input: Pick<ToonRecoveryDraft, "kind" | "workspaceId" | "projectId" | "entityId">): ToonRecoveryDraft | null {
  const key = recoveryKey(input);
  const retained = memoryRecoveryDrafts.get(key);
  if (retained) return retained;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${RECOVERY_PREFIX}:${key}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as ToonRecoveryDraft;
    if (value.kind !== input.kind || value.workspaceId !== input.workspaceId || value.projectId !== input.projectId || value.entityId !== input.entityId || typeof value.revision !== "string") return null;
    memoryRecoveryDrafts.set(key, value);
    return value;
  } catch {
    return null;
  }
}

export function clearToonRecoveryDraft(input: Pick<ToonRecoveryDraft, "kind" | "workspaceId" | "projectId" | "entityId">): void {
  const key = recoveryKey(input);
  memoryRecoveryDrafts.delete(key);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`${RECOVERY_PREFIX}:${key}`);
  } catch {
    // Ignore storage restrictions after the authoritative save completed.
  }
}
