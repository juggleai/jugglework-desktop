/**
 * Main-process interaction store. Polls the managed server's OpenCode
 * permission/question list endpoints on-demand and projects them into the
 * shared DesktopRemoteInteraction schema for session.snapshot.
 *
 * This is a pull-based adapter, not a push-based SSE consumer. The remote
 * controller calls session.snapshot or subscribes to SSE events to see
 * interaction state. The Main process does not need a long-lived SSE
 * subscription of its own.
 */

/** @typedef {{ getJson(pathname: string): Promise<unknown> }} ManagedRuntimeClient */
/** @typedef {import("@jugglework/types/desktop-remote-control").DesktopRemoteInteraction} DesktopRemoteInteraction */
import { ManagedRuntimeClientError } from "./managed-runtime-client.mjs";

const INTERACTION_TTL_MS = 5 * 60 * 1000;
const MAX_FALLBACK_SESSIONS = 200;
const FALLBACK_CONCURRENCY = 8;

export class RemoteControlInteractionSnapshotError extends Error {
  /** @param {"snapshot_required" | "interaction_not_found"} code */
  constructor(code) {
    super("The interaction snapshot is unavailable.");
    this.name = "RemoteControlInteractionSnapshotError";
    this.code = code;
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1000;
}

/** @param {unknown} value @returns {value is string} */
function isIdentifier(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @typedef {{ rootSessionId: string, targetSessionId: string, parentSessionId: string | null }} InteractionOwnership
 */

/** @param {string} sessionId @param {InteractionOwnership | null | undefined} ownership */
function normalizedOwnership(sessionId, ownership) {
  if (!ownership || !isString(ownership.targetSessionId) || !isString(ownership.rootSessionId) ||
      !(ownership.parentSessionId === null || isString(ownership.parentSessionId))) return null;
  const targetSessionId = ownership.targetSessionId;
  const rootSessionId = ownership.rootSessionId;
  const parentSessionId = ownership.parentSessionId;
  if (targetSessionId !== sessionId) return null;
  return { rootSessionId, targetSessionId, parentSessionId };
}

/** @param {unknown} raw @param {string} sessionId @param {number} [now] @param {InteractionOwnership | null} [ownership] @param {1 | 2} [payloadVersion] */
export function normalizeRemotePermissionInteraction(raw, sessionId, now = Date.now(), ownership = null, payloadVersion = 1) {
  if (!raw || typeof raw !== "object") return null;
  const entry = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!isIdentifier(id)) return null;
  if (isString(entry.sessionID) && entry.sessionID !== sessionId) return null;
  const owner = ownership ? normalizedOwnership(sessionId, ownership)
    : payloadVersion === 1 ? { rootSessionId: sessionId, targetSessionId: sessionId, parentSessionId: null } : null;
  if (!owner) return null;
  const action = isString(entry.action) ? entry.action : isString(entry.permission) ? entry.permission : "Permission required";
  const resources = Array.isArray(entry.resources) ? entry.resources.filter(isString) : Array.isArray(entry.patterns) ? entry.patterns.filter(isString) : [];
  const description = resources.length > 0 ? `${action}: ${resources.join(", ")}`.slice(0, 2000) : action.slice(0, 2000);
  const interaction = {
    id,
    type: /** @type {"permission"} */ ("permission"),
    sessionId,
    runId: null,
    status: /** @type {"pending"} */ ("pending"),
    title: action.slice(0, 500),
    description,
    permittedResponses: [/** @type {"allow_once"} */ ("allow_once"), /** @type {"reject"} */ ("reject")],
    resolution: null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INTERACTION_TTL_MS).toISOString(),
  };
  return payloadVersion === 2 ? { ...interaction, ...owner } : interaction;
}

/** @param {unknown} raw @param {string} sessionId @param {number} [now] @param {InteractionOwnership | null} [ownership] */
export function normalizeRemoteQuestionInteraction(raw, sessionId, now = Date.now(), ownership = null, payloadVersion = 1) {
  if (!raw || typeof raw !== "object") return null;
  const entry = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!isIdentifier(id)) return null;
  if (isString(entry.sessionID) && entry.sessionID !== sessionId) return null;
  const owner = ownership ? normalizedOwnership(sessionId, ownership)
    : payloadVersion === 1 ? { rootSessionId: sessionId, targetSessionId: sessionId, parentSessionId: null } : null;
  if (!owner) return null;
  if (!Array.isArray(entry.questions) || entry.questions.length < 1 || entry.questions.length > 100) return null;
  const questions = [];
  const questionIds = new Set();
  for (const q of entry.questions) {
    if (!q || typeof q !== "object" || Array.isArray(q)) return null;
    const question = /** @type {Record<string, unknown>} */ (q);
    const prompt = typeof question.question === "string" ? question.question : typeof question.header === "string" ? question.header : "";
    if (!prompt.trim() || prompt !== prompt.trim() || prompt.length > 5000 || !Array.isArray(question.options) || question.options.length > 100 ||
        (question.multiple !== undefined && typeof question.multiple !== "boolean") ||
        (question.custom !== undefined && typeof question.custom !== "boolean")) return null;
    const options = [];
    for (const opt of question.options) {
      let label = "";
      if (typeof opt === "string") label = opt;
      if (typeof opt === "object" && opt !== null) {
        const o = /** @type {Record<string, unknown>} */ (opt);
        label = typeof o.label === "string" ? o.label : "";
      }
      if (!label.trim() || label !== label.trim() || label.length > 1000) return null;
      options.push(label);
    }
    const id = question.id === undefined ? `q_${prompt.slice(0, 32)}` : question.id;
    if (!isIdentifier(id) || questionIds.has(id)) return null;
    questionIds.add(id);
    questions.push({
      id,
      prompt,
      multiple: question.multiple === true,
      options,
    });
  }
  const interaction = {
    id,
    type: /** @type {"question"} */ ("question"),
    sessionId,
    runId: null,
    status: /** @type {"pending"} */ ("pending"),
    title: "Question",
    questions,
    resolution: null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INTERACTION_TTL_MS).toISOString(),
  };
  return payloadVersion === 2 ? { ...interaction, ...owner } : interaction;
}

/**
 * @param {{
 *   managedRuntimeClient: ManagedRuntimeClient,
 *   now?: () => number,
 * }} options
 */
export function createRemoteControlInteractionStore({ managedRuntimeClient, now = Date.now }) {
  if (!managedRuntimeClient || typeof managedRuntimeClient.getJson !== "function") {
    throw new TypeError("Interaction store requires a managed runtime client.");
  }
  if (typeof now !== "function") throw new TypeError("Interaction store requires a clock.");

  /** @type {Map<string, Map<string, { id: string, parentID: string | null }>>} */
  const sessionGraphs = new Map();

  /** @param {unknown} value @returns {unknown[] | null} */
  function responseItems(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return null;
    const record = /** @type {Record<string, unknown>} */ (value);
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.interactions)) return record.interactions;
    if (Array.isArray(record.items)) return record.items;
    if (record.item && typeof record.item === "object") return responseItems(record.item);
    const permissions = Array.isArray(record.permissions)
      ? record.permissions.map((entry) => ({ kind: "permission", entry }))
      : [];
    const questions = Array.isArray(record.questions)
      ? record.questions.map((entry) => ({ kind: "question", entry }))
      : [];
    if (Object.hasOwn(record, "permissions") || Object.hasOwn(record, "questions")) {
      return [...permissions, ...questions];
    }
    return null;
  }

  /** @param {string} workspaceId */
  async function readSessionGraph(workspaceId) {
    const response = await managedRuntimeClient.getJson(
      `/workspace/${encodeURIComponent(workspaceId)}/sessions?limit=10000`,
    );
    if (!response || typeof response !== "object" || !Array.isArray(/** @type {Record<string, unknown>} */ (response).items)) {
      throw new RemoteControlInteractionSnapshotError("snapshot_required");
    }
    const record = /** @type {Record<string, unknown>} */ (response);
    if (record.incomplete === true || record.truncated === true || record.nextCursor !== undefined) {
      throw new RemoteControlInteractionSnapshotError("snapshot_required");
    }
    const items = /** @type {unknown[]} */ (record.items);
    if (items.length >= 10_000) throw new RemoteControlInteractionSnapshotError("snapshot_required");
    /** @type {Map<string, { id: string, parentID: string | null }>} */
    const graph = new Map();
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const session = /** @type {Record<string, unknown>} */ (raw);
      if (!isString(session.id)) continue;
      if (!(session.parentID === undefined || session.parentID === null || isString(session.parentID))) {
        throw new RemoteControlInteractionSnapshotError("snapshot_required");
      }
      const parentID = isString(session.parentID) ? session.parentID : null;
      graph.set(session.id, { id: session.id, parentID });
    }
    sessionGraphs.set(workspaceId, graph);
    return graph;
  }

  /** @param {Map<string, { id: string, parentID: string | null }>} graph @param {string} targetSessionId @returns {InteractionOwnership | null} */
  function ownershipIn(graph, targetSessionId) {
    const target = graph.get(targetSessionId);
    if (!target) return null;
    const visited = new Set();
    let current = target;
    while (true) {
      if (visited.has(current.id)) return null;
      visited.add(current.id);
      if (!current.parentID) {
        return { rootSessionId: current.id, targetSessionId, parentSessionId: target.parentID };
      }
      const parent = graph.get(current.parentID);
      if (!parent) return null;
      current = parent;
    }
  }

  /** @param {{ workspaceId: string, targetSessionId: string }} input @returns {Promise<InteractionOwnership | null>} */
  async function resolveOwnership({ workspaceId, targetSessionId }) {
    if (!isString(workspaceId) || !isString(targetSessionId)) return null;
    try {
      const graph = await readSessionGraph(workspaceId);
      return ownershipIn(graph, targetSessionId);
    } catch {
      const verified = sessionGraphs.get(workspaceId);
      return verified ? ownershipIn(verified, targetSessionId) : null;
    }
  }

  /** @param {unknown} raw @param {string} requestedRootSessionId */
  function normalizeSnapshotInteraction(raw, requestedRootSessionId, payloadVersion) {
    if (!raw || typeof raw !== "object") return null;
    const envelope = /** @type {Record<string, unknown>} */ (raw);
    const nested = envelope.entry ?? envelope.interaction ?? envelope.request ?? raw;
    if (!nested || typeof nested !== "object") return null;
    const entry = /** @type {Record<string, unknown>} */ (nested);
    const targetSessionId = isString(envelope.targetSessionId) ? envelope.targetSessionId
      : isString(entry.targetSessionId) ? entry.targetSessionId
        : isString(entry.sessionID) ? entry.sessionID
          : isString(entry.sessionId) ? entry.sessionId : "";
    const rootSessionId = isString(envelope.rootSessionId) ? envelope.rootSessionId
      : isString(entry.rootSessionId) ? entry.rootSessionId : "";
    if (!targetSessionId || rootSessionId !== requestedRootSessionId ||
        (payloadVersion === 1 && targetSessionId !== requestedRootSessionId)) return null;
    /** @type {string | null} */
    const parentSessionId = isString(envelope.parentSessionId) ? envelope.parentSessionId
      : isString(entry.parentSessionId) ? entry.parentSessionId : null;
    const ownership = { rootSessionId, targetSessionId, parentSessionId };
    const kind = envelope.kind ?? envelope.type ?? entry.kind ?? entry.type;
    return kind === "permission"
      ? normalizeRemotePermissionInteraction(entry, targetSessionId, now(), ownership, payloadVersion)
      : kind === "question"
        ? normalizeRemoteQuestionInteraction(entry, targetSessionId, now(), ownership, payloadVersion)
        : null;
  }

  /** @param {string} workspaceId @param {string} targetSessionId @param {InteractionOwnership} ownership */
  async function readExactPending(workspaceId, targetSessionId, ownership, payloadVersion) {
    const [permRaw, questionRaw] = await Promise.allSettled([
      managedRuntimeClient.getJson(`/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(targetSessionId)}/permission`),
      managedRuntimeClient.getJson(`/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(targetSessionId)}/question`),
    ]);
    if (permRaw.status !== "fulfilled" || questionRaw.status !== "fulfilled") {
      throw new RemoteControlInteractionSnapshotError("snapshot_required");
    }
    const permissionItems = responseItems(permRaw.value);
    const questionItems = responseItems(questionRaw.value);
    if (permissionItems === null || questionItems === null) throw new RemoteControlInteractionSnapshotError("snapshot_required");
    const interactions = [];
    for (const item of permissionItems) {
        const normalized = normalizeRemotePermissionInteraction(item, targetSessionId, now(), ownership, payloadVersion);
        if (!normalized) throw new RemoteControlInteractionSnapshotError("snapshot_required");
        interactions.push(normalized);
    }
    for (const item of questionItems) {
        const normalized = normalizeRemoteQuestionInteraction(item, targetSessionId, now(), ownership, payloadVersion);
        if (!normalized) throw new RemoteControlInteractionSnapshotError("snapshot_required");
        interactions.push(normalized);
    }
    return interactions;
  }

  /** @param {string} workspaceId @param {string} rootSessionId */
  async function readFallback(workspaceId, rootSessionId, payloadVersion) {
    const graph = await readSessionGraph(workspaceId);
    if (ownershipIn(graph, rootSessionId)?.rootSessionId !== rootSessionId) {
      throw new RemoteControlInteractionSnapshotError("interaction_not_found");
    }
    const targets = [...graph.keys()].flatMap((targetSessionId) => {
      const ownership = ownershipIn(graph, targetSessionId);
      return ownership?.rootSessionId === rootSessionId && (payloadVersion === 2 || targetSessionId === rootSessionId)
        ? [{ targetSessionId, ownership }]
        : [];
    });
    if (targets.length > MAX_FALLBACK_SESSIONS) throw new RemoteControlInteractionSnapshotError("snapshot_required");
    const interactions = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(FALLBACK_CONCURRENCY, targets.length) }, async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++];
        if (!target) break;
        interactions.push(...await readExactPending(workspaceId, target.targetSessionId, target.ownership, payloadVersion));
      }
    }));
    if (interactions.length > 50) throw new RemoteControlInteractionSnapshotError("snapshot_required");
    return interactions;
  }

  /**
   * Lists pending permission and question interactions for a session.
   * @param {{ workspaceId: string, sessionId: string, payloadVersion?: 1 | 2 }} input
   * @returns {Promise<DesktopRemoteInteraction[]>}
   */
  async function listPending({ workspaceId, sessionId, payloadVersion = 1 }) {
    if (!isString(workspaceId) || !isString(sessionId)) return [];
    try {
      const snapshot = await managedRuntimeClient.getJson(
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/interactions/snapshot?includeDescendants=true`,
      );
      const record = snapshot && typeof snapshot === "object" ? /** @type {Record<string, unknown>} */ (snapshot) : null;
      const item = record?.item && typeof record.item === "object" ? /** @type {Record<string, unknown>} */ (record.item) : record;
      if (!item || item.incomplete === true || item.truncated === true || item.snapshotRequired === true) {
        throw new RemoteControlInteractionSnapshotError("snapshot_required");
      }
      const items = responseItems(snapshot);
      if (items !== null) {
        if (items.length > 50) throw new RemoteControlInteractionSnapshotError("snapshot_required");
        const normalized = [];
        for (const raw of items) {
          const envelope = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : null;
          const entry = envelope && (envelope.entry ?? envelope.interaction ?? envelope.request ?? raw);
          const nested = entry && typeof entry === "object" ? /** @type {Record<string, unknown>} */ (entry) : null;
          const root = envelope?.rootSessionId ?? nested?.rootSessionId;
          const target = envelope?.targetSessionId ?? nested?.targetSessionId ?? nested?.sessionID ?? nested?.sessionId;
          if (!isIdentifier(root) || !isIdentifier(target)) {
            throw new RemoteControlInteractionSnapshotError("snapshot_required");
          }
          if (root !== sessionId) continue;
          if (payloadVersion === 1 && target !== sessionId) continue;
          const interaction = normalizeSnapshotInteraction(raw, sessionId, payloadVersion);
          if (!interaction) throw new RemoteControlInteractionSnapshotError("snapshot_required");
          normalized.push(interaction);
        }
        return normalized;
      }
      throw new RemoteControlInteractionSnapshotError("snapshot_required");
    } catch (error) {
      const unsupported = error instanceof ManagedRuntimeClientError && error.code === "http_error" &&
        error.status === 404 && error.serverCode === "not_found";
      if (!unsupported) {
        if (error instanceof RemoteControlInteractionSnapshotError) throw error;
        throw new RemoteControlInteractionSnapshotError("snapshot_required");
      }
    }
    return readFallback(workspaceId, sessionId, payloadVersion);
  }

  return Object.freeze({ listPending, resolveOwnership, ownershipIn });
}
