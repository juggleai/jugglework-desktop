import { z } from "zod";

export type OpenCodeContext = {
  agent?: string;
  sessionID?: string;
  messageID?: string;
  directory?: string;
  worktree?: string;
  workspaceId?: string;
  workspaceID?: string;
  abort?: AbortSignal;
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
  skills: z.array(z.object({ capability: z.string().min(1) }).passthrough()),
  capabilities: z.array(z.string()).optional(),
}).passthrough();

export const JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION =
  "If the user asks for something you cannot do with obvious built-in tools, check JuggleWork extensions before saying the capability is unavailable. For image generation, always call jugglework_image_models_list and then jugglework_image_generate before any Cloud search, skill, Pillow, SVG, canvas, or other fallback. For video generation, always call jugglework_video_models_list and then jugglework_video_generate before Cloud search or generic fallbacks. Submit exactly once per user request. jugglework_video_generate waits for the terminal job state: keep the turn open while it runs, then immediately report completion or failure and the artifact path. Do not use shell sleep. Use jugglework_video_job_get only as a compatibility fallback if a non-terminal response is returned; never resubmit a failed job. Use jugglework_video_job_cancel when cancellation is requested. Never bypass these tools with bash, curl, direct provider HTTP requests, or handcrafted media. Never read credential stores, environment-value files, API keys, or tokens to diagnose media failures, and never place credential values in tool output or transcripts. These direct local media tools use the models configured in this workspace. For other local extensions, use jugglework_query with id extension.actions and jugglework_execute with id extension.call. Configured provider IDs, model IDs, model display names, and generation aliases are models, not skills: never derive a skill name from them and never call the skill tool for names such as doubao-image-gen or seedream. The skill tool may only receive an exact name present in the system-provided available_skills list. Do not silently replace a requested configured model generation with Pillow, ffmpeg, SVG, canvas, or another handcrafted artifact; if no ready configured model exists, report that explicit result and ask before using a synthetic fallback.";

export const JUGGLEWORK_CLOUD_SKILL_AUTHORING_INSTRUCTION =
  "Skill creation routing: Remote-guided local. For a general request to create or update a skill, retrieve and follow the listed create-skill remote skill by calling jugglework-cloud_execute_capability with the exact skill:create-skill capability. Its returned instructions are authoritative generic authoring guidance, but user-provided valid name, intended behavior, source or content, and workspace-local target take precedence over generic defaults; do not ask again for details already supplied. If the user supplies a complete valid SKILL.md, preserve its body and content rather than regenerating it. The result must remain one complete file at <current-workspace>/.opencode/skills/<skill-name>/SKILL.md. Never override a valid user-specified local target; reject or clarify an invalid or outside target instead. Validate and re-read the file after writing. The remote skill is guidance only: never persist or save the authored skill to Cloud or the server. An explicit request for a workspace-local skill is handled directly as local authoring without retrieving remote guidance.";

export const JUGGLEWORK_LOCAL_SKILL_AUTHORING_INSTRUCTION =
  "Skill creation routing: Local fallback. For a general request to create or update a skill, use the bundled local skill-creator guidance. User-provided valid name, intended behavior, source or content, and workspace-local target take precedence over generic defaults; do not ask again for details already supplied. If the user supplies a complete valid SKILL.md, preserve its body and content rather than regenerating it. Keep one complete file at <current-workspace>/.opencode/skills/<skill-name>/SKILL.md. Never override a valid user-specified local target; reject or clarify an invalid or outside target instead. Validate and re-read the file after writing. Explicit workspace-local requests are always handled directly by this local path. There is no Cloud or server persistence mode for authored skills; never save one remotely.";

// fix(L3): 组织连接器是 Cloud MCP，不应在搜索为空后被误判为本地 MCP。
// before: 只提示关键词变体；after: 明确空目录结果的边界。
// TIPS：search_capabilities 的入参只有 query 与 limit（additionalProperties: false）。
// 提示模型传 type 之类的过滤字段会被服务端拒绝，等于把搜索本身弄失败。
// TIPS：组织连接现在还带工作区级开关。成员在本工作区关掉的连接，服务端会以
// status "disabled_in_workspace" 的伪匹配回来；搜索为空时也要把这一档说清楚，
// 否则模型会把「我自己关的」误报成「没授权」，把人送去重走授权流程。
export const JUGGLEWORK_CLOUD_CONNECTION_INSTRUCTION =
  `${JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION} The JuggleWork Cloud connection is verified ready for this exact workspace/model. For org-connected services other than local image/video generation, use jugglework-cloud_search_capabilities — it accepts only query and limit — with 2-4 keyword variants that include the connection name, then jugglework-cloud_execute_capability with an exact returned name — and only mention services that search (or available_skills) actually returns. If a result has status disabled_in_workspace, that connection is switched off for this workspace by the member: relay its hint, say it can be re-enabled in Settings > Connectors, and do not retry it or suggest reconnecting the account. If every search returns no matches, report that the Cloud capability catalog has not exposed that connection yet, and add that it may also be switched off for this workspace in Settings > Connectors; do not look for it as a local MCP server. When a remote skill is listed under available_skills, call jugglework-cloud_execute_capability with that skill's <capability> directly; do not treat the local OpenCode skill list as the full inventory. Local JuggleWork extensions remain available through jugglework_query/jugglework_execute with extension.actions and extension.call. Settings > Connect is the member connection surface. A successful search proves JuggleWork Cloud itself is authorized, so a downstream connector failure does not mean JuggleWork Cloud needs to be reconnected. If a result has kind connection_status, name connectionStatus.connectionName and relay connectionStatus.action exactly: use Your Connections for the member, the organization Connections dashboard for an org admin, or the provider admin console for a provider-side failure. After the requested human fixes that connector, search again in the same task because results are live, not cached, so unchanged retries return the same error.`;

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

export type JuggleWorkConnectSkillPromptCatalog = {
  instruction: string;
  capabilities: ReadonlySet<string>;
};

export function parseJuggleWorkConnectSkillPromptCatalog(payload: unknown): JuggleWorkConnectSkillPromptCatalog {
  const parsed = connectSkillsResponseSchema.parse(payload);
  const capabilities = new Set(parsed.skills.map((skill) => skill.capability));
  if (parsed.capabilities) {
    const declaredCapabilities = new Set(parsed.capabilities);
    const setsMatch = capabilities.size === declaredCapabilities.size
      && [...capabilities].every((capability) => declaredCapabilities.has(capability));
    if (!setsMatch) throw new Error("Connect skill capabilities do not match the rendered skill catalog");
  }
  return {
    instruction: parsed.instruction,
    capabilities,
  };
}

export async function resolveJuggleWorkConnectSkillPromptCatalog(_input?: unknown, fetcher: JuggleWorkFetch = fetch): Promise<JuggleWorkConnectSkillPromptCatalog> {
  try {
    const { url, token } = requireJuggleWorkServer();
    // Connect skills are server-scoped; workspace/directory query params are unused.
    const response = await fetcher(`${url}/experimental/connect/skills`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return { instruction: "", capabilities: new Set() };
    return parseJuggleWorkConnectSkillPromptCatalog(await parseResponse(response));
  } catch {
    return { instruction: "", capabilities: new Set() };
  }
}

export async function resolveJuggleWorkConnectSkillInstruction(input?: unknown, fetcher: JuggleWorkFetch = fetch): Promise<string> {
  return (await resolveJuggleWorkConnectSkillPromptCatalog(input, fetcher)).instruction;
}

export type JuggleWorkExtensionDiscoveryResolution = {
  instruction: string;
  cloudReady: boolean;
};

function discoveryResolution(instruction: string, cloudReady = false): JuggleWorkExtensionDiscoveryResolution {
  return { instruction, cloudReady };
}

export function composeJuggleWorkExtensionDiscoveryResolution(state: JuggleWorkExtensionConnectState | null): JuggleWorkExtensionDiscoveryResolution {
  if (!state) return discoveryResolution(JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION);
  if (state.workspace?.resolution && state.workspace.resolution !== "resolved") return discoveryResolution(JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION);
  const health = state.cloudHealth;
  if (health?.usable === true && health.usableByCurrentModel === true) {
    return discoveryResolution(JUGGLEWORK_CLOUD_CONNECTION_INSTRUCTION, true);
  }
  if (health?.phase === "engine_disabled" || health?.firstFailure?.code === "engine_disabled" || health?.firstFailure?.code === "cloud_mcp_disabled") {
    return discoveryResolution(JUGGLEWORK_CONNECT_DISABLED_INSTRUCTION);
  }
  if (health) {
    if (!health.desired.present || health.firstFailure?.code === "cloud_mcp_missing") {
      return discoveryResolution(JUGGLEWORK_CONNECT_SIGN_IN_INSTRUCTION);
    }
    return discoveryResolution(JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION);
  }
  if (!state.connectCatalogEnabled || state.googleWorkspace.legacyConfigured) {
    return discoveryResolution(JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION);
  }
  return discoveryResolution(JUGGLEWORK_CONNECT_SIGN_IN_INSTRUCTION);
}

export function composeJuggleWorkExtensionDiscoveryInstruction(state: JuggleWorkExtensionConnectState | null): string {
  return composeJuggleWorkExtensionDiscoveryResolution(state).instruction;
}

export function composeSteeringFromEngineMcpStatus(status: string | undefined): string {
  return composeSteeringResolutionFromEngineMcpStatus(status).instruction;
}

export function composeSteeringResolutionFromEngineMcpStatus(status: string | undefined): JuggleWorkExtensionDiscoveryResolution {
  // This status is the in-process projection used to build the current prompt's
  // MCP tool set, so connected proves readiness without a second server probe.
  if (status === "connected") return discoveryResolution(JUGGLEWORK_CLOUD_CONNECTION_INSTRUCTION, true);
  if (status === "disabled") return discoveryResolution(JUGGLEWORK_CONNECT_DISABLED_INSTRUCTION);
  if (status === "needs_auth" || status === "needs_client_registration") {
    return discoveryResolution(JUGGLEWORK_CONNECT_SIGN_IN_INSTRUCTION);
  }
  return discoveryResolution(JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION);
}

export function composeSkillAuthoringInstruction(input: {
  cloudReady: boolean;
  capabilities: ReadonlySet<string>;
}): {
  mode: "remote-guided-local" | "local";
  prompt: string;
} {
  if (input.cloudReady && input.capabilities.has("skill:create-skill")) {
    return { mode: "remote-guided-local", prompt: JUGGLEWORK_CLOUD_SKILL_AUTHORING_INSTRUCTION };
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
  return (await resolveJuggleWorkExtensionDiscovery(input, fetcher, engine)).instruction;
}

export async function resolveJuggleWorkExtensionDiscovery(
  input?: unknown,
  fetcher: JuggleWorkFetch = fetch,
  engine: JuggleWorkEngineMcpStatusSource = {},
): Promise<JuggleWorkExtensionDiscoveryResolution> {
  if (engine.client) {
    try {
      // Invariant: the OpenCode engine owns MCP registration and builds the
      // prompt tool list, so tool-availability steering must come from that
      // same in-process MCP state. Server health probes may fail for reasons
      // (for example corporate TLS trust) that do not affect engine tools.
      const engineStatus = await fetchEngineMcpStatus(input, engine);
      if (engineStatus.found) return composeSteeringResolutionFromEngineMcpStatus(engineStatus.status);
    } catch {
      return discoveryResolution(JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION);
    }
  }
  try {
    return composeJuggleWorkExtensionDiscoveryResolution(await fetchJuggleWorkConnectState(input, fetcher));
  } catch {
    return discoveryResolution(JUGGLEWORK_EXTENSION_DISCOVERY_INSTRUCTION);
  }
}
