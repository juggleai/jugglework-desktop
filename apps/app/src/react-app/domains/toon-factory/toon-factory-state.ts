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
