import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { z } from "zod";
import { responseLanguageInstruction } from "@jugglework/types/response-language";
import { generateArtifactFiles } from "./artifact-generate.js";
import { OFFICE_EDITING_INSTRUCTION, renderOfficeEditingContext } from "./office-editing-context.js";
import type { JuggleWorkAffordanceDescriptor, JuggleWorkAffordanceEffects } from "@jugglework/types/jugglework-affordance";
import {
  combineInstructionSections,
  composeAgentInstructions,
  createInstructionSection,
} from "./agent-instruction-compose.js";
import {
  composeSkillAuthoringInstruction,
  resolveJuggleWorkConnectSkillPromptCatalog,
  resolveJuggleWorkExtensionDiscovery,
  type OpenCodeContext,
  type JuggleWorkEngineMcpStatusClient,
} from "./jugglework-extensions-preview-steering.js";
import {
  buildJuggleWorkProviderContributions,
  type ConnectSkillDescriptor,
  type EngineMcpDescriptor,
} from "./jugglework-provider-adapters.js";

type ExtensionActionPayload = {
  extensionId: string;
  action: string;
  args: Record<string, unknown>;
  context: ReturnType<typeof contextPayload>;
};

type ResponseLanguage = "en" | "zh";

const listActionsArgsSchema = z.object({
  extensionId: z.string().optional().describe("Optional extension id to filter by, such as google-workspace."),
});

const callArgsSchema = z.object({
  extensionId: z.string().describe("Extension id, such as google-workspace."),
  action: z.string().describe("Action id from extension.actions."),
  args: z.record(z.string(), z.unknown()).optional().describe("JSON arguments for the action."),
});

const imageModelsListArgsSchema = z.object({
  mode: z.enum(["text-to-image", "image-to-image", "multi-image-to-image"]).optional()
    .describe("Optional image generation mode to filter configured ready models."),
});

const imageGenerateArgsSchema = z.object({
  prompt: z.string().trim().min(1).describe("Image generation or editing prompt."),
  mode: z.enum(["text-to-image", "image-to-image", "multi-image-to-image"]).default("text-to-image")
    .describe("Generation mode. Reference images are required for edit modes."),
  model: z.object({ providerID: z.string().trim().min(1), modelID: z.string().trim().min(1) }).optional()
    .describe("Optional exact configured model. Omit to use the first ready compatible model."),
  sourceImagePaths: z.array(z.string().trim().min(1)).max(16).optional()
    .describe("Workspace-relative reference image paths; one for image-to-image, 2-16 for multi-image-to-image."),
  size: z.string().optional().describe("Optional provider-supported output size, such as auto or 1024x1024."),
  filename: z.string().trim().max(100).optional().describe("Optional output filename stem."),
});

const videoModelsListArgsSchema = z.object({
  mode: z.enum(["text-to-video", "image-to-video"]).optional(),
});

const videoGenerateArgsSchema = z.object({
  prompt: z.string().trim().min(1),
  mode: z.enum(["text-to-video", "image-to-video"]),
  model: z.object({ providerID: z.string().trim().min(1), modelID: z.string().trim().min(1) }).optional(),
  sourceImagePath: z.string().trim().min(1).optional(),
  durationSeconds: z.number().int().positive().optional(),
  resolution: z.string().optional(),
  filename: z.string().trim().max(100).optional(),
  clientRequestId: z.string().trim().min(1).optional(),
});

const videoJobArgsSchema = z.object({
  jobId: z.string().trim().min(1).describe("Video job id returned by jugglework_video_generate."),
});

async function callLocalExtension(
  extensionId: string,
  action: string,
  args: Record<string, unknown>,
  context: OpenCodeContext,
) {
  return postJson("/experimental/extensions/call", {
    extensionId,
    action,
    args,
    context: contextPayload(context),
  });
}

const TERMINAL_VIDEO_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "submission_unknown"]);
const VIDEO_JOB_WAIT_TIMEOUT_MS = 20 * 60 * 1000;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function videoJobFromExtensionResponse(value: unknown): Record<string, unknown> | null {
  const envelope = objectRecord(value);
  const result = objectRecord(envelope?.result);
  const job = objectRecord(result?.job);
  return job && typeof job.id === "string" && typeof job.status === "string" ? job : null;
}

function waitForDelay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Video generation wait was cancelled.", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Video generation wait was cancelled.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForVideoJob(
  initialResponse: unknown,
  context: OpenCodeContext,
  pollIntervalMs = 5_000,
) {
  let response = initialResponse;
  let job = videoJobFromExtensionResponse(response);
  if (!job || TERMINAL_VIDEO_JOB_STATUSES.has(String(job.status))) return response;
  const deadline = Date.now() + VIDEO_JOB_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    response = await callLocalExtension("media-generation", "video_job_get", { jobId: String(job.id) }, context);
    job = videoJobFromExtensionResponse(response);
    if (!job || TERMINAL_VIDEO_JOB_STATUSES.has(String(job.status))) return response;
    await waitForDelay(pollIntervalMs, context.abort);
  }
  throw new Error("video_generation_wait_timeout");
}

const juggleworkAffordanceRequestSchema = z.object({
  id: z.string().trim().min(1).describe("Semantic affordance id from jugglework_context."),
  args: z.record(z.string(), z.unknown()).optional().describe("JSON arguments for the affordance."),
  expectedRevision: z.number().int().nonnegative().optional().describe("Context revision from jugglework_context. Use for commands to prevent stale writes."),
  actor: z.string().trim().min(1).optional().describe("Optional agent or client id used to attribute serialized commands."),
});

const connectSkillDescriptorSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  capability: z.string(),
}).passthrough();

const connectSkillsEnvelopeSchema = z.object({
  skills: z.array(connectSkillDescriptorSchema),
}).passthrough();

const sessionSearchArgsSchema = z.object({
  query: z.string().trim().min(1).describe("Text to search for across JuggleWork session titles and message transcripts."),
  workspaceId: z.string().trim().optional().describe("Optional JuggleWork workspace id/name to limit the search."),
  limit: z.number().int().positive().max(20).optional().describe("Maximum matching sessions to return. Defaults to 10, max 20."),
  scanLimit: z.number().int().positive().max(500).optional().describe("Maximum newest sessions to scan across matching workspaces. Defaults to 100, max 500."),
  messageLimit: z.number().int().positive().max(1000).optional().describe("Maximum recent messages to load per scanned session. Defaults to 400, max 1000."),
});

const sessionReadArgsSchema = z.object({
  sessionId: z.string().trim().min(1).describe("JuggleWork/OpenCode session ID returned by session.search."),
  workspaceId: z.string().trim().optional().describe("Optional JuggleWork workspace id/name. Omit to resolve the session across all workspaces."),
  count: z.number().int().positive().max(100).optional().describe("Number of recent transcript messages to return. Defaults to 30, max 100."),
});

const sessionCreateArgsSchema = z.object({
  sessions: z.array(z.object({
    title: z.string().trim().min(1).max(120).describe("Short title shown in the JuggleWork session list."),
    prompt: z.string().trim().min(1).max(100_000).describe("Self-contained task to start in the new session."),
  })).min(1).describe("One entry per new session to create and start."),
  workspaceId: z.string().trim().optional().describe("Optional JuggleWork workspace id/name. Defaults to the workspace containing the current session."),
});

const workspaceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  path: z.string().optional(),
  displayName: z.string().optional(),
}).passthrough();

const workspaceListEnvelopeSchema = z.object({
  items: z.array(workspaceSchema),
}).passthrough();

const sessionTimeSchema = z.object({
  created: z.number().optional(),
  updated: z.number().optional(),
}).passthrough();

const sessionInfoSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  time: sessionTimeSchema.optional(),
}).passthrough();

const sessionListEnvelopeSchema = z.object({
  items: z.array(sessionInfoSchema),
}).passthrough();

const sessionEnvelopeSchema = z.object({
  item: sessionInfoSchema,
}).passthrough();

const createdSessionEnvelopeSchema = z.object({
  item: sessionInfoSchema,
  started: z.boolean(),
}).passthrough();

const sessionPartSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
}).passthrough();

const sessionMessageSchema = z.object({
  info: z.object({
    id: z.string(),
    role: z.string(),
    time: sessionTimeSchema.optional(),
  }).passthrough(),
  parts: z.array(sessionPartSchema),
}).passthrough();

const sessionMessagesEnvelopeSchema = z.object({
  items: z.array(sessionMessageSchema),
}).passthrough();

const JUGGLEWORK_AGENT_SURFACE_INSTRUCTION =
  `## JuggleWork app context
Use jugglework_context when the request depends on the current JuggleWork screen, open tabs, split view, focused pane, sidebar, side panel, settings panel, or available app actions.
Each affordance declares its effects and executor. Use jugglework_query only for side-effect-free affordances whose executor is JuggleWork. Use jugglework_execute for JuggleWork commands without activating the desktop window. If executor names another tool, call that exact tool instead.
Reading another session does not require opening it. Prefer session.search then session.read for transcript questions; use session.create for new chats and a UI command only when the user asks to navigate.
To open settings or navigate the app, use jugglework_execute with ids from jugglework_context such as settings.panel.open — never browser_* tools for the JuggleWork app itself.`;

const JUGGLEWORK_BROWSER_INSTRUCTION =
  `Do NOT use browser_navigate, browser_click, or browser_snapshot to interact with the JuggleWork app itself. Those are for browsing external websites.

## Built-in Browser (external websites)
For web browsing tasks, ALWAYS start with jugglework_execute id browser.open_url. It creates/selects a built-in JuggleWork browser tab and returns browser_url plus target_id. Use that exact browser_url and target_id for every later browser_snapshot, browser_click, browser_fill, browser_eval, and browser_screenshot call.
Do not call browser_navigate without a target_id returned by browser.open_url. Do not use browser_* tools on the JuggleWork app target (avoid targets with title "JuggleWork" or URLs containing ":5173/#/").`;

// ── UI control bridge discovery ──

type UiBridge = { baseUrl: string; token: string };
let cachedBridge: UiBridge | null = null;
let cachedBridgeAt = 0;
const BRIDGE_CACHE_MS = 2_000;
const BRIDGE_TIMEOUT_MS = 5_000;

type JuggleWorkWorkspace = z.infer<typeof workspaceSchema>;
type SessionInfo = z.infer<typeof sessionInfoSchema>;
type SessionMessage = z.infer<typeof sessionMessageSchema>;
type SessionSearchSnippet = { before: string; match: string; after: string };
type SessionSearchResult = {
  workspaceId: string;
  workspace: string;
  sessionId: string;
  title: string;
  updatedAt: number;
  kind: "title" | "message";
  snippet: SessionSearchSnippet;
  role?: string;
  messageId?: string;
  messageIndex?: number;
};
type CreatedJuggleWorkSessionResult = {
  ok: true;
  sessionId: string;
  title: string;
  started: boolean;
  route: string;
};
type FailedJuggleWorkSessionResult = {
  ok: false;
  title: string;
  error: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const affordanceReadEffects: JuggleWorkAffordanceEffects = { data: "read", ui: "none", external: false };
const affordanceWriteEffects: JuggleWorkAffordanceEffects = { data: "write", ui: "none", external: false };
const affordanceExternalWriteEffects: JuggleWorkAffordanceEffects = { data: "write", ui: "none", external: true };

const officeAffordances: JuggleWorkAffordanceDescriptor[] = [
  {
    id: "office.selection", kind: "query", title: "Office selections for this turn",
    description: "Read this exact user turn's fixed selection references before editing. A selection turn requires selectionRef for discovery, calls and saving; never fall back to the current tab.",
    provider: { id: "jugglework-office", kind: "builtin" }, arguments: [],
    effects: affordanceReadEffects, confirmation: "never", availability: { enabled: true }, executor: { kind: "jugglework" },
  },
  {
    id: "office.tools", kind: "query", title: "Office content tool schema",
    description: "List names/descriptions for this chat's current document format. Pass name to get one tool's exact inputSchema, before office.call.",
    provider: { id: "jugglework-office", kind: "builtin" }, arguments: [{name: "name", type: "string", required: false, description: "Exact native content tool name; omit to list names."}, {name: "selectionRef", type: "string", required: false, description: "Required for selection turns; use a reference returned by office.selection."}],
    effects: affordanceReadEffects, confirmation: "never", availability: { enabled: true }, executor: { kind: "jugglework" },
  },
  {
    id: "office.call", kind: "command", title: "Edit current Office document",
    description: "Run a content tool with {name,args}, against this chat's live model. Get its schema using office.tools first. Lifecycle and save_file are forbidden; save with office.save_document.",
    provider: { id: "jugglework-office", kind: "builtin" }, arguments: [{name: "name", type: "string", required: true, description: "Exact content tool name."}, {name: "args", type: "object", required: true, description: "Arguments matching the tool schema."}, {name: "selectionRef", type: "string", required: false, description: "Required for selection turns; binds the original document and permitted range."}],
    effects: affordanceWriteEffects, confirmation: "never", availability: { enabled: true }, executor: { kind: "jugglework" },
  },
  {
    id: "office.current_document", kind: "query", title: "Current Office document",
    description: "Read this chat's DOCX, CSV, XLSX or PPTX document, readiness, actual engineFileId and current selection. Does not use global window focus.",
    provider: { id: "jugglework-office", kind: "builtin" }, arguments: [],
    effects: affordanceReadEffects, confirmation: "never", availability: { enabled: true }, executor: { kind: "jugglework" },
  },
  {
    id: "office.save_document", kind: "command", title: "Save current Office document",
    description: "Save this chat's current DOCX, CSV, XLSX or PPTX to its bound original path. No path or format arguments.",
    provider: { id: "jugglework-office", kind: "builtin" }, arguments: [{name: "selectionRef", type: "string", required: false, description: "Required to save the original document in a selection turn."}],
    effects: affordanceWriteEffects, confirmation: "never", availability: { enabled: true }, executor: { kind: "jugglework" },
  },
];

/** 按真实工具上下文解析当前聊天文档，禁止用 UI 全局焦点替代执行归属。 */
async function currentOfficeDocument(context: OpenCodeContext) {
  if (!context.sessionID) throw new Error("Office requires the calling session");
  const signal = AbortSignal.timeout(5_000);
  const workspace = await resolveContextWorkspace(context.workspaceId ?? context.workspaceID, context, signal);
  const response = await serverGet(`/workspace/${encodeURIComponent(workspace.id)}/office/current?sessionId=${encodeURIComponent(context.sessionID)}`, signal);
  if (!isRecord(response) || !(response.document === null || isRecord(response.document))) throw new Error("Invalid Office document context");
  return { workspaceId: workspace.id, document: response.document, selection: response.selection ?? null };
}

function affordanceResult(
  id: string,
  result: unknown,
  effects: JuggleWorkAffordanceEffects,
) {
  if (isRecord(result) && result.ok === false) {
    return {
      ok: false,
      id,
      error: typeof result.error === "string" ? result.error : `${id} failed`,
      code: "failed",
    };
  }
  return { ok: true, id, result, effects };
}

function unavailableAffordance(id: string, error: string) {
  return { ok: false, id, error, code: "unavailable" };
}

function optionalStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" && property.trim().length > 0 ? property : undefined;
}

type JuggleWorkEngineMcpStatusFunction = JuggleWorkEngineMcpStatusClient["mcp"]["status"];

function isJuggleWorkEngineMcpStatusFunction(value: unknown): value is JuggleWorkEngineMcpStatusFunction {
  return typeof value === "function";
}

function readEngineMcpStatusClient(value: unknown): JuggleWorkEngineMcpStatusClient | undefined {
  const client = isRecord(value) ? value.client : undefined;
  const mcp = isRecord(client) ? client.mcp : undefined;
  const status = isRecord(mcp) ? mcp.status : undefined;
  if (!isJuggleWorkEngineMcpStatusFunction(status)) return undefined;
  return { mcp: { status: (request) => status.call(mcp, request) } };
}

function normalizeOpenCodeContext(value: unknown): OpenCodeContext {
  const nested = isRecord(value) ? { ...value, ...(isRecord(value.context) ? value.context : {}) } : value;
  const agent = optionalStringProperty(nested, "agent");
  const sessionID = optionalStringProperty(nested, "sessionID");
  const messageID = optionalStringProperty(nested, "messageID");
  const directory = optionalStringProperty(nested, "directory");
  const worktree = optionalStringProperty(nested, "worktree");
  const workspaceId = optionalStringProperty(nested, "workspaceId");
  const workspaceID = optionalStringProperty(nested, "workspaceID");
  return {
    ...(agent ? { agent } : {}),
    ...(sessionID ? { sessionID } : {}),
    ...(messageID ? { messageID } : {}),
    ...(directory ? { directory } : {}),
    ...(worktree ? { worktree } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceID ? { workspaceID } : {}),
  };
}

function mergeTransformInputWithFactoryContext(input: unknown, factoryContext: OpenCodeContext): unknown {
  if (Object.keys(factoryContext).length === 0) return input;
  const inputRecord = isRecord(input) ? input : {};
  const inputContext = normalizeOpenCodeContext(inputRecord);
  return {
    ...inputRecord,
    context: {
      ...factoryContext,
      ...inputContext,
    },
  };
}

const SESSION_SEARCH_DEFAULT_LIMIT = 10;
const SESSION_SEARCH_DEFAULT_SCAN_LIMIT = 100;
const SESSION_SEARCH_DEFAULT_MESSAGE_LIMIT = 400;
const SESSION_SEARCH_CONCURRENCY = 6;
const SESSION_SNIPPET_BEFORE = 36;
const SESSION_SNIPPET_AFTER = 72;

function userAppDataDir(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support");
  if (platform() === "win32") return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function uiControlDiscoveryPaths(): string[] {
  return [
    process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY?.trim(),
    join(userAppDataDir(), "com.juggleai.jugglework", "jugglework-ui-control.json"),
    join(userAppDataDir(), "com.juggleai.jugglework.dev", "jugglework-ui-control.json"),
  ].filter((p): p is string => Boolean(p));
}

async function discoverUiBridge(): Promise<UiBridge | null> {
  if (cachedBridge && Date.now() - cachedBridgeAt < BRIDGE_CACHE_MS) return cachedBridge;
  for (const candidate of uiControlDiscoveryPaths()) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.baseUrl === "string" && typeof parsed.token === "string") {
        cachedBridge = { baseUrl: parsed.baseUrl, token: parsed.token };
        cachedBridgeAt = Date.now();
        return cachedBridge;
      }
    } catch {
      // Try next
    }
  }
  return null;
}

async function uiBridgeRequest(path: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const bridge = await discoverUiBridge();
  if (!bridge) return { ok: false, error: "JuggleWork UI bridge not available. The desktop app may not be running." };
  try {
    const response = await fetch(`${bridge.baseUrl}${path}`, {
      method: options.method || "GET",
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: text || `HTTP ${response.status}` }; }
  } catch (error) {
    cachedBridge = null;
    cachedBridgeAt = 0;
    return { ok: false, error: `UI bridge unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function serverGet(path: string, signal?: AbortSignal): Promise<unknown> {
  const { url, token } = requireJuggleWorkServer();
  const response = await fetch(`${url}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new Error(errorMessage(payload, "JuggleWork server request failed"));
  return payload;
}

async function readSessionResponseLanguage(
  sessionID: string | undefined,
  context: OpenCodeContext,
): Promise<ResponseLanguage | null> {
  if (!sessionID) return null;
  const directory = context.directory?.trim() || context.worktree?.trim();
  const workspaceId = context.workspaceId?.trim() || context.workspaceID?.trim();
  if (!directory && !workspaceId) return null;
  const query = new URLSearchParams();
  if (directory) query.set("directory", directory);
  else if (workspaceId) query.set("workspaceId", workspaceId);
  try {
    const payload = objectRecord(await serverGet(
      `/internal/session-response-language/${encodeURIComponent(sessionID)}?${query.toString()}`,
    ));
    return payload?.language === "zh" || payload?.language === "en" ? payload.language : null;
  } catch {
    // Language steering is best effort: a transient local-server read failure
    // must not prevent the model request from running.
    return null;
  }
}

async function readConnectSkillDescriptors(): Promise<ConnectSkillDescriptor[]> {
  try {
    const parsed = connectSkillsEnvelopeSchema.safeParse(
      await serverGet("/experimental/connect/skills"),
    );
    return parsed.success ? parsed.data.skills : [];
  } catch {
    return [];
  }
}

async function readEngineMcpDescriptors(
  client: JuggleWorkEngineMcpStatusClient | undefined,
  directory: string | undefined,
): Promise<EngineMcpDescriptor[]> {
  if (!client) return [];
  try {
    const result = await client.mcp.status(directory ? { query: { directory } } : undefined);
    const payload = isRecord(result) && result.data !== undefined ? result.data : result;
    if (!isRecord(payload)) return [];
    return Object.entries(payload).map(([name, entry]) => {
      const status = typeof entry === "string"
        ? entry
        : optionalStringProperty(entry, "status");
      return status ? { name, status } : { name };
    });
  } catch {
    return [];
  }
}

async function readJuggleWorkAgentContext(
  engineMcpStatusClient: JuggleWorkEngineMcpStatusClient | undefined,
  engineMcpStatusDirectory: string | undefined,
): Promise<Record<string, unknown>> {
  const [uiResult, skills, mcps] = await Promise.all([
    uiBridgeRequest("/context"),
    readConnectSkillDescriptors(),
    readEngineMcpDescriptors(engineMcpStatusClient, engineMcpStatusDirectory),
  ]);
  const contributions = buildJuggleWorkProviderContributions(skills, mcps);
  const providerAffordances = [...contributions.flatMap((contribution) => contribution.affordances), ...officeAffordances];
  const uiContext = isRecord(uiResult) && isRecord(uiResult.context) ? uiResult.context : null;
  if (!uiContext) {
    return {
      ok: true,
      context: null,
      ui: uiResult,
      availableAffordances: providerAffordances,
      contributions,
    };
  }
  const uiAffordances = Array.isArray(uiContext.availableAffordances)
    ? uiContext.availableAffordances
    : [];
  return {
    ok: true,
    context: {
      ...uiContext,
      availableAffordances: [...uiAffordances, ...providerAffordances],
      contributions,
    },
  };
}

async function queryJuggleWorkAffordance(rawArgs: unknown, context: OpenCodeContext): Promise<unknown> {
  const request = juggleworkAffordanceRequestSchema.parse(rawArgs);
  if (request.id === "office.tools") {
    if (!context.sessionID || !context.messageID) throw new Error("Office requires the calling session and message");
    const args = z.object({ name: z.string().min(1).optional(), selectionRef: z.string().min(1).optional() }).strict().parse(request.args ?? {});
    const workspace = await resolveContextWorkspace(context.workspaceId ?? context.workspaceID, context);
    const query = new URLSearchParams({sessionId: context.sessionID, messageId: context.messageID, ...(args.name ? {name: args.name} : {}), ...(args.selectionRef ? {selectionRef: args.selectionRef} : {})});
    return affordanceResult(request.id, await serverGet(`/workspace/${encodeURIComponent(workspace.id)}/office/tools?${query}`, AbortSignal.timeout(5_000)), affordanceReadEffects);
  }
  if (request.id === "office.selection") {
    if (!context.sessionID || !context.messageID) throw new Error("Office selections require the calling session and message");
    if (Object.keys(request.args ?? {}).length) throw new Error("Office selection query does not accept target overrides");
    const workspace = await resolveContextWorkspace(context.workspaceId ?? context.workspaceID, context);
    const query = new URLSearchParams({ sessionId: context.sessionID, messageId: context.messageID });
    return affordanceResult(request.id, await serverGet(`/workspace/${encodeURIComponent(workspace.id)}/office/selection?${query}`), affordanceReadEffects);
  }
  if (request.id === "office.current_document") {
    return affordanceResult(request.id, await currentOfficeDocument(context), affordanceReadEffects);
  }
  if (request.id === "session.search") {
    return affordanceResult(
      request.id,
      await searchJuggleWorkSessions(request.args ?? {}),
      affordanceReadEffects,
    );
  }
  if (request.id === "session.read") {
    return affordanceResult(
      request.id,
      await readJuggleWorkSession(request.args ?? {}),
      affordanceReadEffects,
    );
  }
  if (request.id === "extension.actions") {
    const args = listActionsArgsSchema.parse(request.args ?? {});
    const query = args.extensionId ? `?extensionId=${encodeURIComponent(args.extensionId)}` : "";
    return affordanceResult(
      request.id,
      await serverGet(`/experimental/extensions/actions${query}`),
      affordanceReadEffects,
    );
  }
  if (request.id.startsWith("connect.")) {
    return unavailableAffordance(
      request.id,
      "This affordance declares a dedicated Connect executor. Call the tool named in jugglework_context.",
    );
  }
  const result = await uiBridgeRequest("/query", {
    method: "POST",
    body: request,
  });
  return isRecord(result) && typeof result.ok === "boolean"
    ? result
    : unavailableAffordance(request.id, "JuggleWork UI query returned an invalid response.");
}

async function executeJuggleWorkAffordance(
  rawArgs: unknown,
  context: OpenCodeContext,
): Promise<unknown> {
  const request = juggleworkAffordanceRequestSchema.parse(rawArgs);
  if (request.id === "office.call") {
    if (!context.sessionID || !context.messageID) throw new Error("Office editing requires the calling session and message");
    const args = z.object({name: z.string().min(1), args: z.record(z.string(), z.unknown()), selectionRef: z.string().min(1).optional()}).strict().parse(request.args ?? {});
    const workspace = await resolveContextWorkspace(context.workspaceId ?? context.workspaceID, context);
    return affordanceResult(request.id, await postJson(`/workspace/${encodeURIComponent(workspace.id)}/office/call`, {sessionId: context.sessionID, messageId: context.messageID, ...args}), affordanceWriteEffects);
  }
  if (request.id === "office.save_document") {
    if (Object.keys(request.args ?? {}).some((key) => key !== "selectionRef")) throw new Error("Office save does not accept path or format arguments");
    if (!context.sessionID || !context.messageID) throw new Error("Office save requires the calling session and message");
    const args = z.object({ selectionRef: z.string().min(1).optional() }).strict().parse(request.args ?? {});
    const workspace = await resolveContextWorkspace(context.workspaceId ?? context.workspaceID, context);
    return affordanceResult(request.id, await postJson(`/workspace/${encodeURIComponent(workspace.id)}/office/save-for-actor`, {
      sessionId: context.sessionID, messageId: context.messageID, ...args,
    }), affordanceWriteEffects);
  }
  if (request.id === "session.create") {
    return affordanceResult(
      request.id,
      await createJuggleWorkSessions(request.args ?? {}, context),
      affordanceWriteEffects,
    );
  }
  if (request.id === "extension.call") {
    const args = callArgsSchema.parse(request.args ?? {});
    return affordanceResult(
      request.id,
      await postJson("/experimental/extensions/call", {
        extensionId: args.extensionId,
        action: args.action,
        args: args.args ?? {},
        context: contextPayload(context),
      }),
      affordanceExternalWriteEffects,
    );
  }
  if (request.id.startsWith("connect.")) {
    return unavailableAffordance(
      request.id,
      "This affordance declares a dedicated Connect executor. Call the tool named in jugglework_context.",
    );
  }
  const result = await uiBridgeRequest("/command", {
    method: "POST",
    body: request,
  });
  return isRecord(result) && typeof result.ok === "boolean"
    ? result
    : unavailableAffordance(request.id, "JuggleWork UI command returned an invalid response.");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

function buildSessionSnippet(text: string, index: number, length: number): SessionSearchSnippet {
  const start = Math.max(0, index - SESSION_SNIPPET_BEFORE);
  const end = Math.min(text.length, index + length + SESSION_SNIPPET_AFTER);
  const before = `${start > 0 ? "..." : ""}${collapseWhitespace(text.slice(start, index)).trimStart()}`;
  const after = `${collapseWhitespace(text.slice(index + length, end)).trimEnd()}${end < text.length ? "..." : ""}`;
  return { before, match: text.slice(index, index + length), after };
}

function workspaceLabel(workspace: JuggleWorkWorkspace): string {
  return workspace.displayName?.trim() || workspace.name?.trim() || workspace.path?.trim() || workspace.id;
}

function sessionTitle(session: SessionInfo): string {
  return session.title?.trim() || session.id;
}

function sessionUpdatedAt(session: SessionInfo): number {
  return session.time?.updated ?? session.time?.created ?? 0;
}

function messageText(message: SessionMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    if (part.synthetic || part.ignored) continue;
    const text = part.text?.trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

function findTextMatch(text: string, queryLower: string): { index: number; length: number } | null {
  const lower = text.toLowerCase();
  const exact = lower.indexOf(queryLower);
  if (exact >= 0) return { index: exact, length: queryLower.length };

  const terms = queryLower.split(/\s+/).filter((term) => term.length > 1);
  if (terms.length < 2) return null;

  let firstIndex = Number.POSITIVE_INFINITY;
  let firstLength = 0;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index < 0) return null;
    if (index < firstIndex) {
      firstIndex = index;
      firstLength = term.length;
    }
  }
  return Number.isFinite(firstIndex) ? { index: firstIndex, length: firstLength } : null;
}

function titleSearchResult(workspace: JuggleWorkWorkspace, session: SessionInfo, queryLower: string): SessionSearchResult | null {
  const title = sessionTitle(session);
  const text = `${title} ${workspaceLabel(workspace)}`;
  const match = findTextMatch(text, queryLower);
  if (!match) return null;
  return {
    workspaceId: workspace.id,
    workspace: workspaceLabel(workspace),
    sessionId: session.id,
    title,
    updatedAt: sessionUpdatedAt(session),
    kind: "title",
    snippet: buildSessionSnippet(text, match.index, match.length),
  };
}

function messageSearchResult(workspace: JuggleWorkWorkspace, session: SessionInfo, messages: SessionMessage[], queryLower: string): SessionSearchResult | null {
  let fallback: SessionSearchResult | null = null;
  for (const [index, message] of messages.entries()) {
    const role = message.info.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(message);
    if (!text) continue;
    const match = findTextMatch(text, queryLower);
    if (!match) continue;
    const result: SessionSearchResult = {
      workspaceId: workspace.id,
      workspace: workspaceLabel(workspace),
      sessionId: session.id,
      title: sessionTitle(session),
      updatedAt: sessionUpdatedAt(session),
      kind: "message",
      role,
      messageId: message.info.id,
      messageIndex: index,
      snippet: buildSessionSnippet(text, match.index, match.length),
    };
    if (role === "user") return result;
    if (!fallback) fallback = result;
  }
  return fallback;
}

async function listJuggleWorkWorkspaces(signal?: AbortSignal): Promise<JuggleWorkWorkspace[]> {
  return workspaceListEnvelopeSchema.parse(await serverGet("/workspaces", signal)).items;
}

function filterWorkspaces(workspaces: JuggleWorkWorkspace[], workspaceId?: string): JuggleWorkWorkspace[] {
  const query = workspaceId?.trim().toLowerCase();
  if (!query) return workspaces;
  return workspaces.filter((workspace) => {
    const labels = [workspace.id, workspace.name, workspace.displayName, workspace.path]
      .filter((label): label is string => typeof label === "string" && label.trim().length > 0)
      .map((label) => label.trim().toLowerCase());
    return labels.includes(query);
  });
}

async function listWorkspaceSessions(workspace: JuggleWorkWorkspace, limit: number): Promise<SessionInfo[]> {
  const query = new URLSearchParams({ roots: "true", limit: String(limit) });
  return sessionListEnvelopeSchema.parse(
    await serverGet(`/workspace/${encodeURIComponent(workspace.id)}/sessions?${query.toString()}`),
  ).items;
}

async function readWorkspaceSession(workspace: JuggleWorkWorkspace, sessionId: string): Promise<SessionInfo> {
  return sessionEnvelopeSchema.parse(
    await serverGet(`/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(sessionId)}`),
  ).item;
}

async function readSessionMessages(workspace: JuggleWorkWorkspace, sessionId: string, limit: number): Promise<SessionMessage[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  return sessionMessagesEnvelopeSchema.parse(
    await serverGet(`/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`),
  ).items;
}

async function forEachWithConcurrency<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, () => worker()));
}

async function searchJuggleWorkSessions(rawArgs: unknown): Promise<object> {
  const args = sessionSearchArgsSchema.parse(rawArgs);
  const resultLimit = args.limit ?? SESSION_SEARCH_DEFAULT_LIMIT;
  const scanLimit = args.scanLimit ?? SESSION_SEARCH_DEFAULT_SCAN_LIMIT;
  const messageLimit = args.messageLimit ?? SESSION_SEARCH_DEFAULT_MESSAGE_LIMIT;
  const queryLower = args.query.trim().toLowerCase();
  const workspaces = filterWorkspaces(await listJuggleWorkWorkspaces(), args.workspaceId);
  if (!workspaces.length) {
    return { ok: false, error: args.workspaceId ? `No workspace matched ${args.workspaceId}` : "No JuggleWork workspaces are available" };
  }

  const sessions: Array<{ workspace: JuggleWorkWorkspace; session: SessionInfo }> = [];
  const workspaceErrors: Array<{ workspaceId: string; workspace: string; error: string }> = [];
  await Promise.all(workspaces.map(async (workspace) => {
    try {
      const items = await listWorkspaceSessions(workspace, scanLimit);
      for (const session of items) sessions.push({ workspace, session });
    } catch (error) {
      workspaceErrors.push({ workspaceId: workspace.id, workspace: workspaceLabel(workspace), error: unknownErrorMessage(error) });
    }
  }));

  const sessionsToScan = sessions
    .sort((left, right) => sessionUpdatedAt(right.session) - sessionUpdatedAt(left.session))
    .slice(0, scanLimit);
  const matches: SessionSearchResult[] = [];

  await forEachWithConcurrency(sessionsToScan, SESSION_SEARCH_CONCURRENCY, async ({ workspace, session }) => {
    const titleMatch = titleSearchResult(workspace, session, queryLower);
    try {
      const messages = await readSessionMessages(workspace, session.id, messageLimit);
      const messageMatch = messageSearchResult(workspace, session, messages, queryLower);
      if (messageMatch) matches.push(messageMatch);
      else if (titleMatch) matches.push(titleMatch);
    } catch {
      if (titleMatch) matches.push(titleMatch);
    }
  });

  const results = matches
    .filter((match) => match !== undefined)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  return {
    ok: true,
    query: args.query,
    workspaceCount: workspaces.length,
    totalCandidateSessions: sessions.length,
    scannedSessions: sessionsToScan.length,
    scanLimit,
    messageLimit,
    resultLimit,
    workspaceErrors,
    truncated: sessions.length > sessionsToScan.length || results.length > resultLimit,
    results: results.slice(0, resultLimit),
  };
}

async function readJuggleWorkSession(rawArgs: unknown): Promise<object> {
  const args = sessionReadArgsSchema.parse(rawArgs);
  const count = args.count ?? 30;
  const workspaces = filterWorkspaces(await listJuggleWorkWorkspaces(), args.workspaceId);
  if (!workspaces.length) {
    return { ok: false, error: args.workspaceId ? `No workspace matched ${args.workspaceId}` : "No JuggleWork workspaces are available" };
  }

  for (const workspace of workspaces) {
    try {
      const session = await readWorkspaceSession(workspace, args.sessionId);
      const messages = await readSessionMessages(workspace, args.sessionId, count);
      const readable = messages
        .map((message, index) => ({
          index,
          id: message.info.id,
          role: message.info.role,
          text: messageText(message),
        }))
        .filter((message) => message.text.trim().length > 0);
      return {
        ok: true,
        workspaceId: workspace.id,
        workspace: workspaceLabel(workspace),
        sessionId: session.id,
        title: sessionTitle(session),
        updatedAt: sessionUpdatedAt(session),
        returned: readable.length,
        requested: count,
        messages: readable,
      };
    } catch {
      if (args.workspaceId) break;
    }
  }

  return { ok: false, error: `Session ${args.sessionId} was not found in matching JuggleWork workspaces` };
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
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return { message: text };
  }
}

function getStringProperty(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : null;
}

function errorMessage(payload: unknown, fallback: string): string {
  return getStringProperty(payload, "message") ?? getStringProperty(payload, "code") ?? fallback;
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDirPath(path: string): string {
  return path.replace(/\/+$/, "");
}

async function resolveContextWorkspace(workspaceId: string | undefined, context: OpenCodeContext, signal?: AbortSignal): Promise<JuggleWorkWorkspace> {
  const workspaces = await listJuggleWorkWorkspaces(signal);
  if (!workspaces.length) throw new Error("No JuggleWork workspaces are available");
  if (workspaceId) {
    const match = filterWorkspaces(workspaces, workspaceId).at(0);
    if (!match) throw new Error(`No workspace matched ${workspaceId}`);
    return match;
  }
  // TIPS: 非 Git 工作区的 worktree 可能是 /，优先使用本轮实际工作目录。
  const directory = context.directory?.trim() || context.worktree?.trim();
  if (directory) {
    const dir = normalizeDirPath(directory);
    const match = workspaces
      .filter((workspace) => {
        const path = workspace.path?.trim();
        if (!path) return false;
        const root = normalizeDirPath(path);
        return dir === root || dir.startsWith(`${root}/`);
      })
      .sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))
      .at(0);
    if (match) return match;
  }
  const only = workspaces.at(0);
  if (workspaces.length === 1 && only) return only;
  throw new Error(`Multiple JuggleWork workspaces match; pass workspaceId. Available: ${workspaces.map((workspace) => workspaceLabel(workspace)).join(", ")}`);
}

async function createJuggleWorkSessions(rawArgs: unknown, context: OpenCodeContext): Promise<object> {
  const args = sessionCreateArgsSchema.parse(rawArgs);
  const workspace = await resolveContextWorkspace(args.workspaceId, context);
  const results = await Promise.all(args.sessions.map(async (session): Promise<CreatedJuggleWorkSessionResult | FailedJuggleWorkSessionResult> => {
    try {
      const payload = createdSessionEnvelopeSchema.parse(await postJson(
        `/workspace/${encodeURIComponent(workspace.id)}/sessions`,
        session,
      ));
      return {
        ok: true,
        sessionId: payload.item.id,
        title: payload.item.title?.trim() || session.title,
        started: payload.started,
        route: `/workspace/${encodeURIComponent(workspace.id)}/session/${encodeURIComponent(payload.item.id)}`,
      };
    } catch (error) {
      return {
        ok: false,
        title: session.title,
        error: unknownErrorMessage(error),
      };
    }
  }));
  const created = results.filter((result): result is CreatedJuggleWorkSessionResult => result.ok);
  const failures = results.filter((result): result is FailedJuggleWorkSessionResult => !result.ok);
  return {
    ok: failures.length === 0,
    workspaceId: workspace.id,
    workspace: workspaceLabel(workspace),
    created,
    failures,
  };
}

async function postJson(path: string, body: ExtensionActionPayload | Record<string, unknown>): Promise<unknown> {
  const { url, token } = requireJuggleWorkServer();
  const response = await fetch(url + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new Error(errorMessage(payload, "JuggleWork extension call failed"));
  }
  return payload;
}

function contextPayload(context: OpenCodeContext) {
  return {
    agent: context.agent,
    sessionId: context.sessionID,
    messageId: context.messageID,
    workspaceId: context.workspaceId ?? context.workspaceID,
    directory: context.directory,
    worktree: context.worktree,
  };
}

function summarizeFileDelivery(response: unknown, include: (key: string) => boolean) {
  if (!isRecord(response) || !Array.isArray(response.turns) || !Array.isArray(response.files)) throw new Error("Invalid file confirmation");
  const targets = response.turns.filter(isRecord).flatMap((turn) => Array.isArray(turn.targets) ? turn.targets.filter(isRecord).filter((target) => include(String(target.key))) : []);
  const ids = new Set(targets.map((target) => target.artifactId));
  const files = response.files.filter((file) => isRecord(file) && ids.has(file.artifactId));
  return { ok: files.length > 0 && targets.every((target) => target.status === "ready"), files, targets };
}

export const JuggleWorkExtensionsPreview = async (factoryInput?: unknown) => {
  const factoryContext = normalizeOpenCodeContext(factoryInput);
  const engineMcpStatusClient = readEngineMcpStatusClient(factoryInput);
  const engineMcpStatusDirectory = factoryContext.directory ?? factoryContext.worktree;
  return {
  "experimental.chat.system.transform": async (input: unknown, output: { system: string[] }) => {
    const mergedInput = mergeTransformInputWithFactoryContext(input, factoryContext);
    const hookContext = normalizeOpenCodeContext(input);
    const requestContext = {
      ...factoryContext,
      ...hookContext,
      ...(isRecord(input) && isRecord(input.context) ? normalizeOpenCodeContext(input.context) : {}),
    };
    const sessionID = optionalStringProperty(input, "sessionID") ?? hookContext.sessionID;
    const [extensionDiscovery, skillCatalog, responseLanguage, officeContext] = await Promise.all([
      resolveJuggleWorkExtensionDiscovery(mergedInput, fetch, {
        client: engineMcpStatusClient,
        directory: engineMcpStatusDirectory,
      }),
      resolveJuggleWorkConnectSkillPromptCatalog(mergedInput, fetch),
      readSessionResponseLanguage(sessionID, requestContext),
      sessionID ? currentOfficeDocument({ ...requestContext, sessionID }).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    const skillAuthoring = composeSkillAuthoringInstruction({
      cloudReady: extensionDiscovery.cloudReady,
      capabilities: skillCatalog.capabilities,
    });
    if (process.env.JUGGLEWORK_DEV_MODE === "1") {
      console.log("[jugglework:skill-authoring] system prompt selected", {
        mode: skillAuthoring.mode,
        prompt: skillAuthoring.prompt,
        directory: normalizeOpenCodeContext(mergedInput).directory ?? factoryContext.directory ?? null,
      });
    }
    // One section id per concern — combine drops empties/duplicates so routing,
    // remote skills, session, and browser guidance never overlap by accident.
    const sections = combineInstructionSections(
      createInstructionSection("routing", extensionDiscovery.instruction),
      createInstructionSection("agent-surface", JUGGLEWORK_AGENT_SURFACE_INSTRUCTION),
      createInstructionSection("office-editing", `${OFFICE_EDITING_INSTRUCTION}\n${renderOfficeEditingContext(officeContext)}`),
      createInstructionSection("file-delivery", "For Shell/Python document generation use jugglework_artifact_generate (artifact.generate_files). It runs the executable in a dedicated output directory and automatically collects files, even with silent stdout. Save only deliverables there; use the system temporary directory for scripts/cache. Use absolute input/script paths. Declare outputs for files written elsewhere in the workspace. Do not use background child processes."),
      createInstructionSection("skill-authoring", skillAuthoring.prompt),
      createInstructionSection("connect-skills", skillCatalog.instruction),
      createInstructionSection("browser", JUGGLEWORK_BROWSER_INSTRUCTION),
      createInstructionSection("response-language", responseLanguage ? responseLanguageInstruction(responseLanguage) : ""),
    );
    output.system.push(...composeAgentInstructions(sections));
  },
  tool: {
    jugglework_artifact_generate: {
      description: "artifact.generate_files: execute a program to generate deliverable files with existing bash permission approval. The host supplies JUGGLEWORK_ARTIFACT_DIR as cwd, then automatically collects outputs after a successful exit. Use an executable (python3, node, python.exe, etc.) and literal arguments; use absolute script/input paths. Does not invoke a shell. Do not launch background children.",
      args: {
        program: z.string().trim().min(1),
        args: z.array(z.string()).max(256),
        outputs: z.array(z.string().min(1)).max(200).optional(),
        timeoutMs: z.number().int().min(1000).max(600000).optional(),
      },
      async execute(args: { program: string; args: string[]; outputs?: string[]; timeoutMs?: number }, context: unknown) {
        const merged = { ...factoryContext, ...normalizeOpenCodeContext(context) };
        if (!merged.sessionID || !merged.messageID) throw new Error("File generation requires a session and tool message");
        const workspace = await resolveContextWorkspace(merged.workspaceId ?? merged.workspaceID, merged);
        const base = `/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(merged.sessionID)}/file-deliveries/generations`;
        const result = await generateArtifactFiles(args, context as Parameters<typeof generateArtifactFiles>[1], {
          prepare: async (outputs) => {
            const response = await postJson(`${base}/prepare`, { messageId: merged.messageID, outputs });
            if (!isRecord(response) || typeof response.generationId !== "string" || typeof response.outputDirectory !== "string") throw new Error("Invalid generation allocation");
            return { generationId: response.generationId, outputDirectory: response.outputDirectory };
          },
          complete: async (generationId, exitCode) => {
            const response = await postJson(`${base}/complete`, { generationId, exitCode });
            return summarizeFileDelivery(response, (key) => key === generationId || key.startsWith(`${generationId}:`));
          },
        });
        return JSON.stringify(result, null, 2);
      },
    },
    jugglework_artifact_register: {
      description: "artifact.register_outputs: register explicit existing workspace files requested by the user. Supplemental only; generation should use jugglework_artifact_generate for automatic collection. Do not register residue from failed generation as successful outputs.",
      args: { outputs: z.array(z.string().min(1)).min(1).max(200) },
      async execute(args: { outputs: string[] }, context: unknown) {
        const merged = { ...factoryContext, ...normalizeOpenCodeContext(context) };
        if (!merged.sessionID || !merged.messageID) throw new Error("File registration requires a session and tool message");
        const permission = context as Parameters<typeof generateArtifactFiles>[1];
        if (typeof permission?.ask !== "function") throw new Error("File registration requires the engine permission context");
        await permission.ask({ permission: "read", patterns: args.outputs, always: [], metadata: { paths: args.outputs } });
        const workspace = await resolveContextWorkspace(merged.workspaceId ?? merged.workspaceID, merged);
        const response = await postJson(`/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(merged.sessionID)}/file-deliveries/register`, { messageId: merged.messageID, outputs: args.outputs });
        return JSON.stringify(summarizeFileDelivery(response, (key) => key.startsWith(`register:${merged.messageID}:`)), null, 2);
      },
    },
    jugglework_image_models_list: {
      description: "List locally configured ready image-generation models. Use this before Cloud search, skills, Pillow, SVG, canvas, or other fallbacks for image generation requests.",
      args: imageModelsListArgsSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = imageModelsListArgsSchema.parse(rawArgs);
        return JSON.stringify(await callLocalExtension("openai-image-generation", "image_models_list", args, { ...factoryContext, ...normalizeOpenCodeContext(context) }), null, 2);
      },
    },
    jugglework_image_generate: {
      description: "Generate or edit an image with a locally configured image model and save a validated artifact in the active workspace. This is the primary tool for requests like 'generate an image'. Do not replace it with an invented skill or Pillow fallback.",
      args: imageGenerateArgsSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = imageGenerateArgsSchema.parse(rawArgs);
        return JSON.stringify(await callLocalExtension("openai-image-generation", "image_generate", args, { ...factoryContext, ...normalizeOpenCodeContext(context) }), null, 2);
      },
    },
    jugglework_video_models_list: {
      description: "List locally configured ready video-generation models before Cloud search or generic fallbacks.",
      args: videoModelsListArgsSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = videoModelsListArgsSchema.parse(rawArgs);
        return JSON.stringify(await callLocalExtension("media-generation", "video_models_list", args, { ...factoryContext, ...normalizeOpenCodeContext(context) }), null, 2);
      },
    },
    jugglework_video_generate: {
      description: "Submit exactly one video-generation request with a locally configured model and wait for its terminal state. The tool returns only after completion, failure, cancellation, or timeout, so summarize the final result immediately and never ask the user to check back. Never resubmit automatically, invoke the provider with bash/curl, or inspect credential stores.",
      args: videoGenerateArgsSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const parsed = videoGenerateArgsSchema.parse(rawArgs);
        const args = { ...parsed, clientRequestId: parsed.clientRequestId ?? randomUUID() };
        const mergedContext = { ...factoryContext, ...normalizeOpenCodeContext(context), abort: context.abort };
        const submitted = await callLocalExtension("media-generation", "video_generate", args, mergedContext);
        return JSON.stringify(await waitForVideoJob(submitted, mergedContext), null, 2);
      },
    },
    jugglework_video_job_get: {
      description: "Get progress or completed artifact metadata for a job returned by jugglework_video_generate. Use this direct local tool to poll until the job reaches a terminal state.",
      args: videoJobArgsSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = videoJobArgsSchema.parse(rawArgs);
        return JSON.stringify(await callLocalExtension("media-generation", "video_job_get", args, { ...factoryContext, ...normalizeOpenCodeContext(context) }), null, 2);
      },
    },
    jugglework_video_job_cancel: {
      description: "Request cancellation of a local video-generation job. Cancellation is best effort and does not delete a completed artifact.",
      args: videoJobArgsSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = videoJobArgsSchema.parse(rawArgs);
        return JSON.stringify(await callLocalExtension("media-generation", "video_job_cancel", args, { ...factoryContext, ...normalizeOpenCodeContext(context) }), null, 2);
      },
    },
    jugglework_context: {
      description: "Read one semantic snapshot of JuggleWork: current screen, retained conversation tabs, split view and focused pane, sidebar and side panel state, settings panel, provider contributions, remote skill guidance, and available affordances with explicit effects and executors.",
      args: {},
      async execute() {
        return JSON.stringify(
          await readJuggleWorkAgentContext(engineMcpStatusClient, engineMcpStatusDirectory),
          null,
          2,
        );
      },
    },
    jugglework_query: {
      description: "Run a side-effect-free JuggleWork affordance whose executor is JuggleWork. Use the exact id and arguments from jugglework_context. This reads backend or app state without navigation or window focus.",
      args: juggleworkAffordanceRequestSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const mergedContext = { ...factoryContext, ...normalizeOpenCodeContext(context) };
        return JSON.stringify(await queryJuggleWorkAffordance(rawArgs, mergedContext), null, 2);
      },
    },
    jugglework_execute: {
      description: "Execute a JuggleWork command whose executor is JuggleWork without activating the desktop window. Use the exact id and arguments from jugglework_context, and pass expectedRevision for UI commands to prevent stale writes. If the descriptor names another executor tool, call that tool instead.",
      args: juggleworkAffordanceRequestSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const mergedContext = { ...factoryContext, ...normalizeOpenCodeContext(context) };
        return JSON.stringify(await executeJuggleWorkAffordance(rawArgs, mergedContext), null, 2);
      },
    },
  },
  };
};
