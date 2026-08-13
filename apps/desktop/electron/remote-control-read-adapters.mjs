import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";
import {
  desktopRemoteOperationResultSchema,
} from "../dist/runtime/desktop-remote-control.js";

import {
  REMOTE_CONTROL_OPERATION_PAYLOAD_VERSION,
  REMOTE_CONTROL_REQUIRED_GATES,
  RemoteControlOperationExecutionError,
} from "./remote-control-operations.mjs";
import { ManagedRuntimeClientError } from "./managed-runtime-client.mjs";

const MAX_SESSION_LIST_ITEMS = 10_000;
const SNAPSHOT_MESSAGE_LIMIT = 200;
const SNAPSHOT_TRANSCRIPT_BUDGET_BYTES = 512 * 1024;
const SNAPSHOT_PART_TEXT_LIMIT = 128 * 1024;
const ISO_EPOCH = new Date(0).toISOString();
const identifierSchema = z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const timeSchema = z.object({
  created: z.number().finite().nonnegative().optional(),
  updated: z.number().finite().nonnegative().optional(),
  completed: z.number().finite().nonnegative().optional(),
}).passthrough();

const messageInfoSchema = z.object({
  id: identifierSchema,
  sessionID: identifierSchema,
  role: z.string(),
  time: timeSchema.optional(),
}).passthrough();
const partSchema = z.object({
  id: identifierSchema,
  messageID: identifierSchema,
  sessionID: identifierSchema,
  type: z.string(),
}).passthrough();
const messageSchema = z.object({ info: messageInfoSchema, parts: z.array(partSchema).max(10_000) }).passthrough();
const todoSchema = z.object({ content: z.string(), status: z.string(), priority: z.string() }).passthrough();
const canonicalSessionStatusSchema = z.object({ type: z.string() }).passthrough();
const canonicalSessionSchema = z.object({
  id: identifierSchema,
  workspaceId: identifierSchema,
  runtimeId: identifierSchema,
  title: z.string(),
  canonicalCwd: z.string(),
  status: canonicalSessionStatusSchema,
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
}).passthrough();
const canonicalPartSchema = z.object({
  id: identifierSchema,
  messageId: identifierSchema,
  sessionId: identifierSchema,
  type: z.string(),
}).passthrough();
const canonicalMessageSchema = z.object({
  id: identifierSchema,
  sessionId: identifierSchema,
  role: z.enum(["user", "assistant", "system"]),
  createdAt: z.number().finite().nonnegative(),
  completedAt: z.number().finite().nonnegative().nullable(),
  parts: z.array(canonicalPartSchema).max(10_000),
}).passthrough();
const canonicalTodoSchema = z.object({
  id: identifierSchema,
  content: z.string(),
  status: z.string(),
  priority: z.string(),
}).passthrough();
const canonicalInteractionSchema = z.object({
  id: identifierSchema,
  sessionId: identifierSchema,
  runId: identifierSchema,
  kind: z.enum(["permission", "question", "input"]),
  state: z.enum(["pending", "resolved", "timed_out", "cancelled"]),
  title: z.string(),
  description: z.string().optional(),
  questions: z.array(z.object({
    id: identifierSchema,
    prompt: z.string(),
    options: z.array(z.string()).max(100).optional(),
    multiple: z.boolean(),
  }).passthrough()).max(100).optional(),
  requestedAt: z.number().finite().nonnegative(),
  deadlineAt: z.number().finite().nonnegative().nullable(),
}).passthrough();
const canonicalSessionListResponseSchema = z.object({ items: z.array(canonicalSessionSchema).max(MAX_SESSION_LIST_ITEMS) }).strict();
const canonicalSessionResponseSchema = z.object({ session: canonicalSessionSchema }).strict();
const canonicalSnapshotResponseSchema = z.object({
  snapshot: z.object({
    session: canonicalSessionSchema,
    messages: z.array(canonicalMessageSchema).max(SNAPSHOT_MESSAGE_LIMIT),
    todos: z.array(canonicalTodoSchema).max(10_000),
    interactions: z.array(canonicalInteractionSchema).max(10_000),
  }).passthrough(),
}).strict();

/** @typedef {{ id: string, name?: unknown, displayName?: unknown, path: string, workspaceType?: unknown }} LocalWorkspace */
/** @typedef {{ getJson(pathname: string): Promise<unknown> }} ManagedRuntimeClient */

/** @param {unknown} value */
function parseArguments(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length) {
    throw new TypeError("Remote read arguments are invalid.");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key) || !identifierSchema.safeParse(value[key]).success) {
      throw new TypeError("Remote read arguments are invalid.");
    }
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, String(value[key])] )));
}

/** @param {unknown} value */
function canonicalPath(value) {
  const input = typeof value === "string" ? value.trim() : "";
  return input ? path.resolve(input).replace(/\\/g, "/").replace(/\/+$/, "") || "/" : "";
}

/** @param {number | undefined} value */
export function normalizeRemoteTimestamp(value) {
  const date = new Date(Number(value));
  return Number.isFinite(value) && Number.isFinite(date.getTime()) ? date.toISOString() : ISO_EPOCH;
}

/** @param {unknown} value @param {number} max */
function boundedText(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * Transcript text is user-visible content, but remote snapshots must not carry
 * machine-local paths or credential values accidentally echoed by tools/models.
 * Preserve surrounding prose while replacing only recognizable sensitive
 * substrings. Tool input/output is omitted separately below.
 * @param {unknown} value
 * @param {number} max
 */
function safeRemoteText(value, max) {
  return boundedText(value, max)
    .replace(/\bBearer\b(?:\s+(?!\[REDACTED\])[^\s"'`,;\]}]+){1,4}/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:authorization|token|access[_-]?token|client[_-]?token|api[_-]?key|password|secret)["']?\s*:\s*)["'][^"']*["']/gi, "$1\"[REDACTED]\"")
    .replace(/((?:authorization|token|access[_-]?token|client[_-]?token|api[_-]?key|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(?:\/Users\/|\/home\/)[^\s"'`<>]+/g, "[LOCAL_PATH]")
    .replace(/[A-Za-z]:\\Users\\[^\s"'`<>]+/g, "[LOCAL_PATH]");
}

/** @param {unknown} status */
function sessionStatus(status) {
  const type = status && typeof status === "object" && "type" in status && typeof status.type === "string" ? status.type : "idle";
  if (["busy", "starting", "running"].includes(type)) return "running";
  if (["retry", "retrying"].includes(type)) return "retrying";
  if (type === "waiting") return "waiting";
  if (type === "aborting") return "aborting";
  if (["unavailable", "interrupted"].includes(type)) return "failed";
  return "idle";
}

/** @param {unknown} error @param {"workspace_not_found" | "session_not_found"} notFoundCode */
function mapClientError(error, notFoundCode) {
  if (error instanceof RemoteControlOperationExecutionError) throw error;
  if (error instanceof ManagedRuntimeClientError && error.code === "http_error" && error.status === 404) {
    throw new RemoteControlOperationExecutionError(notFoundCode);
  }
  throw new RemoteControlOperationExecutionError("internal_error");
}

/** Snapshot pending-operation metadata is optional for read-only history. */
async function readPendingOperations(client, workspaceId, sessionId) {
  try {
    const pending = await client.getJson(`/workspace/${encodeURIComponent(workspaceId)}/agent/v1/sessions/${encodeURIComponent(sessionId)}/pending`);
    const record = /** @type {Record<string, unknown>} */ (pending);
    return pending && typeof pending === "object" && Array.isArray(record.items) ? record.items : [];
  } catch {
    return [];
  }
}

/** @param {z.infer<typeof canonicalPartSchema>} part */
function normalizeCanonicalRemotePart(part) {
  if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
    if (part.type === "reasoning" && part.visibility === "hidden") return null;
    return { type: part.type, id: part.id, text: safeRemoteText(part.text, SNAPSHOT_PART_TEXT_LIMIT) };
  }
  if (part.type !== "tool" || typeof part.toolName !== "string" || !identifierSchema.safeParse(part.toolName).success) return null;
  const metadata = part.metadata && typeof part.metadata === "object" ? /** @type {Record<string, unknown>} */ (part.metadata) : null;
  const title = metadata && typeof metadata.title === "string" ? safeRemoteText(metadata.title.trim(), 500) || null : null;
  return {
    type: "tool",
    id: part.id,
    name: part.toolName,
    title,
    status: part.state === "running" ? "running" : part.state === "completed" ? "completed" : part.state === "error" || part.state === "cancelled" ? "failed" : "pending",
    input: null,
    output: null,
  };
}

/** @param {z.infer<typeof canonicalMessageSchema>} message @param {string} sessionId */
export function normalizeCanonicalRemoteMessage(message, sessionId) {
  if (message.sessionId !== sessionId) return null;
  const parts = message.parts.flatMap((part) => {
    if (part.sessionId !== sessionId || part.messageId !== message.id) return [];
    const normalized = normalizeCanonicalRemotePart(part);
    return normalized ? [normalized] : [];
  });
  if (parts.length === 0) return null;
  return {
    id: message.id,
    role: message.role,
    createdAt: normalizeRemoteTimestamp(message.createdAt),
    completedAt: message.completedAt === null ? null : normalizeRemoteTimestamp(message.completedAt),
    parts,
  };
}

/** @param {z.infer<typeof canonicalInteractionSchema>} interaction @param {string} sessionId */
export function normalizeCanonicalRemoteInteraction(interaction, sessionId) {
  if (interaction.sessionId !== sessionId || interaction.state !== "pending") return null;
  const base = {
    id: interaction.id,
    sessionId,
    runId: interaction.runId,
    status: "pending",
    title: safeRemoteText(interaction.title.trim(), 500) || "Interaction",
    resolution: null,
    createdAt: normalizeRemoteTimestamp(interaction.requestedAt),
    expiresAt: interaction.deadlineAt === null ? null : normalizeRemoteTimestamp(interaction.deadlineAt),
  };
  if (interaction.kind === "permission") {
    return {
      ...base,
      type: "permission",
      description: safeRemoteText(interaction.description ?? interaction.title, 2_000),
      permittedResponses: ["allow_once", "reject"],
    };
  }
  if (interaction.kind !== "question" || !interaction.questions?.length) return null;
  return {
    ...base,
    type: "question",
    questions: interaction.questions.map((question) => ({
      id: question.id,
      prompt: safeRemoteText(question.prompt.trim(), 5_000),
      multiple: question.multiple,
      options: (question.options ?? []).map((option) => safeRemoteText(option.trim(), 1_000)).filter(Boolean),
    })),
  };
}

/** @param {unknown} state */
function toolStatus(state) {
  if (!state || typeof state !== "object" || !("status" in state)) return "pending";
  if (state.status === "running") return "running";
  if (state.status === "completed") return "completed";
  if (state.status === "error") return "failed";
  return "pending";
}

/** @param {z.infer<typeof partSchema>} part */
export function normalizeRemoteMessagePart(part) {
  if (part.synthetic === true || part.ignored === true) return null;
  if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
    return { type: part.type, id: part.id, text: safeRemoteText(part.text, SNAPSHOT_PART_TEXT_LIMIT) };
  }
  if (part.type !== "tool" || typeof part.tool !== "string" || !identifierSchema.safeParse(part.tool).success) return null;
  /** @type {Record<string, unknown>} */
  const state = part.state && typeof part.state === "object" ? /** @type {Record<string, unknown>} */ (part.state) : {};
  /** @type {Record<string, unknown>} */
  const metadata = state.metadata && typeof state.metadata === "object" ? /** @type {Record<string, unknown>} */ (state.metadata) : {};
  const title = typeof state.title === "string" ? state.title : typeof metadata.title === "string" ? metadata.title : null;
  return {
    type: "tool",
    id: part.id,
    name: part.tool,
    title: title === null ? null : safeRemoteText(title.trim(), 500) || null,
    status: toolStatus(state),
    // Tool payloads routinely contain paths, environment values, command
    // output, and provider credentials. Phase 1 exposes only semantic tool
    // identity/status/title; payload expansion requires a later explicit spec.
    input: null,
    output: null,
  };
}

/** @param {z.infer<typeof messageSchema>} message @param {string} sessionId */
export function normalizeRemoteMessage(message, sessionId) {
  if (message.info.sessionID !== sessionId || !["user", "assistant", "system", "tool"].includes(message.info.role)) return null;
  const parts = message.parts.flatMap((part) => {
    if (part.sessionID !== sessionId || part.messageID !== message.info.id) return [];
    const normalized = normalizeRemoteMessagePart(part);
    return normalized ? [normalized] : [];
  });
  if (parts.length === 0) return null;
  return {
    id: message.info.id,
    role: message.info.role,
    createdAt: normalizeRemoteTimestamp(message.info.time?.created),
    completedAt: Number.isFinite(message.info.time?.completed) ? normalizeRemoteTimestamp(message.info.time?.completed) : null,
    parts,
  };
}

/**
 * Keep the newest complete normalized messages that fit the transport budget.
 * One huge local transcript can therefore never tear down the 1 MiB WSS
 * channel. Older transcript pagination is a later payload version.
 * @param {unknown[]} messages
 */
function boundedTranscript(messages) {
  const selected = [];
  let bytes = 2;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const encoded = Buffer.byteLength(JSON.stringify(message), "utf8") + (selected.length ? 1 : 0);
    if (encoded > SNAPSHOT_TRANSCRIPT_BUDGET_BYTES) continue;
    if (bytes + encoded > SNAPSHOT_TRANSCRIPT_BUDGET_BYTES) break;
    selected.unshift(message);
    bytes += encoded;
  }
  return selected;
}

/** @param {z.infer<typeof todoSchema>} todo @param {string} sessionId @param {number} index */
export function normalizeRemoteTodo(todo, sessionId, index) {
  const content = boundedText(todo.content.trim(), 10_000);
  if (!content) return null;
  const digest = createHash("sha256").update(`${sessionId}\u0000${index}\u0000${content}`).digest("hex").slice(0, 24);
  return {
    id: `todo_${digest}`,
    content: safeRemoteText(content, 10_000),
    status: ["pending", "in_progress", "completed", "cancelled"].includes(todo.status) ? todo.status : "pending",
    priority: ["low", "medium", "high"].includes(todo.priority) ? todo.priority : "medium",
  };
}

/**
 * @param {{ readWorkspaceState(): Promise<unknown> }} workspaceStore
 * @returns {Promise<LocalWorkspace[]>}
 */
async function localWorkspaces(workspaceStore) {
  const state = await workspaceStore.readWorkspaceState();
  const entries = state && typeof state === "object" && "workspaces" in state && Array.isArray(state.workspaces) ? state.workspaces : [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || entry.workspaceType === "remote") return [];
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const workspacePath = canonicalPath(entry.path);
    return identifierSchema.safeParse(id).success && workspacePath ? [{ ...entry, id, path: workspacePath }] : [];
  });
}

/**
 * @param {{ readWorkspaceState(): Promise<unknown> }} workspaceStore
 * @param {ManagedRuntimeClient} client
 * @param {string} workspaceId
 * @returns {Promise<LocalWorkspace>}
 */
async function authorizedWorkspace(workspaceStore, client, workspaceId) {
  // First try the managed server (authoritative), then fall back to the local
  // workspace store for canonical-path verification.
  try {
    const response = await client.getJson(`/workspaces`);
    if (response && typeof response === "object" && Array.isArray(/** @type {Record<string, unknown>} */ (response).items)) {
      const found = /** @type {Record<string, unknown>[]} */ (/** @type {Record<string, unknown>} */ (response).items).find(
        (/** @type {Record<string, unknown>} */ entry) =>
          entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim() === workspaceId,
      );
      if (found) {
        const workspacePath = canonicalPath(found.path || found.directory);
        return {
          id: workspaceId,
          name: typeof found.name === "string" ? found.name : (typeof found.displayName === "string" ? found.displayName : ""),
          path: workspacePath || "/",
          workspaceType: typeof found.workspaceType === "string" ? found.workspaceType : "local",
        };
      }
    }
  } catch {
    // Fall through to local store.
  }
  const workspace = (await localWorkspaces(workspaceStore)).find((entry) => entry.id === workspaceId);
  if (!workspace) throw new RemoteControlOperationExecutionError("workspace_not_found");
  return workspace;
}

/** @param {LocalWorkspace} workspace */
function workspaceSummary(workspace) {
  const requestedName = typeof workspace.displayName === "string" && workspace.displayName.trim()
    ? workspace.displayName.trim()
    : typeof workspace.name === "string" && workspace.name.trim()
      ? workspace.name.trim()
      : path.basename(workspace.path) || "Workspace";
  return { id: workspace.id, name: safeRemoteText(requestedName, 500) || "Workspace" };
}

/** @param {z.infer<typeof canonicalSessionSchema>} session @param {LocalWorkspace} workspace */
function sessionSummary(session, workspace) {
  if (session.workspaceId !== workspace.id || canonicalPath(session.canonicalCwd) !== workspace.path) throw new RemoteControlOperationExecutionError("session_not_found");
  const title = safeRemoteText((session.title || "Untitled session").trim(), 1_000) || "Untitled session";
  return {
    id: session.id,
    workspaceId: workspace.id,
    title,
    status: sessionStatus(session.status),
    createdAt: normalizeRemoteTimestamp(session.createdAt),
    updatedAt: normalizeRemoteTimestamp(session.updatedAt),
    activeRunId: null,
  };
}

/** @param {ManagedRuntimeClient} client @param {string} workspaceId @param {string} sessionId */
async function readSession(client, workspaceId, sessionId) {
  try {
    return canonicalSessionResponseSchema.parse(await client.getJson(`/workspace/${encodeURIComponent(workspaceId)}/agent/v1/sessions/${encodeURIComponent(sessionId)}`)).session;
  } catch (error) {
    mapClientError(error, "session_not_found");
  }
}

/**
 * Builds concrete read registrations. Local registry membership and exact
 * canonical directory equality are checked before transcript content is read.
 *
 * @param {{
 *   workspaceStore: { readWorkspaceState(): Promise<unknown> },
 *   managedRuntimeClient: ManagedRuntimeClient,
 *   now?: () => number,
 *   interactions?: { listPending(input: { workspaceId: string, sessionId: string }): unknown | Promise<unknown> } | null,
 * }} options
 */
export function createRemoteControlReadRegistrations({ workspaceStore, managedRuntimeClient, now = Date.now, interactions = null }) {
  if (!workspaceStore || typeof workspaceStore.readWorkspaceState !== "function" || !managedRuntimeClient || typeof managedRuntimeClient.getJson !== "function" || typeof now !== "function") {
    throw new TypeError("Remote read adapter dependencies are invalid.");
  }

  const registration = (operation, validateArguments, execute) => ({
    operation,
    payloadVersions: [REMOTE_CONTROL_OPERATION_PAYLOAD_VERSION],
    requiredGates: [...REMOTE_CONTROL_REQUIRED_GATES[operation]],
    validateArguments,
    execute,
  });

  return [
    registration("workspace.list", (value) => parseArguments(value, []), async () => {
      // The managed server is the authoritative source of active workspaces.
      // The local workspace store JSON can be stale after installs or if the
      // renderer hasn't persisted new workspaces yet. Query both and merge,
      // preferring managed server entries; filter to local-only.
      /** @type {{ id: string, name?: string, displayName?: string, path?: string, workspaceType?: string, directory?: string }[]} */
      let managedWorkspaces = [];
      try {
        const response = await managedRuntimeClient.getJson("/workspaces");
        if (response && typeof response === "object" && Array.isArray(/** @type {Record<string, unknown>} */ (response).items)) {
          managedWorkspaces = /** @type {Record<string, unknown>} */ (response).items.filter(
            (/** @type {Record<string, unknown>} */ entry) =>
              entry && typeof entry === "object" &&
              typeof entry.id === "string" && entry.id.trim() &&
              entry.workspaceType !== "remote",
          ).map((/** @type {Record<string, unknown>} */ entry) => ({
            id: String(entry.id).trim(),
            name: typeof entry.name === "string" ? entry.name : (typeof entry.displayName === "string" ? entry.displayName : ""),
            path: typeof entry.path === "string" ? entry.path : (typeof entry.directory === "string" ? entry.directory : ""),
            workspaceType: typeof entry.workspaceType === "string" ? entry.workspaceType : "local",
          }));
        }
      } catch (error) {
        if (error instanceof RemoteControlOperationExecutionError) throw error;
      }
      // Fall back to local workspace store if managed server returns nothing.
      const source = managedWorkspaces.length > 0 ? managedWorkspaces : (await localWorkspaces(workspaceStore)).map((w) => ({ id: w.id, name: typeof w.name === "string" ? w.name : "", path: w.path, workspaceType: "local" }));
      const result = { workspaces: source.map((w) => ({ id: w.id, name: safeRemoteText(w.name || path.basename(w.path || "") || "Workspace", 500) || "Workspace" })) };
      return desktopRemoteOperationResultSchema.parse({ operation: "workspace.list", payloadVersion: 1, result }).result;
    }),
    registration("session.list", (value) => parseArguments(value, ["workspaceId"]), async ({ arguments: args }) => {
      const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
      let response;
       try {
         response = canonicalSessionListResponseSchema.parse(await managedRuntimeClient.getJson(`/workspace/${encodeURIComponent(workspace.id)}/agent/v1/sessions`));
      } catch (error) {
        mapClientError(error, "workspace_not_found");
      }
       const result = { sessions: response.items.map((session) => sessionSummary(session, workspace)) };
      return desktopRemoteOperationResultSchema.parse({ operation: "session.list", payloadVersion: 1, result }).result;
    }),
    registration("session.snapshot", (value) => parseArguments(value, ["workspaceId", "sessionId"]), async ({ arguments: args, context }) => {
      const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
      const session = await readSession(managedRuntimeClient, workspace.id, args.sessionId);
      if (session.id !== args.sessionId) throw new RemoteControlOperationExecutionError("session_not_found");
      const summary = sessionSummary(session, workspace);

      let response;
      try {
         response = canonicalSnapshotResponseSchema.parse(await managedRuntimeClient.getJson(`/workspace/${encodeURIComponent(workspace.id)}/agent/v1/sessions/${encodeURIComponent(args.sessionId)}/snapshot?limit=${SNAPSHOT_MESSAGE_LIMIT}`));
      } catch (error) {
        mapClientError(error, "session_not_found");
      }
       if (response.snapshot.session.id !== args.sessionId || response.snapshot.session.workspaceId !== workspace.id || canonicalPath(response.snapshot.session.canonicalCwd) !== workspace.path) {
        throw new RemoteControlOperationExecutionError("session_not_found");
      }

      const contextGates = context && typeof context === "object" && context.featureGates && typeof context.featureGates === "object"
        ? context.featureGates
        : {};
       const pendingInteractions = contextGates.interactions === true
         ? response.snapshot.interactions.flatMap((interaction) => {
             const normalized = normalizeCanonicalRemoteInteraction(interaction, args.sessionId);
             return normalized ? [normalized] : [];
           })
         : [];
      const pendingOperations = await readPendingOperations(managedRuntimeClient, workspace.id, args.sessionId);
      const captured = new Date(now());
      if (!Number.isFinite(captured.getTime())) throw new RemoteControlOperationExecutionError("internal_error");
      const result = {
        schemaVersion: 1,
        workspace: workspaceSummary(workspace),
         session: { ...summary, status: sessionStatus(response.snapshot.session.status) },
         messages: boundedTranscript(response.snapshot.messages.flatMap((message) => {
           const normalized = normalizeCanonicalRemoteMessage(message, args.sessionId);
          return normalized ? [normalized] : [];
        })),
         todos: response.snapshot.todos.map((todo) => ({
           id: todo.id,
           content: safeRemoteText(todo.content.trim(), 10_000),
           status: ["pending", "in_progress", "completed", "cancelled"].includes(todo.status) ? todo.status : "pending",
           priority: ["low", "medium", "high"].includes(todo.priority) ? todo.priority : "medium",
         })),
        interactions: pendingInteractions,
        pendingOperations,
        capturedAt: captured.toISOString(),
      };
      return desktopRemoteOperationResultSchema.parse({ operation: "session.snapshot", payloadVersion: 1, result }).result;
    }),
  ];
}
