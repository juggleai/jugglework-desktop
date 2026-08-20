import type {
  AgentPartInput,
  FilePartInput,
  Message,
  OutputFormat,
  Part,
  Session,
  SubtaskPartInput,
  TextPartInput,
  Todo,
} from "@opencode-ai/sdk/v2/client";
import {
  agentContextDiagnosticsReportSchema,
  agentContextDiagnosticsRequestSchema,
  type AgentContextDiagnosticsReport,
  type AgentContextDiagnosticsRequest,
} from "@jugglework/types/agent-context-diagnostics";
import {
  AGENT_CONTEXT_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
  requestAgentContextDiagnosticsPayload,
} from "./agent-context-diagnostics-transport";
import { desktopFetch, desktopFetchAgentContextDiagnostics } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";
import type { ExecResult, OpencodeConfigFile, WorkspaceInfo, WorkspaceList } from "./desktop";
import type { DenOrgMarketplace, DenOrgPluginResolved, DenResourceSnapshot } from "./den-types";
import type { CloudImportedMarketplace, CloudImportedPlugin } from "../cloud/import-state";
import type {
  AutomationDefinitionRecord,
  AutomationDraft,
  AutomationListResponse,
  AutomationRun,
  AutomationRunListResponse,
  AutomationSyncMutation,
  AutomationSchedule,
  AutomationActiveRange,
} from "@jugglework/types/automation";

export type JuggleWorkServerCapabilities = {
  skills: { read: boolean; write: boolean; source: "jugglework" | "opencode" };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
  sandbox?: { enabled: boolean; backend: "none" | "docker" | "container" };
  proxy?: { opencode: boolean };
  toolProviders?: {
    browser?: {
      enabled: boolean;
      placement: "in-sandbox" | "host-machine" | "client-machine" | "external";
      mode: "none" | "headless" | "interactive";
    };
    files?: {
      injection: boolean;
      outbox: boolean;
      inboxPath: string;
      outboxPath: string;
      maxBytes: number;
    };
  };
};

export type JuggleWorkServerStatus = "connected" | "disconnected" | "limited";

export type JuggleWorkServerDiagnostics = {
  ok: boolean;
  version: string;
  uptimeMs: number;
  readOnly: boolean;
  approval: { mode: "manual" | "auto"; timeoutMs: number };
  corsOrigins: string[];
  workspaceCount: number;
  activeWorkspaceId?: string | null;
  selectedWorkspaceId?: string | null;
  workspace: JuggleWorkWorkspaceInfo | null;
  authorizedRoots: string[];
  server: { host: string; port: number; configPath?: string | null };
  tokenSource: { client: string; host: string };
};

export type JuggleWorkServerSettings = {
  urlOverride?: string;
  portOverride?: number;
  token?: string;
  hostToken?: string;
  remoteAccessEnabled?: boolean;
};

// The shared WorkspaceWire contract now carries the opencode block; keep the
// historical name as an alias for the many existing imports.
export type JuggleWorkWorkspaceInfo = WorkspaceInfo;

export type JuggleWorkWorkspaceList = {
  items: JuggleWorkWorkspaceInfo[];
  workspaces?: WorkspaceInfo[];
  activeId?: string | null;
};

export type JuggleWorkSessionMessage = {
  info: Message;
  parts: Part[];
};

export type JuggleWorkSessionSnapshot = {
  session: Session;
  messages: JuggleWorkSessionMessage[];
  todos: Todo[];
  status:
    | { type: "idle" }
    | { type: "busy" }
    | { type: "retry"; attempt: number; message: string; next: number };
};

export type JuggleWorkSessionRunOrigin = "local-renderer" | "remote-control";
export type JuggleWorkSessionRunStatus = "starting" | "running" | "waiting" | "retrying" | "aborting";
export type JuggleWorkSessionRunObservation =
  | JuggleWorkSessionRunStatus
  | "idle"
  | "completed"
  | "failed"
  | "aborted";

export type JuggleWorkSessionRun = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  generation: number;
  origin: JuggleWorkSessionRunOrigin;
  startCommandCorrelationId: string | null;
  abortCommandCorrelationId: string | null;
  status: JuggleWorkSessionRunStatus;
  observedActive: boolean;
  startedAt: number;
  updatedAt: number;
  activeObservedAt: number | null;
  abortRequestedAt: number | null;
};

export type JuggleWorkSessionPrompt = {
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  tools?: Record<string, boolean>;
  format?: OutputFormat;
  system?: string;
  variant?: string;
  parts?: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>;
  reasoning_effort?: string;
};

export type JuggleWorkInteractionOrigin = "local-renderer" | "remote-control";
export type JuggleWorkPermissionResponse = "allow_once" | "always" | "reject";
export type JuggleWorkQuestionAnswer = { questionId: string; values: string[] };
export type JuggleWorkInteractionResolution = { interactionId: string; status: "resolved" };
export type JuggleWorkPermissionReplyInput =
  | {
      origin: "local-renderer";
      commandCorrelationId: string | null;
      response: JuggleWorkPermissionResponse;
    }
  | {
      origin: "remote-control";
      commandCorrelationId: string | null;
      response: Exclude<JuggleWorkPermissionResponse, "always">;
    };

export type JuggleWorkPluginItem = {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  path?: string;
};

export type JuggleWorkSkillItem = {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  trigger?: string;
};

export type JuggleWorkSkillContent = {
  item: JuggleWorkSkillItem;
  content: string;
};

export type JuggleWorkWorkspaceFileContent = {
  path: string;
  content: string;
  bytes: number;
  updatedAt: number;
};

export type JuggleWorkWorkspaceFileWriteResult = {
  ok: boolean;
  path: string;
  bytes: number;
  updatedAt: number;
  revision?: string;
};

export type JuggleWorkWorkspaceFileDeleteResult = {
  ok: boolean;
  path: string;
  code?: string;
};

export type JuggleWorkAuthorizedFoldersResponse = {
  folders: string[];
  hiddenCount: number;
  workspaceRoot: string;
};

export type JuggleWorkAuthorizedFoldersUpdateResponse = {
  folders: string[];
  hiddenCount: number;
  updatedAt: number;
};

export type JuggleWorkRuntimeConfigMigrationResult = {
  migrated: boolean;
  keys: string[];
  legacyKeys: string[];
  userOpencodeKeys: string[];
  updatedAt: number | null;
  legacyError?: string | null;
};

export type JuggleWorkRuntimeDisabledProvidersResult = {
  ok: true;
  disabledProviders: string[];
  changed?: boolean;
};

export type JuggleWorkLegacyConfigSweepState = {
  version: 1;
  sweptAt: string;
  files: Array<{
    path: string;
    removedKeys: string[];
    backupPath: string | null;
  }>;
  error?: string;
};

export type JuggleWorkRuntimeConfigStatus = {
  runtime: Record<string, unknown>;
  runtimeKeys: string[];
  effectiveRuntime: Record<string, unknown>;
  managedFilePath: string;
  managedFileRebuiltAt: number | null;
  managedFileContentRedacted: string | null;
  sweep: JuggleWorkLegacyConfigSweepState | null;
  sources?: {
    projectOpencode: { path: string; exists: boolean; keys: string[]; config: Record<string, unknown> };
    globalOpencode: { path: string; exists: boolean; keys: string[]; config: Record<string, unknown> };
    runtimeDatabase: { keys: string[]; config: Record<string, unknown> };
    injected: { keys: string[]; config: Record<string, unknown> };
  };
  legacyJuggleWork: {
    path: string;
    keys: string[];
    error: string | null;
  };
  userOpencode: {
    path: string;
    exists: boolean;
    keys: string[];
    migratableKeys: string[];
  };
};

export type JuggleWorkDesktopCloudSyncChange = {
  id: string;
  kind: "new" | "modified" | "removed";
  resourceKind: "llmProvider" | "marketplace" | "plugin" | "configItem";
  marketplaceId?: string;
  pluginId?: string;
  previousLastUpdatedAt: string | null;
  nextLastUpdatedAt: string | null;
  queuedAt: number;
};

export type JuggleWorkDesktopCloudSyncState = {
  entries: Record<string, unknown>;
  updatedAt: number;
  version: 1;
};

export type JuggleWorkDesktopCloudSyncResult = {
  changes: JuggleWorkDesktopCloudSyncChange[];
  state: JuggleWorkDesktopCloudSyncState;
};

export type JuggleWorkCloudPluginInstallResult = {
  item: CloudImportedPlugin;
  warnings: string[];
};

export type JuggleWorkCloudPluginsResult = {
  marketplaces: Record<string, CloudImportedMarketplace>;
  plugins: Record<string, CloudImportedPlugin>;
};

export type JuggleWorkClaudePluginComponent = {
  type: "mcp" | "skill" | "command" | "agent";
  name: string;
  description: string | null;
};

export type JuggleWorkClaudePluginPreview = {
  pluginId: string;
  name: string;
  description: string | null;
  version: string | null;
  source: { owner: string; repo: string; ref: string; dir: string | null };
  components: JuggleWorkClaudePluginComponent[];
  warnings: string[];
};

function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export type JuggleWorkCommandItem = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
  scope: "workspace" | "global";
};

export type JuggleWorkMcpItem = {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
};

export type JuggleWorkMcpEngineSync = {
  status: "ok" | "failed";
  at: number;
  failures: Array<{ name: string; status?: number; message?: string }>;
};

export type JuggleWorkCloudMcpProviderModelContext = {
  provider: string;
  model: string;
};

export type JuggleWorkCloudMcpFailureStage =
  | "prerequisites"
  | "token_mint"
  | "desired_config"
  | "engine_delivery"
  | "transport_auth"
  | "tool_registration"
  | "provider_projection"
  | "plugin_load"
  | "steering"
  | "desired"
  | "workspace"
  | "configuration"
  | "registration"
  | "engine_status"
  | "tool_ids"
  | "plugin_canary";

export type JuggleWorkCloudMcpFailureCode =
  | "cloud_desired_missing"
  | "cloud_mcp_missing"
  | "cloud_mcp_disabled"
  | "cloud_endpoint_invalid"
  | "cloud_token_org_mismatch"
  | "cloud_mcp_needs_auth"
  | "invalid_mcp_token"
  | "mcp_session_revoked"
  | "mcp_membership_revoked"
  | "insufficient_mcp_scope"
  | "wrong_mcp_resource"
  | "workspace_directory_ambiguous"
  | "opencode_unconfigured"
  | "opencode_engine_unreachable"
  | "opencode_unreachable"
  | "cloud_status_missing"
  | "cloud_disabled"
  | "jugglework_cloud_auth_required"
  | "jugglework_cloud_auth_invalid"
  | "jugglework_cloud_token_expired"
  | "jugglework_cloud_membership_required"
  | "jugglework_cloud_scope_missing"
  | "jugglework_cloud_resource_forbidden"
  | "jugglework_cloud_resource_not_found"
  | "jugglework_cloud_client_registration_required"
  | "cloud_connection_failed"
  | "cloud_registration_failed"
  | "cloud_tools_denied"
  | "opencode_tool_ids_unsupported"
  | "opencode_tool_ids_unavailable"
  | "cloud_tools_missing"
  | "provider_projection_unavailable"
  | "provider_projection_missing"
  | "extensions_plugin_missing"
  | string;

export type JuggleWorkCloudMcpFailure = {
  code: JuggleWorkCloudMcpFailureCode;
  stage: JuggleWorkCloudMcpFailureStage | string;
  retryable: boolean;
  recommendedAction: string;
  message: string;
  aliases?: string[];
  requestId?: string;
  referenceId?: string;
  details?: unknown;
};

export type JuggleWorkCloudMcpCompatibility = {
  jugglework: {
    serverVersion: string | null;
    app: Record<string, string | number | boolean | null> | null;
  };
  opencode: {
    expectedVersion: string | null;
    actualVersion: string | null;
    probe: "ok" | "unavailable" | "not_checked" | string;
    error?: unknown;
  };
  pluginFileHashes: Array<{
    name: string;
    sha256: string | null;
    error?: string;
  }>;
  supportedFeatures: {
    dynamicMcp: boolean;
    directoryScoping: boolean;
    toolIds: boolean;
    providerToolProjection: boolean;
    pluginCanaries: boolean;
  };
  experimentalToolIds: {
    checked: boolean;
    expected: string[];
    present: string[];
    missing: string[];
    includesMcpTools: boolean | null;
    limitation?: string;
    error?: unknown;
  };
  experimentalProviderTools: {
    checked: boolean;
    provider?: string;
    model?: string;
    expected: string[];
    present: string[];
    missing: string[];
    includesMcpTools: boolean | null;
    limitation?: string;
    error?: unknown;
  };
};

export type JuggleWorkCloudMcpHealthPhase =
  | "missing_desired"
  | "workspace_ambiguous"
  | "engine_unconfigured"
  | "engine_unreachable"
  | "engine_missing"
  | "engine_disabled"
  | "engine_needs_auth"
  | "engine_needs_client_registration"
  | "engine_failed"
  | "registration_failed"
  | "denied_by_tools"
  | "tool_ids_unsupported"
  | "cloud_tools_missing"
  | "provider_projection_missing"
  | "extensions_plugin_missing"
  | "ready"
  | string;

export type JuggleWorkCloudMcpDeliverySnapshot = {
  state: "not_desired" | "pending" | "registering" | "ready" | "failed" | "stale" | string;
  desiredRevision: string | null;
  appliedRevision: string | null;
  updatedAt: number | null;
  appliedAt: number | null;
  lastAttemptAt: number | null;
  trigger?: string;
  failure?: JuggleWorkCloudMcpFailure;
};

export type JuggleWorkCloudMcpProbeStep = {
  step: "initialize" | "initialized_notice" | "tools_list" | string;
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  error?: unknown;
};

export type JuggleWorkCloudMcpProbeTrace = {
  endpoint: string | null;
  startedAt: string;
  latencyMs: number;
  protocolVersion: string | null;
  serverInfo: { name: string | null; version: string | null } | null;
  steps: JuggleWorkCloudMcpProbeStep[];
};

export type JuggleWorkCloudMcpEngineRefreshStep = {
  step: "engine_disconnect" | "reapply" | string;
  ok: boolean;
  latencyMs: number;
  detail?: unknown;
};

export type JuggleWorkCloudMcpEngineRefresh = {
  performed: boolean;
  reason?: "desired_missing" | string;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  steps: JuggleWorkCloudMcpEngineRefreshStep[];
};

export type JuggleWorkCloudMcpEngineRefreshResult = {
  refresh: JuggleWorkCloudMcpEngineRefresh;
  health: JuggleWorkCloudMcpHealth;
};

export type JuggleWorkCloudMcpHealth = {
  schemaVersion: 1;
  phase: JuggleWorkCloudMcpHealthPhase;
  usable: boolean;
  usableByCurrentModel: boolean | null;
  connectCatalogEnabled: boolean;
  workspace: {
    id: string;
    type: string;
    directory: string | null;
    path: string;
  };
  desired: {
    present: boolean;
    name: "jugglework-cloud";
    revision: string | null;
    config: Record<string, unknown> | null;
    token: {
      present: boolean;
      metadata: Record<string, string | number | boolean | null>;
    };
    org?: Record<string, string | number | boolean | null>;
    app?: Record<string, string | number | boolean | null>;
    updatedAt?: number;
  };
  delivery: JuggleWorkCloudMcpDeliverySnapshot;
  engine: {
    status: "not_checked" | "missing" | "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration" | "unreachable" | "unknown" | string;
    error?: unknown;
  };
  /** The engine's own view of every MCP server it tracks (older servers omit this). */
  engineInspection?: {
    checked: boolean;
    cloudPresent?: boolean;
    serverCount?: number;
    servers?: Array<{ name: string; status: string; error?: string }>;
  };
  tools: {
    expected: string[];
    present: string[];
    missing: string[];
    direct: {
      checked: boolean;
      source: "mcp_tools_list" | string;
      expected: string[];
      present: string[];
      missing: string[];
      trace?: JuggleWorkCloudMcpProbeTrace;
      error?: unknown;
      failure?: JuggleWorkCloudMcpFailure;
    };
    providerProjection: {
      checked: boolean;
      provider?: string;
      model?: string;
      source?: "experimental_tool" | "provider_capability" | string;
      limitation?: string;
      modelExists?: boolean;
      toolCalling?: boolean | null;
      present: string[];
      missing: string[];
      error?: unknown;
    };
  };
  pluginCanaries: {
    expected: string[];
    present: string[];
    missing: string[];
  };
  compatibility: JuggleWorkCloudMcpCompatibility;
  toolDenies: unknown[];
  firstFailure: JuggleWorkCloudMcpFailure | null;
  checkedAt: string;
  durationMs?: number;
};

export type JuggleWorkCloudMcpReconcilePayload = {
  workspaceId: string;
  name: "jugglework-cloud";
  config: Record<string, unknown>;
  tokenMetadata?: Record<string, string | number | boolean | null>;
  org?: Record<string, string | number | boolean | null>;
  app?: Record<string, string | number | boolean | null>;
  appVersion?: string;
  buildSha?: string;
  connectCatalogEnabled?: boolean;
  trigger?: string;
  provider?: string;
  model?: string;
};

export type JuggleWorkWorkspaceExport = {
  workspaceId: string;
  exportedAt: number;
  opencode?: Record<string, unknown>;
  jugglework?: Record<string, unknown>;
  skills?: Array<{ name: string; description?: string; trigger?: string; content: string }>;
  commands?: Array<{ name: string; description?: string; template?: string }>;
  files?: Array<{ path: string; content: string }>;
};

export type JuggleWorkWorkspaceImportChange = {
  kind: "opencode" | "jugglework" | "skill" | "command" | "file";
  action: "create" | "update" | "replace" | "delete" | "unchanged";
  label: string;
  path: string;
};

export type JuggleWorkWorkspaceImportPreview = {
  fingerprint: string;
  summary: {
    total: number;
    create: number;
    update: number;
    replace: number;
    delete: number;
    unchanged: number;
  };
  changes: JuggleWorkWorkspaceImportChange[];
};

export type JuggleWorkWorkspaceExportSensitiveMode = "auto" | "include" | "exclude";

export type JuggleWorkWorkspaceExportWarning = {
  id: string;
  label: string;
  detail: string;
};

export type JuggleWorkBlueprintSessionsMaterializeResult = {
  ok: boolean;
  created: Array<{ templateId: string; sessionId: string; title: string }>;
  existing: Array<{ templateId: string; sessionId: string }>;
  openSessionId: string | null;
};

export type JuggleWorkArtifactItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  createdAt?: number;
  updatedAt?: number;
  mime?: string;
};

export type JuggleWorkArtifactList = {
  items: JuggleWorkArtifactItem[];
};

export type GoogleWorkspaceAccount = {
  accountId: string | null;
  email: string | null;
  name: string | null;
  picture: string | null;
  sub: string | null;
  scopes?: string[];
  connectedAt?: string | null;
};

export type GoogleWorkspaceAuthStatus = {
  configured: boolean;
  missing: string[];
  customClient: boolean;
  vault: "encrypted" | "plaintext-dev" | "unavailable";
  connected: boolean;
  account: GoogleWorkspaceAccount | null;
  accounts: GoogleWorkspaceAccount[];
  activeAccountId: string | null;
  scopes: string[];
  connectedAt: string | null;
  error: string | null;
  testStatus: string | null;
  smokeTest: {
    driveFileId: string | null;
    driveFileName: string | null;
    gmailDraftId: string | null;
  } | null;
  connect?: {
    enabled: true;
    cloudMcpPresent: boolean;
    guidance: string;
  };
};

export type JuggleWorkConnectState = {
  ok: true;
  schemaVersion: 1;
  connectEnabled: boolean;
  cloudMcpPresent: boolean;
  googleWorkspace: { legacyConfigured: boolean };
};

export type GoogleWorkspaceConnectStart = {
  flowId: string;
  authUrl: string;
  expiresAt: number;
};

export type GoogleWorkspaceConnectStatus = {
  flowId: string;
  status: "pending" | "connected" | "failed" | "expired";
  expiresAt: number;
  error: string | null;
  googleWorkspace: GoogleWorkspaceAuthStatus | null;
};

export type JuggleWorkExtensionActionCall = {
  extensionId: string;
  action: string;
  args?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type JuggleWorkExtensionActionResult =
  | {
    ok: true;
    extensionId: string;
    action: string;
    result: unknown;
    context?: Record<string, unknown>;
  }
  | {
    ok: false;
    error: string;
    message: string;
  };

export type JuggleWorkResolvedArtifactTarget = {
  id: string;
  kind: "file" | "url";
  value: string;
  name: string;
  preview: "browser" | "markdown" | "sheet" | "slides" | "image" | "pdf" | "html" | "text" | "external";
  confidence: number;
  reason: string;
  exists?: boolean;
  size?: number;
  updatedAt?: number;
  contentType?: string;
};

export type JuggleWorkWorkspaceFileStat = {
  ok: boolean;
  path: string;
  exists: boolean;
  kind?: "file" | "dir" | "other";
  size?: number;
  updatedAt?: number;
};

export type JuggleWorkInboxItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  updatedAt?: number;
};

export type JuggleWorkInboxList = {
  items: JuggleWorkInboxItem[];
};

export type JuggleWorkInboxUploadResult = {
  ok: boolean;
  path: string;
  bytes: number;
};

export type JuggleWorkUserEnvItem = {
  key: string;
  updatedAt: number;
  hasValue: boolean;
  value?: string;
};

export type JuggleWorkActor = {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
};

export type JuggleWorkAuditEntry = {
  id: string;
  workspaceId: string;
  actor: JuggleWorkActor;
  action: string;
  target: string;
  summary: string;
  timestamp: number;
};

export type JuggleWorkReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export type JuggleWorkReloadEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  reason: "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";
  trigger?: JuggleWorkReloadTrigger;
  timestamp: number;
};

export type JuggleWorkSessionGroupDefinition = {
  id: string;
  label: string;
};

export type JuggleWorkSessionGroupState = {
  groups: JuggleWorkSessionGroupDefinition[];
  assignments: Record<string, string>;
};

export type JuggleWorkSessionGroupEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  type: "session_groups.updated";
  action: "created" | "updated" | "deleted" | "assigned" | "reordered" | "imported";
  groupId?: string;
  sessionId?: string;
  timestamp: number;
};

// Fallback for explicit server-mode URL derivation. Desktop local workers replace this
// with the persisted runtime-discovered port once the host reports it.
export const DEFAULT_JUGGLEWORK_SERVER_PORT = 8787;

const STORAGE_URL_OVERRIDE = "jugglework.server.urlOverride";
const STORAGE_PORT_OVERRIDE = "jugglework.server.port";
const STORAGE_TOKEN = "jugglework.server.token";
const STORAGE_HOST_AUTH_KEY = "jugglework.server.hostToken";
const STORAGE_REMOTE_ACCESS = "jugglework.server.remoteAccessEnabled";

export function normalizeJuggleWorkServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export function isLoopbackJuggleWorkServerUrl(input: string) {
  const normalized = normalizeJuggleWorkServerUrl(input) ?? "";
  if (!normalized) return false;
  try {
    const hostname = new URL(normalized).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function parseJuggleWorkWorkspaceIdFromUrl(input: string) {
  const normalized = normalizeJuggleWorkServerUrl(input) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const legacyIndex = segments.indexOf("w");
    if (legacyIndex >= 0 && segments[legacyIndex + 1]) {
      return decodeURIComponent(segments[legacyIndex + 1]);
    }
    const workspaceIndex = segments.indexOf("workspace");
    if (workspaceIndex >= 0 && segments[workspaceIndex + 1]) {
      return decodeURIComponent(segments[workspaceIndex + 1]);
    }
    return null;
  } catch {
    const match = normalized.match(/\/(?:w|workspace)\/([^/?#]+)/);
    if (!match?.[1]) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}

export function buildJuggleWorkWorkspaceBaseUrl(hostUrl: string, workspaceId?: string | null) {
  const normalized = normalizeJuggleWorkServerUrl(hostUrl) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const workspaceIndex = segments.indexOf("workspace");
    const legacyIndex = segments.indexOf("w");
    const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
    if (mountIndex >= 0 && segments[mountIndex + 1]) {
      const prefix = segments.slice(0, mountIndex).join("/");
      url.pathname = `${prefix ? `/${prefix}` : ""}/workspace/${encodeURIComponent(
        decodeURIComponent(segments[mountIndex + 1]),
      )}`;
      return url.toString().replace(/\/+$/, "");
    }

    const id = (workspaceId ?? "").trim();
    if (!id) return url.toString().replace(/\/+$/, "");

    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/workspace/${encodeURIComponent(id)}`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    const id = (workspaceId ?? "").trim();
    if (!id) return normalized;
    return `${normalized.replace(/\/+$/, "")}/workspace/${encodeURIComponent(id)}`;
  }
}

const JUGGLEWORK_INVITE_PARAM_URL = "ow_url";
const JUGGLEWORK_INVITE_PARAM_TOKEN = "ow_token";
const JUGGLEWORK_INVITE_PARAM_STARTUP = "ow_startup";
const JUGGLEWORK_INVITE_PARAM_AUTO_CONNECT = "ow_auto_connect";

export type JuggleWorkConnectInvite = {
  url: string;
  token?: string;
  startup?: "server";
  autoConnect?: boolean;
};

export function readJuggleWorkConnectInviteFromSearch(input: string | URLSearchParams) {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;

  const rawUrl = search.get(JUGGLEWORK_INVITE_PARAM_URL)?.trim() ?? "";
  const url = normalizeJuggleWorkServerUrl(rawUrl);
  if (!url) return null;

  const token = search.get(JUGGLEWORK_INVITE_PARAM_TOKEN)?.trim() ?? "";
  const startupRaw = search.get(JUGGLEWORK_INVITE_PARAM_STARTUP)?.trim() ?? "";
  const startup = startupRaw === "server" ? "server" : undefined;
  const autoConnect = search.get(JUGGLEWORK_INVITE_PARAM_AUTO_CONNECT)?.trim() === "1";

  return {
    url,
    token: token || undefined,
    startup,
    autoConnect: autoConnect || undefined,
  } satisfies JuggleWorkConnectInvite;
}

export function stripJuggleWorkConnectInviteFromUrl(input: string) {
  try {
    const url = new URL(input);
    url.searchParams.delete(JUGGLEWORK_INVITE_PARAM_URL);
    url.searchParams.delete(JUGGLEWORK_INVITE_PARAM_TOKEN);
    url.searchParams.delete(JUGGLEWORK_INVITE_PARAM_STARTUP);
    url.searchParams.delete(JUGGLEWORK_INVITE_PARAM_AUTO_CONNECT);
    return url.toString();
  } catch {
    return input;
  }
}

export function readJuggleWorkServerSettings(): JuggleWorkServerSettings {
  if (typeof window === "undefined") return {};
  try {
    const urlOverride = normalizeJuggleWorkServerUrl(
      window.localStorage.getItem(STORAGE_URL_OVERRIDE) ?? "",
    );
    const portRaw = window.localStorage.getItem(STORAGE_PORT_OVERRIDE) ?? "";
    const portOverride = portRaw ? Number(portRaw) : undefined;
    const token = window.localStorage.getItem(STORAGE_TOKEN) ?? undefined;
    const hostToken = window.localStorage.getItem(STORAGE_HOST_AUTH_KEY) ?? undefined;
    const remoteAccessRaw = window.localStorage.getItem(STORAGE_REMOTE_ACCESS) ?? "";
    return {
      urlOverride: urlOverride ?? undefined,
      portOverride: Number.isNaN(portOverride) ? undefined : portOverride,
      token: token?.trim() || undefined,
      hostToken: hostToken?.trim() || undefined,
      remoteAccessEnabled: remoteAccessRaw === "1",
    };
  } catch {
    return {};
  }
}

export function writeJuggleWorkServerSettings(next: JuggleWorkServerSettings): JuggleWorkServerSettings {
  if (typeof window === "undefined") return next;
  try {
    const urlOverride = normalizeJuggleWorkServerUrl(next.urlOverride ?? "");
    const portOverride = typeof next.portOverride === "number" ? next.portOverride : undefined;
    const token = next.token?.trim() || undefined;
    const hostToken = next.hostToken?.trim() || undefined;
    const remoteAccessEnabled = next.remoteAccessEnabled === true;

    if (urlOverride) {
      window.localStorage.setItem(STORAGE_URL_OVERRIDE, urlOverride);
    } else {
      window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    }

    if (typeof portOverride === "number" && !Number.isNaN(portOverride)) {
      window.localStorage.setItem(STORAGE_PORT_OVERRIDE, String(portOverride));
    } else {
      window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    }

    if (token) {
      window.localStorage.setItem(STORAGE_TOKEN, token);
    } else {
      window.localStorage.removeItem(STORAGE_TOKEN);
    }

    if (hostToken) {
      window.localStorage.setItem(STORAGE_HOST_AUTH_KEY, hostToken);
    } else {
      window.localStorage.removeItem(STORAGE_HOST_AUTH_KEY);
    }

    if (remoteAccessEnabled) {
      window.localStorage.setItem(STORAGE_REMOTE_ACCESS, "1");
    } else {
      window.localStorage.removeItem(STORAGE_REMOTE_ACCESS);
    }

    return readJuggleWorkServerSettings();
  } catch {
    return next;
  }
}

export function hydrateJuggleWorkServerSettingsFromEnv() {
  if (typeof window === "undefined") return;

  const envUrl = typeof import.meta.env?.VITE_JUGGLEWORK_URL === "string"
    ? import.meta.env.VITE_JUGGLEWORK_URL.trim()
    : "";
  const envPort = typeof import.meta.env?.VITE_JUGGLEWORK_PORT === "string"
    ? import.meta.env.VITE_JUGGLEWORK_PORT.trim()
    : "";
  const envToken = typeof import.meta.env?.VITE_JUGGLEWORK_TOKEN === "string"
    ? import.meta.env.VITE_JUGGLEWORK_TOKEN.trim()
    : "";
  const envHostToken = typeof import.meta.env?.VITE_JUGGLEWORK_HOST_TOKEN === "string"
    ? import.meta.env.VITE_JUGGLEWORK_HOST_TOKEN.trim()
    : "";

  if (!envUrl && !envPort && !envToken && !envHostToken) return;

  try {
    const current = readJuggleWorkServerSettings();
    const next: JuggleWorkServerSettings = { ...current };
    let changed = false;

    if (!current.urlOverride && envUrl) {
      next.urlOverride = normalizeJuggleWorkServerUrl(envUrl) ?? undefined;
      changed = true;
    }

    if (!current.portOverride && envPort) {
      const parsed = Number(envPort);
      if (Number.isFinite(parsed) && parsed > 0) {
        next.portOverride = parsed;
        changed = true;
      }
    }

    if (!current.token && envToken) {
      next.token = envToken;
      changed = true;
    }

    if (!current.hostToken && envHostToken) {
      next.hostToken = envHostToken;
      changed = true;
    }

    if (changed) {
      writeJuggleWorkServerSettings(next);
    }
  } catch {
    // ignore
  }
}

export function clearJuggleWorkServerSettings() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    window.localStorage.removeItem(STORAGE_TOKEN);
    window.localStorage.removeItem(STORAGE_HOST_AUTH_KEY);
    window.localStorage.removeItem(STORAGE_REMOTE_ACCESS);
  } catch {
    // ignore
  }
}

export class JuggleWorkServerError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function buildHeaders(
  token?: string,
  hostToken?: string,
  extra?: Record<string, string>,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-JuggleWork-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

function buildAuthHeaders(token?: string, hostToken?: string, extra?: Record<string, string>) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-JuggleWork-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

// Use Tauri's fetch when running in the desktop app to avoid CORS issues.
// Stream URLs (SSE) bypass the plugin because its `fetch_read_body` IPC call
// blocks until the body closes — that freezes the webview for infinite bodies.
const JUGGLEWORK_STREAM_URL_RE = /\/events(\b|\?)|\/event-stream\b|\/stream\b/;

function isStreamUrl(url: string): boolean {
  return JUGGLEWORK_STREAM_URL_RE.test(url);
}

const resolveFetch = (url?: string) => {
  if (!isDesktopRuntime()) return globalThis.fetch;
  if (url && isStreamUrl(url)) {
    return typeof window !== "undefined" ? window.fetch.bind(window) : globalThis.fetch;
  }
  return desktopFetch;
};

const DEFAULT_JUGGLEWORK_SERVER_TIMEOUT_MS = 10_000;
const ENGINE_RELOAD_TIMEOUT_MS = 60_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal && !init.signal ? { ...init, signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(url, initWithSignal), timeoutPromise]);
  } catch (error) {
    const name = (error && typeof error === "object" && "name" in error ? (error as any).name : "") as string;
    if (name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildHeaders(options.token, options.hostToken),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_JUGGLEWORK_SERVER_TIMEOUT_MS,
  );

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new JuggleWorkServerError(response.status, code, message, json?.details);
  }

  return json as T;
}

async function requestAgentContextDiagnosticsJson(
  baseUrl: string,
  path: string,
  options: {
    token?: string;
    hostToken?: string;
    body: AgentContextDiagnosticsRequest;
    timeoutMs: number;
  },
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const result = await requestAgentContextDiagnosticsPayload({
    url,
    init: {
      method: "POST",
      headers: buildHeaders(options.token, options.hostToken),
      body: JSON.stringify(options.body),
    },
    timeoutMs: options.timeoutMs,
    fetchImpl: (input, init, deadlineAtMs) => isDesktopRuntime()
      ? desktopFetchAgentContextDiagnostics(input, init, deadlineAtMs)
      : globalThis.fetch(input, init),
  });

  if (!result.response.ok) {
    const payload = result.payload;
    const code = payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string"
      ? payload.code
      : "request_failed";
    const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
      ? payload.message
      : result.response.statusText;
    const details = payload && typeof payload === "object" && "details" in payload
      ? payload.details
      : undefined;
    throw new JuggleWorkServerError(result.response.status, code, message, details);
  }

  return result.payload;
}

async function requestMultipartRaw(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: FormData; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "POST",
      headers: buildAuthHeaders(options.token, options.hostToken),
      body: options.body,
    },
    options.timeoutMs ?? DEFAULT_JUGGLEWORK_SERVER_TIMEOUT_MS,
  );
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function requestBinary(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; timeoutMs?: number } = {},
): Promise<{ data: ArrayBuffer; contentType: string | null; filename: string | null }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildAuthHeaders(options.token, options.hostToken),
    },
    options.timeoutMs ?? DEFAULT_JUGGLEWORK_SERVER_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new JuggleWorkServerError(response.status, code, message, json?.details);
  }

  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const filenameRaw = filenameMatch?.[1] ?? filenameMatch?.[2] ?? null;
  const filename = filenameRaw ? decodeURIComponent(filenameRaw) : null;
  const data = await response.arrayBuffer();
  return { data, contentType, filename };
}

export function createJuggleWorkServerClient(options: { baseUrl: string; token?: string; hostToken?: string }) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;
  const hostToken = options.hostToken;

  const timeouts = {
    health: 3_000,
    capabilities: 6_000,
    listWorkspaces: 8_000,
    activateWorkspace: 10_000,
    deleteWorkspace: 10_000,
    deleteSession: 12_000,
    sessionRead: 12_000,
    status: 6_000,
    diagnostics: AGENT_CONTEXT_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    config: 10_000,
    cloudMcpHealth: 12_000,
    cloudMcpProbeHealth: 30_000,
    cloudMcpReconcile: 60_000,
    workspaceExport: 30_000,
    workspaceImport: 30_000,
    binary: 60_000,
  };

  return {
    baseUrl,
    token,
    health: () =>
      requestJson<{ ok: boolean; version: string; uptimeMs: number }>(baseUrl, "/health", { token, hostToken, timeoutMs: timeouts.health }),
    status: () => requestJson<JuggleWorkServerDiagnostics>(baseUrl, "/status", { token, hostToken, timeoutMs: timeouts.status }),
    capabilities: () => requestJson<JuggleWorkServerCapabilities>(baseUrl, "/capabilities", { token, hostToken, timeoutMs: timeouts.capabilities }),
    googleWorkspaceStatus: () => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/status", { token, hostToken, timeoutMs: timeouts.status }),
    setConnectState: (connectEnabled: boolean) => requestJson<JuggleWorkConnectState>(baseUrl, "/experimental/connect/state", { token, hostToken, method: "PUT", body: { connectEnabled }, timeoutMs: timeouts.config }),
    googleWorkspaceConnectStart: (options?: { gmailRead?: boolean; features?: string[] }) => requestJson<GoogleWorkspaceConnectStart>(baseUrl, "/experimental/google-workspace/connect/start", { token, hostToken, method: "POST", body: { gmailRead: options?.gmailRead === true, features: options?.features ?? [] }, timeoutMs: timeouts.status }),
    googleWorkspaceConnectStatus: (flowId: string) => requestJson<GoogleWorkspaceConnectStatus>(baseUrl, `/experimental/google-workspace/connect/status/${encodeURIComponent(flowId)}`, { token, hostToken, timeoutMs: timeouts.status }),
    googleWorkspaceDisconnect: (accountId?: string | null) => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/disconnect", { token, hostToken, method: "POST", body: accountId ? { accountId } : {}, timeoutMs: timeouts.status }),
    googleWorkspaceSetActiveAccount: (accountId: string) => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/active-account", { token, hostToken, method: "POST", body: { accountId }, timeoutMs: timeouts.status }),
    googleWorkspaceTestConnection: () => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/test", { token, hostToken, method: "POST", timeoutMs: 60_000 }),
    googleWorkspaceRunScopeSmokeTest: () => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/smoke-test", { token, hostToken, method: "POST", timeoutMs: 120_000 }),
    callExtensionAction: (payload: JuggleWorkExtensionActionCall) =>
      requestJson<JuggleWorkExtensionActionResult>(baseUrl, "/experimental/extensions/call", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.binary,
      }),
    listWorkspaces: () => requestJson<JuggleWorkWorkspaceList>(baseUrl, "/workspaces", { token, hostToken, timeoutMs: timeouts.listWorkspaces }),
    /** 分页读取本机自动化任务。 */
    listAutomations: (options?: { cursor?: string; limit?: number }) => {
      const query = new URLSearchParams();
      if (options?.cursor) query.set("cursor", options.cursor);
      if (options?.limit) query.set("limit", String(options.limit));
      return requestJson<AutomationListResponse>(baseUrl, `/automations${query.size ? `?${query}` : ""}`, {
        token, hostToken, timeoutMs: timeouts.config,
      });
    },
    /** 读取指定本机工作空间当前可用于自动化的模型、Agent 和技能。 */
    /**
     * 读取自动化可选依赖。
     * @param workspaceId 工作空间 ID；留空时服务端回落到第一个本机工作空间，便于未选工作空间时也能展示列表
     */
    listAutomationDependencies: (workspaceId?: string) => requestJson<{
      models: Array<{ providerId: string; providerName: string; providerSource?: string; modelId: string; modelName: string; variants: string[] }>;
      agents: Array<{ id: string; name: string; description: string }>;
      skills: Array<{ id: string; name: string; description: string }>;
      connectors?: Array<{ id: string; label: string; ready: boolean }>;
    }>(baseUrl, `/automations/dependencies${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`, {
      token, hostToken, timeoutMs: timeouts.config,
    }),
    /** 校验频率并返回与 Embedded Server 一致的摘要及下一次运行。 */
    previewAutomationSchedule: (schedule: AutomationSchedule, activeRange?: AutomationActiveRange) =>
      requestJson<{ summary: string; nextRunAt: number | null }>(baseUrl, "/automations/preview", {
        token, hostToken, method: "POST", body: { schedule, activeRange, locale: "zh-CN" }, timeoutMs: timeouts.config,
      }),
    /** 按 ID 读取本机自动化任务。 */
    getAutomation: (automationId: string) => requestJson<{ item: AutomationDefinitionRecord }>(
      baseUrl, `/automations/${encodeURIComponent(automationId)}`, { token, hostToken, timeoutMs: timeouts.config },
    ),
    /** 原子创建本机自动化任务。 */
    createAutomation: (draft: AutomationDraft) => requestJson<{ item: AutomationDefinitionRecord }>(
      baseUrl, "/automations", { token, hostToken, method: "POST", body: draft, timeoutMs: timeouts.config },
    ),
    /** 以乐观锁更新本机自动化任务。 */
    updateAutomation: (automationId: string, baseRevision: number, draft: AutomationDraft) =>
      requestJson<{ item: AutomationDefinitionRecord }>(baseUrl, `/automations/${encodeURIComponent(automationId)}`, {
        token, hostToken, method: "PUT", body: { baseRevision, draft }, timeoutMs: timeouts.config,
      }),
    /** 暂停或恢复本机自动化任务。 */
    setAutomationPaused: (automationId: string, baseRevision: number, paused: boolean) =>
      requestJson<{ item: AutomationDefinitionRecord }>(baseUrl, `/automations/${encodeURIComponent(automationId)}/${paused ? "pause" : "resume"}`, {
        token, hostToken, method: "POST", body: { baseRevision }, timeoutMs: timeouts.config,
      }),
    /** 读取去除权限确认、默认暂停的复制草稿。 */
    duplicateAutomation: (automationId: string) => requestJson<{ draft: AutomationDraft; sourceAutomationId: string }>(
      baseUrl, `/automations/${encodeURIComponent(automationId)}/duplicate`, {
        token, hostToken, method: "POST", body: {}, timeoutMs: timeouts.config,
      },
    ),
    /** 立即创建一次手动运行。 */
    runAutomation: (automationId: string) => requestJson<{ item: AutomationRun }>(
      baseUrl, `/automations/${encodeURIComponent(automationId)}/run`, {
        token, hostToken, method: "POST", body: {}, timeoutMs: timeouts.config,
      },
    ),
    /** 创建任务墓碑并保留运行历史。 */
    deleteAutomation: (automationId: string, baseRevision: number) => requestJson<{ item: AutomationDefinitionRecord }>(
      baseUrl, `/automations/${encodeURIComponent(automationId)}`, {
        token, hostToken, method: "DELETE", body: { baseRevision }, timeoutMs: timeouts.config,
      },
    ),
    /** 分页读取本机自动化运行记录。 */
    listAutomationRuns: (options?: { cursor?: string; limit?: number; automationId?: string; status?: string; trigger?: string; scheduledFrom?: number; scheduledTo?: number }) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(options ?? {})) if (value !== undefined) query.set(key, String(value));
      return requestJson<AutomationRunListResponse>(baseUrl, `/automation-runs${query.size ? `?${query}` : ""}`, {
        token, hostToken, timeoutMs: timeouts.config,
      });
    },
    /** 读取到期的自动化云同步 outbox。 */
    readAutomationOutbox: (limit = 20) => requestJson<{ items: AutomationSyncMutation[] }>(
      baseUrl, `/automation-sync/outbox?limit=${limit}`, { token, hostToken, timeoutMs: timeouts.config },
    ),
    /** 确认云端已经接受完全匹配的本地版本。 */
    acknowledgeAutomationOutbox: (mutation: Pick<AutomationSyncMutation, "mutationId" | "entityId" | "localRevision">) =>
      requestJson<{ ok: true }>(baseUrl, "/automation-sync/ack", {
        token, hostToken, method: "POST", body: mutation, timeoutMs: timeouts.config,
      }),
    /** 持久化同步失败和退避截止时间。 */
    failAutomationOutbox: (input: { mutationId: string; errorCode: string; errorMessage: string; nextAttemptAt: number }) =>
      requestJson<{ ok: true }>(baseUrl, "/automation-sync/fail", {
        token, hostToken, method: "POST", body: input, timeoutMs: timeouts.config,
      }),
    createLocalWorkspace: (payload: { folderPath: string; name: string; preset: string }) =>
      requestJson<WorkspaceList>(baseUrl, "/workspaces/local", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.activateWorkspace,
      }),
    createRemoteWorkspace: (payload: {
      baseUrl: string;
      juggleworkHostUrl?: string | null;
      juggleworkToken?: string | null;
      juggleworkWorkspaceId?: string | null;
      juggleworkWorkspaceName?: string | null;
      displayName?: string | null;
      directory?: string | null;
      remoteType?: "jugglework" | "opencode";
      sandboxBackend?: string | null;
      sandboxRunId?: string | null;
      sandboxContainerName?: string | null;
    }) =>
      requestJson<WorkspaceList>(baseUrl, "/workspaces/remote", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.activateWorkspace,
      }),
    updateWorkspaceDisplayName: (workspaceId: string, displayName: string | null) =>
      requestJson<WorkspaceList>(baseUrl, `/workspaces/${encodeURIComponent(workspaceId)}/display-name`, {
        token,
        hostToken,
        method: "PATCH",
        body: { displayName },
        timeoutMs: timeouts.activateWorkspace,
      }),
    activateWorkspace: (workspaceId: string, options?: { persist?: boolean }) => {
      const query = options?.persist ? "?persist=true" : "";
      return requestJson<{ activeId: string; workspace: JuggleWorkWorkspaceInfo; persisted: boolean }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}/activate${query}`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.activateWorkspace },
      );
    },
    deleteWorkspace: (workspaceId: string) =>
      requestJson<{ ok: boolean; deleted: boolean; persisted: boolean; activeId: string | null; items: JuggleWorkWorkspaceInfo[]; workspaces?: WorkspaceInfo[] }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteWorkspace },
      ),
    deleteSession: (workspaceId: string, sessionId: string) =>
      requestJson<{ ok: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteSession },
      ),
    listSessions: (
      workspaceId: string,
      options?: { roots?: boolean; start?: number; search?: string; limit?: number },
    ) => {
      const query = new URLSearchParams();
      if (typeof options?.roots === "boolean") query.set("roots", String(options.roots));
      if (typeof options?.start === "number") query.set("start", String(options.start));
      if (options?.search?.trim()) query.set("search", options.search.trim());
      if (typeof options?.limit === "number") query.set("limit", String(options.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<{ items: Session[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions${suffix}`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      );
    },
    getSessionGroups: (workspaceId: string) =>
      requestJson<{ state: JuggleWorkSessionGroupState; updatedAt: number | null }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      ),
    putSessionGroups: (workspaceId: string, state: JuggleWorkSessionGroupState) =>
      requestJson<{ state: JuggleWorkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, method: "PUT", body: { state }, timeoutMs: timeouts.config },
      ),
    createSessionGroup: (workspaceId: string, input: { id?: string; label: string }) =>
      requestJson<{ state: JuggleWorkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.config },
      ),
    reorderSessionGroups: (workspaceId: string, groupIds: string[]) =>
      requestJson<{ state: JuggleWorkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/reorder`,
        { token, hostToken, method: "PATCH", body: { groupIds }, timeoutMs: timeouts.config },
      ),
    assignSessionGroup: (workspaceId: string, sessionId: string, groupId: string | null) =>
      requestJson<{ state: JuggleWorkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/assignments/${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "PATCH", body: { groupId }, timeoutMs: timeouts.config },
      ),
    renameSessionGroup: (workspaceId: string, groupId: string, label: string) =>
      requestJson<{ state: JuggleWorkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}`,
        { token, hostToken, method: "PATCH", body: { label }, timeoutMs: timeouts.config },
      ),
    removeSessionGroup: (workspaceId: string, groupId: string, destinationGroupId: string | null = null) =>
      requestJson<{ state: JuggleWorkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}${destinationGroupId ? `?destinationGroupId=${encodeURIComponent(destinationGroupId)}` : ""}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.config },
      ),
    listSessionGroupEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: JuggleWorkSessionGroupEvent[]; cursor?: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/events${query}`,
        { token, hostToken },
      );
    },
    getSession: (workspaceId: string, sessionId: string) =>
      requestJson<{ item: Session }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      ),
    getSessionMessages: (workspaceId: string, sessionId: string, options?: { limit?: number }) => {
      const query = new URLSearchParams();
      if (typeof options?.limit === "number") query.set("limit", String(options.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<{ items: JuggleWorkSessionMessage[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      );
    },
    getSessionSnapshot: (workspaceId: string, sessionId: string, options?: { limit?: number }) => {
      const query = new URLSearchParams();
      if (typeof options?.limit === "number") query.set("limit", String(options.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<{ item: JuggleWorkSessionSnapshot }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/snapshot${suffix}`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      );
    },
    startSessionRun: (
      workspaceId: string,
      sessionId: string,
      input: {
        origin: JuggleWorkSessionRunOrigin;
        startCommandCorrelationId: string | null;
        prompt: JuggleWorkSessionPrompt;
      },
    ) => requestJson<{ run: JuggleWorkSessionRun }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/runs/start`, {
      token,
      hostToken,
      method: "POST",
      body: input,
      timeoutMs: 0,
    }),
    abortSessionRun: (
      workspaceId: string,
      sessionId: string,
      runId: string,
      input: { abortCommandCorrelationId: string | null },
    ) =>
      requestJson<{ run: JuggleWorkSessionRun; abortRequested: true }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/abort`,
        { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.sessionRead },
      ),
    observeSessionRun: (
      workspaceId: string,
      sessionId: string,
      runId: string,
      input: { status: JuggleWorkSessionRunObservation },
    ) => requestJson<{
      cleared: boolean;
      run: JuggleWorkSessionRun | null;
      terminalStatus: "completed" | "failed" | "aborted" | null;
    }>(
      baseUrl,
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/observations`,
      { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.sessionRead },
    ),
    listActiveSessionRuns: (workspaceId: string) => requestJson<{
      items: JuggleWorkSessionRun[];
    }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/session-runs`, {
      token,
      hostToken,
      timeoutMs: timeouts.sessionRead,
    }),
    replyPermissionInteraction: (
      workspaceId: string,
      sessionId: string,
      interactionId: string,
      input: JuggleWorkPermissionReplyInput,
    ) => requestJson<JuggleWorkInteractionResolution>(
      baseUrl,
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/permission/reply`,
      { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.sessionRead },
    ),
    replyQuestionInteraction: (
      workspaceId: string,
      sessionId: string,
      interactionId: string,
      input: {
        origin: JuggleWorkInteractionOrigin;
        commandCorrelationId: string | null;
        answers: JuggleWorkQuestionAnswer[];
      },
    ) => requestJson<JuggleWorkInteractionResolution>(
      baseUrl,
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/question/reply`,
      { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.sessionRead },
    ),
    exportWorkspace: (
      workspaceId: string,
      options?: { sensitiveMode?: JuggleWorkWorkspaceExportSensitiveMode },
    ) => {
      const query = new URLSearchParams();
      if (options?.sensitiveMode) {
        query.set("sensitive", options.sensitiveMode);
      }
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<JuggleWorkWorkspaceExport>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/export${suffix}`, {
        token,
        hostToken,
        timeoutMs: timeouts.workspaceExport,
      });
    },
    importWorkspace: (workspaceId: string, payload: Record<string, unknown>) =>
      requestJson<{ ok: boolean; preview?: JuggleWorkWorkspaceImportPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/import`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.workspaceImport,
      }),
    previewWorkspaceImport: (workspaceId: string, payload: Record<string, unknown>) =>
      requestJson<JuggleWorkWorkspaceImportPreview>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/import/preview`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
          timeoutMs: timeouts.workspaceImport,
        },
      ),
    materializeBlueprintSessions: (workspaceId: string) =>
      requestJson<JuggleWorkBlueprintSessionsMaterializeResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/blueprint/sessions/materialize`,
        {
          token,
          hostToken,
          method: "POST",
          timeoutMs: timeouts.workspaceImport,
        },
      ),
    getConfig: (workspaceId: string) =>
      requestJson<{ opencode: Record<string, unknown>; jugglework: Record<string, unknown>; updatedAt?: number | null }>(
        baseUrl,
        `/workspace/${workspaceId}/config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    listAuthorizedFolders: (workspaceId: string) =>
      requestJson<JuggleWorkAuthorizedFoldersResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/authorized-folders`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    setAuthorizedFolders: (workspaceId: string, folders: string[]) =>
      requestJson<JuggleWorkAuthorizedFoldersUpdateResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/authorized-folders`,
        {
          token,
          hostToken,
          method: "PUT",
          body: { folders },
          timeoutMs: timeouts.config,
        },
      ),
    migrateRuntimeConfig: (workspaceId: string) =>
      requestJson<JuggleWorkRuntimeConfigMigrationResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/runtime-config/migrate`,
        {
          token,
          hostToken,
          method: "POST",
          timeoutMs: timeouts.config,
        },
      ),
    setRuntimeDisabledProviders: (workspaceId: string, providers: string[]) =>
      requestJson<JuggleWorkRuntimeDisabledProvidersResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/runtime-config/disabled-providers`,
        {
          token,
          hostToken,
          method: "POST",
          body: { providers },
          timeoutMs: timeouts.config,
        },
      ),
    getRuntimeConfigStatus: (workspaceId: string) =>
      requestJson<JuggleWorkRuntimeConfigStatus>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/runtime-config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    patchConfig: (workspaceId: string, payload: { opencode?: Record<string, unknown>; jugglework?: Record<string, unknown> }) =>
      requestJson<{ updatedAt?: number | null }>(baseUrl, `/workspace/${workspaceId}/config`, {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),
    getDesktopCloudSync: (workspaceId: string) =>
      requestJson<JuggleWorkDesktopCloudSyncState>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/desktop-cloud-sync`, {
        token,
        hostToken,
        timeoutMs: timeouts.config,
      }),
    syncDesktopCloud: (workspaceId: string, snapshot: DenResourceSnapshot) =>
      requestJson<JuggleWorkDesktopCloudSyncResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/desktop-cloud-sync`, {
        token,
        hostToken,
        method: "POST",
        body: { snapshot },
        timeoutMs: timeouts.config,
      }),
    listCloudPlugins: (workspaceId: string) =>
      requestJson<JuggleWorkCloudPluginsResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins`, {
        token,
        hostToken,
        timeoutMs: timeouts.config,
      }),
    installCloudPlugin: (workspaceId: string, payload: { marketplaceId: string | null; marketplace?: DenOrgMarketplace | null; resolved: DenOrgPluginResolved }) =>
      requestJson<JuggleWorkCloudPluginInstallResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.config,
      }),
    removeCloudPlugin: (workspaceId: string, pluginId: string) =>
      requestJson<JuggleWorkCloudPluginInstallResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins/${encodeURIComponent(pluginId)}`, {
        token,
        hostToken,
        method: "DELETE",
        timeoutMs: timeouts.config,
      }),
    previewClaudePlugin: (workspaceId: string, payload: { url: string; ref?: string }) =>
      requestJson<{ preview: JuggleWorkClaudePluginPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/claude-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: { ...payload, dryRun: true },
        timeoutMs: timeouts.config,
      }),
    installClaudePlugin: (workspaceId: string, payload: { url: string; ref?: string }) =>
      requestJson<JuggleWorkCloudPluginInstallResult & { preview: JuggleWorkClaudePluginPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/claude-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.config,
      }),
    readOpencodeConfigFile: (workspaceId: string, scope: "project" | "global" = "project") => {
      const query = `?scope=${scope}`;
      return requestJson<OpencodeConfigFile>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/opencode-config${query}`, {
        token,
        hostToken,
      });
    },
    writeOpencodeConfigFile: (workspaceId: string, scope: "project" | "global", content: string) =>
      requestJson<ExecResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/opencode-config`, {
        token,
        hostToken,
        method: "POST",
        body: { scope, content },
      }),
    listReloadEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: JuggleWorkReloadEvent[]; cursor?: number }>(
        baseUrl,
        `/workspace/${workspaceId}/events${query}`,
        { token, hostToken },
      );
    },
    reloadEngine: (workspaceId: string) =>
      requestJson<{ ok: boolean; reloadedAt?: number }>(baseUrl, `/workspace/${workspaceId}/engine/reload`, {
        token,
        hostToken,
        method: "POST",
        timeoutMs: ENGINE_RELOAD_TIMEOUT_MS,
      }),
    listPlugins: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: JuggleWorkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins${query}`,
        { token, hostToken },
      );
    },
    addPlugin: (workspaceId: string, spec: string) =>
      requestJson<{ items: JuggleWorkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins`,
        { token, hostToken, method: "POST", body: { spec } },
      ),
    removePlugin: (workspaceId: string, name: string) =>
      requestJson<{ items: JuggleWorkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
    listSkills: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: JuggleWorkSkillItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/skills${query}`,
        { token, hostToken },
      );
    },
    getSkill: (workspaceId: string, name: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<JuggleWorkSkillContent>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}${query}`,
        { token, hostToken },
      );
    },
    upsertSkill: (workspaceId: string, payload: { name: string; content: string; description?: string }) =>
      requestJson<JuggleWorkSkillItem>(baseUrl, `/workspace/${workspaceId}/skills`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    deleteSkill: (workspaceId: string, name: string) =>
      requestJson<{ path: string }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "DELETE",
        },
      ),
    listMcp: (workspaceId: string) =>
      requestJson<{ items: JuggleWorkMcpItem[]; engineSync?: JuggleWorkMcpEngineSync | null }>(
        baseUrl,
        `/workspace/${workspaceId}/mcp`,
        { token, hostToken },
      ),
    getJuggleWorkCloudMcpHealth: (
      workspaceId: string,
      providerModel?: JuggleWorkCloudMcpProviderModelContext,
      options?: { probe?: boolean },
    ) => {
      const query = new URLSearchParams();
      if (providerModel?.provider.trim() && providerModel.model.trim()) {
        query.set("provider", providerModel.provider.trim());
        query.set("model", providerModel.model.trim());
      }
      // probe=1 verifies the Cloud endpoint directly from the JuggleWork server
      // (initialize + tools/list), independent of the engine's own connection.
      if (options?.probe) query.set("probe", "1");
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<JuggleWorkCloudMcpHealth>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/jugglework-cloud/health${suffix}`,
        { token, hostToken, timeoutMs: options?.probe ? timeouts.cloudMcpProbeHealth : timeouts.cloudMcpHealth },
      );
    },
    reconcileJuggleWorkCloudMcp: (workspaceId: string, payload: JuggleWorkCloudMcpReconcilePayload) =>
      requestJson<JuggleWorkCloudMcpHealth>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/jugglework-cloud/reconcile`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
          timeoutMs: timeouts.cloudMcpReconcile,
        },
      ),
    refreshJuggleWorkCloudMcpEngine: (
      workspaceId: string,
      payload?: { provider?: string; model?: string; trigger?: string },
    ) =>
      requestJson<JuggleWorkCloudMcpEngineRefreshResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/jugglework-cloud/engine-refresh`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload ?? {},
          timeoutMs: timeouts.cloudMcpReconcile,
        },
      ),
    runAgentContextDiagnostics: async (
      workspaceId: string,
      input: AgentContextDiagnosticsRequest,
    ): Promise<AgentContextDiagnosticsReport> => {
      const body = agentContextDiagnosticsRequestSchema.parse(input);
      const payload = await requestAgentContextDiagnosticsJson(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/diagnostics/agent-context`,
        {
          token,
          hostToken,
          body,
          timeoutMs: timeouts.diagnostics,
        },
      );
      return agentContextDiagnosticsReportSchema.parse(payload);
    },
    addMcp: (workspaceId: string, payload: { name: string; config: Record<string, unknown> }) =>
      requestJson<{ items: JuggleWorkMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    removeMcp: (workspaceId: string, name: string) =>
      requestJson<{ items: JuggleWorkMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
    setMcpEnabled: (workspaceId: string, name: string, enabled: boolean) =>
      requestJson<{ items: JuggleWorkMcpItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}/enabled`,
        {
          token,
          hostToken,
          method: "POST",
          body: { enabled },
        },
      ),

    logoutMcpAuth: (workspaceId: string, name: string) =>
      requestJson<{ ok: true }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}/auth`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    listCommands: (workspaceId: string, scope: "workspace" | "global" = "workspace") =>
      requestJson<{ items: JuggleWorkCommandItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/commands?scope=${scope}`,
        { token, hostToken },
      ),
    listAudit: (workspaceId: string, limit = 50) =>
      requestJson<{ items: JuggleWorkAuditEntry[] }>(
        baseUrl,
        `/workspace/${workspaceId}/audit?limit=${limit}`,
        { token, hostToken },
      ),
    upsertCommand: (
      workspaceId: string,
      payload: { name: string; description?: string; template: string; agent?: string; model?: string | null; subtask?: boolean },
    ) =>
      requestJson<{ items: JuggleWorkCommandItem[] }>(baseUrl, `/workspace/${workspaceId}/commands`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    deleteCommand: (workspaceId: string, name: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${workspaceId}/commands/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
    uploadInbox: async (workspaceId: string, file: File, options?: { path?: string }) => {
      const id = workspaceId.trim();
      if (!id) throw new Error("workspaceId is required");
      if (!file) throw new Error("file is required");
      const form = new FormData();
      form.append("file", file);
      if (options?.path?.trim()) {
        form.append("path", options.path.trim());
      }

      const result = await requestMultipartRaw(baseUrl, `/workspace/${encodeURIComponent(id)}/inbox`, {
        token,
        hostToken,
        method: "POST",
        body: form,
        timeoutMs: timeouts.binary,
      });

      if (!result.ok) {
        let message = result.text.trim();
        try {
          const json = message ? JSON.parse(message) : null;
          if (json && typeof json.message === "string") {
            message = json.message;
          }
        } catch {
          // ignore
        }
        throw new JuggleWorkServerError(
          result.status,
          "request_failed",
          message || "Shared folder upload failed",
        );
      }

      const body = result.text.trim();
      if (body) {
        try {
          const parsed = JSON.parse(body) as Partial<JuggleWorkInboxUploadResult>;
          if (typeof parsed.path === "string" && parsed.path.trim()) {
            return {
              ok: parsed.ok ?? true,
              path: parsed.path.trim(),
              bytes: typeof parsed.bytes === "number" ? parsed.bytes : file.size,
            } satisfies JuggleWorkInboxUploadResult;
          }
        } catch {
          // ignore invalid JSON and fall back
        }
      }

      return {
        ok: true,
        path: options?.path?.trim() || file.name,
        bytes: file.size,
      } satisfies JuggleWorkInboxUploadResult;
    },

    listInbox: (workspaceId: string) =>
      requestJson<JuggleWorkInboxList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/inbox`, {
        token,
        hostToken,
      }),

    downloadInboxItem: (workspaceId: string, inboxId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(inboxId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    readWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<JuggleWorkWorkspaceFileContent>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    statWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<JuggleWorkWorkspaceFileStat>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/stat?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    writeWorkspaceFile: (
      workspaceId: string,
      payload: { path: string; content: string; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<JuggleWorkWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
        },
      ),

    deleteWorkspaceFiles: async (
      workspaceId: string,
      files: Array<{ path: string; recursive?: boolean }>,
    ): Promise<JuggleWorkWorkspaceFileDeleteResult[]> => {
      if (files.length === 0) return [];
      const created = await requestJson<{ session: { id: string } }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/sessions`,
        { token, hostToken, method: "POST", body: { write: true } },
      );
      const sessionId = created.session.id;
      try {
        const result = await requestJson<{ items: Array<{ ok?: boolean; path?: string; code?: string }> }>(
          baseUrl,
          `/files/sessions/${encodeURIComponent(sessionId)}/ops`,
          {
            token,
            hostToken,
            method: "POST",
            body: {
              operations: files.map((file) => ({
                type: "delete",
                path: file.path,
                recursive: file.recursive === true,
              })),
            },
          },
        );
        return result.items.map((item, index) => ({
          ok: item.ok === true,
          path: typeof item.path === "string" ? item.path : files[index]?.path ?? "",
          ...(typeof item.code === "string" ? { code: item.code } : {}),
        }));
      } finally {
        await requestJson<{ ok: boolean }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}`, {
          token,
          hostToken,
          method: "DELETE",
        }).catch(() => undefined);
      }
    },

    writeWorkspaceBinaryFile: (
      workspaceId: string,
      payload: { path: string; data: ArrayBuffer; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<JuggleWorkWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/raw`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            path: payload.path,
            dataBase64: arrayBufferToBase64(payload.data),
            baseUpdatedAt: payload.baseUpdatedAt,
            force: payload.force,
          },
        },
      ),

    downloadWorkspaceFile: (workspaceId: string, path: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/raw?path=${encodeURIComponent(path)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    listArtifacts: (workspaceId: string) =>
      requestJson<JuggleWorkArtifactList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/artifacts`, {
        token,
        hostToken,
      }),

    resolveArtifacts: (
      workspaceId: string,
      targets: Array<{
        kind: "file" | "url";
        value: string;
        name?: string;
        preview?: string;
        confidence?: number;
        reason?: string;
      }>,
    ) =>
      requestJson<{ items: JuggleWorkResolvedArtifactTarget[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/resolve`,
        { token, hostToken, method: "POST", body: { targets } },
      ),

    downloadArtifact: (workspaceId: string, artifactId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    // User-level env vars (host-auth only — desktop shell is the sole caller).
    // See apps/server/src/env-file.ts and apps/app/pr/environment-variables.md.
    listUserEnvKeys: () =>
      requestJson<{ keys: string[] }>(
        baseUrl,
        "/env/keys",
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    getUserEnvStatus: (runtimeKey?: string | null) => {
      const params = new URLSearchParams();
      if (runtimeKey?.trim()) params.set("runtimeKey", runtimeKey.trim());
      const query = params.size ? `?${params.toString()}` : "";
      return requestJson<{ runtimeKey: string; pendingChanges: boolean }>(
        baseUrl,
        `/env/status${query}`,
        { token, hostToken, timeoutMs: timeouts.config },
      );
    },

    setUserEnvPendingChanges: (pendingChanges: boolean, runtimeKey?: string | null) =>
      requestJson<{ runtimeKey: string; pendingChanges: boolean }>(baseUrl, "/env/status", {
        token,
        hostToken,
        method: "PUT",
        body: { pendingChanges, runtimeKey: runtimeKey?.trim() || undefined },
        timeoutMs: timeouts.config,
      }),

    listUserEnv: () =>
      requestJson<{ items: JuggleWorkUserEnvItem[] }>(
        baseUrl,
        "/env?includeValues=false",
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    getUserEnv: (key: string) =>
      requestJson<{ item: JuggleWorkUserEnvItem & { value: string } }>(
        baseUrl,
        `/env/${encodeURIComponent(key)}`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    upsertUserEnv: (entries: Array<{ key: string; value: string }>) =>
      requestJson<{ ok: true; count: number }>(baseUrl, "/env", {
        token,
        hostToken,
        method: "PUT",
        body: { entries },
        timeoutMs: timeouts.config,
      }),

    deleteUserEnv: (key: string) =>
      requestJson<{ ok: true }>(baseUrl, `/env/${encodeURIComponent(key)}`, {
        token,
        hostToken,
        method: "DELETE",
        timeoutMs: timeouts.config,
      }),

    createVoiceRealtimeSession: (payload?: { model?: string; sessionContext?: string }) =>
      requestJson<{
        ok: true;
        clientSecret: string;
        expiresAt: number | null;
        model: string;
        transcriptionModel: string;
        tools: string[];
        source?: string;
      }>(baseUrl, "/voice/realtime/session", {
        token,
        hostToken,
        method: "POST",
        body: payload ?? {},
        timeoutMs: timeouts.config,
      }),
  };
}

export type JuggleWorkServerClient = ReturnType<typeof createJuggleWorkServerClient>;
