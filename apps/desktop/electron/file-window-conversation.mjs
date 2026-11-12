import { desktopConfigSchema, isDesktopModelBlocked, checkDesktopAppRestriction } from "@jugglework/types/den/desktop-policies";

export const conversationDenied = () => new Error("文件窗口会话请求不可用");
export const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const identifier = (value) => typeof value === "string" && /^[^\s\u0000-\u001f\u007f/\\?#]{1,256}$/.test(value);
const modelIdentifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
// Agent names and variant keys are opaque JSON values, not URL path identifiers.
const conversationOptionName = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
// Body IDs are Server identifiers, not URL path segments. In particular question IDs may contain spaces.
const bodyIdentifier = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
export function keys(value, allowed) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw conversationDenied();
}

/** 主窗口开窗参数只允许模型身份、agent、档位；策略始终由 Main 单独读取。 */
export function validateFileWindowConversationOptions(value) {
  if (value === undefined) return {};
  keys(value, ["model", "agent", "variant"]);
  const result = {};
  if (value.model !== undefined) {
    if (value.model !== null) {
      keys(value.model, ["providerID", "modelID"]);
      if (!modelIdentifier(value.model.providerID) || !modelIdentifier(value.model.modelID)) throw conversationDenied();
    }
    result.model = value.model === null ? null : { providerID: value.model.providerID, modelID: value.model.modelID };
  }
  for (const key of ["agent", "variant"]) {
    if (value[key] === undefined) continue;
    if (value[key] !== null && !conversationOptionName(value[key])) throw conversationDenied();
    result[key] = value[key];
  }
  return result;
}

/** 从可信主窗口的既有、组织隔离的策略缓存读取；不读取或返回凭据。 */
export async function readFileWindowDesktopConfig(window, bootstrap) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || !bootstrap?.baseUrl) return null;
  const base = new URL(bootstrap.baseUrl);
  // Match Den's stripDenApiBasePath twice (resolveDenBaseUrls), including
  // control-plane URLs and deployment prefixes, without importing App runtime.
  for (let pass = 0; pass < 2; pass++) {
    const pathname = base.pathname.replace(/\/+$/, "");
    const suffix = ["/jwork/api", "/api/den", "/jwork"].find((candidate) => pathname.toLowerCase().endsWith(candidate));
    if (!suffix) break;
    base.pathname = pathname.slice(0, -suffix.length) || "/";
  }
  const cacheBase = base.href.replace(/\/+$/, "");
  const source = `(() => {
    const org = (localStorage.getItem("jugglework.den.activeOrgId") || "").trim();
    if (!org) return null;
    const raw = localStorage.getItem(${JSON.stringify(`jugglework.den.desktopConfig:${cacheBase}::`)} + org);
    if (!raw || raw.length > 65536) return null;
    try { return JSON.parse(raw); } catch { return null; }
  })()`;
  let timer;
  try {
    const value = await Promise.race([window.webContents.executeJavaScript(source), new Promise((resolve) => { timer = setTimeout(() => resolve(null), 8000); })]);
    if (window.isDestroyed() || window.webContents.isDestroyed()) return null;
    const result = desktopConfigSchema.safeParse(value);
    return result.success ? result.data : null;
  } finally { clearTimeout(timer); }
}

/** 凭据容器不属于会话 UI 数据；保留既有 Event/JSON 形状和正文。 */
export function redactConversation(value) {
  if (Array.isArray(value)) return value.map(redactConversation);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|client[-_]?token|host[-_]?token|auth|authorization|cookie|set-cookie|password|secret|credentials?|headers|env|providerOptions)$/i.test(key))
    .map(([key, child]) => [key, key === "error" && child !== null ? { name: child?.name === "MessageAbortedError" ? "MessageAbortedError" : "UnknownError", data: { message: "Session request failed" } }
      : key === "message" && value.type === "retry" ? "Provider is retrying" : redactConversation(child)]));
}

const SESSION_EVENTS = new Set([
  "session.updated", "session.deleted", "session.status", "session.idle", "session.error", "session.compacted",
  "session.next.compaction.started", "session.next.compaction.ended", "session.next.retried",
  "message.updated", "message.removed", "message.part.updated", "message.part.removed", "message.part.delta", "todo.updated",
  "permission.asked", "permission.replied", "permission.v2.asked", "permission.v2.replied",
  "question.asked", "question.replied", "question.rejected", "question.v2.asked", "question.v2.replied", "question.v2.rejected",
]);

/** 解包 Server 的既有 envelope，仅发布固定会话 Event，不发布 workspace/provider 配置事件。 */
export function fileWindowSessionEvent(entry, raw) {
  if (!entry.conversation) return null;
  if (raw?.workspaceId !== undefined && raw.workspaceId !== entry.workspaceId) return null;
  const event = record(raw?.payload) ? raw.payload : raw;
  if (!record(event) || !record(event.properties)) return null;
  if (["server.connected", "server.heartbeat"].includes(event.type)) return { type: event.type, properties: {} };
  if (!SESSION_EVENTS.has(event.type)) return null;
  const p = event.properties;
  const sessionId = event.type.startsWith("session.") && ["session.updated", "session.deleted"].includes(event.type)
    ? p.info?.id ?? p.sessionID : p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
  if (sessionId !== entry.sessionId && !entry.verifiedDescendants?.has(sessionId)) return null;
  // Conflicting identities cannot smuggle a second session through a nested part/info.
  for (const id of [p.sessionID, p.info?.sessionID, p.part?.sessionID, p.targetSessionId])
    if (id !== undefined && id !== sessionId) return null;
  if (p.rootSessionId !== undefined && p.rootSessionId !== entry.sessionId) return null;
  if (p.ancestryPath !== undefined && !validAncestry(entry, { sessionID: sessionId, targetSessionId: sessionId, rootSessionId: p.rootSessionId, ancestryPath: p.ancestryPath, parentSessionId: p.parentSessionId })) return null;
  return { type: event.type, properties: redactConversation(p) };
}

/** 选区身份只接受 Main 从真实原生采集投递、且文档仍登记在本窗口的引用。 */
function validateOfficeReferences(entry, ids) {
  if (!Array.isArray(ids) || ids.length > 16 || new Set(ids).size !== ids.length ||
      ids.some((id) => !identifier(id) || !entry.officeReferences?.has(id) ||
        !entry.tabs.some((tab) => tab.documentId === entry.officeReferences.get(id)))) throw conversationDenied();
}

/** 沿用共用 Composer 的历史展示字段；只接收预览，不接收坐标、引用身份或工具权限。 */
function validateOfficeDisplay(metadata, prompt) {
  keys(metadata, ["officeSelectionGroup"]);
  const group = metadata.officeSelectionGroup;
  keys(group, ["instruction", "references"]);
  keys(group.instruction, ["text"]);
  if (!Array.isArray(prompt.officeInstructions) || !prompt.officeInstructions.some((item) => item?.text === group.instruction.text) ||
      !Array.isArray(group.references) || group.references.length > 16) throw conversationDenied();
  for (const ref of group.references) {
    keys(ref, ["locator", "preview"]);
    keys(ref.locator, ["kind"]);
    if (!["doc-text", "doc-caret", "sheet-cells", "sheet-rows", "sheet-columns", "slide-text", "slide-shapes", "slide-pages"].includes(ref.locator.kind)) throw conversationDenied();
    keys(ref.preview, ["name", "path", "range", "text"]);
    for (const key of ["name", "range", "text"])
      if (typeof ref.preview[key] !== "string" || ref.preview[key].length > 4096) throw conversationDenied();
    if (ref.preview.path !== undefined && (typeof ref.preview.path !== "string" || ref.preview.path.length > 4096)) throw conversationDenied();
  }
}

/** 文件窗口只可把登记云文档标签作为本轮范围，不能伪造其他组织或未打开的可写目标。 */
function validateCloudDocTurn(entry, turn) {
  if (turn === undefined) return;
  keys(turn, ["currentTenantId", "references", "activeDoc"]);
  if (!Array.isArray(turn.references) || turn.references.length > 32) throw conversationDenied();
  if (turn.currentTenantId === null && !turn.references.length && !turn.activeDoc) return;
  const activeTab = entry.tabs.find(tab => tab.path === entry.activePath);
  const actualDoc = tab => entry.cloudDocument ? entry.cloudDocument(tab) : tab?.cloudDoc;
  const active = actualDoc(activeTab);
  if (!active || turn.currentTenantId !== active.tenantId) throw conversationDenied();
  for (const ref of [...turn.references, ...(turn.activeDoc ? [turn.activeDoc] : [])]) {
    keys(ref, ["tenantId", "workspaceId", "docId", "title", "blockIds"]);
    if (ref.tenantId !== active.tenantId || !identifier(ref.workspaceId) || !identifier(ref.docId) ||
      typeof ref.title !== "string" || ref.title.length > 300 ||
      (ref.blockIds !== undefined && (!Array.isArray(ref.blockIds) || ref.blockIds.length > 200 || !ref.blockIds.every(identifier))) ||
      !entry.tabs.some(tab => { const document = actualDoc(tab); return document?.tenantId === ref.tenantId && document.workspaceId === ref.workspaceId && document.docId === ref.docId; })) throw conversationDenied();
  }
  if (turn.activeDoc && (turn.activeDoc.workspaceId !== active.workspaceId || turn.activeDoc.docId !== active.docId)) throw conversationDenied();
}

function validatePrompt(entry, prompt) {
  keys(prompt, ["messageID", "model", "agent", "variant", "system", "parts", "officeSelectionRefs", "officeInstructions", "cloudDocTurn"]);
  validateCloudDocTurn(entry, prompt.cloudDocTurn);
  if (prompt.model !== undefined) {
    keys(prompt.model, ["providerID", "modelID"]);
    if (!modelIdentifier(prompt.model.providerID) || !modelIdentifier(prompt.model.modelID)) throw conversationDenied();
  }
  if (prompt.messageID !== undefined && !identifier(prompt.messageID)) throw conversationDenied();
  for (const key of ["agent", "variant"])
    if (prompt[key] !== undefined && !conversationOptionName(prompt[key])) throw conversationDenied();
  if (prompt.system !== undefined && (typeof prompt.system !== "string" || prompt.system.length > 16_384)) throw conversationDenied();
  if (!Array.isArray(prompt.parts) || !prompt.parts.length || prompt.parts.length > 64) throw conversationDenied();
  for (const part of prompt.parts) {
    keys(part, ["id", "type", "text", "synthetic", "metadata"]);
    if (part.type !== "text" || typeof part.text !== "string" || part.text.length > 48_000 ||
        (part.id !== undefined && !identifier(part.id)) || (part.synthetic !== undefined && typeof part.synthetic !== "boolean")) throw conversationDenied();
    if (part.metadata !== undefined) validateOfficeDisplay(part.metadata, prompt);
  }
  const refs = prompt.officeSelectionRefs ?? [];
  validateOfficeReferences(entry, refs);
  const instructions = prompt.officeInstructions ?? [];
  if (!Array.isArray(instructions) || instructions.length > 32) throw conversationDenied();
  for (const instruction of instructions) {
    keys(instruction, ["instructionId", "text", "bindingState", "referenceIds"]);
    if (!identifier(instruction.instructionId) || typeof instruction.text !== "string" || instruction.text.length > 32768 ||
        !["bound", "needs-selection", "detached"].includes(instruction.bindingState)) throw conversationDenied();
    validateOfficeReferences(entry, instruction.referenceIds);
    if (instruction.bindingState !== "bound" && instruction.referenceIds.length ||
        instruction.referenceIds.some((id) => !refs.includes(id))) throw conversationDenied();
  }
  if (refs.some((id) => !instructions.some((item) => item.bindingState === "bound" && item.referenceIds.includes(id)))) throw conversationDenied();
}

/** 只声明 App 实际使用的有限路由；任何额外路径、查询或写操作均拒绝。 */
export function authorizeConversationRequest(entry, url, prefix, method, body) {
  if (!entry.conversation || entry.workspaceId.startsWith("rem_") || !identifier(entry.sessionId)) throw conversationDenied();
  const session = `${prefix}/sessions/${encodeURIComponent(entry.sessionId)}`;
  const query = url.searchParams;
  const noQuery = () => { if (url.search) throw conversationDenied(); };
  if (method === "GET" && [session, `${session}/messages`, `${session}/snapshot`].includes(url.pathname)) {
    if (url.pathname === session) noQuery();
    else if (url.search && ([...query.keys()].length !== 1 || !query.has("limit") || !/^[1-9]\d{0,3}$/.test(query.get("limit")) || Number(query.get("limit")) > 1000)) throw conversationDenied();
    return { kind: url.pathname === session ? "session" : url.pathname.endsWith("/snapshot") ? "snapshot" : "messages" };
  }
  if (method === "GET" && url.pathname === `${prefix}/session-runs`) { noQuery(); return { kind: "runs" }; }
  if (method === "GET" && url.pathname === `${session}/permission-mode`) { noQuery(); return { kind: "permission-mode" }; }
  if (method === "GET" && url.pathname === `${session}/interactions/snapshot`) {
    if (url.search && (url.search !== "?includeDescendants=true" && url.search !== "?includeDescendants=false")) throw conversationDenied();
    return { kind: "interactions" };
  }
  if (method === "GET" && ["provider", "agent"].some((name) => url.pathname === `${prefix}/opencode/${name}`)) {
    if (url.search && ([...query.keys()].length !== 1 || !query.has("directory") || query.get("directory") !== entry.workspaceRoot)) throw conversationDenied();
    return { kind: url.pathname.endsWith("/provider") ? "provider" : "agent" };
  }
  if (method === "GET" && ["session-changes", "changes"].some(name => url.pathname === `${prefix}/cloud-docs/${name}`)) {
    const names = url.pathname.endsWith('/session-changes') ? ['sessionId'] : ['sessionId', 'messageId'];
    if ([...query.keys()].length !== names.length || names.some(name => query.getAll(name).length !== 1) ||
      query.get('sessionId') !== entry.sessionId || (names.includes('messageId') && !identifier(query.get('messageId')))) throw conversationDenied();
    return { kind: "cloud-changes" };
  }
  noQuery();
  if (method !== "POST") throw conversationDenied();
  if (url.pathname === `${prefix}/cloud-docs/undo`) {
    keys(body, ['sessionId', 'messageId']);
    if (body.sessionId !== entry.sessionId || !identifier(body.messageId)) throw conversationDenied();
    return { kind: 'cloud-undo' };
  }
  if (["validate", "release"].some((action) => url.pathname === `${prefix}/office/selection-references/${action}`)) {
    keys(body, ["sessionId", "referenceIds"]);
    if (body.sessionId !== entry.sessionId) throw conversationDenied();
    validateOfficeReferences(entry, body.referenceIds);
    return { kind: "office-references" };
  }
  if (url.pathname === `${session}/runs/start`) {
    keys(body, ["origin", "startCommandCorrelationId", "prompt", "responseLanguage", "whenBusy"]);
    if (body.origin !== "local-renderer" || (body.whenBusy !== undefined && body.whenBusy !== "reject") ||
        !(body.startCommandCorrelationId === null || identifier(body.startCommandCorrelationId))) throw conversationDenied();
    validatePrompt(entry, body.prompt);
    if (body.responseLanguage !== undefined) {
      keys(body.responseLanguage, ["detected", "fallback"]);
      if (!["zh", "en"].includes(body.responseLanguage.fallback)) throw conversationDenied();
      for (const value of Object.values(body.responseLanguage)) if (!["zh", "en"].includes(value)) throw conversationDenied();
    }
    return { kind: "start" };
  }
  const runPrefix = `${session}/runs/`;
  if (url.pathname.startsWith(runPrefix) && url.pathname.endsWith("/abort")) {
    const runId = decodeURIComponent(url.pathname.slice(runPrefix.length, -6));
    if (!identifier(runId)) throw conversationDenied();
    keys(body, ["abortCommandCorrelationId"]);
    if (!(body.abortCommandCorrelationId === null || identifier(body.abortCommandCorrelationId))) throw conversationDenied();
    return { kind: "abort", runId };
  }
  const interactionPrefix = `${prefix}/sessions/`;
  if (url.pathname.startsWith(interactionPrefix)) {
    const match = /^([^/]+)\/interactions\/([^/]+)\/(permission|question)\/reply$/.exec(url.pathname.slice(interactionPrefix.length));
    if (!match || !identifier(decodeURIComponent(match[1])) || !identifier(decodeURIComponent(match[2]))) throw conversationDenied();
    const [, target, id, type] = match;
    keys(body, ["origin", "commandCorrelationId", type === "permission" ? "response" : "answers"]);
    if (body.origin !== "local-renderer" || !(body.commandCorrelationId === null || identifier(body.commandCorrelationId))) throw conversationDenied();
    if (type === "permission") {
      if (!["allow_once", "always", "reject"].includes(body.response)) throw conversationDenied();
    } else {
      if (!Array.isArray(body.answers) || body.answers.length > 100) throw conversationDenied();
      for (const answer of body.answers) {
        keys(answer, ["questionId", "values"]);
        if (!bodyIdentifier(answer.questionId) || !Array.isArray(answer.values) || answer.values.length > 100 || answer.values.some((value) => typeof value !== "string" || value.length > 5000)) throw conversationDenied();
      }
    }
    return { kind: "reply", targetSessionId: decodeURIComponent(target), interactionId: decodeURIComponent(id), interactionType: type };
  }
  throw conversationDenied();
}

export function ownedRun(entry, run) { return run?.workspaceId === entry.workspaceId && run?.sessionId === entry.sessionId; }
function validAncestry(entry, item) {
  const path = item?.ancestryPath;
  return item?.rootSessionId === entry.sessionId && identifier(item?.sessionID) && item.targetSessionId === item.sessionID &&
    Array.isArray(path) && path.length > 0 && path.every(identifier) && new Set(path).size === path.length &&
    path[0] === entry.sessionId && path.at(-1) === item.sessionID && item.parentSessionId === (path.at(-2) ?? null);
}

export function ownedInteraction(entry, item) {
  return identifier(item?.id) && validAncestry(entry, item);
}

/** Start must name an available model; only the live engine provider source can grant the local-config exemption. */
export function authorizeConversationModel(entry, model, providers) {
  const config = desktopConfigSchema.safeParse(entry.conversation?.desktopConfig);
  if (!config.success || !model) throw conversationDenied();
  const provider = providers?.all?.find((item) => item.id === model.providerID);
  if (!provider || !providers.connected?.includes(provider.id) || !Object.hasOwn(provider.models ?? {}, model.modelID) ||
      isDesktopModelBlocked({ model, allowedModels: config.data.allowedModels, providerSource: provider.source,
        checkRestriction: (input) => checkDesktopAppRestriction({ config: config.data, ...input }) })) throw conversationDenied();
}

/** 只投影绑定会话，provider/agent 采用字段白名单避免嵌套配置携带凭据。 */
export function projectConversationResponse(entry, request, value) {
  if (request.kind === "runs") return { items: (value.items ?? []).filter((run) => ownedRun(entry, run)).map(redactConversation) };
  if (request.kind === "interactions") {
    const item = value.item;
    // Replace proof on every snapshot, including failures, rather than trusting renderer/event ancestry claims.
    entry.verifiedDescendants = new Set();
    if (!record(item) || item.rootSessionId !== entry.sessionId || item.includeDescendants !== true ||
        !Array.isArray(item.permissions) || !Array.isArray(item.questions)) throw conversationDenied();
    const permissions = item.permissions.filter((it) => ownedInteraction(entry, it));
    const questions = item.questions.filter((it) => ownedInteraction(entry, it));
    for (const interaction of [...permissions, ...questions])
      for (const id of interaction.ancestryPath.slice(1)) entry.verifiedDescendants.add(id);
    return { item: { snapshotStartedAt: item.snapshotStartedAt, rootSessionId: entry.sessionId, includeDescendants: true,
      permissions: permissions.map(redactConversation), questions: questions.map(redactConversation) } };
  }
  const pick = (object, fields) => Object.fromEntries(fields.filter((key) => object[key] !== undefined).map((key) => [key, redactConversation(object[key])]));
  if (request.kind === "provider") return {
    all: (value.all ?? []).map((provider) => ({ ...pick(provider, ["id", "name", "source"]),
      models: Object.fromEntries(Object.entries(provider.models ?? {}).map(([id, model]) => [id, { ...pick(model, ["id", "providerID", "name", "family", "status", "release_date", "capabilities", "cost", "limit"]),
        ...(record(model.variants) ? { variants: Object.fromEntries(Object.keys(model.variants).map((name) => [name, {}])) } : {}) }])) })),
    connected: value.connected ?? [], default: value.default ?? {},
  };
  if (request.kind === "agent") return value.map((agent) => pick(agent, ["name", "description", "mode", "hidden", "native", "color", "model", "variant"]));
  if (request.kind === "permission-mode") {
    if (value.state && (value.state.workspaceId !== entry.workspaceId || value.state.rootSessionId !== entry.sessionId)) throw conversationDenied();
    return { ...redactConversation(value), grants: (value.grants ?? []).filter((grant) => grant.workspaceId === entry.workspaceId && grant.rootSessionId === entry.sessionId).map(redactConversation) };
  }
  if (request.kind === "session" && value.item?.id !== entry.sessionId) throw conversationDenied();
  if (request.kind === "snapshot" && value.item?.session?.id !== entry.sessionId) throw conversationDenied();
  if (["messages", "snapshot"].includes(request.kind)) {
    const messages = request.kind === "messages" ? value.items : value.item.messages;
    if (!Array.isArray(messages) || messages.some((message) => message.info?.sessionID !== entry.sessionId ||
      message.parts?.some((part) => part.sessionID !== entry.sessionId))) throw conversationDenied();
  }
  if (["start", "abort"].includes(request.kind) && !ownedRun(entry, value.run)) throw conversationDenied();
  if (request.kind === "reply" && value.interactionId !== request.interactionId) throw conversationDenied();
  return redactConversation(value);
}
