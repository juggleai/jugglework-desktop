import { isToolUIPart, type UIMessage } from "ai";
import type { FilePart, Part, PermissionRequest, PermissionV2Request, QuestionRequest, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client";

import { getReactQueryClient } from "../../../infra/query-client";
import { captureAnalyticsEvent, takeTaskRunStart } from "@/app/lib/analytics";
import { trackTaskCompleted, trackTaskFailed } from "@/app/lib/den-telemetry";
import { createClient } from "@/app/lib/opencode";
import { normalizeEvent } from "@/app/utils";
import { SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX, SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX, type OpencodeEvent, type PendingPermission, type PendingQuestion } from "@/app/types";
import { createSessionErrorUIMessage, describeOpencodeSessionError, snapshotToUIMessages } from "./usechat-adapter";
import {
  parseDynamicToolUIPart,
  parseStructuredOutputUIPart,
  STRUCTURED_OUTPUT_TOOL,
} from "./parse-tool-parts";
import type { JuggleWorkServerClient, JuggleWorkSessionSnapshot } from "@/app/lib/jugglework-server";
import { applyRevertCursor, reconcileTranscriptMessages } from "./transcript-reconcile";
import {
  useSessionActivityStore,
} from "../status/session-activity-store";
import { notifyDesktopEvent } from "../../../shell/desktop-notifications";
import { reconcileRunCompletionDiagnostic } from "./run-completion-diagnostics";
import {
  completeRunningSessionCompactions,
  getSessionCompactionFromPart,
  upsertSessionCompactionMessage,
  type SessionCompactionMode,
} from "@/app/lib/session-compaction";
import {
  captureInteractionSnapshotFence,
  getWorkspaceInteractionState,
  interactionRootsForSessions,
  reconcileInteractionSnapshot,
  removeWorkspaceSessionAncestry,
  resolveLiveInteraction,
  seedWorkspaceSessionAncestry,
  upsertLivePermission,
  upsertLiveQuestion,
} from "./workspace-interactions";

type SyncOptions = {
  workspaceId: string;
  baseUrl: string;
  juggleworkToken: string;
  interactionClient?: JuggleWorkServerClient;
  onSessionCreated?: (session: Session) => void;
  onSessionUpdated?: (update: { sessionId: string; info: Record<string, unknown> }) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onSessionStatus?: (update: { sessionId: string; status: SessionStatus }) => void;
};

export async function reconcileWorkspaceInteractionRoots(
  client: JuggleWorkServerClient,
  workspaceId: string,
  sessionIds: Iterable<string>,
) {
  const roots = interactionRootsForSessions(getWorkspaceInteractionState(workspaceId), sessionIds);
  await Promise.all(roots.map(async (rootSessionId) => {
    const snapshotFence = captureInteractionSnapshotFence(workspaceId);
    try {
      const { item } = await client.getInteractionSnapshot(workspaceId, rootSessionId);
      reconcileInteractionSnapshot(workspaceId, item, snapshotFence);
    } catch {
      // The live stream remains actionable; retry on the next successful connection.
    }
  }));
}

type PendingDelta = {
  sessionId: string;
  messageId: string;
  partId: string;
  reasoning: boolean;
  delta: string;
};

type SyncEntry = {
  input: SyncOptions;
  refs: number;
  dispose: () => void;
  disposeTimer: ReturnType<typeof setTimeout> | null;
  trackedSessionRefs: Map<string, number>;
  retainedSessionTimers: Map<string, ReturnType<typeof setTimeout>>;
  sessionCreatedListeners: Set<NonNullable<SyncOptions["onSessionCreated"]>>;
  sessionUpdatedListeners: Set<NonNullable<SyncOptions["onSessionUpdated"]>>;
  sessionDeletedListeners: Set<NonNullable<SyncOptions["onSessionDeleted"]>>;
  sessionStatusListeners: Set<NonNullable<SyncOptions["onSessionStatus"]>>;
  pendingDeltas: Map<string, { messageId: string; reasoning: boolean; text: string }>;
  // Coalesce rapid-fire delta events from the SSE stream into one cache
  // commit per animation frame. Without this, a long response produces a
  // setQueryData per token; each triggers a full transcript re-render
  // (~27ms on large sessions) which starves the main thread and looks to
  // the user like the app "freezes after 2 words."
  deltaFlushBuffer: PendingDelta[];
  deltaFlushScheduled: boolean;
};

const idleStatus: SessionStatus = { type: "idle" };
const syncs = new Map<string, SyncEntry>();
const retainedSessionTtlMs = 10 * 60_000;
const idleRetainedSessionTtlMs = 10_000;
const liveTodoRevision = new Map<string, number>();
let todoRevision = 0;
let legacyInteractionRevision = 0;

export const snapshotKey = (workspaceId: string, sessionId: string) =>
  ["react-session-snapshot", workspaceId, sessionId] as const;
export const transcriptKey = (workspaceId: string, sessionId: string) =>
  ["react-session-transcript", workspaceId, sessionId] as const;
export const statusKey = (workspaceId: string, sessionId: string) =>
  ["react-session-status", workspaceId, sessionId] as const;
export const todoKey = (workspaceId: string, sessionId: string) =>
  ["react-session-todos", workspaceId, sessionId] as const;
export const permissionKey = (workspaceId: string, sessionId: string) =>
  ["react-session-permissions", workspaceId, sessionId] as const;
export const questionKey = (workspaceId: string, sessionId: string) =>
  ["react-session-questions", workspaceId, sessionId] as const;
const todoRevisionKey = (workspaceId: string, sessionId: string) => `${workspaceId}:${sessionId}`;
export function captureTodoSnapshotRevision(): number {
  return todoRevision;
}

/**
 * Clear progress from the previous task before submitting another task in the
 * same session. Recording a live revision prevents an older in-flight
 * snapshot from restoring the cleared progress.
 */
export function clearSessionTodos(workspaceId: string, sessionId: string) {
  liveTodoRevision.set(todoRevisionKey(workspaceId, sessionId), ++todoRevision);
  getReactQueryClient().setQueryData(todoKey(workspaceId, sessionId), []);
}

function syncKey(input: SyncOptions) {
  return `${input.workspaceId}:${input.baseUrl}:${input.juggleworkToken}`;
}

function getErrorStatus(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const record = error as {
    status?: unknown;
    response?: { status?: unknown };
    cause?: { status?: unknown };
  };
  const status = record.status ?? record.response?.status ?? record.cause?.status;
  return typeof status === "number" ? status : null;
}

function shouldRetrySyncSubscribe(error: unknown) {
  const status = getErrorStatus(error);
  return status !== 401 && status !== 403 && status !== 404;
}

function isTrackedSession(entry: SyncEntry, sessionId: string) {
  return (entry.trackedSessionRefs.get(sessionId) ?? 0) > 0 || entry.retainedSessionTimers.has(sessionId);
}

function isTrackedByAnotherSync(input: SyncOptions, entry: SyncEntry, sessionId: string) {
  for (const candidate of syncs.values()) {
    if (candidate === entry) continue;
    if (candidate.input.workspaceId !== input.workspaceId) continue;
    if (isTrackedSession(candidate, sessionId)) return true;
  }
  return false;
}

function getSessionUpdatedInfo(event: OpencodeEvent) {
  if (event.type !== "session.updated") return null;
  const props = event.properties;
  if (!props || typeof props !== "object") return null;
  const record = props as { sessionID?: unknown; info?: unknown };
  const info = record.info;
  if (!info || typeof info !== "object") return null;
  const sessionId = typeof record.sessionID === "string"
    ? record.sessionID
    : typeof (info as { id?: unknown }).id === "string"
      ? (info as { id: string }).id
      : "";
  if (!sessionId) return null;
  return { sessionId, info: info as Record<string, unknown> };
}

function getSessionCreatedInfo(event: OpencodeEvent): Session | null {
  if (event.type !== "session.created") return null;
  const props = event.properties;
  if (!props || typeof props !== "object") return null;
  const info = (props as { info?: unknown }).info;
  if (!info || typeof info !== "object") return null;
  const record = info as Partial<Session>;
  if (typeof record.id !== "string" || !record.id) return null;
  return record as Session;
}

function isLiveStatus(status: SessionStatus | null | undefined) {
  return status?.type === "busy" || status?.type === "retry";
}

function messageHasVisibleAssistantOutput(message: UIMessage) {
  if (message.role !== "assistant") return false;
  return message.parts.some((part) => {
    if ("text" in part && typeof part.text === "string") return part.text.trim().length > 0;
    return part.type === "dynamic-tool" || part.type === "file";
  });
}

function assistantOutputAfterLatestUser(messages: UIMessage[]) {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  return messages.slice(lastUserIndex + 1).some(messageHasVisibleAssistantOutput);
}

function sessionIdFromProperties(properties: unknown) {
  if (!properties || typeof properties !== "object") return "";
  const sessionID = (properties as { sessionID?: unknown }).sessionID;
  return typeof sessionID === "string" ? sessionID : "";
}

function compactionEventProperties(properties: unknown) {
  if (!properties || typeof properties !== "object") return null;
  const record = properties as {
    sessionID?: unknown;
    messageID?: unknown;
    reason?: unknown;
    timestamp?: unknown;
  };
  if (typeof record.sessionID !== "string" || !record.sessionID) return null;
  const mode: SessionCompactionMode = record.reason === "auto" || record.reason === "manual"
    ? record.reason
    : "unknown";
  return {
    sessionId: record.sessionID,
    messageId: typeof record.messageID === "string" && record.messageID
      ? record.messageID
      : null,
    mode,
    timestamp: typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
      ? record.timestamp
      : null,
  };
}

function sessionErrorFromProperties(properties: unknown) {
  if (!properties || typeof properties !== "object") return undefined;
  return (properties as { error?: unknown }).error;
}

function permissionNotificationDetail(permission: PermissionRequest | PermissionV2Request) {
  if ("action" in permission) {
    return `A session is waiting for permission to ${permission.action.replace(/[._-]/g, " ")}.`;
  }
  return `A session is waiting for ${permission.permission} permission.`;
}

function questionNotificationText(question: QuestionRequest) {
  const prompt = question.questions.find((item) => item.question.trim())?.question.trim();
  return prompt ? `Question: ${prompt}` : undefined;
}

function latestAssistantMessageId(messages: UIMessage[]) {
  // The snapshot keys each error to its errored assistant message id, so the
  // live event must resolve to that same id to dedupe on reload. Skipping
  // synthetic error messages ensures a follow-up error keys off the real
  // assistant turn rather than overwriting the previous error message.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    if (message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX)) continue;
    return message.id;
  }
  return null;
}

function partHasVisibleAssistantOutput(part: Part) {
  if (part.type === "text" && part.synthetic) return false;
  if (part.type === "text" && part.ignored) return false;
  const partType = String(part.type);
  if ("text" in part && typeof part.text === "string" && part.text.trim().length > 0) return true;
  return partType === "tool" || partType === "file" || partType === "agent";
}

function retryMessage(error: unknown) {
  return describeOpencodeSessionError(error, "Provider request failed")
    .split("\n")
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 300) || "Provider request failed";
}

function partMarksMeaningfulProgress(part: Part) {
  if (part.type === "retry") return false;
  if (part.type === "text" || part.type === "reasoning") return part.text.trim().length > 0;
  return part.type === "tool" || part.type === "file" || part.type === "agent";
}

function latestActiveSnapshotRetry(snapshot: JuggleWorkSessionSnapshot) {
  if (snapshot.status.type === "idle") return null;
  const lastUserIndex = snapshot.messages.findLastIndex((message) => message.info.role === "user");
  for (let messageIndex = snapshot.messages.length - 1; messageIndex > lastUserIndex; messageIndex -= 1) {
    const message = snapshot.messages[messageIndex];
    const retry = message?.parts.findLast((part) => part.type === "retry");
    if (!retry || retry.type !== "retry") continue;
    return {
      attempt: retry.attempt,
      message: retryMessage(retry.error),
      next: null,
      observedAt: retry.time.created,
    };
  }
  return null;
}

function clearTrackedSession(input: SyncOptions, entry: SyncEntry, sessionId: string) {
  entry.trackedSessionRefs.delete(sessionId);
  const retainedTimer = entry.retainedSessionTimers.get(sessionId);
  if (retainedTimer) clearTimeout(retainedTimer);
  entry.retainedSessionTimers.delete(sessionId);
  entry.deltaFlushBuffer = entry.deltaFlushBuffer.filter(
    (item) => item.sessionId !== sessionId,
  );
  const queryClient = getReactQueryClient();
  if (!isTrackedByAnotherSync(input, entry, sessionId)) {
    queryClient.removeQueries({ queryKey: todoKey(input.workspaceId, sessionId), exact: true });
    liveTodoRevision.delete(todoRevisionKey(input.workspaceId, sessionId));
  }
  if (entry.refs <= 0 && entry.retainedSessionTimers.size === 0) {
    disposeWorkspaceSync(syncKey(input), entry);
  }
}

function retainSession(input: SyncOptions, entry: SyncEntry, sessionId: string, ttlMs = retainedSessionTtlMs) {
  const existing = entry.retainedSessionTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  entry.retainedSessionTimers.set(sessionId, setTimeout(() => {
    clearTrackedSession(input, entry, sessionId);
  }, ttlMs));
}

function disposeWorkspaceSync(key: string, entry: SyncEntry) {
  if (entry.refs > 0) return;
  if (entry.disposeTimer) {
    clearTimeout(entry.disposeTimer);
    entry.disposeTimer = null;
  }
  for (const timer of entry.retainedSessionTimers.values()) clearTimeout(timer);
  entry.retainedSessionTimers.clear();
  entry.dispose();
  if (syncs.get(key) === entry) syncs.delete(key);
}

function releaseRetainedSessionSoon(input: SyncOptions, entry: SyncEntry, sessionId: string) {
  if (!entry.retainedSessionTimers.has(sessionId)) return;
  retainSession(input, entry, sessionId, idleRetainedSessionTtlMs);
}

type PermissionSeed = PermissionRequest | PermissionV2Request;

function isV2PermissionRequest(permission: PermissionSeed): permission is PermissionV2Request {
  return "action" in permission;
}

function legacyPermissionWithReceivedAt(permission: PermissionRequest, receivedAt: number): PendingPermission {
  return {
    ...permission,
    receivedAt,
    interactionRevision: receivedAt,
    protocol: "legacy",
    targetSessionId: permission.sessionID,
    parentSessionId: null,
    rootSessionId: permission.sessionID,
    ancestryPath: [permission.sessionID],
  };
}

export function captureLegacyInteractionSnapshotRevision(): number {
  return legacyInteractionRevision;
}

function v2PermissionKind(action: string): string {
  if (action === "external_directory") return "external_directory";
  if (action.endsWith(".external_directory")) return "external_directory";
  if (action === "file.read") return "read";
  if (action === "file.edit" || action === "file.write") return "edit";
  return action;
}

function v2PermissionWithReceivedAt(permission: PermissionV2Request, receivedAt: number): PendingPermission {
  const metadata: Record<string, unknown> = {
    ...(permission.metadata ?? {}),
    action: permission.action,
  };
  if (permission.save?.length) metadata.save = permission.save.join(", ");
  return {
    id: permission.id,
    sessionID: permission.sessionID,
    permission: v2PermissionKind(permission.action),
    patterns: permission.resources,
    metadata,
    always: permission.save ?? [],
    ...(permission.source ? { tool: { messageID: permission.source.messageID, callID: permission.source.callID } } : {}),
    receivedAt,
    interactionRevision: receivedAt,
    protocol: "v2",
    v2: {
      action: permission.action,
      resources: permission.resources,
      ...(permission.save ? { save: permission.save } : {}),
    },
    targetSessionId: permission.sessionID,
    parentSessionId: null,
    rootSessionId: permission.sessionID,
    ancestryPath: [permission.sessionID],
  };
}

function permissionWithReceivedAt(permission: PermissionSeed, receivedAt: number): PendingPermission {
  return isV2PermissionRequest(permission)
    ? v2PermissionWithReceivedAt(permission, receivedAt)
    : legacyPermissionWithReceivedAt(permission, receivedAt);
}

function questionWithReceivedAt(question: QuestionRequest, receivedAt: number): PendingQuestion {
  return {
    ...question,
    receivedAt,
    interactionRevision: receivedAt,
    protocol: "legacy",
    targetSessionId: question.sessionID,
    parentSessionId: null,
    rootSessionId: question.sessionID,
    ancestryPath: [question.sessionID],
  };
}

function sortPermissions(a: PendingPermission, b: PendingPermission) {
  return a.receivedAt - b.receivedAt || a.id.localeCompare(b.id);
}

function sortQuestions(a: PendingQuestion, b: PendingQuestion) {
  return a.receivedAt - b.receivedAt || a.id.localeCompare(b.id);
}

export function seedPermissionState(
  workspaceId: string,
  sessionId: string,
  permissions: PermissionSeed[],
  options: { snapshotRevision?: number } = {},
) {
  useSessionActivityStore.getState().replaceWaitingRequests(
    workspaceId,
    sessionId,
    "permission",
    permissions.flatMap((permission) => permission.sessionID === sessionId ? [permission.id] : []),
  );
  const queryClient = getReactQueryClient();
  const revision = ++legacyInteractionRevision;
  queryClient.setQueryData<PendingPermission[]>(permissionKey(workspaceId, sessionId), (current = []) => {
    const revisionById = new Map(current.map((permission) => [permission.id, permission.interactionRevision]));
    const seeded = permissions.flatMap((permission) =>
      permission.sessionID === sessionId ? [permissionWithReceivedAt(permission, revisionById.get(permission.id) ?? revision)] : [],
    );
    const seededIds = new Set(seeded.map((permission) => permission.id));
    const snapshotRevision = options.snapshotRevision;
    const liveAfterSnapshot =
      typeof snapshotRevision === "number"
        ? current.filter(
            (permission) =>
              permission.sessionID === sessionId &&
              permission.interactionRevision > snapshotRevision &&
              !seededIds.has(permission.id),
          )
        : [];
    return [...seeded, ...liveAfterSnapshot].sort(sortPermissions);
  });
}

export function seedQuestionState(
  workspaceId: string,
  sessionId: string,
  questions: QuestionRequest[],
  options: { snapshotRevision?: number } = {},
) {
  useSessionActivityStore.getState().replaceWaitingRequests(
    workspaceId,
    sessionId,
    "question",
    questions.flatMap((question) => question.sessionID === sessionId ? [question.id] : []),
  );
  const queryClient = getReactQueryClient();
  const revision = ++legacyInteractionRevision;
  queryClient.setQueryData<PendingQuestion[]>(questionKey(workspaceId, sessionId), (current = []) => {
    const revisionById = new Map(current.map((question) => [question.id, question.interactionRevision]));
    const seeded = questions.flatMap((question) =>
      question.sessionID === sessionId ? [questionWithReceivedAt(question, revisionById.get(question.id) ?? revision)] : [],
    );
    const seededIds = new Set(seeded.map((question) => question.id));
    const snapshotRevision = options.snapshotRevision;
    const liveAfterSnapshot =
      typeof snapshotRevision === "number"
        ? current.filter(
            (question) =>
              question.sessionID === sessionId &&
              question.interactionRevision > snapshotRevision &&
              !seededIds.has(question.id),
          )
        : [];
    return [...seeded, ...liveAfterSnapshot].sort(sortQuestions);
  });
}

function fileProviderMetadata(part: FilePart) {
  if (part.source) {
    return { opencode: { partId: part.id, source: part.source } };
  }
  return { opencode: { partId: part.id } };
}

function toFileUIPart(part: FilePart): UIMessage["parts"][number] {
  return {
    type: "file",
    url: part.url,
    filename: part.filename,
    mediaType: part.mime,
    providerMetadata: fileProviderMetadata(part),
  };
}

function toFileSourceUIPart(part: FilePart): UIMessage["parts"][number] | null {
  const source = part.source;
  if (!source) return null;

  const sourceId = `${part.id}:source`;
  const providerMetadata = { opencode: { partId: sourceId, sourcePartId: part.id, source } };

  if (source.type === "resource") {
    if (source.uri.startsWith("http://")) {
      return { type: "source-url", sourceId, url: source.uri, title: source.uri, providerMetadata };
    }
    if (source.uri.startsWith("https://")) {
      return { type: "source-url", sourceId, url: source.uri, title: source.uri, providerMetadata };
    }
    return { type: "source-document", sourceId, mediaType: part.mime, title: source.uri, providerMetadata };
  }

  if (source.type === "symbol") {
    return { type: "source-document", sourceId, mediaType: part.mime, title: source.name, filename: source.path, providerMetadata };
  }

  return { type: "source-document", sourceId, mediaType: part.mime, title: source.path, filename: source.path, providerMetadata };
}

function toFileUIParts(part: FilePart): UIMessage["parts"] {
  const sourcePart = toFileSourceUIPart(part);
  if (sourcePart) return [toFileUIPart(part), sourcePart];
  return [toFileUIPart(part)];
}

function toUIPart(part: Part): UIMessage["parts"][number] | null {
  if (part.type === "text") {
    if (part.synthetic || part.ignored) return null;
    return {
      type: "text",
      text: part.text,
      state: "done",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "reasoning") {
    return {
      type: "reasoning",
      text: part.text,
      state: "done",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "file") {
    return toFileUIPart(part);
  }
  if (part.type === "tool") {
    if (part.tool === STRUCTURED_OUTPUT_TOOL) {
      return parseStructuredOutputUIPart(part);
    }
    return parseDynamicToolUIPart(part);
  }
  if (part.type === "agent") {
    return {
      type: "text",
      text: part.name ? `@${part.name}` : "@agent",
      state: "done",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "step-start") return { type: "step-start" };
  if (part.type === "compaction") {
    // A CompactionPart marks the context boundary that the engine will use;
    // it is not proof that summarization has finished. Completion is rendered
    // from session.next.compaction.ended or completed summary-message metadata.
    return null;
  }
  return null;
}

function toUIParts(part: Part): UIMessage["parts"] {
  if (part.type === "file") return toFileUIParts(part);
  const mapped = toUIPart(part);
  if (!mapped) return [];
  if (part.type === "tool" && part.tool === STRUCTURED_OUTPUT_TOOL) return [mapped];
  if (part.type === "tool" && part.state.status === "completed" && part.state.attachments) {
    return [mapped, ...part.state.attachments.flatMap(toFileUIParts)];
  }
  return [mapped];
}

function getPartMetadataId(part: UIMessage["parts"][number]) {
  if (part.type === "dynamic-tool") {
    const metadata = part.callProviderMetadata?.opencode;
    if (!metadata || typeof metadata !== "object") return null;
    return "partId" in metadata ? (metadata as { partId?: string }).partId ?? null : null;
  }
  if (part.type !== "text" && part.type !== "reasoning" && part.type !== "file" && part.type !== "source-url" && part.type !== "source-document") return null;
  const metadata = part.providerMetadata?.opencode;
  if (!metadata || typeof metadata !== "object") return null;
  return "partId" in metadata ? (metadata as { partId?: string }).partId ?? null : null;
}

function upsertMessage(messages: UIMessage[], next: UIMessage) {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index === -1) return [...messages, next];
  return messages.map((message, messageIndex) =>
    messageIndex === index
      ? {
          ...message,
          ...next,
          metadata: message.metadata || next.metadata
            ? {
                ...(message.metadata ?? {}),
                ...(next.metadata ?? {}),
                opencode: {
                  ...((message.metadata as { opencode?: Record<string, unknown> } | undefined)?.opencode ?? {}),
                  ...((next.metadata as { opencode?: Record<string, unknown> } | undefined)?.opencode ?? {}),
                },
              }
            : undefined,
          parts: next.parts.length > 0 ? next.parts : message.parts,
        }
      : message,
  );
}

/**
 * When a message.part.updated or message.part.delta event arrives for a
 * messageID we haven't seen a message.updated for yet, we have to stub the
 * message so the part has somewhere to live. The stub's role used to be
 * hard-coded to "assistant", which meant that if part events beat the
 * message.updated event for a *user* turn (a common race during
 * promptAsync), that user message flashed as an assistant-styled block
 * until the real role arrived a tick later.
 *
 * Assistant-only part kinds provide a definitive role. For ambiguous text or
 * file parts, infer from the conversation until message.updated supplies the
 * authoritative role. If the transcript is empty the first ambiguous message
 * is the user's.
 */
function inferStubRole(
  messages: UIMessage[],
  part?: UIMessage["parts"][number],
): UIMessage["role"] {
  // Reasoning, tool calls, and step boundaries can only belong to assistant
  // output. Multi-step tool runs legitimately create consecutive assistant
  // messages, so the generic user/assistant alternation heuristic is wrong
  // for these parts.
  if (part && (part.type === "reasoning" || isToolUIPart(part) || part.type === "step-start")) {
    return "assistant";
  }
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return "user";
  if (lastMessage.role === "user") return "assistant";
  if (lastMessage.role === "assistant") return "user";
  return "assistant";
}

function upsertPart(messages: UIMessage[], messageId: string, partId: string, next: UIMessage["parts"][number]) {
  return messages.map((message) => {
    if (message.id !== messageId) return message;
    const index = message.parts.findIndex((part) =>
      ("toolCallId" in part && part.toolCallId === partId) || getPartMetadataId(part) === partId,
    );
    if (index === -1) {
      return { ...message, parts: [...message.parts, next] };
    }
    const parts = message.parts.slice();
    parts[index] = next;
    return { ...message, parts };
  });
}

function appendDelta(messages: UIMessage[], messageId: string, partId: string, delta: string, reasoning: boolean) {
  // Fast path: locate the target message by index, only clone that message
  // and its parts array. The previous implementation ran messages.map AND
  // message.parts.map on every delta event, which is O(N * P) per token.
  // For an old session with hundreds of prior messages/parts that allocated
  // thousands of objects per token and crushed the main thread after a
  // handful of tokens.
  const messageIndex = messages.findIndex((message) => message.id === messageId);
  if (messageIndex === -1) return messages;

  const target = messages[messageIndex]!;
  const lastPart = target.parts[target.parts.length - 1];

  let partIndex = -1;
  for (let i = 0; i < target.parts.length; i++) {
    const part = target.parts[i]!;
    const id = getPartMetadataId(part);
    if (reasoning && part.type === "reasoning") {
      if (id === partId || (!id && part === lastPart)) {
        partIndex = i;
        break;
      }
    } else if (!reasoning && part.type === "text") {
      if (id === partId || (!id && part === lastPart)) {
        partIndex = i;
        break;
      }
    }
  }

  let nextParts: UIMessage["parts"];
  if (partIndex === -1) {
    // No existing matching part — append a fresh one so the delta is not lost.
    const newPart: UIMessage["parts"][number] = reasoning
      ? {
          type: "reasoning",
          text: delta,
          state: "streaming" as const,
          providerMetadata: { opencode: { partId } },
        }
      : {
          type: "text",
          text: delta,
          state: "streaming" as const,
          providerMetadata: { opencode: { partId } },
        };
    nextParts = target.parts.slice();
    nextParts.push(newPart);
  } else {
    const existing = target.parts[partIndex]!;
    nextParts = target.parts.slice();
    if (existing.type === "text") {
      nextParts[partIndex] = {
        ...existing,
        text: `${existing.text}${delta}`,
        state: "streaming",
      };
    } else if (existing.type === "reasoning") {
      nextParts[partIndex] = {
        ...existing,
        text: `${existing.text}${delta}`,
        state: "streaming",
      };
    }
  }

  const nextMessages = messages.slice();
  nextMessages[messageIndex] = { ...target, parts: nextParts };
  return nextMessages;
}

export function coalescePendingDeltas(items: PendingDelta[]) {
  if (items.length < 2) return items;

  const ordered: PendingDelta[] = [];
  const byKey = new Map<string, PendingDelta>();
  for (const item of items) {
    const key = `${item.sessionId}\u0000${item.messageId}\u0000${item.partId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.delta += item.delta;
      existing.reasoning = existing.reasoning || item.reasoning;
      continue;
    }

    const next = { ...item };
    byKey.set(key, next);
    ordered.push(next);
  }
  return ordered;
}

/** 意味着工作区文件已落盘改动的引擎事件，「变更」面板据此重取，无需轮询 */
const FILE_CHANGE_EVENT_TYPES = new Set(["session.diff", "file.edited", "file.watcher.updated"]);

const fileChangeListeners = new Map<string, Set<() => void>>();

/**
 * 订阅某个工作区的文件改动事件
 *
 * TIPS: 引擎事件流由本模块统一维护，「文件」面板不在 kernel 的 GlobalSDKProvider
 * 作用域内，拿不到那条总线，只能从这里转发。
 *
 * @param workspaceId 工作区 id
 * @param listener 改动回调
 * @returns 取消订阅的函数
 */
export function subscribeWorkspaceFileChanges(workspaceId: string, listener: () => void) {
  let bucket = fileChangeListeners.get(workspaceId);

  if (!bucket) {
    bucket = new Set();
    fileChangeListeners.set(workspaceId, bucket);
  }

  bucket.add(listener);

  return () => {
    const current = fileChangeListeners.get(workspaceId);

    if (!current) return;

    current.delete(listener);

    if (current.size === 0) fileChangeListeners.delete(workspaceId);
  };
}

function applyEvent(entry: SyncEntry, workspaceId: string, event: OpencodeEvent) {
  const queryClient = getReactQueryClient();
  const input = entry.input;

  if (FILE_CHANGE_EVENT_TYPES.has(event.type)) {
    for (const listener of fileChangeListeners.get(workspaceId) ?? []) listener();
    return;
  }

  if (event.type === "session.created") {
    const session = getSessionCreatedInfo(event);
    if (!session) return;
    seedWorkspaceSessionAncestry(workspaceId, [session]);
    for (const listener of entry.sessionCreatedListeners) listener(session);
    return;
  }

  if (event.type === "session.updated") {
    const update = getSessionUpdatedInfo(event);
    if (!update) return;
    if (Object.prototype.hasOwnProperty.call(update.info, "parentID")) {
      seedWorkspaceSessionAncestry(workspaceId, [{
        id: update.sessionId,
        parentID: typeof update.info.parentID === "string" ? update.info.parentID : undefined,
      } as Session]);
    }
    if (!isTrackedSession(entry, update.sessionId)) return;
    // Keep the cached snapshot's revert cursor in sync with the server. The
    // renderer derives the visible transcript from this cursor, so a revert
    // (or its cleanup on the next prompt) must reach the snapshot cache or
    // the transcript stays frozen on stale history.
    queryClient.setQueryData<JuggleWorkSessionSnapshot>(
      snapshotKey(workspaceId, update.sessionId),
      (current) => {
        if (!current) return current;
        const revert = (update.info as { revert?: JuggleWorkSessionSnapshot["session"]["revert"] }).revert;
        return { ...current, session: { ...current.session, revert } };
      },
    );
    for (const listener of entry.sessionUpdatedListeners) listener(update);
    return;
  }

  if (event.type === "session.deleted") {
    const props = (event.properties ?? {}) as { sessionID?: string; info?: { id?: string } };
    const sessionId = props.sessionID ?? props.info?.id ?? "";
    if (sessionId) removeWorkspaceSessionAncestry(workspaceId, sessionId);
    if (sessionId) {
      for (const listener of entry.sessionDeletedListeners) listener(sessionId);
    }
    return;
  }

  if (event.type === "session.error") {
    const sessionId = sessionIdFromProperties(event.properties);
    if (sessionId) {
      const errorText = describeOpencodeSessionError(sessionErrorFromProperties(event.properties));
      const runStartedAt = takeTaskRunStart(sessionId);
      if (runStartedAt !== null) {
        captureAnalyticsEvent("task_run_errored", {
          duration_ms: Date.now() - runStartedAt,
        });
        trackTaskFailed(sessionId, Date.now() - runStartedAt);
      }
      notifyDesktopEvent({ type: "task.failed", sessionId, errorText });
      useSessionActivityStore.getState().setError(workspaceId, sessionId, errorText);
      if (isTrackedSession(entry, sessionId)) {
        queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId), (current = []) => {
          // Key the error to the latest assistant turn so it lands beside the
          // turn that failed and a later turn's error becomes its own message
          // instead of overwriting this one. Falls back to the session id when
          // no assistant turn exists yet (e.g. error before any output).
          const turnKey = latestAssistantMessageId(current) ?? sessionId;
          // Note: turnKey matches the snapshot's per-turn key (the errored
          // assistant message id) so a reload reconciles instead of
          // duplicating; the sessionId fallback only applies when the run
          // errored before any assistant message existed.
          return upsertMessage(current, createSessionErrorUIMessage(turnKey, errorText));
        });
      }
    }
    return;
  }

  if (event.type === "session.next.compaction.started") {
    const compaction = compactionEventProperties(event.properties);
    if (!compaction) return;
    useSessionActivityStore.getState().setCompacting(workspaceId, compaction.sessionId, true);
    if (compaction.messageId && isTrackedSession(entry, compaction.sessionId)) {
      queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, compaction.sessionId), (current = []) =>
        upsertSessionCompactionMessage(current, {
          messageId: compaction.messageId!,
          mode: compaction.mode,
          running: true,
          startedAt: compaction.timestamp,
        }),
      );
    }
    return;
  }

  if (event.type === "session.next.compaction.ended") {
    const compaction = compactionEventProperties(event.properties);
    if (!compaction) return;
    useSessionActivityStore.getState().setCompacting(workspaceId, compaction.sessionId, false);
    if (isTrackedSession(entry, compaction.sessionId)) {
      queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, compaction.sessionId), (current = []) => {
        if (compaction.messageId) {
          return upsertSessionCompactionMessage(current, {
            messageId: compaction.messageId,
            mode: compaction.mode,
            running: false,
            finishedAt: compaction.timestamp,
          });
        }
        return completeRunningSessionCompactions(current, compaction.timestamp);
      });
    }
    return;
  }

  if (event.type === "session.compacted") {
    const sessionId = sessionIdFromProperties(event.properties);
    if (!sessionId) return;
    useSessionActivityStore.getState().setCompacting(workspaceId, sessionId, false);
    if (isTrackedSession(entry, sessionId)) {
      queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId), (current = []) =>
        completeRunningSessionCompactions(current, Date.now()),
      );
    }
    return;
  }

  if (event.type === "session.status") {
    const props = (event.properties ?? {}) as { sessionID?: string; status?: SessionStatus };
    if (!props.sessionID || !props.status) return;
    useSessionActivityStore.getState().setRunStatus(workspaceId, props.sessionID, props.status);
    const tracked = isTrackedSession(entry, props.sessionID);
    if (tracked) {
      queryClient.setQueryData(statusKey(workspaceId, props.sessionID), props.status);
      if (isLiveStatus(props.status)) {
        // A provider/SSE interruption can recover. Once authoritative live
        // activity resumes, remove the provisional interruption receipt.
        queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, props.sessionID), (current = []) =>
          current.filter((message) => !message.id.startsWith(SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX)),
        );
      }
    }
    for (const listener of entry.sessionStatusListeners) listener({ sessionId: props.sessionID, status: props.status });
    if (input && tracked && !isLiveStatus(props.status)) {
      void queryClient.invalidateQueries({ queryKey: snapshotKey(workspaceId, props.sessionID) });
      releaseRetainedSessionSoon(input, entry, props.sessionID);
    }
    return;
  }

  if (event.type === "session.next.retried") {
    const props = (event.properties ?? {}) as {
      timestamp?: number;
      sessionID?: string;
      attempt?: number;
      error?: unknown;
    };
    if (!props.sessionID || typeof props.attempt !== "number") return;
    const activityStore = useSessionActivityStore.getState();
    if (!activityStore.recordsByWorkspaceId[workspaceId]?.[props.sessionID]?.runActive) {
      activityStore.setRunStatus(workspaceId, props.sessionID, { type: "busy" });
    }
    activityStore.setProviderRetry(workspaceId, props.sessionID, {
      attempt: props.attempt,
      message: retryMessage(props.error),
      next: null,
      observedAt: typeof props.timestamp === "number" ? props.timestamp : Date.now(),
    });
    return;
  }

  if (event.type === "todo.updated") {
    const props = (event.properties ?? {}) as { sessionID?: string; todos?: Todo[] };
    if (!props.sessionID || !props.todos) return;
    if (!isTrackedSession(entry, props.sessionID)) return;
    liveTodoRevision.set(todoRevisionKey(workspaceId, props.sessionID), ++todoRevision);
    queryClient.setQueryData(todoKey(workspaceId, props.sessionID), props.todos);
    return;
  }

  if (event.type === "permission.asked") {
    const permission = event.properties as PermissionRequest;
    if (!permission?.id || !permission.sessionID) return;
    if (!upsertLivePermission(workspaceId, permission)) return;
    notifyDesktopEvent({
      type: "permission.asked",
      sessionId: permission.sessionID,
      detail: permissionNotificationDetail(permission),
    });
    useSessionActivityStore.getState().setWaitingRequest(workspaceId, permission.sessionID, "permission", permission.id, true);
    return;
  }

  if (event.type === "permission.v2.asked") {
    const permission = event.properties as PermissionV2Request;
    if (!permission?.id || !permission.sessionID) return;
    if (!upsertLivePermission(workspaceId, permission)) return;
    notifyDesktopEvent({
      type: "permission.asked",
      sessionId: permission.sessionID,
      detail: permissionNotificationDetail(permission),
    });
    useSessionActivityStore.getState().setWaitingRequest(workspaceId, permission.sessionID, "permission", permission.id, true);
    return;
  }

  if (event.type === "permission.replied" || event.type === "permission.v2.replied") {
    const props = (event.properties ?? {}) as { sessionID?: string; requestID?: string };
    if (!props.sessionID || !props.requestID) return;
    useSessionActivityStore.getState().setWaitingRequest(workspaceId, props.sessionID, "permission", props.requestID, false);
    resolveLiveInteraction(workspaceId, "permission", props.sessionID, props.requestID);
    return;
  }

  if (event.type === "question.asked" || event.type === "question.v2.asked") {
    const question = event.properties as QuestionRequest;
    if (!question?.id || !question.sessionID) return;
    if (!upsertLiveQuestion(workspaceId, {
      ...question,
      protocol: event.type === "question.v2.asked" ? "v2" : "legacy",
    })) return;
    notifyDesktopEvent({
      type: "question.asked",
      sessionId: question.sessionID,
      question: questionNotificationText(question),
    });
    useSessionActivityStore.getState().setWaitingRequest(workspaceId, question.sessionID, "question", question.id, true);
    return;
  }

  if (
    event.type === "question.replied" ||
    event.type === "question.rejected" ||
    event.type === "question.v2.replied" ||
    event.type === "question.v2.rejected"
  ) {
    const props = (event.properties ?? {}) as { sessionID?: string; requestID?: string };
    if (!props.sessionID || !props.requestID) return;
    useSessionActivityStore.getState().setWaitingRequest(workspaceId, props.sessionID, "question", props.requestID, false);
    resolveLiveInteraction(workspaceId, "question", props.sessionID, props.requestID);
    return;
  }

  if (event.type === "message.updated") {
    const props = (event.properties ?? {}) as {
      info?: { id?: string; role?: UIMessage["role"] | string; sessionID?: string; finish?: string; summary?: boolean; error?: unknown; time?: { created?: number; completed?: number } };
    };
    const info = props.info;
    if (!info?.id || !info.sessionID || (info.role !== "user" && info.role !== "assistant" && info.role !== "system")) {
      return;
    }
    const messageActivityStore = useSessionActivityStore.getState();
    messageActivityStore.markMessageRole(workspaceId, info.sessionID, info.id, info.role);
    if (info.role === "assistant") {
      // TIPS: 带 error 的助手消息就是这次运行的终点。中断（MessageAbortedError）只写在消息上，
      // 引擎不一定再发 session.error，session.idle 也可能因为 SSE 重连而丢；不在这里收口，
      // 侧栏（尤其工作区折叠后行尾的 loading）会一直转。
      if (info.error) messageActivityStore.setRunStatus(workspaceId, info.sessionID, idleStatus);
      else if (info.summary === true && typeof info.time?.completed === "number") {
        messageActivityStore.setCompacting(workspaceId, info.sessionID, false);
      } else messageActivityStore.markRuntimeEvent(workspaceId, info.sessionID);
    }
    if (!isTrackedSession(entry, info.sessionID)) return;
    const created = info.time?.created;
    const completed = info.time?.completed;
    const timingMetadata = {
      ...(typeof created === "number" ? { created } : {}),
      ...(typeof completed === "number" ? { completed } : {}),
      ...(info.role === "assistant" && typeof info.finish === "string" ? { finish: info.finish } : {}),
      ...(info.role === "assistant" && info.summary === true ? { summary: true } : {}),
    };
    const next = {
      id: info.id,
      role: info.role,
      ...(Object.keys(timingMetadata).length > 0 ? { metadata: { opencode: timingMetadata } } : {}),
      parts: [],
    } satisfies UIMessage;
    const messageId = info.id;
    queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, info.sessionID), (current = []) => {
      const updated = upsertMessage(current, next);
      if (info.role !== "assistant" || info.summary !== true || typeof completed !== "number") {
        return updated;
      }
      return upsertSessionCompactionMessage(updated, {
        messageId,
        mode: "unknown",
        running: false,
        startedAt: created,
        finishedAt: completed,
      });
    });
    return;
  }

  if (event.type === "message.removed") {
    // Revert cleanup (and explicit message deletion) removes messages
    // server-side; drop them from both the live transcript cache and the
    // cached snapshot so they can't be resurrected by later merges.
    const props = (event.properties ?? {}) as { sessionID?: string; messageID?: string };
    if (!props.sessionID || !props.messageID) return;
    if (!isTrackedSession(entry, props.sessionID)) return;
    queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, props.sessionID), (current = []) =>
      current.filter((message) => message.id !== props.messageID),
    );
    queryClient.setQueryData<JuggleWorkSessionSnapshot>(
      snapshotKey(workspaceId, props.sessionID),
      (current) => {
        if (!current) return current;
        return { ...current, messages: current.messages.filter((message) => message.info.id !== props.messageID) };
      },
    );
    return;
  }

  if (event.type === "message.part.updated") {
    const props = (event.properties ?? {}) as { part?: Part };
    const part = props.part;
    if (!part?.sessionID || !part.messageID) return;
    const activityStore = useSessionActivityStore.getState();
    activityStore.markRuntimeEvent(workspaceId, part.sessionID);
    if (part.type === "retry") {
      if (!activityStore.recordsByWorkspaceId[workspaceId]?.[part.sessionID]?.runActive) {
        activityStore.setRunStatus(workspaceId, part.sessionID, { type: "busy" });
      }
      activityStore.setProviderRetry(workspaceId, part.sessionID, {
        attempt: part.attempt,
        message: retryMessage(part.error),
        next: null,
        observedAt: part.time.created,
      });
    } else if (partMarksMeaningfulProgress(part)) {
      activityStore.markProgress(workspaceId, part.sessionID);
    }
    if (partHasVisibleAssistantOutput(part)) {
      activityStore.markAssistantOutput(workspaceId, part.sessionID, part.messageID);
    }
    if (!isTrackedSession(entry, part.sessionID)) return;
    const [mapped, ...attachments] = toUIParts(part);
    if (!mapped) return;
    const pending = entry.pendingDeltas.get(part.id);
    // Seed the new part with any deltas that arrived before this
    // declaration. We deliberately ignore `pending.reasoning` — it
    // can't be trusted because opencode emits `field: "text"` for
    // both text and reasoning streams. The part's actual kind
    // (`mapped.type`) is the source of truth.
    //
    // Both `pending.text` and `mapped.text` are cumulative views of the
    // same stream, so we keep whichever is longer instead of
    // concatenating (concatenation double-counts the bytes that landed
    // in both). Without this, reasoning text shows up duplicated in the
    // streaming UI.
    const seededPart =
      pending && (mapped.type === "text" || mapped.type === "reasoning")
        ? {
            ...mapped,
            text: pending.text.length > mapped.text.length ? pending.text : mapped.text,
            state: "streaming" as const,
          }
        : mapped;
    // Drop any deltas for this partID still queued in the rAF flush
    // buffer — they've already been incorporated into `mapped.text`.
    // Without this, the rAF flush would re-append them on top of the
    // cumulative text we just wrote, duplicating bytes mid-stream.
    if (entry.deltaFlushBuffer.length > 0) {
      entry.deltaFlushBuffer = entry.deltaFlushBuffer.filter(
        (item) => item.partId !== part.id,
      );
    }
    queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, part.sessionID), (current = []) => {
      const compaction = getSessionCompactionFromPart(seededPart);
      if (compaction) {
        return upsertSessionCompactionMessage(current, {
          messageId: part.messageID,
          partId: part.id,
          mode: compaction.mode,
          running: compaction.running,
          startedAt: compaction.startedAt,
          finishedAt: compaction.finishedAt,
        });
      }
      // If we already have this message, keep its role; otherwise infer
      // from the alternation pattern. Only the newly-stubbed case needs
      // the inference — upsertMessage preserves existing role when the
      // stub's role matches what we'd write anyway, and any subsequent
      // message.updated will overwrite both.
      const existing = current.find((m) => m.id === part.messageID);
      const role = existing?.role ?? inferStubRole(current, seededPart);
      const withMessage = upsertMessage(current, { id: part.messageID, role, parts: [] });
      const seededPartId = getPartMetadataId(seededPart) ?? part.id;
      let next = upsertPart(withMessage, part.messageID, seededPartId, seededPart);
      for (const attachment of attachments) {
        const attachmentId = getPartMetadataId(attachment);
        if (attachmentId) next = upsertPart(next, part.messageID, attachmentId, attachment);
      }
      return next;
    });
    if (pending) entry.pendingDeltas.delete(part.id);
    return;
  }

  if (event.type === "message.part.delta") {
    const props = (event.properties ?? {}) as {
      sessionID?: string;
      messageID?: string;
      partID?: string;
      field?: string;
      delta?: string;
    };
    if (!props.sessionID || !props.messageID || !props.partID || !props.delta) return;
    useSessionActivityStore.getState().markProgress(workspaceId, props.sessionID);
    useSessionActivityStore.getState().markAssistantOutput(workspaceId, props.sessionID, props.messageID, { allowUnknownMessageRole: true });
    if (!isTrackedSession(entry, props.sessionID)) return;
    // Note: we do NOT trust `props.field` to disambiguate reasoning vs
    // text. Opencode emits `field: "text"` for both kinds; the actual
    // distinction lives on the part's `type`, which we only see via
    // `message.part.updated`. The flusher resolves the kind at apply
    // time, falling back to `pendingDeltas` if the part hasn't been
    // declared yet.
    entry.deltaFlushBuffer.push({
      sessionId: props.sessionID!,
      messageId: props.messageID!,
      partId: props.partID!,
      reasoning: false,
      delta: props.delta!,
    });
    scheduleDeltaFlush(entry, workspaceId);
    return;
  }

  if (event.type === "session.idle") {
    const props = (event.properties ?? {}) as { sessionID?: string };
    if (!props.sessionID) return;
    // Only emits for runs this client instrumented (markTaskRunStart in the
    // send path); also dedupes idle events from multiple workspace syncs.
    const runStartedAt = takeTaskRunStart(props.sessionID);
    if (runStartedAt !== null) {
      captureAnalyticsEvent("task_run_completed", {
        duration_ms: Date.now() - runStartedAt,
      });
      trackTaskCompleted(props.sessionID, Date.now() - runStartedAt);
      notifyDesktopEvent({ type: "task.completed", sessionId: props.sessionID });
    }
    const activityStore = useSessionActivityStore.getState();
    const recordedFinishReason = activityStore.getFinishReason(workspaceId, props.sessionID);
    activityStore.setRunStatus(workspaceId, props.sessionID, idleStatus);
    const tracked = isTrackedSession(entry, props.sessionID);
    if (tracked) {
      queryClient.setQueryData(statusKey(workspaceId, props.sessionID), idleStatus);
      const todos = queryClient.getQueryData<Todo[]>(todoKey(workspaceId, props.sessionID)) ?? [];
      queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, props.sessionID), (current = []) => {
        const result = reconcileRunCompletionDiagnostic(current, todos, { finishReason: recordedFinishReason });
        activityStore.setCompletionDiagnostic(
          workspaceId,
          props.sessionID!,
          Boolean(result.diagnostic),
          result.diagnostic?.finishReason ?? recordedFinishReason,
        );
        return result.messages;
      });
    }
    for (const listener of entry.sessionStatusListeners) listener({ sessionId: props.sessionID, status: idleStatus });
    if (input && tracked) {
      void queryClient.invalidateQueries({ queryKey: snapshotKey(workspaceId, props.sessionID) });
      releaseRetainedSessionSoon(input, entry, props.sessionID);
    }
  }
}

function scheduleDeltaFlush(entry: SyncEntry, workspaceId: string) {
  if (entry.deltaFlushScheduled) return;
  entry.deltaFlushScheduled = true;
  const run = () => {
    entry.deltaFlushScheduled = false;
    if (entry.deltaFlushBuffer.length === 0) return;
    flushDeltas(entry, workspaceId);
  };
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function" &&
    (typeof document === "undefined" || document.visibilityState === "visible")
  ) {
    window.requestAnimationFrame(run);
  } else if (typeof window !== "undefined") {
    window.setTimeout(run, 50);
  } else {
    queueMicrotask(run);
  }
}

function flushDeltas(entry: SyncEntry, workspaceId: string) {
  const queryClient = getReactQueryClient();
  const pending = coalescePendingDeltas(entry.deltaFlushBuffer);
  entry.deltaFlushBuffer = [];

  // Group by session id so each transcript cache is touched at most once
  // per flush.
  const bySession = new Map<string, PendingDelta[]>();
  for (const item of pending) {
    const bucket = bySession.get(item.sessionId);
    if (bucket) bucket.push(item);
    else bySession.set(item.sessionId, [item]);
  }

  for (const [sessionId, items] of bySession) {
    queryClient.setQueryData<UIMessage[]>(
      transcriptKey(workspaceId, sessionId),
      (current = []) => {
        let next = current;
        const nextById = new Map(next.map((message) => [message.id, message]));
        for (const item of items) {
          // Resolve the part kind from the transcript instead of trusting
          // the inbound delta event (opencode emits `field: "text"` for
          // both text and reasoning parts). If the part hasn't been
          // declared yet via `message.part.updated`, defer the delta into
          // `entry.pendingDeltas` so the part can be created with the
          // correct kind later. Without this, every delta lands as a text
          // part — and reasoning content leaks into the response markdown
          // until the next reload reconstructs the transcript from the
          // snapshot.
          const ownerMessage = nextById.get(item.messageId);
          const ownerPartsById = new Map(
            (ownerMessage?.parts ?? []).flatMap((part) => {
              const id = part.type === "dynamic-tool" ? part.toolCallId : getPartMetadataId(part);
              return id ? [[id, part] as const] : [];
            }),
          );
          const ownerPart = ownerPartsById.get(item.partId);

          if (!ownerPart) {
            // A delta can beat both message.updated and message.part.updated.
            // Buffer it without creating a role-guessed message shell. The
            // authoritative message event or typed part event will create the
            // message later, avoiding false user rows between assistant steps.
            const existing = entry.pendingDeltas.get(item.partId) ?? {
              messageId: item.messageId,
              reasoning: item.reasoning,
              text: "",
            };
            existing.text += item.delta;
            entry.pendingDeltas.set(item.partId, existing);
            continue;
          }

          const reasoning = ownerPart.type === "reasoning";
          next = appendDelta(next, item.messageId, item.partId, item.delta, reasoning);
        }
        return next;
      },
    );
  }
}

function startSync(input: SyncOptions) {
  const client = createClient(input.baseUrl, undefined, { token: input.juggleworkToken, mode: "jugglework" });
  const controller = new AbortController();
  const entry = syncs.get(syncKey(input));
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let activeConnectionController: AbortController | null = null;
  let lastEventAt = Date.now();
  let retryDelayMs = 1_000;
  const staleStreamMs = 30_000;

  const reconcileTrackedInteractions = async () => {
    if (!entry || !input.interactionClient) return;
    const sessionIds = new Set([
      ...entry.trackedSessionRefs.keys(),
      ...entry.retainedSessionTimers.keys(),
    ]);
    await reconcileWorkspaceInteractionRoots(input.interactionClient, input.workspaceId, sessionIds);
  };

  const scheduleRetry = () => {
    if (disposed || controller.signal.aborted || retryTimer) return;
    activeConnectionController = null;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, 10_000);
  };

  const connect = async () => {
    const connectionController = new AbortController();
    activeConnectionController = connectionController;
    try {
      const sub = await client.event.subscribe(undefined, { signal: connectionController.signal });
      retryDelayMs = 1_000;
      lastEventAt = Date.now();
      void reconcileTrackedInteractions();
      for await (const raw of sub.stream) {
        if (controller.signal.aborted || connectionController.signal.aborted) return;
        lastEventAt = Date.now();
        const event = normalizeEvent(raw);
        if (!event) continue;
        if (!entry) continue;
        applyEvent(entry, input.workspaceId, event);
      }
      if (!controller.signal.aborted && activeConnectionController === connectionController) scheduleRetry();
    } catch (error) {
      const activityStore = useSessionActivityStore.getState();
      const liveSessionIds = Object.entries(activityStore.recordsByWorkspaceId[input.workspaceId] ?? {})
        .flatMap(([sessionId, record]) => record.runActive ? [sessionId] : []);
      if (
        !controller.signal.aborted &&
        (connectionController.signal.aborted || shouldRetrySyncSubscribe(error))
      ) {
        if (liveSessionIds.length > 0 && !connectionController.signal.aborted) {
          activityStore.markProviderDisconnected(input.workspaceId);
          const queryClient = getReactQueryClient();
          for (const sessionId of liveSessionIds) {
            const todos = queryClient.getQueryData<Todo[]>(todoKey(input.workspaceId, sessionId)) ?? [];
            queryClient.setQueryData<UIMessage[]>(transcriptKey(input.workspaceId, sessionId), (current = []) => {
              const result = reconcileRunCompletionDiagnostic(current, todos, { finishReason: "provider_disconnected" });
              activityStore.setCompletionDiagnostic(
                input.workspaceId,
                sessionId,
                Boolean(result.diagnostic),
                result.diagnostic?.finishReason ?? "provider_disconnected",
              );
              return result.messages;
            });
          }
        }
        scheduleRetry();
      }
    } finally {
      if (activeConnectionController === connectionController) activeConnectionController = null;
    }
  };

  void connect();
  watchdogTimer = setInterval(() => {
    useSessionActivityStore.getState().refreshStalledStatuses();
    if (disposed || controller.signal.aborted || retryTimer) return;
    const active = activeConnectionController;
    if (!active || active.signal.aborted) return;
    if (Date.now() - lastEventAt < staleStreamMs) return;
    active.abort();
    scheduleRetry();
  }, 10_000);

  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    activeConnectionController?.abort();
    controller.abort();
  };
}

export function ensureWorkspaceSessionSync(input: SyncOptions) {
  const key = syncKey(input);
  const existing = syncs.get(key);
  if (existing) {
    if (existing.disposeTimer) {
      clearTimeout(existing.disposeTimer);
      existing.disposeTimer = null;
    }
    if (input.onSessionCreated) existing.sessionCreatedListeners.add(input.onSessionCreated);
    if (input.onSessionUpdated) existing.sessionUpdatedListeners.add(input.onSessionUpdated);
    if (input.onSessionDeleted) existing.sessionDeletedListeners.add(input.onSessionDeleted);
    if (input.onSessionStatus) existing.sessionStatusListeners.add(input.onSessionStatus);
    if (input.interactionClient) existing.input.interactionClient = input.interactionClient;
    existing.refs += 1;
    return () => releaseWorkspaceSessionSync(input);
  }

  syncs.set(key, {
    input,
    refs: 1,
    dispose: () => {},
    disposeTimer: null,
    trackedSessionRefs: new Map(),
    retainedSessionTimers: new Map(),
    sessionCreatedListeners: new Set(input.onSessionCreated ? [input.onSessionCreated] : []),
    sessionUpdatedListeners: new Set(input.onSessionUpdated ? [input.onSessionUpdated] : []),
    sessionDeletedListeners: new Set(input.onSessionDeleted ? [input.onSessionDeleted] : []),
    sessionStatusListeners: new Set(input.onSessionStatus ? [input.onSessionStatus] : []),
    pendingDeltas: new Map(),
    deltaFlushBuffer: [],
    deltaFlushScheduled: false,
  });

  const created = syncs.get(key)!;
  created.dispose = startSync(input);

  return () => releaseWorkspaceSessionSync(input);
}

function releaseWorkspaceSessionSync(input: SyncOptions) {
  const key = syncKey(input);
  const existing = syncs.get(key);
  if (!existing) return;
  if (input.onSessionCreated) existing.sessionCreatedListeners.delete(input.onSessionCreated);
  if (input.onSessionUpdated) existing.sessionUpdatedListeners.delete(input.onSessionUpdated);
  if (input.onSessionDeleted) existing.sessionDeletedListeners.delete(input.onSessionDeleted);
  if (input.onSessionStatus) existing.sessionStatusListeners.delete(input.onSessionStatus);
  existing.refs -= 1;
  if (existing.refs > 0) return;
  if (existing.retainedSessionTimers.size === 0) {
    disposeWorkspaceSync(key, existing);
  }
}

export function seedSessionState(
  workspaceId: string,
  snapshot: JuggleWorkSessionSnapshot,
  options?: { snapshotTodoRevision?: number; skipTodos?: boolean },
) {
  const queryClient = getReactQueryClient();
  const key = transcriptKey(workspaceId, snapshot.session.id);
  const incomingSnapshotMessages = snapshotToUIMessages(snapshot);
  const completion = snapshot.status.type === "idle"
    ? reconcileRunCompletionDiagnostic(incomingSnapshotMessages, snapshot.todos)
    : { messages: incomingSnapshotMessages, diagnostic: null };
  const incoming = completion.messages;
  const existing = queryClient.getQueryData<UIMessage[]>(key);

  const activityStore = useSessionActivityStore.getState();
  activityStore.seedSessionRun(
    workspaceId,
    snapshot.session.id,
    snapshot.status,
    assistantOutputAfterLatestUser(incoming),
  );
  const snapshotRetry = latestActiveSnapshotRetry(snapshot);
  if (snapshotRetry && snapshot.status.type !== "retry") {
    activityStore.setProviderRetry(workspaceId, snapshot.session.id, snapshotRetry);
  }
  activityStore.setCompletionDiagnostic(
    workspaceId,
    snapshot.session.id,
    Boolean(completion.diagnostic),
    completion.diagnostic?.finishReason ?? null,
  );

  // The snapshot's revert cursor is authoritative: messages at/after it are
  // reverted server-side, so the cache must not keep them alive (a later
  // merge would resurrect them once the server deletes them on next prompt).
  queryClient.setQueryData(key, applyRevertCursor(
    reconcileTranscriptMessages({
      currentMessages: existing ?? [],
      snapshotMessages: incoming,
      reason: "snapshot",
    }),
    snapshot.session.revert?.messageID ?? null,
  ));

  queryClient.setQueryData(statusKey(workspaceId, snapshot.session.id), snapshot.status);
  const snapshotTodoRevision = options?.snapshotTodoRevision ?? todoRevision;
  const latestLiveTodoRevision = liveTodoRevision.get(todoRevisionKey(workspaceId, snapshot.session.id)) ?? 0;
  if (!options?.skipTodos && latestLiveTodoRevision <= snapshotTodoRevision) {
    queryClient.setQueryData(todoKey(workspaceId, snapshot.session.id), snapshot.todos);
  }
}

/**
 * Apply a server-confirmed revert to the local session caches.
 *
 * `session.revert` only reaches the renderer through the snapshot cache, so
 * after a successful `session.revert` call this stamps the returned revert
 * cursor into the cached snapshot, truncates the live transcript cache, and
 * refetches the snapshot to pick up the server's post-revert truth. Without
 * this the UI keeps rendering the old transcript until a full reload.
 */
export function applySessionRevert(workspaceId: string, session: Session) {
  const queryClient = getReactQueryClient();
  const revertMessageId = session.revert?.messageID ?? null;

  queryClient.setQueryData<JuggleWorkSessionSnapshot>(
    snapshotKey(workspaceId, session.id),
    (current) => (current ? { ...current, session: { ...current.session, revert: session.revert } } : current),
  );
  queryClient.setQueryData<UIMessage[]>(
    transcriptKey(workspaceId, session.id),
    (current = []) => applyRevertCursor(current, revertMessageId),
  );
  void queryClient.invalidateQueries({ queryKey: snapshotKey(workspaceId, session.id) });
}

export function trackWorkspaceSessionSync(input: SyncOptions, sessionId: string | null | undefined) {
  const normalizedSessionId = sessionId?.trim() ?? "";
  if (!normalizedSessionId) return () => {};

  const entry = syncs.get(syncKey(input));
  if (!entry) return () => {};

  const retainedTimer = entry.retainedSessionTimers.get(normalizedSessionId);
  if (retainedTimer) {
    clearTimeout(retainedTimer);
    entry.retainedSessionTimers.delete(normalizedSessionId);
  }

  entry.trackedSessionRefs.set(
    normalizedSessionId,
    (entry.trackedSessionRefs.get(normalizedSessionId) ?? 0) + 1,
  );

  return () => {
    const current = entry.trackedSessionRefs.get(normalizedSessionId) ?? 0;
    if (current <= 1) {
      entry.trackedSessionRefs.delete(normalizedSessionId);
      retainSession(input, entry, normalizedSessionId);
      return;
    }
    entry.trackedSessionRefs.set(normalizedSessionId, current - 1);
  };
}

export function trackWorkspaceSessionsSync(input: SyncOptions, sessionIds: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const releases = sessionIds.flatMap((sessionId) => {
    const id = sessionId?.trim() ?? "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [trackWorkspaceSessionSync(input, id)];
  });
  return () => {
    for (const release of releases) release();
  };
}

export function __createWorkspaceSessionSyncForTest(input: SyncOptions) {
  const key = syncKey(input);
  syncs.set(key, {
    input,
    refs: 1,
    dispose: () => {},
    disposeTimer: null,
    trackedSessionRefs: new Map(),
    retainedSessionTimers: new Map(),
    sessionCreatedListeners: new Set(input.onSessionCreated ? [input.onSessionCreated] : []),
    sessionUpdatedListeners: new Set(),
    sessionDeletedListeners: new Set(input.onSessionDeleted ? [input.onSessionDeleted] : []),
    sessionStatusListeners: new Set(),
    pendingDeltas: new Map(),
    deltaFlushBuffer: [],
    deltaFlushScheduled: false,
  });
  return () => {
    const entry = syncs.get(key);
    if (entry) {
      for (const timer of entry.retainedSessionTimers.values()) clearTimeout(timer);
    }
    syncs.delete(key);
  };
}

export function __hasWorkspaceSessionSyncForTest(input: SyncOptions) {
  return syncs.has(syncKey(input));
}

export function __disposeWorkspaceSessionSyncForTest(input: SyncOptions) {
  const key = syncKey(input);
  const entry = syncs.get(key);
  if (!entry) return;
  entry.refs = 0;
  disposeWorkspaceSync(key, entry);
}

export function __applySessionSyncEventForTest(input: SyncOptions, event: OpencodeEvent) {
  const entry = syncs.get(syncKey(input));
  if (!entry) return;
  applyEvent(entry, input.workspaceId, event);
}
