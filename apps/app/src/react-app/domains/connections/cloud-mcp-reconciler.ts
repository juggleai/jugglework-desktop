import {
  type DenMcpToken,
  type DenMcpTokenMintContext,
  resolveCloudMcpResourceUrl,
} from "../../../app/lib/den";
import type {
  JuggleWorkCloudMcpEngineRefresh,
  JuggleWorkCloudMcpEngineRefreshResult,
  JuggleWorkCloudMcpFailure,
  JuggleWorkCloudMcpHealth,
  JuggleWorkCloudMcpProviderModelContext,
  JuggleWorkCloudMcpReconcilePayload,
} from "../../../app/lib/jugglework-server";
import {
  CLOUD_MCP_SERVER_NAME,
  clearCloudMcpScopedMetadata,
  clearCloudMcpUserState,
  getCloudMcpScopeKey,
  isCloudMcpSyncMarkerFresh,
  normalizeCloudMcpScope,
  readCloudMcpCatalogMarker,
  readCloudMcpSyncMarker,
  readCloudMcpUserState,
  writeCloudMcpCatalogMarker,
  writeCloudMcpSyncMarker,
  writeCloudMcpUserState,
  type CloudMcpScope,
  type CloudMcpUserState,
} from "./cloud-mcp-user-state";
import { resolveWorkspaceMcpKey } from "./workspace-mcp-key";

export const JUGGLEWORK_CLOUD_EXPECTED_TOOLS = [
  "jugglework-cloud_search_capabilities",
  "jugglework-cloud_execute_capability",
];

export type CloudMcpClient = {
  baseUrl: string;
  getJuggleWorkCloudMcpHealth: (
    workspaceId: string,
    providerModel?: JuggleWorkCloudMcpProviderModelContext,
    options?: { probe?: boolean },
  ) => Promise<JuggleWorkCloudMcpHealth>;
  reconcileJuggleWorkCloudMcp: (
    workspaceId: string,
    payload: JuggleWorkCloudMcpReconcilePayload,
  ) => Promise<JuggleWorkCloudMcpHealth>;
  refreshJuggleWorkCloudMcpEngine?: (
    workspaceId: string,
    payload?: { provider?: string; model?: string; trigger?: string },
  ) => Promise<JuggleWorkCloudMcpEngineRefreshResult>;
  /** 旧版 JuggleWork 服务端没有这条路由；缺省即退回账号级令牌行为。 */
  getCloudMcpWorkspaceKey?: (workspaceId: string) => Promise<{ workspaceId: string; workspaceKey: string }>;
};

export type CloudMcpOperationContext = CloudMcpScope & {
  denAuthToken: string | null;
  orgSlug?: string | null;
  orgName?: string | null;
  fallbackUrl?: string | null;
  providerModel?: JuggleWorkCloudMcpProviderModelContext;
  connectCatalogEnabled?: boolean;
  trigger?: string;
  /**
   * 该工作区稳定的工作区键。带上它铸造的令牌是执行令牌，云端按工作区策略过滤；
   * 缺省（旧版 JuggleWork 服务端没有这条路由）则退回账号级行为，与升级前一致。
   */
  workspaceKey?: string | null;
};

export type CloudMcpOperationMode = "health" | "repair";

export type CloudMcpOperationResult = {
  status: "checked" | "ready" | "repaired" | "unchanged" | "skipped" | "failed";
  health: JuggleWorkCloudMcpHealth | null;
  skippedReason?: "signed_out" | "missing_org" | "missing_workspace" | "disabled" | "deduped" | "mint_failed";
  attempts: number;
  markerWritten: boolean;
  reminted: boolean;
};

export type CloudMcpMainStatus = "ready" | "connecting" | "disabled" | "degraded" | "signed_out";

export type CloudMcpDisplaySummary = {
  status: CloudMcpMainStatus;
  statusLabel: "Ready" | "Connecting" | "Disabled" | "Degraded" | "Signed out";
  tone: "ready" | "warning" | "neutral" | "error";
  stageLabel: string;
  recommendedAction: string;
};

type MintCloudMcpToken = (context: DenMcpTokenMintContext) => Promise<DenMcpToken | null>;

type CloudMcpReconcilerInput = {
  mode: CloudMcpOperationMode;
  client: CloudMcpClient;
  context: CloudMcpOperationContext;
  mintToken: MintCloudMcpToken;
  force?: boolean;
  refreshMarginMs: number;
  now?: number;
  configuredEnabled?: boolean | null;
  /**
   * Ask the JuggleWork server to also verify the Cloud endpoint directly
   * (initialize + tools/list outside the engine). Only meaningful for
   * mode "health"; repair reconciles always probe on the server.
   */
  probe?: boolean;
};

type OpenCodeDisconnectClient = {
  mcp: {
    disconnect: (input: { directory: string; name: string }) => Promise<unknown>;
  };
};

type CleanupClient = {
  baseUrl: string;
  removeMcp: (workspaceId: string, name: string) => Promise<unknown>;
};

const repairInFlight = new Map<string, Promise<CloudMcpOperationResult>>();

const APP_VERSION = String(import.meta.env.VITE_JUGGLEWORK_APP_VERSION ?? "").trim();
const APP_BUILD_SHA = String(import.meta.env.VITE_JUGGLEWORK_BUILD_SHA ?? import.meta.env.VITE_JUGGLEWORK_GIT_SHA ?? "").trim();

function normalizeCode(code: string | null | undefined): string {
  return code?.trim().toLowerCase().replace(/[-.]/g, "_") ?? "";
}

function isProviderProjectionFailure(failure?: JuggleWorkCloudMcpFailure | null): boolean {
  if (!failure) return false;
  if (failure.stage === "provider_projection") return true;
  const code = normalizeCode(failure.code);
  if (
    code === "provider_tool_projection_missing" ||
    code === "provider_projection_missing" ||
    code === "provider_projection_unavailable"
  ) {
    return true;
  }
  return code.includes("provider_projection") || code.includes("provider_tool_projection");
}

function normalizedContextScope(context: CloudMcpOperationContext): CloudMcpScope | null {
  return normalizeCloudMcpScope({
    denBaseUrl: context.denBaseUrl,
    serverBaseUrl: context.serverBaseUrl,
    orgId: context.orgId,
    workspaceId: context.workspaceId,
  });
}

function tokenMetadata(token: DenMcpToken): Record<string, string | number | boolean | null> {
  return {
    organizationId: token.organizationId,
    expiresAt: token.expiresAt,
    resource: token.resource,
    scopes: token.scopes.join(" "),
  };
}

function orgMetadata(context: CloudMcpOperationContext): Record<string, string | number | boolean | null> {
  return {
    id: context.orgId.trim(),
    slug: context.orgSlug?.trim() || null,
    name: context.orgName?.trim() || null,
  };
}

function appMetadata(): Record<string, string | number | boolean | null> | undefined {
  const metadata: Record<string, string | number | boolean | null> = {};
  if (APP_VERSION) metadata.version = APP_VERSION;
  if (APP_BUILD_SHA) metadata.buildSha = APP_BUILD_SHA;
  return Object.keys(metadata).length ? metadata : undefined;
}

function resolveMcpUrl(token: DenMcpToken, fallbackUrl?: string | null): string | null {
  const healedResource = resolveCloudMcpResourceUrl(token.resource);
  if (healedResource) return `${healedResource}/agent`;
  const fallback = fallbackUrl?.trim() ?? "";
  return fallback || null;
}

function cloudMcpRemoteConfig(url: string, token: DenMcpToken): Record<string, unknown> {
  return {
    type: "remote",
    enabled: true,
    url,
    headers: { Authorization: `Bearer ${token.token}` },
    oauth: false,
  };
}

export function buildJuggleWorkCloudMcpReconcilePayload(input: {
  context: CloudMcpOperationContext;
  token: DenMcpToken;
  /** 账号级目录令牌；只在需要刷新 host 级目录配置时传入。 */
  catalogToken?: DenMcpToken | null;
}): JuggleWorkCloudMcpReconcilePayload | null {
  const workspaceId = input.context.workspaceId.trim();
  const url = resolveMcpUrl(input.token, input.context.fallbackUrl);
  if (!workspaceId || !url) return null;
  const app = appMetadata();
  const catalogUrl = input.catalogToken
    ? resolveMcpUrl(input.catalogToken, input.context.fallbackUrl)
    : null;
  return {
    workspaceId,
    name: CLOUD_MCP_SERVER_NAME,
    config: cloudMcpRemoteConfig(url, input.token),
    ...(input.catalogToken && catalogUrl
      ? { catalog: { config: cloudMcpRemoteConfig(catalogUrl, input.catalogToken) } }
      : {}),
    tokenMetadata: tokenMetadata(input.token),
    org: orgMetadata(input.context),
    ...(app ? { app, appVersion: typeof app.version === "string" ? app.version : undefined, buildSha: typeof app.buildSha === "string" ? app.buildSha : undefined } : {}),
    connectCatalogEnabled: input.context.connectCatalogEnabled ?? true,
    trigger: input.context.trigger ?? "desktop-repair",
    ...(input.context.providerModel ? {
      provider: input.context.providerModel.provider,
      model: input.context.providerModel.model,
    } : {}),
  };
}

export function isCloudMcpAuthTokenFailureCode(code: string | null | undefined): boolean {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  if (
    normalized.includes("membership") ||
    normalized.includes("scope") ||
    normalized.includes("policy") ||
    normalized.includes("forbidden") ||
    normalized.includes("resource") ||
    normalized.includes("not_found") ||
    normalized.includes("client_registration")
  ) {
    return false;
  }
  return normalized === "jugglework_cloud_auth_required" ||
    normalized === "jugglework_cloud_auth_invalid" ||
    normalized === "jugglework_cloud_token_expired" ||
    // The Den rejects an expired/missing first-party bearer with exactly these
    // codes; the `_mcp_` infix means the `invalid_token` substring below never
    // matches them (field incident: token sat expired for 7 days because the
    // remint retry never fired).
    normalized === "invalid_mcp_token" ||
    normalized === "missing_mcp_token" ||
    normalized.includes("invalid_token") ||
    normalized.includes("unauthorized") ||
    normalized.includes("expired") ||
    normalized.includes("auth");
}

/**
 * Health failures carry the primary `code` plus optional `aliases` (e.g. the
 * direct-probe 401 reports code `invalid_mcp_token` with alias
 * `jugglework_cloud_token_expired`). Remint decisions must consider both.
 */
export function isCloudMcpAuthTokenFailure(failure: Pick<JuggleWorkCloudMcpFailure, "code" | "aliases"> | null | undefined): boolean {
  if (!failure) return false;
  if (isCloudMcpAuthTokenFailureCode(failure.code)) return true;
  return (failure.aliases ?? []).some((alias) => isCloudMcpAuthTokenFailureCode(alias));
}

function shouldSkipForPrerequisite(input: CloudMcpReconcilerInput, scope: CloudMcpScope): CloudMcpOperationResult | null {
  if (!scope.workspaceId) return { status: "skipped", health: null, skippedReason: "missing_workspace", attempts: 0, markerWritten: false, reminted: false };
  if (input.mode === "health") return null;
  if (!input.context.denAuthToken?.trim()) return { status: "skipped", health: null, skippedReason: "signed_out", attempts: 0, markerWritten: false, reminted: false };
  if (!scope.orgId) return { status: "skipped", health: null, skippedReason: "missing_org", attempts: 0, markerWritten: false, reminted: false };
  if (input.configuredEnabled === false) {
    return { status: "skipped", health: null, skippedReason: "disabled", attempts: 0, markerWritten: false, reminted: false };
  }
  // Recorded user intent only blocks provisioning (entry absent/unknown). A
  // known-enabled entry must keep its token fresh even when a stale
  // disabled/removed intent is still recorded.
  if (input.configuredEnabled !== true && readCloudMcpUserState(scope) !== null) {
    return { status: "skipped", health: null, skippedReason: "disabled", attempts: 0, markerWritten: false, reminted: false };
  }
  return null;
}

function writeUsableMarker(input: {
  health: JuggleWorkCloudMcpHealth | null;
  scope: CloudMcpScope;
  expiresAt: string | null;
}): boolean {
  if (!input.health?.usable || !input.expiresAt) return false;
  writeCloudMcpSyncMarker({ ...input.scope, expiresAt: input.expiresAt });
  return true;
}

async function probeHealth(input: CloudMcpReconcilerInput, scope: CloudMcpScope, options?: { writeFreshnessMarker?: boolean }): Promise<CloudMcpOperationResult> {
  const health = await input.client.getJuggleWorkCloudMcpHealth(
    scope.workspaceId,
    input.context.providerModel,
    input.probe ? { probe: true } : undefined,
  );
  const marker = options?.writeFreshnessMarker ? readCloudMcpSyncMarker(scope) : null;
  const markerWritten = options?.writeFreshnessMarker === true
    ? writeUsableMarker({ health, scope, expiresAt: marker?.expiresAt ?? null })
    : false;
  return {
    status: health.usable ? "ready" : "checked",
    health,
    attempts: 0,
    markerWritten,
    reminted: false,
  };
}

/**
 * 判断这一轮是否需要顺带铸造账号级目录令牌。
 *
 * TIPS：目录令牌整个账号只需一枚，且与执行令牌同样是 6 天有效期。用独立标记
 * 判断新鲜度，绝大多数维护轮次因此完全跳过目录铸造——否则每工作区每轮都会多
 * 打一次铸造接口，正好撞上服务端的每会话铸造限流。
 */
function needsCatalogToken(input: CloudMcpReconcilerInput, scope: CloudMcpScope): boolean {
  const marker = readCloudMcpCatalogMarker({
    denBaseUrl: scope.denBaseUrl,
    serverBaseUrl: scope.serverBaseUrl,
    orgId: scope.orgId,
  });
  if (!marker) return true;
  return !isCloudMcpSyncMarkerFresh({
    expiresAt: marker.expiresAt,
    now: input.now ?? Date.now(),
    refreshMarginMs: input.refreshMarginMs,
  });
}

async function mintAndPost(input: CloudMcpReconcilerInput, scope: CloudMcpScope): Promise<{ health: JuggleWorkCloudMcpHealth | null; token: DenMcpToken | null }> {
  const workspaceKey = input.context.workspaceKey?.trim() ?? "";
  const token = await input.mintToken({
    baseUrl: scope.denBaseUrl,
    authToken: input.context.denAuthToken,
    orgId: scope.orgId,
    workspaceKey: workspaceKey || null,
  });
  if (!token) return { health: null, token: null };
  // 目录令牌只在带 workspaceKey 的部署上才有意义：不带工作区键时执行令牌本身
  // 就是账号级的，服务端沿用它做目录即可，不必多铸一枚。
  const catalogToken = workspaceKey && needsCatalogToken(input, scope)
    ? await input.mintToken({
        baseUrl: scope.denBaseUrl,
        authToken: input.context.denAuthToken,
        orgId: scope.orgId,
        workspaceKey: null,
      }).catch(() => null)
    : null;
  const payload = buildJuggleWorkCloudMcpReconcilePayload({
    context: { ...input.context, ...scope },
    token,
    catalogToken,
  });
  if (!payload) return { health: null, token };
  const health = await input.client.reconcileJuggleWorkCloudMcp(scope.workspaceId, payload);
  if (catalogToken && payload.catalog) {
    writeCloudMcpCatalogMarker({
      denBaseUrl: scope.denBaseUrl,
      serverBaseUrl: scope.serverBaseUrl,
      orgId: scope.orgId,
      expiresAt: catalogToken.expiresAt,
    });
  }
  return { health, token };
}

async function repairCloudMcp(input: CloudMcpReconcilerInput, scope: CloudMcpScope): Promise<CloudMcpOperationResult> {
  if (!input.force) {
    const healthResult = await probeHealth(input, scope, { writeFreshnessMarker: true });
    if (healthResult.health?.usable) return { ...healthResult, status: "unchanged" };
  }

  const marker = readCloudMcpSyncMarker(scope);
  if (!input.force && marker && isCloudMcpSyncMarkerFresh({
    expiresAt: marker.expiresAt,
    now: input.now ?? Date.now(),
    refreshMarginMs: input.refreshMarginMs,
  })) {
    const health = await input.client.getJuggleWorkCloudMcpHealth(scope.workspaceId, input.context.providerModel);
    if (health.usable) return { status: "unchanged", health, attempts: 0, markerWritten: false, reminted: false };
  }

  const first = await mintAndPost(input, scope);
  if (!first.token) {
    return { status: "skipped", health: null, skippedReason: "mint_failed", attempts: 1, markerWritten: false, reminted: false };
  }

  let attempts = 1;
  let health = first.health;
  let token = first.token;
  let reminted = false;
  if (isCloudMcpAuthTokenFailure(health?.firstFailure)) {
    const second = await mintAndPost(input, scope);
    attempts += 1;
    reminted = true;
    if (second.token) token = second.token;
    if (second.health) health = second.health;
  }

  const markerWritten = writeUsableMarker({ health, scope, expiresAt: token.expiresAt });
  return {
    status: health?.usable ? "repaired" : "failed",
    health,
    attempts,
    markerWritten,
    reminted,
  };
}

export async function runJuggleWorkCloudMcpReconciler(input: CloudMcpReconcilerInput): Promise<CloudMcpOperationResult> {
  const scope = normalizedContextScope(input.context);
  if (!scope) return { status: "skipped", health: null, skippedReason: "missing_workspace", attempts: 0, markerWritten: false, reminted: false };
  const prerequisite = shouldSkipForPrerequisite(input, scope);
  if (prerequisite) return prerequisite;

  if (input.mode === "health") return probeHealth(input, scope);

  const scopeKey = getCloudMcpScopeKey(scope);
  if (!scopeKey) return { status: "skipped", health: null, skippedReason: "missing_workspace", attempts: 0, markerWritten: false, reminted: false };
  const existing = repairInFlight.get(scopeKey);
  if (existing) return existing;
  // 工作区键在这里统一解析，所有调用点（会话维护、Settings › Connect 的测试与修复）
  // 因此拿到同一个键，不会出现同一工作区两种令牌分片。
  const resolved: CloudMcpReconcilerInput = input.context.workspaceKey !== undefined
    ? input
    : {
        ...input,
        context: { ...input.context, workspaceKey: await resolveWorkspaceMcpKey(input.client, scope.workspaceId) },
      };
  const task = repairCloudMcp(resolved, scope).finally(() => {
    repairInFlight.delete(scopeKey);
  });
  repairInFlight.set(scopeKey, task);
  return task;
}

export type CloudMcpEngineRefreshRunResult = {
  status: "refreshed" | "failed" | "skipped";
  skippedReason?: "missing_workspace" | "unsupported";
  health: JuggleWorkCloudMcpHealth | null;
  refresh: JuggleWorkCloudMcpEngineRefresh | null;
};

const engineRefreshInFlight = new Map<string, Promise<CloudMcpEngineRefreshRunResult>>();

/**
 * Force the engine to drop its jugglework-cloud MCP client and reconnect.
 * OpenCode keeps a failed MCP failed forever (no automatic retry), so this is
 * the explicit "try again from scratch" lever: engine disconnect, then
 * re-registration from the persisted desired config, then a direct probe.
 */
export async function runJuggleWorkCloudMcpEngineRefresh(input: {
  client: CloudMcpClient;
  context: CloudMcpOperationContext;
}): Promise<CloudMcpEngineRefreshRunResult> {
  const scope = normalizedContextScope(input.context);
  if (!scope?.workspaceId) {
    return { status: "skipped", skippedReason: "missing_workspace", health: null, refresh: null };
  }
  const refreshEngine = input.client.refreshJuggleWorkCloudMcpEngine;
  if (!refreshEngine) {
    return { status: "skipped", skippedReason: "unsupported", health: null, refresh: null };
  }
  const scopeKey = getCloudMcpScopeKey(scope);
  if (!scopeKey) {
    return { status: "skipped", skippedReason: "missing_workspace", health: null, refresh: null };
  }
  const existing = engineRefreshInFlight.get(scopeKey);
  if (existing) return existing;
  const task = (async (): Promise<CloudMcpEngineRefreshRunResult> => {
    const providerModel = input.context.providerModel;
    const result = await refreshEngine(scope.workspaceId, {
      ...(providerModel ? { provider: providerModel.provider, model: providerModel.model } : {}),
      trigger: input.context.trigger ?? "desktop-engine-refresh",
    });
    return {
      status: result.health.usable ? "refreshed" : "failed",
      health: result.health,
      refresh: result.refresh,
    };
  })().finally(() => {
    engineRefreshInFlight.delete(scopeKey);
  });
  engineRefreshInFlight.set(scopeKey, task);
  return task;
}

export function cloudMcpFailureStageLabel(input: {
  signedIn: boolean;
  orgSelected: boolean;
  userState?: CloudMcpUserState | null;
  health?: JuggleWorkCloudMcpHealth | null;
}): string {
  if (!input.signedIn) return "Sign in required";
  if (!input.orgSelected) return "Select an organization";
  if (input.userState) return "Agent access disabled";
  const code = normalizeCode(input.health?.firstFailure?.code);
  if (!code) return input.health?.usableByCurrentModel === null ? "Current model access not checked" : "Agent access ready";
  if (code === "cloud_mcp_disabled" || code === "cloud_disabled") return "Agent access disabled";
  if (code === "cloud_desired_missing" || code === "cloud_mcp_missing") return "Couldn’t apply Cloud access to this workspace";
  if (code.includes("auth") || code.includes("token") || code.includes("unauthorized")) return "Cloud authentication expired";
  if (code === "cloud_tools_missing") return "Cloud endpoint tools are missing";
  if (code === "cloud_status_missing" || code === "cloud_registration_failed") return "Cloud tools weren’t registered";
  if (isProviderProjectionFailure(input.health?.firstFailure)) return "Current model can’t use Cloud tools";
  if (code.includes("tool_ids") || code.includes("client_registration")) return "JuggleWork components need updating";
  if (code === "extensions_plugin_missing") return "Agent instructions are out of date";
  if (code.includes("unreachable") || code.includes("connection") || code.includes("status_missing")) return "Cloud connection unavailable";
  return "Couldn’t apply Cloud access to this workspace";
}

export function cloudMcpRecommendedAction(input: {
  signedIn: boolean;
  orgSelected: boolean;
  userState?: CloudMcpUserState | null;
  health?: JuggleWorkCloudMcpHealth | null;
}): string {
  if (!input.signedIn) return "Sign in to JuggleWork Cloud.";
  if (!input.orgSelected) return "Choose the organization agents should use.";
  if (input.userState) return "Enable Agent access or use Repair and test when you want agents to use connected services.";
  const code = normalizeCode(input.health?.firstFailure?.code);
  if (!code) {
    if (input.health?.usableByCurrentModel === null) return "Model access was not checked because no current model is selected.";
    return "No action needed.";
  }
  if (code === "cloud_mcp_disabled" || code === "cloud_disabled") return "Enable Agent access or use Repair and test when you want agents to use connected services.";
  if (code === "cloud_desired_missing" || code === "cloud_mcp_missing") return "Use Repair and test to apply agent access for this workspace.";
  if (code.includes("auth") || code.includes("token") || code.includes("unauthorized")) return "Use Repair and test to refresh Cloud authentication.";
  if (code.includes("membership")) return "Ask an organization admin to grant access.";
  if (code.includes("scope")) return "Reconnect JuggleWork Cloud with the required permissions.";
  if (code.includes("policy") || code.includes("forbidden") || code.includes("resource")) return "Check organization policy and resource access.";
  if (isProviderProjectionFailure(input.health?.firstFailure)) return "Choose a model that can use JuggleWork Cloud tools.";
  if (code.includes("tool_ids") || code.includes("client_registration")) return "Update JuggleWork, then retry.";
  if (code === "extensions_plugin_missing") return "Reload the agent so JuggleWork instructions are current.";
  if (code === "cloud_tools_missing") return "Reconnect JuggleWork Cloud so the endpoint exposes search_capabilities and execute_capability.";
  if (code === "cloud_status_missing" || code === "cloud_registration_failed") return "Use Repair and test to register the Cloud tools.";
  return input.health?.firstFailure?.recommendedAction || "Use Repair and test, then check Advanced Settings if it still fails.";
}

export function cloudMcpDisplaySummary(input: {
  signedIn: boolean;
  orgSelected: boolean;
  connecting: boolean;
  userState?: CloudMcpUserState | null;
  health?: JuggleWorkCloudMcpHealth | null;
}): CloudMcpDisplaySummary {
  if (input.connecting) {
    return {
      status: "connecting",
      statusLabel: "Connecting",
      tone: "warning",
      stageLabel: "Cloud connection unavailable",
      recommendedAction: "Checking agent access now.",
    };
  }
  if (!input.signedIn) {
    return {
      status: "signed_out",
      statusLabel: "Signed out",
      tone: "neutral",
      stageLabel: cloudMcpFailureStageLabel(input),
      recommendedAction: cloudMcpRecommendedAction(input),
    };
  }
  const code = normalizeCode(input.health?.firstFailure?.code);
  const configEnabled = input.health?.desired.config?.enabled;
  const disabled = input.userState || code === "cloud_mcp_disabled" || code === "cloud_disabled" || configEnabled === false;
  if (disabled) {
    return {
      status: "disabled",
      statusLabel: "Disabled",
      tone: "neutral",
      stageLabel: cloudMcpFailureStageLabel(input),
      recommendedAction: cloudMcpRecommendedAction(input),
    };
  }
  if (input.health?.usable) {
    return {
      status: "ready",
      statusLabel: "Ready",
      tone: "ready",
      stageLabel: cloudMcpFailureStageLabel(input),
      recommendedAction: cloudMcpRecommendedAction(input),
    };
  }
  return {
    status: "degraded",
    statusLabel: "Degraded",
    tone: "error",
    stageLabel: cloudMcpFailureStageLabel(input),
    recommendedAction: cloudMcpRecommendedAction(input),
  };
}

export async function cleanupJuggleWorkCloudMcpAfterSignOut(input: {
  context: CloudMcpScope;
  juggleworkClient: CleanupClient | null;
  opencodeClient: OpenCodeDisconnectClient | null;
  directory: string;
}): Promise<void> {
  const scope = normalizeCloudMcpScope(input.context);
  if (scope) clearCloudMcpScopedMetadata(scope);

  await Promise.all([
    input.juggleworkClient && scope
      ? input.juggleworkClient.removeMcp(scope.workspaceId, CLOUD_MCP_SERVER_NAME).catch(() => null)
      : Promise.resolve(null),
    input.opencodeClient && input.directory.trim()
      ? input.opencodeClient.mcp.disconnect({ directory: input.directory.trim(), name: CLOUD_MCP_SERVER_NAME }).catch(() => null)
      : Promise.resolve(null),
  ]);
}

export function recordCloudMcpDisabledIntent(scope: CloudMcpScope, state: CloudMcpUserState): void {
  writeCloudMcpUserState(state, scope);
  clearCloudMcpScopedMetadata(scope);
}

export function clearCloudMcpDisabledIntent(scope: CloudMcpScope): void {
  clearCloudMcpUserState(scope);
}
