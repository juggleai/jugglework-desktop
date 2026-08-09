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

const INTERACTION_TTL_MS = 5 * 60 * 1000;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1000;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {unknown} raw @param {string} sessionId */
function normalizePermissionInteraction(raw, sessionId) {
  if (!raw || typeof raw !== "object") return null;
  const entry = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!isString(id)) return null;
  if (isString(entry.sessionID) && entry.sessionID !== sessionId) return null;
  const action = isString(entry.action) ? entry.action : isString(entry.permission) ? entry.permission : "Permission required";
  const resources = Array.isArray(entry.resources) ? entry.resources.filter(isString) : Array.isArray(entry.patterns) ? entry.patterns.filter(isString) : [];
  const description = resources.length > 0 ? `${action}: ${resources.join(", ")}`.slice(0, 2000) : action.slice(0, 2000);
  const now = Date.now();
  return {
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
}

/** @param {unknown} raw @param {string} sessionId */
function normalizeQuestionInteraction(raw, sessionId) {
  if (!raw || typeof raw !== "object") return null;
  const entry = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!isString(id)) return null;
  if (isString(entry.sessionID) && entry.sessionID !== sessionId) return null;
  const rawQuestions = Array.isArray(entry.questions) ? entry.questions : [];
  const questions = rawQuestions.flatMap((q) => {
    if (!q || typeof q !== "object") return [];
    const question = /** @type {Record<string, unknown>} */ (q);
    const prompt = typeof question.question === "string" ? question.question : typeof question.header === "string" ? question.header : "";
    if (!isString(prompt)) return [];
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const options = rawOptions.flatMap((opt) => {
      if (!opt) return [];
      if (typeof opt === "string") return [opt.slice(0, 1000)];
      if (typeof opt === "object" && opt !== null) {
        const o = /** @type {Record<string, unknown>} */ (opt);
        const label = typeof o.label === "string" ? o.label : "";
        return isString(label) ? [label] : [];
      }
      return [];
    });
    return [{
      id: typeof question.id === "string" && question.id ? question.id : `q_${prompt.slice(0, 32)}`,
      prompt: prompt.slice(0, 5000),
      multiple: question.multiple === true,
      options: options.slice(0, 100),
    }];
  });
  if (questions.length === 0) return null;
  const now = Date.now();
  return {
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
}

/**
 * @param {{
 *   managedRuntimeClient: ManagedRuntimeClient,
 * }} options
 */
export function createRemoteControlInteractionStore({ managedRuntimeClient }) {
  if (!managedRuntimeClient || typeof managedRuntimeClient.getJson !== "function") {
    throw new TypeError("Interaction store requires a managed runtime client.");
  }

  /**
   * Lists pending permission and question interactions for a session.
   * @param {{ workspaceId: string, sessionId: string }} input
   * @returns {Promise<DesktopRemoteInteraction[]>}
   */
  async function listPending({ workspaceId, sessionId }) {
    if (!isString(workspaceId) || !isString(sessionId)) return [];
    try {
      const [permRaw, questionRaw] = await Promise.allSettled([
        managedRuntimeClient.getJson(`/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}/permission`),
        managedRuntimeClient.getJson(`/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}/question`),
      ]);
      const interactions = [];
      if (permRaw.status === "fulfilled") {
        const items = permRaw.value && typeof permRaw.value === "object" && "data" in permRaw.value
          ? /** @type {Record<string, unknown>} */ (permRaw.value).data
          : permRaw.value && typeof permRaw.value === "object" && Array.isArray(/** @type {Record<string, unknown>} */ (permRaw.value).items)
            ? /** @type {Record<string, unknown>} */ (permRaw.value).items
            : Array.isArray(permRaw.value) ? permRaw.value : [];
        if (Array.isArray(items)) {
          for (const item of items) {
            const normalized = normalizePermissionInteraction(item, sessionId);
            if (normalized) interactions.push(normalized);
          }
        }
      }
      if (questionRaw.status === "fulfilled") {
        const items = questionRaw.value && typeof questionRaw.value === "object" && "data" in questionRaw.value
          ? /** @type {Record<string, unknown>} */ (questionRaw.value).data
          : questionRaw.value && typeof questionRaw.value === "object" && Array.isArray(/** @type {Record<string, unknown>} */ (questionRaw.value).items)
            ? /** @type {Record<string, unknown>} */ (questionRaw.value).items
            : Array.isArray(questionRaw.value) ? questionRaw.value : [];
        if (Array.isArray(items)) {
          for (const item of items) {
            const normalized = normalizeQuestionInteraction(item, sessionId);
            if (normalized) interactions.push(normalized);
          }
        }
      }
      return interactions.slice(0, 50);
    } catch {
      return [];
    }
  }

  return Object.freeze({ listPending });
}
