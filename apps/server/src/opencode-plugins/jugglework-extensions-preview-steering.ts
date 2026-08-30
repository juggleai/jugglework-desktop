import { z } from "zod";

export type OpenCodeContext = {
  agent?: string;
  sessionID?: string;
  messageID?: string;
  directory?: string;
  worktree?: string;
  workspaceId?: string;
  workspaceID?: string;
};

export type JuggleWorkExtensionConnectState = {
  connectEnabled: boolean;
  connectCatalogEnabled: boolean;
  cloudMcpPresent: boolean;
  cloudHealth: JuggleWorkCloudHealthSummary | null;
  workspace?: {
    resolution?: string;
    id?: string | null;
    directory?: string | null;
    reason?: string;
  };
  googleWorkspace: {
    legacyConfigured: boolean;
  };
};

export type JuggleWorkCloudHealthSummary = {
  usable: boolean;
  usableByCurrentModel: boolean | null;
  phase: string;
  connectCatalogEnabled?: boolean;
  workspace: {
    id: string;
    directory: string | null;
  };
  desired: {
    present: boolean;
    revision: string | null;
  };
  delivery?: {
    appliedRevision?: string | null;
  };
  engine?: {
    status?: string;
  };
  firstFailure: {
    code: string;
    stage: string;
    recommendedAction: string;
    message: string;
  } | null;
};

type JuggleWorkFetch = (url: string, init?: RequestInit) => Promise<Response>;

type EngineMcpStatusRequest = {
  query?: {
    directory?: string;
  };
};

export type JuggleWorkEngineMcpStatusClient = {
  mcp: {
    status: (request?: EngineMcpStatusRequest) => Promise<unknown>;
  };
};

export type JuggleWorkEngineMcpStatusSource = {
  client?: JuggleWorkEngineMcpStatusClient;
  directory?: string;
};

type EngineMcpStatusResult =
  | { found: true; status: string | undefined }
  | { found: false };

type ProviderModel = {
  provider: string;
  model: string;
};

const cloudFailureSchema = z.object({
  code: z.string(),
  stage: z.string(),
  recommendedAction: z.string(),
  message: z.string(),
}).passthrough();

const cloudHealthSchema = z.object({
  usable: z.boolean(),
  usableByCurrentModel: z.boolean().nullable(),
  phase: z.string(),
  connectCatalogEnabled: z.boolean().optional(),
  workspace: z.object({
    id: z.string(),
    directory: z.string().nullable(),
  }).passthrough(),
  desired: z.object({
    present: z.boolean(),
    revision: z.string().nullable(),
  }).passthrough(),
  delivery: z.object({
    appliedRevision: z.string().nullable().optional(),
  }).passthrough().optional(),
  engine: z.object({
    status: z.string().optional(),
  }).passthrough().optional(),
  firstFailure: cloudFailureSchema.nullable(),
}).passthrough();

const connectStateResponseSchema = z.object({
  ok: z.literal(true),
  schemaVersion: z.number(),
  connectEnabled: z.boolean(),
  connectCatalogEnabled: z.boolean().optional(),
  cloudMcpPresent: z.boolean(),
  cloudHealth: cloudHealthSchema.nullable().optional(),
  workspace: z.object({
    resolution: z.string().optional(),
    id: z.string().nullable().optional(),
    directory: z.string().nullable().optional(),
    reason: z.string().optional(),
  }).passthrough().optional(),
  googleWorkspace: z.object({
    legacyConfigured: z.boolean(),
  }).passthrough(),
}).passthrough();

const connectSkillsResponseSchema = z.object({
  ok: z.literal(true),
  schemaVersion: z.number(),
  instruction: z.string(),
}).passthrough();

export const JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION =
  "If the user asks for something you cannot do with obvious built-in tools, check JuggleWork extensions before saying the capability is unavailable. Use jugglework_query with id extension.actions to inspect available extension actions, then jugglework_execute with id extension.call for the matching action.";

export const JUGGLEWORK_CLOUD_SKILL_AUTHORING_INSTRUCTION =
  "Skill creation: Cloud. When the user asks to create a skill, retrieve and follow the listed create-skill remote skill by calling jugglework-cloud_execute_capability with its exact <capability>. Create the skill in JuggleWork Cloud as a private plugin, not in the workspace. For later steps, use add-to-marketplace or add-user-to-marketplace only when the user asks. Use a workspace-local skill only when the user explicitly requests one. Do not create both copies.";

export const JUGGLEWORK_LOCAL_SKILL_AUTHORING_INSTRUCTION =
  "Skill creation: Local. Create or update a workspace-local skill only when the user requests one. Keep one skill in .opencode/skills/<skill-name>/SKILL.md, validate it, and re-read it after writing. Do not create a Cloud copy.";

// fix(L3): 组织连接器是 Cloud MCP，不应在搜索为空后被误判为本地 MCP。
// before: 只提示关键词变体；after: 明确空目录结果的边界。
// TIPS：search_capabilities 的入参只有 query 与 limit（additionalProperties: false）。
// 提示模型传 type 之类的过滤字段会被服务端拒绝，等于把搜索本身弄失败。
// TIPS：组织连接现在还带工作区级开关。成员在本工作区关掉的连接，服务端会以
// status "disabled_in_workspace" 的伪匹配回来；搜索为空时也要把这一档说清楚，
// 否则模型会把「我自己关的」误报成「没授权」，把人送去重走授权流程。
export const JUGGLEWORK_CLOUD_CONNECTION_INSTRUCTION =
  "The JuggleWork Cloud connection is verified ready for this exact workspace/model. For org-connected services, use jugglework-cloud_search_capabilities — it accepts only query and limit — with 2-4 keyword variants that include the connection name, then jugglework-cloud_execute_capability with an exact returned name — and only mention services that search (or available_skills) actually returns. If a result has status disabled_in_workspace, that connection is switched off for this workspace by the member: relay its hint, say it can be re-enabled in Settings > Connectors, and do not retry it or suggest reconnecting the account. If every search returns no matches, report that the Cloud capability catalog has not exposed that connection yet, and add that it may also be switched off for this workspace in Settings > Connectors; do not look for it as a local MCP server. When a remote skill is listed under available_skills, call jugglework-cloud_execute_capability with that skill's <capability> directly; do not treat the local OpenCode skill list as the full inventory. Local JuggleWork extensions remain available through jugglework_query/jugglework_execute with extension.actions and extension.call. Settings > Connect is the member connection surface. A successful search proves JuggleWork Cloud itself is authorized, so a downstream connector failure does not mean JuggleWork Cloud needs to be reconnected. If a result has kind connection_status, name connectionStatus.connectionName and relay connectionStatus.action exactly: use Your Connections for the member, the organization Connections dashboard for an org admin, or the provider admin console for a provider-side failure. After the requested human fixes that connector, search again in the same task because results are live, not cached, so unchanged retries return the same error.";

export const JUGGLEWORK_CONNECT_SIGN_IN_INSTRUCTION =
  `${JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION} JuggleWork Cloud is not signed in or no desired agent access configuration exists for this workspace. Direct the user to sign in to JuggleWork and connect the service in Settings → Connect.`;

export const JUGGLEWORK_CONNECT_DISABLED_INSTRUCTION =
  `${JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION} JuggleWork Cloud agent access is explicitly disabled for this workspace. Explain that the user can enable agent access in Settings → Connect.`;

const JUGGLEWORK_CLOUD_MCP_NAME = "jugglework-cloud";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getRecordProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readNestedString(value: unknown, keys: string[]): string | undefined {
  let current = value;
  for (const key of keys) current = getRecordProperty(current, key);
  return readString(current);
}

function readContext(input: unknown): OpenCodeContext {
  const context = getRecordProperty(input, "context");
  const session = getRecordProperty(input, "session");
  const directory = readNestedString(input, ["directory"]) ?? readNestedString(context, ["directory"]) ?? readNestedString(session, ["directory"]);
  const worktree = readNestedString(input, ["worktree"]) ?? readNestedString(context, ["worktree"]) ?? readNestedString(session, ["worktree"]);
  const workspaceId = readNestedString(input, ["workspaceId"]) ?? readNestedString(input, ["workspaceID"]) ?? readNestedString(context, ["workspaceId"]) ?? readNestedString(context, ["workspaceID"]);
  return {
    ...(directory ? { directory } : {}),
    ...(worktree ? { worktree } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function readProviderModel(input: unknown): ProviderModel | undefined {
  const model = getRecordProperty(input, "model");
  const provider = readNestedString(model, ["providerID"]) ?? readNestedString(model, ["provider"]) ?? readNestedString(input, ["provider"]);
  const modelId = readNestedString(model, ["modelID"]) ?? readNestedString(model, ["id"]) ?? readNestedString(input, ["modelID"]);
  if (provider && modelId) return { provider, model: modelId };
  const combined = modelId?.includes("/") ? modelId : readNestedString(input, ["model"]) ?? readNestedString(model, ["name"]);
  if (combined?.includes("/")) {
    const [providerPart, ...modelParts] = combined.split("/");
    const joinedModel = modelParts.join("/").trim();
    if (providerPart?.trim() && joinedModel) return { provider: providerPart.trim(), model: joinedModel };
  }
  return undefined;
}

function serverUrl(): string {
  return String(process.env.JUGGLEWORK_SERVER_URL || "").replace(/\/$/, "");
}

function serverToken(): string {
  return String(process.env.JUGGLEWORK_SERVER_TOKEN || "");
}

function requireJuggleWorkServer(): { url: string; token: string } {
  const url = serverUrl();
  const token = serverToken();
  if (!url || !token) {
    throw new Error("JuggleWork extension tools are only available when OpenCode is launched by JuggleWork.");
  }
  return { url, token };
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function getStringProperty(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const property = value[key];
  return typeof property === "string" ? property : null;
}

function errorMessage(payload: unknown, fallback: string): string {
  return getStringProperty(payload, "message") ?? getStringProperty(payload, "code") ?? fallback;
}

function readEngineDirectory(input: unknown, fallback?: string): string | undefined {
  const context = readContext(input);
  return context.directory ?? context.worktree ?? readString(fallback);
}

function engineStatusPayload(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const data = result.data;
  if (data !== undefined) return data;
  if (result.error !== undefined) throw new Error("OpenCode MCP status request failed");
  const responseOk = getRecordProperty(result.response, "ok");
  if (responseOk === false) throw new Error("OpenCode MCP status request failed");
  return result;
}

function readEngineMcpStatus(result: unknown): EngineMcpStatusResult {
  const entry = getRecordProperty(engineStatusPayload(result), JUGGLEWORK_CLOUD_MCP_NAME);
  if (entry === undefined) return { found: false };
  if (typeof entry === "string") return { found: true, status: readString(entry) };
  return { found: true, status: readNestedString(entry, ["status"]) };
}

async function fetchEngineMcpStatus(input: unknown, engine: JuggleWorkEngineMcpStatusSource): Promise<EngineMcpStatusResult> {
  if (!engine.client) return { found: false };
  const directory = readEngineDirectory(input, engine.directory);
  const request = directory ? { query: { directory } } : undefined;
  return readEngineMcpStatus(await engine.client.mcp.status(request));
}

async function fetchJuggleWorkConnectState(input: unknown, fetcher: JuggleWorkFetch): Promise<JuggleWorkExtensionConnectState> {
  const { url, token } = requireJuggleWorkServer();
  const context = readContext(input);
  const providerModel = readProviderModel(input);
  const query = new URLSearchParams();
  const workspaceId = context.workspaceId ?? context.workspaceID;
  const directory = context.worktree ?? context.directory;
  if (workspaceId) query.set("workspaceId", workspaceId);
  if (directory) query.set("directory", directory);
  if (providerModel) {
    query.set("provider", providerModel.provider);
    query.set("model", providerModel.model);
  }
  const suffix = query.size ? `?${query.toString()}` : "";
  const response = await fetcher(`${url}/experimental/connect/state${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new Error(errorMessage(payload, "JuggleWork connect state request failed"));
  const parsed = connectStateResponseSchema.parse(payload);
  return {
    connectEnabled: parsed.connectEnabled,
    connectCatalogEnabled: parsed.connectCatalogEnabled ?? parsed.connectEnabled,
    cloudMcpPresent: parsed.cloudMcpPresent,
    cloudHealth: parsed.cloudHealth ?? null,
    ...(parsed.workspace ? { workspace: parsed.workspace } : {}),
    googleWorkspace: {
      legacyConfigured: parsed.googleWorkspace.legacyConfigured,
    },
  };
}

export async function resolveJuggleWorkConnectSkillInstruction(_input?: unknown, fetcher: JuggleWorkFetch = fetch): Promise<string> {
  try {
    const { url, token } = requireJuggleWorkServer();
    // Connect skills are server-scoped; workspace/directory query params are unused.
    const response = await fetcher(`${url}/experimental/connect/skills`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return "";
    return connectSkillsResponseSchema.parse(await parseResponse(response)).instruction;
  } catch {
    return "";
  }
}

export function composeJuggleWorkExtensionDiscoveryInstruction(state: JuggleWorkExtensionConnectState | null): string {
  if (!state) return JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION;
  if (state.workspace?.resolution && state.workspace.resolution !== "resolved") return JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION;
  const health = state.cloudHealth;
  if (health?.usable === true && health.usableByCurrentModel !== false) return JUGGLEWORK_CLOUD_CONNECTION_INSTRUCTION;
  if (health?.phase === "engine_disabled" || health?.firstFailure?.code === "engine_disabled" || health?.firstFailure?.code === "cloud_mcp_disabled") return JUGGLEWORK_CONNECT_DISABLED_INSTRUCTION;
  if (health) {
    if (!health.desired.present || health.firstFailure?.code === "cloud_mcp_missing") return JUGGLEWORK_CONNECT_SIGN_IN_INSTRUCTION;
    return JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION;
  }
  if (!state.connectCatalogEnabled || state.googleWorkspace.legacyConfigured) return JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION;
  return JUGGLEWORK_CONNECT_SIGN_IN_INSTRUCTION;
}

export function composeSteeringFromEngineMcpStatus(status: string | undefined): string {
  if (status === "connected") return JUGGLEWORK_CLOUD_CONNECTION_INSTRUCTION;
  if (status === "disabled") return JUGGLEWORK_CONNECT_DISABLED_INSTRUCTION;
  if (status === "needs_auth" || status === "needs_client_registration") return JUGGLEWORK_CONNECT_SIGN_IN_INSTRUCTION;
  return JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION;
}

export function composeSkillAuthoringInstruction(extensionInstruction: string): {
  mode: "cloud" | "local";
  prompt: string;
} {
  if (extensionInstruction === JUGGLEWORK_CLOUD_CONNECTION_INSTRUCTION) {
    return { mode: "cloud", prompt: JUGGLEWORK_CLOUD_SKILL_AUTHORING_INSTRUCTION };
  }
  return { mode: "local", prompt: JUGGLEWORK_LOCAL_SKILL_AUTHORING_INSTRUCTION };
}

export function resetJuggleWorkExtensionDiscoveryInstructionCacheForTests(): void {
  // Retained for older tests; steering is deliberately uncached so repair is observed immediately.
}

export async function resolveJuggleWorkExtensionDiscoveryInstruction(
  input?: unknown,
  fetcher: JuggleWorkFetch = fetch,
  engine: JuggleWorkEngineMcpStatusSource = {},
): Promise<string> {
  if (engine.client) {
    try {
      // Invariant: the OpenCode engine owns MCP registration and builds the
      // prompt tool list, so tool-availability steering must come from that
      // same in-process MCP state. Server health probes may fail for reasons
      // (for example corporate TLS trust) that do not affect engine tools.
      const engineStatus = await fetchEngineMcpStatus(input, engine);
      if (engineStatus.found) return composeSteeringFromEngineMcpStatus(engineStatus.status);
    } catch {
      return JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION;
    }
  }
  try {
    return composeJuggleWorkExtensionDiscoveryInstruction(await fetchJuggleWorkConnectState(input, fetcher));
  } catch {
    return JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION;
  }
}
