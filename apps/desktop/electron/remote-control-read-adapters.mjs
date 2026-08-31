import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";
import {
  desktopRemoteOperationResultSchema,
} from "../dist/runtime/desktop-remote-control.js";

import {
  REMOTE_CONTROL_DESCENDANT_PAYLOAD_VERSION,
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
const jsonValueSchema = z.json();

const timeSchema = z.object({
  created: z.number().finite().nonnegative().optional(),
  updated: z.number().finite().nonnegative().optional(),
  completed: z.number().finite().nonnegative().optional(),
}).passthrough();
const sessionSchema = z.object({
  id: identifierSchema,
  title: z.string().nullish(),
  slug: z.string().nullish(),
  directory: z.string(),
  time: timeSchema.optional(),
}).passthrough();
const sessionListResponseSchema = z.object({ items: z.array(sessionSchema).max(MAX_SESSION_LIST_ITEMS) }).strict();
const sessionResponseSchema = z.object({ item: sessionSchema }).strict();
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
const statusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }).passthrough(),
  z.object({ type: z.literal("busy") }).passthrough(),
  z.object({ type: z.literal("retry") }).passthrough(),
]);
const statusesResponseSchema = z.record(z.string(), statusSchema);
const snapshotResponseSchema = z.object({
  item: z.object({
    session: sessionSchema,
    messages: z.array(messageSchema).max(SNAPSHOT_MESSAGE_LIMIT),
    todos: z.array(todoSchema).max(10_000),
    status: statusSchema,
  }).strict(),
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

/** @param {unknown} value */
function safeJson(value) {
  return jsonValueSchema.safeParse(value).success ? value : null;
}

/** @param {unknown} status */
function sessionStatus(status) {
  if (status && typeof status === "object" && "type" in status && status.type === "busy") return "running";
  if (status && typeof status === "object" && "type" in status && status.type === "retry") return "retrying";
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

/** @param {z.infer<typeof sessionSchema>} session @param {LocalWorkspace} workspace @param {unknown} status */
function sessionSummary(session, workspace, status = null) {
  if (canonicalPath(session.directory) !== workspace.path) throw new RemoteControlOperationExecutionError("session_not_found");
  const title = safeRemoteText((session.title || session.slug || "Untitled session").trim(), 1_000) || "Untitled session";
  return {
    id: session.id,
    workspaceId: workspace.id,
    title,
    status: sessionStatus(status),
    createdAt: normalizeRemoteTimestamp(session.time?.created),
    updatedAt: normalizeRemoteTimestamp(session.time?.updated ?? session.time?.created),
    activeRunId: null,
  };
}

/** @param {ManagedRuntimeClient} client @param {string} workspaceId @param {string} sessionId */
async function readSession(client, workspaceId, sessionId) {
  try {
    return sessionResponseSchema.parse(await client.getJson(`/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`)).item;
  } catch (error) {
    mapClientError(error, "session_not_found");
  }
}

/** @param {ManagedRuntimeClient} client @param {LocalWorkspace} workspace @param {string} sessionId */
async function verifyRemoteSessionRoot(client, workspace, sessionId) {
  let response;
  try {
    response = await client.getJson(`/workspace/${encodeURIComponent(workspace.id)}/sessions?limit=${MAX_SESSION_LIST_ITEMS}`);
  } catch {
    throw new RemoteControlOperationExecutionError("snapshot_required");
  }
  if (!response || typeof response !== "object") throw new RemoteControlOperationExecutionError("snapshot_required");
  const record = /** @type {Record<string, unknown>} */ (response);
  if (!Array.isArray(record.items) || record.incomplete === true || record.truncated === true ||
      record.nextCursor !== undefined || record.items.length >= MAX_SESSION_LIST_ITEMS) {
    throw new RemoteControlOperationExecutionError("snapshot_required");
  }
  /** @type {Map<string, string | null>} */
  const parents = new Map();
  for (const raw of record.items) {
    const parsed = sessionSchema.safeParse(raw);
    if (!parsed.success || parents.has(parsed.data.id) ||
        !(parsed.data.parentID === undefined || parsed.data.parentID === null || identifierSchema.safeParse(parsed.data.parentID).success)) {
      throw new RemoteControlOperationExecutionError("snapshot_required");
    }
    parents.set(parsed.data.id, typeof parsed.data.parentID === "string" ? parsed.data.parentID : null);
  }
  if (!parents.has(sessionId)) throw new RemoteControlOperationExecutionError("snapshot_required");
  const visited = new Set();
  let current = sessionId;
  while (true) {
    if (visited.has(current)) throw new RemoteControlOperationExecutionError("snapshot_required");
    visited.add(current);
    const parent = parents.get(current);
    if (parent === undefined) throw new RemoteControlOperationExecutionError("snapshot_required");
    if (parent === null) break;
    current = parent;
  }
  if (current !== sessionId) throw new RemoteControlOperationExecutionError("snapshot_required");
}

/**
 * Creates the authority check used before the agent establishes an immutable
 * remote-session binding.
 * @param {{ workspaceStore: { readWorkspaceState(): Promise<unknown> }, managedRuntimeClient: ManagedRuntimeClient }} options
 */
export function createRemoteSessionRootVerifier({ workspaceStore, managedRuntimeClient }) {
  if (!workspaceStore || typeof workspaceStore.readWorkspaceState !== "function" ||
      !managedRuntimeClient || typeof managedRuntimeClient.getJson !== "function") {
    throw new TypeError("Remote session root verifier dependencies are invalid.");
  }
  return async ({ workspaceId, rootSessionId }) => {
    try {
      const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, workspaceId);
      await verifyRemoteSessionRoot(managedRuntimeClient, workspace, rootSessionId);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Builds concrete read registrations. Local registry membership and exact
 * canonical directory equality are checked before transcript content is read.
 *
 * @param {{
 *   workspaceStore: { readWorkspaceState(): Promise<unknown> },
 *   managedRuntimeClient: ManagedRuntimeClient,
 *   now?: () => number,
 *   interactions?: { listPending(input: { workspaceId: string, sessionId: string, payloadVersion: 1 | 2 }): unknown | Promise<unknown> } | null,
 * }} options
 */
export function createRemoteControlReadRegistrations({ workspaceStore, managedRuntimeClient, now = Date.now, interactions = null }) {
  if (!workspaceStore || typeof workspaceStore.readWorkspaceState !== "function" || !managedRuntimeClient || typeof managedRuntimeClient.getJson !== "function" || typeof now !== "function") {
    throw new TypeError("Remote read adapter dependencies are invalid.");
  }

  const registration = (operation, validateArguments, execute, payloadVersions = [REMOTE_CONTROL_OPERATION_PAYLOAD_VERSION]) => ({
    operation,
    payloadVersions,
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
      let statuses;
      try {
        [response, statuses] = await Promise.all([
          managedRuntimeClient.getJson(`/workspace/${encodeURIComponent(workspace.id)}/sessions?limit=${MAX_SESSION_LIST_ITEMS}`).then((value) => sessionListResponseSchema.parse(value)),
          managedRuntimeClient.getJson(`/workspace/${encodeURIComponent(workspace.id)}/opencode/session/status`).then((value) => statusesResponseSchema.parse(value)),
        ]);
      } catch (error) {
        mapClientError(error, "workspace_not_found");
      }
      const result = { sessions: response.items.filter((session) => !session.parentID).map((session) => sessionSummary(session, workspace, statuses[session.id])) };
      return desktopRemoteOperationResultSchema.parse({ operation: "session.list", payloadVersion: 1, result }).result;
    }),
    registration("session.snapshot", (value, payloadVersion) => {
      const keys = payloadVersion === REMOTE_CONTROL_DESCENDANT_PAYLOAD_VERSION
        ? ["workspaceId", "rootSessionId"]
        : ["workspaceId", "sessionId"];
      const parsed = parseArguments(value, keys);
      return Object.freeze({ workspaceId: parsed.workspaceId, sessionId: payloadVersion === 2 ? parsed.rootSessionId : parsed.sessionId });
    }, async ({ arguments: args, context, payloadVersion }) => {
      const boundRootSessionId = context?.remoteSessionBinding?.rootSessionId;
      if (!identifierSchema.safeParse(boundRootSessionId).success || boundRootSessionId !== args.sessionId) {
        throw new RemoteControlOperationExecutionError("snapshot_required");
      }
      const workspace = await authorizedWorkspace(workspaceStore, managedRuntimeClient, args.workspaceId);
      if (context?.remoteSessionBinding?.rootVerified !== true) {
        await verifyRemoteSessionRoot(managedRuntimeClient, workspace, args.sessionId);
      }
      const session = await readSession(managedRuntimeClient, workspace.id, args.sessionId);
      if (session.id !== args.sessionId) throw new RemoteControlOperationExecutionError("session_not_found");
      const summary = sessionSummary(session, workspace);

      let response;
      try {
        response = snapshotResponseSchema.parse(await managedRuntimeClient.getJson(`/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(args.sessionId)}/snapshot?limit=${SNAPSHOT_MESSAGE_LIMIT}`));
      } catch (error) {
        mapClientError(error, "session_not_found");
      }
      if (response.item.session.id !== args.sessionId || canonicalPath(response.item.session.directory) !== workspace.path) {
        throw new RemoteControlOperationExecutionError("session_not_found");
      }

      const contextGates = context && typeof context === "object" && context.featureGates && typeof context.featureGates === "object"
        ? context.featureGates
        : {};
      let pendingInteractions = [];
      let pendingOperations = [];
      if (interactions && contextGates.interactions === true) {
        try {
          const rawInteractions = await interactions.listPending({
            workspaceId: workspace.id,
            sessionId: args.sessionId,
            payloadVersion,
          });
          pendingInteractions = Array.isArray(rawInteractions) ? rawInteractions : [];
        } catch (error) {
          if (error && typeof error === "object" && error.code === "snapshot_required") {
            throw new RemoteControlOperationExecutionError("snapshot_required");
          }
          throw error;
        }
      }
      const pending = await managedRuntimeClient.getJson(`/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(args.sessionId)}/pending`);
      const pendingRecord = /** @type {Record<string, unknown>} */ (pending);
      if (!pending || typeof pending !== "object" || !Array.isArray(pendingRecord.items)) throw new RemoteControlOperationExecutionError("internal_error");
      pendingOperations = pendingRecord.items;
      const captured = new Date(now());
      if (!Number.isFinite(captured.getTime())) throw new RemoteControlOperationExecutionError("internal_error");
      const result = {
        schemaVersion: 1,
        workspace: workspaceSummary(workspace),
        session: { ...summary, status: sessionStatus(response.item.status) },
        messages: boundedTranscript(response.item.messages.flatMap((message) => {
          const normalized = normalizeRemoteMessage(message, args.sessionId);
          return normalized ? [normalized] : [];
        })),
        todos: response.item.todos.flatMap((todo, index) => {
          const normalized = normalizeRemoteTodo(todo, args.sessionId, index);
          return normalized ? [normalized] : [];
        }),
        interactions: pendingInteractions,
        pendingOperations,
        capturedAt: captured.toISOString(),
      };
      return desktopRemoteOperationResultSchema.parse({ operation: "session.snapshot", payloadVersion, result }).result;
    }, [REMOTE_CONTROL_OPERATION_PAYLOAD_VERSION, REMOTE_CONTROL_DESCENDANT_PAYLOAD_VERSION]),
  ];
}
