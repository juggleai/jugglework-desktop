import {
  normalizeDesktopConfig,
  type DesktopConfig as SharedDesktopConfig,
} from "@jugglework/types/den/desktop-policies";

// Re-export the shared schema under the local alias so React consumers
// (e.g. the cloud domain's desktop-config provider) can import it alongside
// the helpers they need. Solid references it internally only; the React
// port wants it as part of the public surface of this module.
export type { SharedDesktopConfig };
export { normalizeDesktopConfig };

import { isDesktopDeployment } from "./jugglework-deployment";
import {
  dispatchDenSettingsChanged,
} from "./den-session-events";
import {
  desktopFetch,
  desktopFetchViaMain,
  getDesktopBootstrapConfig as getDesktopBootstrapConfigFromShell,
  readInitialDesktopBootstrapConfig,
  setDesktopBootstrapConfig as setDesktopBootstrapConfigInShell,
  type DesktopBootstrapConfig as ShellDesktopBootstrapConfig,
} from "./desktop";
import { isDesktopRuntime } from "./runtime-env";
import type { ReloadReason } from "../types";
import type {
  JuggleWorkExtensionContribution,
  JuggleWorkExtensionContributionType,
  JuggleWorkExtensionLifecycle,
  JuggleWorkExtensionManifest,
  JuggleWorkExtensionResource,
  JuggleWorkExtensionResourceType,
  JuggleWorkExtensionSetup,
  JuggleWorkExtensionSource,
  JuggleWorkExtensionSourceFormat,
} from "../extensions";

export const STORAGE_BASE_URL = "jugglework.den.baseUrl";
const LEGACY_STORAGE_API_BASE_URL = "jugglework.den.apiBaseUrl";
const STORAGE_AUTH_TOKEN = "jugglework.den.authToken";
const STORAGE_IM_LOGIN_BOOTSTRAP = "jugglework.den.imLoginBootstrap";
const STORAGE_ACTIVE_ORG_ID = "jugglework.den.activeOrgId";
const STORAGE_ACTIVE_ORG_SLUG = "jugglework.den.activeOrgSlug";
const STORAGE_ACTIVE_ORG_NAME = "jugglework.den.activeOrgName";
/**
 * Identity of the account whose local state this machine currently holds.
 * Nothing else persisted here identifies a *user* — base URL, token and org
 * do not — so without this the app cannot tell a re-login from a different
 * person signing in, and no per-account cleanup can be triggered at all.
 */
const STORAGE_USER_ID = "jugglework.den.userId";
export const CLOUD_MCP_SYNC_MARKER_STORAGE_KEY = "jugglework.den.mcp.sync";
const ORG_PROXY_HEADER = "x-jugglework-legacy-org-id";
const DEFAULT_DEN_TIMEOUT_MS = 12_000;

export const DEFAULT_DEN_AUTH_NAME = "JuggleWork User";
const BUILD_DEN_BASE_URL =
  (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_BASE_URL === "string"
    ? import.meta.env.VITE_DEN_BASE_URL
    : "").trim() || "https://work.juggle.im";
const BUILD_DEN_REQUIRE_SIGNIN =
  (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_REQUIRE_SIGNIN === "string"
    ? /^(1|true|yes|on)$/i.test(import.meta.env.VITE_DEN_REQUIRE_SIGNIN.trim())
    : false);
// Local-only convenience for source development. Vite loads this value from
// `.env.development.local`, while production builds never load that file. The
// configured token intentionally wins over persisted state so rotating an
// expired token only requires replacing the file and restarting the dev app.
const BUILD_DEN_DEV_AUTH_TOKEN =
  (typeof import.meta !== "undefined" &&
  import.meta.env?.DEV === true &&
  typeof import.meta.env?.VITE_DEN_DEV_AUTH_TOKEN === "string"
    ? import.meta.env.VITE_DEN_DEV_AUTH_TOKEN
    : "").trim();
const BUILD_DEN_DEV_IM_LOGIN_BOOTSTRAP: DenIMLoginBootstrap | null = (() => {
  if (typeof import.meta === "undefined" || import.meta.env?.DEV !== true) return null;
  const read = (key: string) => {
    const value = import.meta.env?.[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const appKey = read("VITE_DEN_DEV_IM_APP_KEY");
  const websocketUrl = read("VITE_DEN_DEV_IM_WEBSOCKET_URL");
  const imUserId = read("VITE_DEN_DEV_IM_USER_ID");
  const token = read("VITE_DEN_DEV_IM_TOKEN");
  if (!appKey || !websocketUrl || !imUserId || !token) return null;
  return {
    provider: read("VITE_DEN_DEV_IM_PROVIDER") || "juggleim",
    appKey,
    websocketUrl,
    imUserId,
    token,
  };
})();

export const HOSTED_DEFAULT_DEN_BASE_URL = "https://work.juggle.im";
export const DEFAULT_DEN_BASE_URL = BUILD_DEN_BASE_URL;

/**
 * Path prefix the JuggleWork server mounts every route under (its
 * `configures.HTTPPathPrefix`). `<origin>/jwork` is the control plane root:
 * the login page, `/api/auth/*`, `/api/v1/*`, `/api/mcp/*` and the web
 * console all hang off it.
 */
export const DEN_CONTROL_PLANE_PATH = "/jwork";
/** API root under the control plane prefix (`/jwork/api`). */
const DEN_API_BASE_PATH = `${DEN_CONTROL_PLANE_PATH}/api`;
/** The pre-`/jwork` layout: den-web proxied den-api at `<origin>/api/den`. */
const LEGACY_DEN_API_BASE_PATH = "/api/den";
export const DEN_DASHBOARD_PATH = `${DEN_CONTROL_PLANE_PATH}/console`;

// Den wire types moved to den-types.ts (leaf module); re-exported here so
// the many existing den.ts importers keep working.
export type * from "./den-types";
import type {
  DenOrgExtensionProjection,
  DenOrgMarketplace,
  DenOrgPlugin,
  DenOrgPluginResolved,
  DenPluginCloudReadiness,
  DenPluginCloudReadinessConnection,
  DenPluginMcpComponent,
  DenPluginCloudReadinessState,
  DenPluginConfigObject,
  DenPluginConfigObjectType,
  DenPluginConfigObjectVersion,
  DenPluginMembership,
  DenResourceSnapshot,
  DenResourceSnapshotConfigItem,
  DenResourceSnapshotMarketplace,
  DenResourceSnapshotPlugin,
  DenSettings,
  DenIMLoginBootstrap,
  DenUser,
} from "./den-types";

type DenBaseUrls = {
  baseUrl: string;
  apiBaseUrl: string;
};

export type DenBootstrapSource = "file" | "default";

/** Org + first-skill identity shared by the handoff and prepared records. */
export type DenBootstrapOrgSkill = {
  orgId: string;
  orgName: string;
  orgSlug: string;
  skillId: string;
  skillTitle: string;
};

export type DenBootstrapHandoff = DenBootstrapOrgSkill & {
  grant: string;
  denBaseUrl: string;
  createdAt: string;
};

export type DenBootstrapPrepared = DenBootstrapOrgSkill & {
  skillsDir: string;
  skillPath: string;
  preparedAt: string;
};

export type DenBootstrapConfig = DenBaseUrls & {
  source: DenBootstrapSource;
  requireSignin: boolean;
  brandAppName?: string | null;
  brandLogoUrl?: string | null;
  brandIconUrl?: string | null;
  claimLinks?: Array<{
    id: string;
    role: string;
    token?: string;
    url: string;
    expiresAt: string;
  }> | null;
  handoff?: DenBootstrapHandoff | null;
  prepared?: DenBootstrapPrepared | null;
};

export type DenDesktopConfig = SharedDesktopConfig;

export type DenOrgSummary = {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
  kind?: "personal" | "organization";
  tier?: DenTenantTier | null;
  accountStatus?: string | null;
};

export type DenTenantTier = "normal" | "pro" | "power" | "team" | "business";

export type DenTenantAccount = {
  kind: "personal" | "organization";
  tier: DenTenantTier;
  status: string;
  tierVersion: number;
  points: {
    available: number;
    reserved: number;
    version: number;
  };
  permissions: {
    canViewLedger: boolean;
    canManageBilling: boolean;
  };
};

export type DenWorkerSummary = {
  workerId: string;
  workerName: string;
  status: string;
  instanceUrl: string | null;
  provider: string | null;
  isMine: boolean;
  createdAt: string | null;
};

export type DenWorkerTokens = {
  clientToken: string | null;
  ownerToken: string | null;
  hostToken: string | null;
  juggleworkUrl: string | null;
  workspaceId: string | null;
};

export type DenMemoryContext = {
  id: string;
  snippet: string;
  citation: Record<string, unknown> | null;
  origin: string | null;
  createdAt: string;
};

export type DenMemory = {
  id: string;
  content: string;
  tags: string[] | null;
  source: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
  contexts: DenMemoryContext[];
};

export type DenMcpToken = {
  token: string;
  expiresAt: string;
  organizationId: string;
  scopes: string[];
  resource: string;
  /**
   * 该令牌绑定的工作区键；空串表示账号级令牌（目录读取），不参与工作区策略。
   * 旧版服务端不回这个字段，解析为空串。
   */
  workspaceKey: string;
};

/** 一条组织 MCP 连接在某个工作区的开关状态。 */
export type DenMcpWorkspaceConnectionPolicy = {
  connectionId: string;
  name: string;
  authType: string;
  credentialMode: string;
  connectedForMe: boolean;
  enabled: boolean;
  toolCount: number;
};

/** 一个工作区的组织连接开关视图。 */
export type DenMcpWorkspacePolicy = {
  workspaceKey: string;
  items: DenMcpWorkspaceConnectionPolicy[];
};

/** 服务端声明的自动化稳定 envelope 与投影兼容能力。 */
export type DenAutomationCapabilities = {
  envelopeVersions: number[];
  documentMediaTypes: string[];
  projections: Record<string, number[]>;
  limits: Record<string, number>;
};

/** 服务端返回的自动化镜像，未知字段必须由调用方原样保留。 */
export type DenAutomationMirror = Record<string, unknown> & {
  automationId?: string;
  revision?: number;
  executorDeviceId?: string;
  compatibility?: string;
};

/** 服务端返回的自动化运行镜像，运行详情 envelope 保持开放结构。 */
export type DenAutomationRunMirror = Record<string, unknown> & {
  runId?: string;
  automationId?: string;
  runRevision?: number;
};

export type DenAutomationPage<T> = {
  items: T[];
  nextCursor?: string;
};

export type DenAutomationListOptions = {
  executorDeviceId?: string;
  state?: string;
  cursor?: string;
  limit?: number;
};

export type DenAutomationRunListOptions = {
  automationId?: string;
  status?: string;
  triggerSource?: string;
  startedAfter?: string;
  startedBefore?: string;
  cursor?: string;
  limit?: number;
};

export type DenOrgLlmProviderModel = {
  id: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string | null;
};

export type DenOrgLlmProvider = {
  id: string;
  source: "models_dev" | "custom" | "jugglework" | "juggle_router";
  providerId: string;
  name: string;
  providerConfig: Record<string, unknown>;
  hasApiKey: boolean;
  managed?: boolean;
  managedKind?: "juggle_router" | null;
  accessScope?: "explicit" | "organization";
  enabled?: boolean;
  models: DenOrgLlmProviderModel[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type DenExternalMcpConnection = {
  id: string;
  name: string;
  url: string;
  authType: "oauth" | "apikey" | "none";
  credentialMode: "shared" | "per_member";
  connected: boolean;
  connectedAt: string | null;
  /** For per_member connections: whether the CALLING member has connected their own account. Always true for connected shared connections. */
  connectedForMe: boolean;
  needsReconnect?: boolean;
  issuerReviewRequired?: boolean;
  reconnectActionOwner?: "member" | "organization_admin" | null;
  missingFeatures?: string[];
  externalAccountId?: string | null;
  grantedScopes?: string[];
  tenantId?: string | null;
};

export type DenMcpConnectionConnectStart = {
  status: "connected" | "needs_auth";
  authorizeUrl: string | null;
};

export type DenOrgLlmProviderConnection = DenOrgLlmProvider & {
  apiKey: string | null;
  /**
   * Per-env-var credential values for providers whose config declares several
   * env keys (e.g. AWS Bedrock). Servers send either `apiKey` or `apiKeys`,
   * never both.
   */
  apiKeys: Record<string, string> | null;
};

export type DenOrgMarketplaceResolved = {
  marketplace: DenOrgMarketplace;
  plugins: DenOrgPlugin[];
};

export type DenBillingPrice = {
  amount: number | null;
  currency: string | null;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
};

export type DenBillingSubscription = {
  id: string;
  status: string;
  amount: number | null;
  currency: string | null;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  endedAt: string | null;
};

export type DenBillingInvoice = {
  id: string;
  createdAt: string | null;
  status: string;
  totalAmount: number | null;
  currency: string | null;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
};

export type DenBillingSummary = {
  featureGateEnabled: boolean;
  hasActivePlan: boolean;
  checkoutRequired: boolean;
  checkoutUrl: string | null;
  portalUrl: string | null;
  price: DenBillingPrice | null;
  subscription: DenBillingSubscription | null;
  invoices: DenBillingInvoice[];
  productId: string | null;
  benefitId: string | null;
};

type DenAuthResult = {
  user: DenUser | null;
  token: string | null;
  im: DenIMLoginBootstrap | null;
};

export type DenDesktopHandoffExchange = {
  user: DenUser | null;
  token: string | null;
  im: DenIMLoginBootstrap | null;
};

export type DenDesktopRemoteEnrollmentGrant = {
  schemaVersion: 1;
  grant: string;
  expiresAt: string;
};

const defaultBootstrapBaseUrls = resolveDenBaseUrls({
  baseUrl: BUILD_DEN_BASE_URL,
});
export const DEFAULT_DEN_API_BASE_URL = defaultBootstrapBaseUrls.apiBaseUrl;

let desktopBootstrapConfig: DenBootstrapConfig = {
  ...defaultBootstrapBaseUrls,
  source: "default",
  requireSignin: BUILD_DEN_REQUIRE_SIGNIN,
};

export type DenAppVersionMetadata = {
  minAppVersion: string;
  latestAppVersion: string;
  publishedDesktopVersions: string[];
};

type RawJsonResponse<T> = {
  ok: boolean;
  status: number;
  json: T | null;
};

export class DenApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "DenApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * True only for 401s that actually came from the Den API (its JSON error
 * envelope parsed into a code). A bare/foreign 401 from a corporate proxy,
 * captive portal, or LB while the control plane is unreachable must be
 * treated as "unavailable", not as a revoked session — otherwise a VPN blip
 * signs the user out and destroys the stored token.
 */
export function isDenSessionRevokedError(error: unknown): boolean {
  return error instanceof DenApiError && error.status === 401 && error.code !== "request_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function getDenAppVersionMetadata(payload: unknown): DenAppVersionMetadata | null {
  if (!isRecord(payload)) return null;

  const latestAppVersion =
    typeof payload.latestAppVersion === "string" ? payload.latestAppVersion.trim() : "";
  if (!latestAppVersion) return null;
  const publishedDesktopVersions = readStringArray(payload.publishedDesktopVersions);

  return {
    minAppVersion:
      typeof payload.minAppVersion === "string" ? payload.minAppVersion.trim() : "",
    latestAppVersion,
    publishedDesktopVersions:
      publishedDesktopVersions.length > 0 ? publishedDesktopVersions : [latestAppVersion],
  };
}

export function normalizeDenDesktopConfig(payload: unknown): DenDesktopConfig {
  return normalizeDesktopConfig(payload);
}

function readTimestampRecord(value: unknown): Record<string, string> {
  if (!isRecord(value) || Array.isArray(value)) return {};

  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const id = key.trim();
    const timestampValue = typeof entry === "string" ? entry.trim() : "";
    if (id && timestampValue) {
      record[id] = timestampValue;
    }
  }
  return record;
}

function readDenResourceSnapshotConfigItems(value: unknown): DenResourceSnapshotConfigItem[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const configItemId = typeof entry.configItemId === "string" ? entry.configItemId.trim() : "";
    const lastUpdatedAt = typeof entry.lastUpdatedAt === "string" ? entry.lastUpdatedAt.trim() : "";
    return configItemId && lastUpdatedAt ? [{ configItemId, lastUpdatedAt }] : [];
  });
}

function readDenResourceSnapshotPlugins(value: unknown): DenResourceSnapshotPlugin[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const pluginId = typeof entry.pluginId === "string" ? entry.pluginId.trim() : "";
    const lastUpdatedAt = typeof entry.lastUpdatedAt === "string" ? entry.lastUpdatedAt.trim() : "";
    if (!pluginId || !lastUpdatedAt) return [];

    return [{
      pluginId,
      lastUpdatedAt,
      configItems: readDenResourceSnapshotConfigItems(entry.configItems),
    }];
  });
}

function readDenResourceSnapshotMarketplaces(value: unknown): Record<string, DenResourceSnapshotMarketplace> {
  if (!isRecord(value) || Array.isArray(value)) return {};

  const marketplaces: Record<string, DenResourceSnapshotMarketplace> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const marketplaceId = key.trim();
    const lastUpdatedAt = typeof entry.lastUpdatedAt === "string" ? entry.lastUpdatedAt.trim() : "";
    if (!marketplaceId || !lastUpdatedAt) continue;
    marketplaces[marketplaceId] = {
      lastUpdatedAt,
      plugins: readDenResourceSnapshotPlugins(entry.plugins),
    };
  }
  return marketplaces;
}

export function normalizeDenResourceSnapshot(payload: unknown): DenResourceSnapshot | null {
  if (!isRecord(payload)) return null;

  const organizationId = typeof payload.organizationId === "string" ? payload.organizationId.trim() : "";
  const orgMemberId = typeof payload.orgMemberId === "string" ? payload.orgMemberId.trim() : "";
  const resources = isRecord(payload.resources) ? payload.resources : null;
  if (!organizationId || !orgMemberId || !resources) return null;

  return {
    organizationId,
    orgMemberId,
    teamIds: readStringArray(payload.teamIds),
    resources: {
      llmProviders: readTimestampRecord(resources.llmProviders),
      marketplaces: readDenResourceSnapshotMarketplaces(resources.marketplaces),
    },
  };
}

export function normalizeDenBaseUrl(input: string | null | undefined): string | null {
  const value = (input ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Origin-level comparison key for Den URLs. Ignores paths (deep links may
 * carry the `/jwork/api` control plane path) and treats loopback aliases
 * (127.0.0.1, [::1]) as `localhost`, matching the server's own dev-mode
 * resource aliasing.
 */
export function denOriginComparisonKey(input: string | null | undefined): string | null {
  const normalized = normalizeDenBaseUrl(input);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "0.0.0.0") {
      url.hostname = "localhost";
    }
    return url.origin;
  } catch {
    return normalized;
  }
}

/**
 * The provider catalog a self-hosted deployment serves at
 * `<origin>/jwork/models/api.json` — the same payload the desktop hands the
 * engine as `OPENCODE_MODELS_URL` (see `denModelsCatalogUrl` in
 * `apps/desktop/electron/runtime.mjs`, which derives the same URL). The hosted
 * control plane serves the same catalog, so only an unusable URL returns null.
 */
export function getDenModelCatalogUrl(baseUrl?: string | null): string | null {
  const effectiveBaseUrl = baseUrl ?? readDenSettings().baseUrl;
  const origin = denOriginComparisonKey(effectiveBaseUrl);
  if (!origin) return null;
  return `${denControlPlaneBaseUrl(resolveDenBaseUrls(effectiveBaseUrl).baseUrl)}/models/api.json`;
}

function isHostedWebAppHost(hostname: string): boolean {
  return hostname.trim().toLowerCase() === new URL(HOSTED_DEFAULT_DEN_BASE_URL).hostname;
}

/**
 * Strip the API path from a stored/deep-linked URL so only the deployment
 * origin remains. Legacy `/api/den` values are accepted so clients upgraded
 * from a den-web deployment keep resolving to the same origin.
 */
function stripDenApiBasePath(input: string | null | undefined): string | null {
  const normalized = normalizeDenBaseUrl(input);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    const suffix = [DEN_API_BASE_PATH, LEGACY_DEN_API_BASE_PATH, DEN_CONTROL_PLANE_PATH].find((candidate) =>
      pathname.toLowerCase().endsWith(candidate),
    );
    if (!suffix) {
      return normalized;
    }

    const nextPathname = pathname.slice(0, -suffix.length) || "/";
    url.pathname = nextPathname;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalized;
  }
}

function ensureDenApiBasePath(input: string | null | undefined): string | null {
  const normalized = normalizeDenBaseUrl(input);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.toLowerCase().endsWith(DEN_API_BASE_PATH)) {
      return normalized;
    }
    url.pathname = `${pathname}${DEN_API_BASE_PATH}`.replace(/\/+/g, "/");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalized;
  }
}

/** The control plane root (`<origin>/jwork`) that `/api/...` routes hang off. */
function denControlPlaneBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${DEN_CONTROL_PLANE_PATH}`;
}

export function resolveDenBaseUrls(input: { baseUrl?: string | null; apiBaseUrl?: string | null } | string | null | undefined): DenBaseUrls {
  const rawBaseUrl = typeof input === "string" ? input : input?.baseUrl;
  const normalizedBaseUrl = normalizeDenBaseUrl(rawBaseUrl);
  const legacyApiBaseUrl = typeof input === "string" ? null : normalizeDenBaseUrl(input?.apiBaseUrl);
  const seedUrl = stripDenApiBasePath(normalizedBaseUrl ?? legacyApiBaseUrl) ?? DEFAULT_DEN_BASE_URL;
  const baseUrl = stripDenApiBasePath(seedUrl) ?? DEFAULT_DEN_BASE_URL;

  return {
    baseUrl,
    apiBaseUrl: ensureDenApiBasePath(baseUrl) ?? baseUrl,
  };
}

export function buildDenDashboardUrl(baseUrl: string | null | undefined): string {
  return new URL(DEN_DASHBOARD_PATH, resolveDenBaseUrls(baseUrl).baseUrl).toString();
}

/** The MCP endpoint served through the Den web proxy from the single base URL. */
export function getDenMcpUrl(): string {
  const { apiBaseUrl } = resolveDenBaseUrls(readDenBootstrapConfig());
  return `${apiBaseUrl.replace(/\/+$/, "")}/mcp`;
}

/**
 * Detects MCP URLs written by older builds that pointed `/mcp` at the bare
 * web-app origin (e.g. `https://work.juggle.im/jwork/api/mcp`). Nothing serves
 * MCP there — those entries fail with a 404 and must be reconfigured.
 */
export function isLegacyWebAppMcpUrl(input: string | null | undefined): boolean {
  if (!input) return false;
  try {
    const url = new URL(input);
    return isHostedWebAppHost(url.hostname) && url.pathname.replace(/\/+$/, "") === "/mcp";
  } catch {
    return false;
  }
}

/**
 * Resolve the URL the cloud MCP entry should connect to from a minted
 * token's `resource`. Older den-api builds mint the bare web-app origin
 * (`https://work.juggle.im/jwork/api/mcp`) where nothing serves MCP — heal
 * those to the control plane's MCP route on the same origin instead of
 * trusting them verbatim. Returns null when the resource is unusable so
 * callers can keep their bootstrap-derived URL.
 */
export function resolveCloudMcpResourceUrl(resource: string | null | undefined): string | null {
  const trimmed = resource?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (isLegacyWebAppMcpUrl(trimmed)) {
      url.pathname = `${DEN_API_BASE_PATH}/mcp`;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function resolveDenBootstrapConfig(
  input: {
    baseUrl: string;
    apiBaseUrl?: string | null;
    requireSignin?: boolean | null;
    brandAppName?: string | null;
    brandLogoUrl?: string | null;
    brandIconUrl?: string | null;
    fromFile?: boolean | null;
    source?: DenBootstrapSource | null;
    claimLinks?: DenBootstrapConfig["claimLinks"];
    handoff?: DenBootstrapHandoff | null;
    prepared?: DenBootstrapPrepared | null;
  },
): DenBootstrapConfig {
  return {
    ...resolveDenBaseUrls(input),
    source: input.source === "file" || input.fromFile === true ? "file" : "default",
    requireSignin: input.requireSignin === true,
    ...(input.brandAppName?.trim() ? { brandAppName: input.brandAppName.trim().slice(0, 64) } : {}),
    ...(input.brandLogoUrl?.trim() ? { brandLogoUrl: input.brandLogoUrl.trim() } : {}),
    ...(input.brandIconUrl?.trim() ? { brandIconUrl: input.brandIconUrl.trim() } : {}),
    ...(input.claimLinks ? { claimLinks: input.claimLinks } : {}),
    ...(input.handoff ? { handoff: input.handoff } : {}),
    ...(input.prepared ? { prepared: input.prepared } : {}),
  };
}

function getPendingBootstrapConfig(next: DenSettings): DenBootstrapConfig | null {
  if (next.baseUrl === undefined) {
    return null;
  }

  const previous = readDenBootstrapConfig();
  return resolveDenBootstrapConfig({
    baseUrl: next.baseUrl ?? previous.baseUrl,
    requireSignin: previous.requireSignin,
    brandAppName: previous.brandAppName,
    brandLogoUrl: previous.brandLogoUrl,
    brandIconUrl: previous.brandIconUrl,
    source: previous.source,
    claimLinks: previous.claimLinks,
    handoff: previous.handoff,
    prepared: previous.prepared,
  });
}

function applyDesktopBootstrapConfig(config: DenBootstrapConfig) {
  desktopBootstrapConfig = config;
}

export function readDenBootstrapConfig(): DenBootstrapConfig {
  return desktopBootstrapConfig;
}

export async function initializeDenBootstrapConfig(): Promise<DenBootstrapConfig> {
  if (!isDesktopRuntime()) {
    desktopBootstrapConfig = resolveDenBootstrapConfig({
      baseUrl: BUILD_DEN_BASE_URL,
      requireSignin: BUILD_DEN_REQUIRE_SIGNIN,
    });
    return desktopBootstrapConfig;
  }

  const initialBootstrap = readInitialDesktopBootstrapConfig();
  if (initialBootstrap) {
    applyDesktopBootstrapConfig(resolveDenBootstrapConfig(initialBootstrap));
    return desktopBootstrapConfig;
  }

  // The shell IPC bridge can be momentarily unavailable at first paint;
  // retry briefly before giving up so a boot race does not poison the
  // session with build defaults.
  const SHELL_BOOTSTRAP_ATTEMPTS = 3;
  const SHELL_BOOTSTRAP_RETRY_DELAY_MS = 350;
  for (let attempt = 1; attempt <= SHELL_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    try {
      const bootstrap = await getDesktopBootstrapConfigFromShell();
      applyDesktopBootstrapConfig(resolveDenBootstrapConfig(bootstrap));
      return desktopBootstrapConfig;
    } catch (error) {
      console.error("[den-bootstrap] shell read failed", attempt, error);
      if (attempt < SHELL_BOOTSTRAP_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, SHELL_BOOTSTRAP_RETRY_DELAY_MS));
      }
    }
  }

  // All quick attempts failed. Keep build defaults in memory only — do NOT
  // sync them to localStorage: previously synced values from a successful
  // boot are more trustworthy than build defaults, and clobbering them
  // silently reverted custom/self-hosted control planes to the production
  // URL until a manual reload.
  desktopBootstrapConfig = resolveDenBootstrapConfig({
    baseUrl: BUILD_DEN_BASE_URL,
    requireSignin: BUILD_DEN_REQUIRE_SIGNIN,
  });

  // Heal in the background without blocking boot: once the bridge comes up,
  // apply the real shell config and notify listeners.
  void (async () => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try {
        const bootstrap = await getDesktopBootstrapConfigFromShell();
        applyDesktopBootstrapConfig(resolveDenBootstrapConfig(bootstrap));
        dispatchDenSettingsChanged({ settings: readDenSettings() });
        return;
      } catch {
        // Bridge still unavailable — keep trying.
      }
    }
  })();

  return desktopBootstrapConfig;
}

/**
 * Re-reads desktop-bootstrap.json from the shell and applies it to the cached
 * snapshot, notifying listeners. Used after the shell itself persisted a new
 * config (e.g. an accepted connect link) so the renderer converges without a
 * reload.
 */
export async function refreshDenBootstrapConfigFromShell(): Promise<DenBootstrapConfig> {
  if (isDesktopRuntime()) {
    try {
      const bootstrap = await getDesktopBootstrapConfigFromShell();
      applyDesktopBootstrapConfig(resolveDenBootstrapConfig(bootstrap));
      dispatchDenSettingsChanged({ settings: readDenSettings() });
    } catch {
      // Bridge hiccup — keep the current cached snapshot.
    }
  }
  return readDenBootstrapConfig();
}

export async function setDenBootstrapConfig(
  next: ShellDesktopBootstrapConfig,
  options?: { dispatchSettingsChanged?: boolean },
): Promise<DenBootstrapConfig> {
  const normalized = resolveDenBootstrapConfig(next);

  if (isDesktopRuntime()) {
    const persisted = await setDesktopBootstrapConfigInShell({
      baseUrl: normalized.baseUrl,
      requireSignin: normalized.requireSignin,
      ...(normalized.brandAppName ? { brandAppName: normalized.brandAppName } : {}),
      ...(normalized.brandLogoUrl ? { brandLogoUrl: normalized.brandLogoUrl } : {}),
      ...(normalized.brandIconUrl ? { brandIconUrl: normalized.brandIconUrl } : {}),
      ...(normalized.handoff ? { handoff: normalized.handoff } : {}),
      ...(normalized.prepared ? { prepared: normalized.prepared } : {}),
    });
    
    applyDesktopBootstrapConfig(resolveDenBootstrapConfig({ ...persisted, source: "file" }));
  } else {
    applyDesktopBootstrapConfig(normalized);
  }

  if (options?.dispatchSettingsChanged !== false) {
    dispatchDenSettingsChanged({
      settings: readDenSettings(),
    });
  }

  return readDenBootstrapConfig();
}

export function buildDenAuthUrl(baseUrl: string, mode: "sign-in" | "sign-up"): string {
  // The server serves the browser login + desktop handoff page at
  // `<origin>/jwork/login`; the bare origin is not a control plane route.
  const target = new URL(`${denControlPlaneBaseUrl(resolveDenBaseUrls(baseUrl).baseUrl)}/login`);
  target.searchParams.set("mode", mode);
  if (isDesktopDeployment()) {
    target.searchParams.set("desktopAuth", "1");
    target.searchParams.set("desktopScheme", "jugglework");
  }
  return target.toString();
}

// Auth routes are written out in full (`/api/auth/...`) so they resolve
// against the control plane root; everything else is a path under the API
// root (`/v1/...` -> `/jwork/api/v1/...`).
function resolveRequestBaseUrl(baseUrls: DenBaseUrls, path: string): string {
  return path.startsWith("/api/") ? denControlPlaneBaseUrl(baseUrls.baseUrl) : baseUrls.apiBaseUrl;
}

export function readDenSettings(): DenSettings {
  if (typeof window === "undefined") {
    return {
      ...readDenBootstrapConfig(),
      authToken: null,
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    };
  }

  const baseUrls = resolveDenBaseUrls({
    baseUrl: isDesktopRuntime()
      ? readDenBootstrapConfig().baseUrl
      : window.localStorage.getItem(STORAGE_BASE_URL) ?? readDenBootstrapConfig().baseUrl,
  });

  return {
    ...baseUrls,
    authToken:
      BUILD_DEN_DEV_AUTH_TOKEN ||
      (window.localStorage.getItem(STORAGE_AUTH_TOKEN) ?? "").trim() ||
      null,
    activeOrgId: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_ID) ?? "").trim() || null,
    activeOrgSlug: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_SLUG) ?? "").trim() || null,
    activeOrgName: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_NAME) ?? "").trim() || null,
  };
}

export function readDenUserId(): string | null {
  if (typeof window === "undefined") return null;
  return (window.localStorage.getItem(STORAGE_USER_ID) ?? "").trim() || null;
}

function denCredentialFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${hash >>> 0}`;
}

export function readDenIMLoginBootstrap(): DenIMLoginBootstrap | null {
  // Keep the fixed development credentials aligned with
  // VITE_DEN_DEV_AUTH_TOKEN: they override stale persisted handoff data and
  // are ignored entirely outside Vite development mode.
  if (BUILD_DEN_DEV_IM_LOGIN_BOOTSTRAP) return BUILD_DEN_DEV_IM_LOGIN_BOOTSTRAP;
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_IM_LOGIN_BOOTSTRAP);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as { authFingerprint?: unknown; im?: unknown };
    const authToken = readDenSettings().authToken?.trim() ?? "";
    if (!authToken || stored.authFingerprint !== denCredentialFingerprint(authToken)) return null;
    return getIMLoginBootstrap({ im: stored.im });
  } catch {
    return null;
  }
}

export function writeDenIMLoginBootstrap(value: DenIMLoginBootstrap | null) {
  if (typeof window === "undefined") return;
  if (value) {
    const authToken = readDenSettings().authToken?.trim() ?? "";
    if (!authToken) {
      window.localStorage.removeItem(STORAGE_IM_LOGIN_BOOTSTRAP);
      return;
    }
    window.localStorage.setItem(STORAGE_IM_LOGIN_BOOTSTRAP, JSON.stringify({
      authFingerprint: denCredentialFingerprint(authToken),
      im: value,
    }));
  } else {
    window.localStorage.removeItem(STORAGE_IM_LOGIN_BOOTSTRAP);
  }
}

export function writeDenUserId(userId: string | null) {
  if (typeof window === "undefined") return;
  const resolved = userId?.trim() ?? "";
  if (resolved) {
    window.localStorage.setItem(STORAGE_USER_ID, resolved);
  } else {
    window.localStorage.removeItem(STORAGE_USER_ID);
  }
}

function mergePassiveDenField(
  current: string | null | undefined,
  next: string | null | undefined,
): string | null {
  const trimmed = next?.trim() ?? "";
  return trimmed || current || null;
}

/**
 * Merge an in-memory den-session snapshot over the persisted settings for the
 * PASSIVE state->storage mirror. A passive sync must never delete persisted
 * credentials just because in-memory state has not (or could not) load them —
 * e.g. while the control plane is unreachable the org list never loads, and
 * mirroring `activeOrg: null` used to erase the stored org (and, after a
 * remount race, the auth token), permanently signing the user out on a
 * transient VPN/network outage. Explicit sign-out/change-server flows clear
 * storage through clearDenSession()/saveControlPlaneUrl() instead.
 */
export function mergePassiveDenSettings(current: DenSettings, next: DenSettings): DenSettings {
  return {
    ...resolveDenBaseUrls(next),
    authToken: mergePassiveDenField(current.authToken, next.authToken),
    activeOrgId: mergePassiveDenField(current.activeOrgId, next.activeOrgId),
    activeOrgSlug: mergePassiveDenField(current.activeOrgSlug, next.activeOrgSlug),
    activeOrgName: mergePassiveDenField(current.activeOrgName, next.activeOrgName),
  };
}

export function writeDenSettings(next: DenSettings, options?: { persistBootstrap?: boolean }) {
  if (typeof window === "undefined") {
    return;
  }

  const pendingBootstrap = getPendingBootstrapConfig(next);
  const previous = readDenSettings();
  const resolved = resolveDenBaseUrls(next);
  const baseUrl = resolved.baseUrl;
  const apiBaseUrl = resolved.apiBaseUrl;
  const authToken = next.authToken?.trim() ?? "";
  const activeOrgId = next.activeOrgId?.trim() ?? "";
  const activeOrgSlug = next.activeOrgSlug?.trim() ?? "";
  const activeOrgName = next.activeOrgName?.trim() ?? "";

  if (
    previous.baseUrl === baseUrl &&
    (previous.apiBaseUrl ?? "") === apiBaseUrl &&
    (previous.authToken ?? "") === authToken &&
    (previous.activeOrgId ?? "") === activeOrgId &&
    (previous.activeOrgSlug ?? "") === activeOrgSlug &&
    (previous.activeOrgName ?? "") === activeOrgName
  ) {
    return;
  }

  if (isDesktopRuntime()) {
    window.localStorage.removeItem(STORAGE_BASE_URL);
  } else {
    window.localStorage.setItem(STORAGE_BASE_URL, baseUrl);
  }
  window.localStorage.removeItem(LEGACY_STORAGE_API_BASE_URL);
  if (previous.baseUrl !== baseUrl || (previous.authToken ?? "") !== authToken) {
    window.localStorage.removeItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY);
  }
  if (authToken) {
    window.localStorage.setItem(STORAGE_AUTH_TOKEN, authToken);
  } else {
    window.localStorage.removeItem(STORAGE_AUTH_TOKEN);
  }

  if (activeOrgId) {
    window.localStorage.setItem(STORAGE_ACTIVE_ORG_ID, activeOrgId);
  } else {
    window.localStorage.removeItem(STORAGE_ACTIVE_ORG_ID);
  }

  if (activeOrgSlug) {
    window.localStorage.setItem(STORAGE_ACTIVE_ORG_SLUG, activeOrgSlug);
  } else {
    window.localStorage.removeItem(STORAGE_ACTIVE_ORG_SLUG);
  }

  if (activeOrgName) {
    window.localStorage.setItem(STORAGE_ACTIVE_ORG_NAME, activeOrgName);
  } else {
    window.localStorage.removeItem(STORAGE_ACTIVE_ORG_NAME);
  }

  if (options?.persistBootstrap !== false && pendingBootstrap) {
    const currentBootstrap = readDenBootstrapConfig();
    if (
      pendingBootstrap.baseUrl !== currentBootstrap.baseUrl
    ) {
      void setDenBootstrapConfig({
        baseUrl: pendingBootstrap.baseUrl,
        requireSignin: currentBootstrap.requireSignin,
        brandAppName: currentBootstrap.brandAppName,
        brandLogoUrl: currentBootstrap.brandLogoUrl,
        brandIconUrl: currentBootstrap.brandIconUrl,
      }).catch(() => undefined);
    }
  }

  dispatchDenSettingsChanged({
    settings: readDenSettings(),
  });
}

export function clearDenSession(options?: { includeBaseUrls?: boolean }) {
  if (typeof window === "undefined") {
    return;
  }

  if (options?.includeBaseUrls) {
    window.localStorage.removeItem(STORAGE_BASE_URL);
    window.localStorage.removeItem(LEGACY_STORAGE_API_BASE_URL);
  }

  window.localStorage.removeItem(STORAGE_AUTH_TOKEN);
  window.localStorage.removeItem(STORAGE_IM_LOGIN_BOOTSTRAP);
  window.localStorage.removeItem(STORAGE_ACTIVE_ORG_ID);
  window.localStorage.removeItem(STORAGE_ACTIVE_ORG_SLUG);
  window.localStorage.removeItem(STORAGE_ACTIVE_ORG_NAME);
  window.localStorage.removeItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY);
  // STORAGE_USER_ID deliberately survives sign-out. It records whose local
  // state this machine still holds, and that state (workspaces, per-workspace
  // cloud config) outlives the session. Clearing it here would make the very
  // case it exists for — sign out A, sign in B — look like a first sign-in.

  dispatchDenSettingsChanged({
    settings: readDenSettings(),
  });
}

export async function ensureDenActiveOrganization(options?: { forceServerSync?: boolean }) {
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  if (!token) {
    return null;
  }

  const client = createDenClient({
    baseUrl: settings.baseUrl,
    token,
  });

  const response = await client.listOrgs();
  const selectedOrgId = settings.activeOrgId?.trim() ?? "";
  const selectedOrgSlug = settings.activeOrgSlug?.trim() ?? "";
  const targetOrg =
    response.orgs.find((org) => org.id === selectedOrgId) ??
    response.orgs.find((org) => org.slug === selectedOrgSlug) ??
    response.orgs.find((org) => org.id === response.activeOrgId) ??
    response.orgs.find((org) => org.slug === response.activeOrgSlug) ??
    response.orgs[0] ??
    null;

  if (!targetOrg) {
    writeDenSettings({
      ...settings,
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    }, { persistBootstrap: false });
    return null;
  }

  if (
    options?.forceServerSync &&
    (!response.activeOrgId || response.activeOrgId !== targetOrg.id)
  ) {
    await client.setActiveOrganization({ organizationId: targetOrg.id });
  }

  writeDenSettings({
    ...settings,
    activeOrgId: targetOrg.id,
    activeOrgSlug: targetOrg.slug,
    activeOrgName: targetOrg.name,
  }, { persistBootstrap: false });

  return targetOrg;
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  if (!isRecord(payload)) {
    return fallback;
  }

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }

  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }

  return fallback;
}

function getUser(payload: unknown): DenUser | null {
  if (!isRecord(payload) || !isRecord(payload.user)) {
    return null;
  }

  const user = payload.user;
  if (typeof user.id !== "string" || typeof user.email !== "string") {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: typeof user.name === "string" ? user.name : null,
    account: typeof user.account === "string" ? user.account : null,
    avatar: typeof user.avatar === "string" ? user.avatar : null,
    imUserId: typeof user.imUserId === "string" ? user.imUserId : null,
  };
}

function getToken(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.token !== "string") {
    return null;
  }
  return payload.token.trim() || null;
}

function getIMLoginBootstrap(payload: unknown): DenIMLoginBootstrap | null {
  if (!isRecord(payload) || !isRecord(payload.im)) return null;
  const im = payload.im;
  if (
    typeof im.provider !== "string" ||
    typeof im.websocketUrl !== "string" ||
    typeof im.appKey !== "string" ||
    typeof im.imUserId !== "string" ||
    typeof im.token !== "string"
  ) {
    return null;
  }
  const result = {
    provider: im.provider.trim(),
    websocketUrl: im.websocketUrl.trim(),
    appKey: im.appKey.trim(),
    imUserId: im.imUserId.trim(),
    token: im.token.trim(),
  };
  return result.websocketUrl && result.appKey && result.imUserId && result.token ? result : null;
}

function getOrgList(payload: unknown): DenOrgSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.orgs)) {
    return [];
  }

  return payload.orgs.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.slug !== "string" ||
      (entry.role !== "owner" && entry.role !== "admin" && entry.role !== "member")
    ) {
      return [];
    }

    return [
      {
        id: entry.id,
        name: entry.name,
        slug: entry.slug,
        role: entry.role,
        kind: entry.kind === "personal" || entry.kind === "organization" ? entry.kind : undefined,
        tier: isDenTenantTier(entry.tier) ? entry.tier : null,
        accountStatus: typeof entry.accountStatus === "string" ? entry.accountStatus : null,
      } satisfies DenOrgSummary,
    ];
  });
}

function isDenTenantTier(value: unknown): value is DenTenantTier {
  return value === "normal" || value === "pro" || value === "power" || value === "team" || value === "business";
}

function isDenTenantTierForKind(kind: "personal" | "organization", tier: unknown): tier is DenTenantTier {
  return kind === "personal"
    ? tier === "normal" || tier === "pro" || tier === "power"
    : tier === "team" || tier === "business";
}

function getTenantAccount(payload: unknown): DenTenantAccount | null {
  if (!isRecord(payload) || !isRecord(payload.points) || !isRecord(payload.permissions)) return null;
  if (
    (payload.kind !== "personal" && payload.kind !== "organization") ||
    !isDenTenantTierForKind(payload.kind, payload.tier) ||
    typeof payload.status !== "string" ||
    typeof payload.tierVersion !== "number" || !Number.isSafeInteger(payload.tierVersion) ||
    typeof payload.points.available !== "number" || !Number.isSafeInteger(payload.points.available) ||
    typeof payload.points.reserved !== "number" || !Number.isSafeInteger(payload.points.reserved) ||
    typeof payload.points.version !== "number" || !Number.isSafeInteger(payload.points.version) ||
    typeof payload.permissions.canViewLedger !== "boolean" ||
    typeof payload.permissions.canManageBilling !== "boolean"
  ) {
    return null;
  }
  return {
    kind: payload.kind,
    tier: payload.tier,
    status: payload.status,
    tierVersion: payload.tierVersion,
    points: {
      available: payload.points.available,
      reserved: payload.points.reserved,
      version: payload.points.version,
    },
    permissions: {
      canViewLedger: payload.permissions.canViewLedger,
      canManageBilling: payload.permissions.canManageBilling,
    },
  };
}

function getWorkers(payload: unknown): DenWorkerSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.workers)) {
    return [];
  }

  return payload.workers.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const instance = isRecord(entry.instance) ? entry.instance : null;
    if (typeof entry.id !== "string" || typeof entry.name !== "string") {
      return [];
    }
    return [
      {
        workerId: entry.id,
        workerName: entry.name,
        status: typeof entry.status === "string" ? entry.status : "unknown",
        instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
        provider: instance && typeof instance.provider === "string" ? instance.provider : null,
        isMine: Boolean(entry.isMine),
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null,
      } satisfies DenWorkerSummary,
    ];
  });
}

function getMemoryContexts(value: unknown): DenMemoryContext[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.snippet !== "string") return [];
    return [
      {
        id: entry.id,
        snippet: entry.snippet,
        citation: isRecord(entry.citation) ? entry.citation : null,
        origin: typeof entry.origin === "string" ? entry.origin : null,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
      } satisfies DenMemoryContext,
    ];
  });
}

function getMemories(payload: unknown): DenMemory[] {
  if (!isRecord(payload) || !Array.isArray(payload.memories)) {
    return [];
  }
  return payload.memories.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.content !== "string") {
      return [];
    }
    return [
      {
        id: entry.id,
        content: entry.content,
        tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : null,
        source: typeof entry.source === "string" ? entry.source : "",
        scope: typeof entry.scope === "string" ? entry.scope : "user",
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
        contexts: getMemoryContexts(entry.contexts),
      } satisfies DenMemory,
    ];
  });
}

function getWorkerTokens(payload: unknown): DenWorkerTokens | null {
  if (!isRecord(payload) || !isRecord(payload.tokens)) {
    return null;
  }

  const tokens = payload.tokens;
  const connect = isRecord(payload.connect) ? payload.connect : null;
  return {
    clientToken: typeof tokens.client === "string" ? tokens.client : null,
    ownerToken: typeof tokens.owner === "string" ? tokens.owner : null,
    hostToken: typeof tokens.host === "string" ? tokens.host : null,
    juggleworkUrl: connect && typeof connect.juggleworkUrl === "string" ? connect.juggleworkUrl : null,
    workspaceId: connect && typeof connect.workspaceId === "string" ? connect.workspaceId : null,
  };
}

function getMcpToken(payload: unknown): DenMcpToken | null {
  if (
    !isRecord(payload) ||
    typeof payload.token !== "string" ||
    typeof payload.expiresAt !== "string" ||
    typeof payload.organizationId !== "string" ||
    typeof payload.resource !== "string"
  ) {
    return null;
  }
  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    organizationId: payload.organizationId,
    scopes: Array.isArray(payload.scopes)
      ? payload.scopes.filter((entry): entry is string => typeof entry === "string")
      : [],
    resource: payload.resource,
    workspaceKey: typeof payload.workspaceKey === "string" ? payload.workspaceKey : "",
  };
}

function getMcpWorkspacePolicy(payload: unknown): DenMcpWorkspacePolicy {
  if (!isRecord(payload)) return { workspaceKey: "", items: [] };
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    workspaceKey: typeof payload.workspaceKey === "string" ? payload.workspaceKey : "",
    items: items.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.connectionId !== "string") return [];
      return [{
        connectionId: entry.connectionId,
        name: typeof entry.name === "string" ? entry.name : entry.connectionId,
        authType: typeof entry.authType === "string" ? entry.authType : "",
        credentialMode: typeof entry.credentialMode === "string" ? entry.credentialMode : "",
        connectedForMe: entry.connectedForMe === true,
        // 服务端只存「关闭」，缺省即启用；缺字段时不能误报为关闭。
        enabled: entry.enabled !== false,
        toolCount: typeof entry.toolCount === "number" && Number.isFinite(entry.toolCount) ? entry.toolCount : 0,
      }];
    }),
  };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseDenOrgLlmProviderModel(value: unknown): DenOrgLlmProviderModel | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    config: parseJsonRecord(value.config),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
  };
}

function parseDenOrgLlmProvider(value: unknown): DenOrgLlmProvider | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.providerId !== "string" ||
    typeof value.name !== "string" ||
    (value.source !== "models_dev" &&
      value.source !== "custom" &&
      value.source !== "jugglework" &&
      value.source !== "juggle_router")
  ) {
    return null;
  }

  return {
    id: value.id,
    source: value.source,
    providerId: value.providerId,
    name: value.name,
    providerConfig: parseJsonRecord(value.providerConfig),
    hasApiKey: value.hasApiKey === true,
    ...(typeof value.managed === "boolean" ? { managed: value.managed } : {}),
    ...(value.managedKind === "juggle_router" || value.managedKind === null
      ? { managedKind: value.managedKind }
      : {}),
    ...(value.accessScope === "explicit" || value.accessScope === "organization"
      ? { accessScope: value.accessScope }
      : {}),
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    models: Array.isArray(value.models)
      ? value.models.flatMap((model) => {
          const parsed = parseDenOrgLlmProviderModel(model);
          return parsed ? [parsed] : [];
        })
      : [],
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function getDenOrgLlmProviders(payload: unknown): DenOrgLlmProvider[] {
  if (!isRecord(payload) || !Array.isArray(payload.llmProviders)) {
    return [];
  }

  return payload.llmProviders.flatMap((provider) => {
    const parsed = parseDenOrgLlmProvider(provider);
    return parsed ? [parsed] : [];
  });
}

function parseDenExternalMcpConnection(value: unknown): DenExternalMcpConnection | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.url !== "string" ||
    (value.authType !== "oauth" && value.authType !== "apikey" && value.authType !== "none") ||
    (value.credentialMode !== "shared" && value.credentialMode !== "per_member")
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    url: value.url,
    authType: value.authType,
    credentialMode: value.credentialMode,
    connected: value.connected === true,
    connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : null,
    connectedForMe: value.connectedForMe === true,
    ...(typeof value.needsReconnect === "boolean" ? { needsReconnect: value.needsReconnect } : {}),
    ...(typeof value.issuerReviewRequired === "boolean" ? { issuerReviewRequired: value.issuerReviewRequired } : {}),
    ...(value.reconnectActionOwner === "member" || value.reconnectActionOwner === "organization_admin" || value.reconnectActionOwner === null
      ? { reconnectActionOwner: value.reconnectActionOwner }
      : {}),
    ...(Array.isArray(value.missingFeatures) ? { missingFeatures: readStringArray(value.missingFeatures) } : {}),
    ...(typeof value.externalAccountId === "string" || value.externalAccountId === null ? { externalAccountId: value.externalAccountId } : {}),
    ...(Array.isArray(value.grantedScopes) ? { grantedScopes: readStringArray(value.grantedScopes) } : {}),
    ...(typeof value.tenantId === "string" || value.tenantId === null ? { tenantId: value.tenantId } : {}),
  };
}

function getDenExternalMcpConnections(payload: unknown): DenExternalMcpConnection[] {
  if (!isRecord(payload) || !Array.isArray(payload.connections)) {
    return [];
  }

  return payload.connections.flatMap((connection) => {
    const parsed = parseDenExternalMcpConnection(connection);
    return parsed ? [parsed] : [];
  });
}

function getDenMcpConnectionConnectStart(payload: unknown): DenMcpConnectionConnectStart | null {
  if (
    !isRecord(payload) ||
    (payload.status !== "connected" && payload.status !== "needs_auth")
  ) {
    return null;
  }

  return {
    status: payload.status,
    authorizeUrl: typeof payload.authorizeUrl === "string" ? payload.authorizeUrl : null,
  };
}

function getDenOrgLlmProviderConnection(payload: unknown): DenOrgLlmProviderConnection | null {
  if (!isRecord(payload) || !payload.llmProvider) {
    return null;
  }

  const provider = parseDenOrgLlmProvider(payload.llmProvider);
  if (!provider || !isRecord(payload.llmProvider)) {
    return null;
  }

  return {
    ...provider,
    apiKey: typeof payload.llmProvider.apiKey === "string" ? payload.llmProvider.apiKey : null,
    apiKeys: parseApiKeysRecord(payload.llmProvider.apiKeys),
  };
}

function parseApiKeysRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].trim().length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function parsePluginConfigObjectType(value: unknown): DenPluginConfigObjectType | null {
  return value === "skill" || value === "agent" || value === "command" || value === "tool" ||
    value === "mcp" || value === "hook" || value === "context" || value === "custom"
    ? value
    : null;
}

function parsePluginConfigObjectVersion(value: unknown): DenPluginConfigObjectVersion | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    rawSourceText: typeof value.rawSourceText === "string" ? value.rawSourceText : null,
    normalizedPayloadJson: isRecord(value.normalizedPayloadJson) ? value.normalizedPayloadJson : null,
    sourceRevisionRef: typeof value.sourceRevisionRef === "string" ? value.sourceRevisionRef : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
  };
}

function parsePluginConfigObject(value: unknown): DenPluginConfigObject | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") return null;
  const objectType = parsePluginConfigObjectType(value.objectType);
  if (!objectType) return null;
  return {
    id: value.id,
    objectType,
    title: value.title,
    description: typeof value.description === "string" ? value.description : null,
    currentFileName: typeof value.currentFileName === "string" ? value.currentFileName : null,
    currentFileExtension: typeof value.currentFileExtension === "string" ? value.currentFileExtension : null,
    currentRelativePath: typeof value.currentRelativePath === "string" ? value.currentRelativePath : null,
    status: typeof value.status === "string" ? value.status : "active",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    latestVersion: parsePluginConfigObjectVersion(value.latestVersion),
  };
}

function parseExtensionSourceFormat(value: unknown): JuggleWorkExtensionSourceFormat | null {
  switch (value) {
    case "jugglework-builtin":
    case "jugglework-extension-manifest":
    case "claude-plugin":
    case "opencode-plugin":
    case "mcp-directory":
    case "manual":
      return value;
    default:
      return null;
  }
}

function parseExtensionSourceOrigin(value: unknown): JuggleWorkExtensionSource["origin"] | undefined {
  switch (value) {
    case "builtin":
    case "den":
    case "workspace":
    case "local":
      return value;
    default:
      return undefined;
  }
}

function parseExtensionSource(value: unknown): JuggleWorkExtensionSource | null {
  if (!isRecord(value) || typeof value.trusted !== "boolean") return null;
  const format = parseExtensionSourceFormat(value.format);
  if (!format) return null;
  const origin = parseExtensionSourceOrigin(value.origin);
  return {
    format,
    trusted: value.trusted,
    ...(origin ? { origin } : {}),
    ...(typeof value.reference === "string" ? { reference: value.reference } : {}),
  };
}

function parseStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value;
}

function parseExtensionResourceType(value: unknown): JuggleWorkExtensionResourceType | null {
  switch (value) {
    case "skill":
    case "agent":
    case "command":
    case "tool":
    case "mcp":
    case "opencode-plugin":
    case "provider":
    case "hook":
    case "context":
    case "secret":
    case "file":
    case "local-service":
    case "native-binary":
      return value;
    default:
      return null;
  }
}

function parseExtensionLocalCommandRef(value: unknown): JuggleWorkExtensionResource["localCommandRef"] | undefined {
  switch (value) {
    case "jugglework.computerUseMcp":
    case "jugglework.uiMcp":
      return value;
    default:
      return undefined;
  }
}

function parseExtensionResource(value: unknown): JuggleWorkExtensionResource | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const type = parseExtensionResourceType(value.type);
  if (!type) return null;
  const command = parseStringList(value.command);
  const localCommandRef = parseExtensionLocalCommandRef(value.localCommandRef);
  return {
    type,
    id: value.id,
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(command ? { command } : {}),
    ...(typeof value.envKey === "string" ? { envKey: value.envKey } : {}),
    ...(typeof value.packageName === "string" ? { packageName: value.packageName } : {}),
    ...(typeof value.providerId === "string" ? { providerId: value.providerId } : {}),
    ...(typeof value.mcpServerName === "string" ? { mcpServerName: value.mcpServerName } : {}),
    ...(localCommandRef ? { localCommandRef } : {}),
    ...(typeof value.required === "boolean" ? { required: value.required } : {}),
  };
}

function parseExtensionContributionType(value: unknown): JuggleWorkExtensionContributionType | null {
  switch (value) {
    case "settings-panel":
    case "setup-instructions":
    case "composer-prompt":
    case "session-side-panel":
    case "session-rail-item":
    case "control-actions":
    case "server-route":
    case "native-capability":
    case "test-action":
      return value;
    default:
      return null;
  }
}

function parseExtensionContributionLocation(value: unknown): JuggleWorkExtensionContribution["location"] | undefined {
  switch (value) {
    case "settings-detail":
    case "composer":
    case "session-right-pane":
    case "session-rail":
    case "server":
    case "native":
      return value;
    default:
      return undefined;
  }
}

function parseExtensionContribution(value: unknown): JuggleWorkExtensionContribution | null {
  if (!isRecord(value)) return null;
  const type = parseExtensionContributionType(value.type);
  if (!type) return null;
  const location = parseExtensionContributionLocation(value.location);
  return {
    type,
    ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}),
    ...(location ? { location } : {}),
  };
}

function parseExtensionSetup(value: unknown): JuggleWorkExtensionSetup | undefined {
  if (!isRecord(value)) return undefined;
  const requiredEnv = parseStringList(value.requiredEnv);
  return {
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
    ...(typeof value.primaryCta === "string" ? { primaryCta: value.primaryCta } : {}),
    ...(typeof value.secondaryCta === "string" ? { secondaryCta: value.secondaryCta } : {}),
    ...(requiredEnv ? { requiredEnv } : {}),
    ...(typeof value.testActionRef === "string" ? { testActionRef: value.testActionRef } : {}),
  };
}

function parseReloadReason(value: unknown): ReloadReason | null {
  switch (value) {
    case "plugins":
    case "skills":
    case "mcp":
    case "config":
    case "agents":
    case "commands":
      return value;
    default:
      return null;
  }
}

function parseReloadReasons(value: unknown): ReloadReason[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reasons = value.flatMap((item) => {
    const reason = parseReloadReason(item);
    return reason ? [reason] : [];
  });
  return reasons.length === value.length ? reasons : undefined;
}

function parseExtensionLifecycle(value: unknown): JuggleWorkExtensionLifecycle | undefined {
  if (!isRecord(value)) return undefined;
  const reload = parseReloadReasons(value.reload);
  const detection = parseStringList(value.detection);
  return {
    ...(reload ? { reload } : {}),
    ...(detection ? { detection } : {}),
  };
}

function parseExtensionPlatform(value: unknown): JuggleWorkExtensionManifest["platform"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const platforms = value.flatMap((item) => {
    switch (item) {
      case "darwin":
      case "linux":
      case "windows":
      case "web":
        return [item];
      default:
        return [];
    }
  });
  return platforms.length === value.length ? platforms : undefined;
}

function parseJuggleWorkExtensionManifest(value: unknown): JuggleWorkExtensionManifest | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    !Array.isArray(value.resources)
  ) {
    return null;
  }
  const source = parseExtensionSource(value.source);
  if (!source) return null;
  const resources = value.resources.flatMap((entry) => {
    const resource = parseExtensionResource(entry);
    return resource ? [resource] : [];
  });
  if (resources.length !== value.resources.length) return null;
  const contributions = Array.isArray(value.contributions)
    ? value.contributions.flatMap((entry) => {
        const contribution = parseExtensionContribution(entry);
        return contribution ? [contribution] : [];
      })
    : undefined;
  if (Array.isArray(value.contributions) && contributions?.length !== value.contributions.length) return null;
  const setup = parseExtensionSetup(value.setup);
  const lifecycle = parseExtensionLifecycle(value.lifecycle);
  const platform = parseExtensionPlatform(value.platform);
  if (Array.isArray(value.platform) && !platform) return null;
  return {
    schemaVersion: 1,
    id: value.id,
    name: value.name,
    description: value.description,
    source,
    ...(isRecord(value.icon)
      ? { icon: {
          ...(typeof value.icon.src === "string" ? { src: value.icon.src } : {}),
          ...(typeof value.icon.simpleIconSlug === "string" ? { simpleIconSlug: value.icon.simpleIconSlug } : {}),
        } }
      : {}),
    ...(isRecord(value.composer) && typeof value.composer.prompt === "string" ? { composer: { prompt: value.composer.prompt } } : {}),
    ...(setup ? { setup } : {}),
    resources,
    ...(contributions ? { contributions } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(typeof value.defaultEnabled === "boolean" ? { defaultEnabled: value.defaultEnabled } : {}),
    ...(typeof value.defaultHidden === "boolean" ? { defaultHidden: value.defaultHidden } : {}),
    ...(platform ? { platform } : {}),
  };
}

function parseDenExtensionProjection(value: unknown): DenOrgExtensionProjection | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  const sourceFormat = parseExtensionSourceFormat(value.sourceFormat);
  if (!sourceFormat) return null;
  return {
    id: value.id,
    name: value.name,
    description: typeof value.description === "string" ? value.description : null,
    sourceFormat,
    manifest: parseJuggleWorkExtensionManifest(value.manifest),
  };
}

function parsePluginCloudReadinessState(value: unknown): DenPluginCloudReadinessState | null {
  switch (value) {
    case "ready":
    case "needs_signin":
    case "needs_admin_setup":
    case "desktop_only":
    case "not_synced":
      return value;
    default:
      return null;
  }
}

function parsePluginCloudReadinessConnection(value: unknown): DenPluginCloudReadinessConnection | null {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.url !== "string") return null;
  if (value.id !== null && typeof value.id !== "string") return null;
  const credentialMode = value.credentialMode === "shared" || value.credentialMode === "per_member"
    ? value.credentialMode
    : undefined;
  return {
    id: value.id,
    name: value.name,
    url: value.url,
    ...(typeof value.configObjectId === "string" ? { configObjectId: value.configObjectId } : {}),
    ...(typeof value.serverName === "string" ? { serverName: value.serverName } : {}),
    ...(credentialMode ? { credentialMode } : {}),
    ...(typeof value.connectedForMe === "boolean" ? { connectedForMe: value.connectedForMe } : {}),
  };
}

/**
 * 解析单条 MCP 承载明细。
 *
 * TIPS: 单条非法只丢这一条——服务端可能逐步补齐字段，一条脏数据不应让整个插件
 * 退回未知状态。
 */
function parsePluginMcpComponent(value: unknown): DenPluginMcpComponent | null {
  if (!isRecord(value) || typeof value.configObjectId !== "string") return null;
  if (value.delivery !== "cloud" && value.delivery !== "desktop") return null;
  const command = Array.isArray(value.command)
    ? value.command.filter((part): part is string => typeof part === "string")
    : [];
  const credentialMode = value.credentialMode === "shared" || value.credentialMode === "per_member"
    ? value.credentialMode
    : undefined;
  return {
    configObjectId: value.configObjectId,
    serverName: typeof value.serverName === "string" ? value.serverName : "",
    delivery: value.delivery,
    ...(typeof value.url === "string" && value.url.trim() ? { url: value.url.trim() } : {}),
    ...(command.length > 0 ? { command } : {}),
    ...(value.connectionId === null || typeof value.connectionId === "string" ? { connectionId: value.connectionId } : {}),
    ...(credentialMode ? { credentialMode } : {}),
    ...(typeof value.connectedForMe === "boolean" ? { connectedForMe: value.connectedForMe } : {}),
  };
}

function parsePluginCloudReadiness(value: unknown): DenPluginCloudReadiness | null {
  if (!isRecord(value) || typeof value.hasInstructional !== "boolean" || !Array.isArray(value.connections)) return null;
  const state = parsePluginCloudReadinessState(value.state);
  if (!state) return null;
  return {
    state,
    hasInstructional: value.hasInstructional,
    connections: value.connections.flatMap((entry) => {
      const connection = parsePluginCloudReadinessConnection(entry);
      return connection ? [connection] : [];
    }),
    components: Array.isArray(value.components)
      ? value.components.flatMap((entry) => {
        const component = parsePluginMcpComponent(entry);
        return component ? [component] : [];
      })
      : [],
  };
}

function parseOrgPlugin(value: unknown): DenOrgPlugin | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  const counts = isRecord(value.componentCounts)
    ? Object.fromEntries(
        Object.entries(value.componentCounts).filter((entry): entry is [string, number] =>
          typeof entry[0] === "string" && typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0,
        ),
      )
    : {};
  return {
    id: value.id,
    name: value.name,
    description: typeof value.description === "string" ? value.description : null,
    status: typeof value.status === "string" ? value.status : "active",
    memberCount: typeof value.memberCount === "number" && Number.isFinite(value.memberCount) ? value.memberCount : 0,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    componentCounts: counts,
    extension: parseDenExtensionProjection(value.extension),
    ...(value.cloudReadiness === undefined ? {} : { cloudReadiness: parsePluginCloudReadiness(value.cloudReadiness) ?? undefined }),
  };
}

function parseOrgMarketplace(value: unknown): DenOrgMarketplace | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  return {
    id: value.id,
    name: value.name,
    description: typeof value.description === "string" ? value.description : null,
    status: typeof value.status === "string" ? value.status : "active",
    pluginCount: typeof value.pluginCount === "number" && Number.isFinite(value.pluginCount) ? value.pluginCount : 0,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function parsePluginMembership(value: unknown): DenPluginMembership | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.pluginId !== "string" || typeof value.configObjectId !== "string") {
    return null;
  }
  const configObject = parsePluginConfigObject(value.configObject);
  return {
    id: value.id,
    pluginId: value.pluginId,
    configObjectId: value.configObjectId,
    ...(configObject ? { configObject } : {}),
  };
}

function getOrgMarketplaces(payload: unknown): DenOrgMarketplace[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  return payload.items.flatMap((item) => {
    const marketplace = parseOrgMarketplace(item);
    return marketplace ? [marketplace] : [];
  });
}

function getOrgMarketplaceResolved(payload: unknown): DenOrgMarketplaceResolved | null {
  if (!isRecord(payload) || !isRecord(payload.item)) return null;
  const marketplace = parseOrgMarketplace(payload.item.marketplace);
  if (!marketplace || !Array.isArray(payload.item.plugins)) return null;
  return {
    marketplace,
    plugins: payload.item.plugins.flatMap((item) => {
      const plugin = parseOrgPlugin(item);
      return plugin ? [plugin] : [];
    }),
  };
}

function getOrgPluginResolved(plugin: DenOrgPlugin, payload: unknown): DenOrgPluginResolved {
  const memberships = isRecord(payload) && Array.isArray(payload.items)
    ? payload.items.flatMap((item) => {
        const membership = parsePluginMembership(item);
        return membership ? [membership] : [];
      })
    : [];
  return { plugin, memberships };
}

function getBillingPrice(value: unknown): DenBillingPrice | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    amount: typeof value.amount === "number" ? value.amount : null,
    currency: typeof value.currency === "string" ? value.currency : null,
    recurringInterval: typeof value.recurringInterval === "string" ? value.recurringInterval : null,
    recurringIntervalCount: typeof value.recurringIntervalCount === "number" ? value.recurringIntervalCount : null,
  };
}

function getBillingSubscription(value: unknown): DenBillingSubscription | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }

  return {
    id: value.id,
    status: typeof value.status === "string" ? value.status : "unknown",
    amount: typeof value.amount === "number" ? value.amount : null,
    currency: typeof value.currency === "string" ? value.currency : null,
    recurringInterval: typeof value.recurringInterval === "string" ? value.recurringInterval : null,
    recurringIntervalCount: typeof value.recurringIntervalCount === "number" ? value.recurringIntervalCount : null,
    currentPeriodStart: typeof value.currentPeriodStart === "string" ? value.currentPeriodStart : null,
    currentPeriodEnd: typeof value.currentPeriodEnd === "string" ? value.currentPeriodEnd : null,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd === true,
    canceledAt: typeof value.canceledAt === "string" ? value.canceledAt : null,
    endedAt: typeof value.endedAt === "string" ? value.endedAt : null,
  };
}

function getBillingInvoice(value: unknown): DenBillingInvoice | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }

  return {
    id: value.id,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    status: typeof value.status === "string" ? value.status : "unknown",
    totalAmount: typeof value.totalAmount === "number" ? value.totalAmount : null,
    currency: typeof value.currency === "string" ? value.currency : null,
    invoiceNumber: typeof value.invoiceNumber === "string" ? value.invoiceNumber : null,
    invoiceUrl: typeof value.invoiceUrl === "string" ? value.invoiceUrl : null,
  };
}

function getBillingSummary(payload: unknown): DenBillingSummary | null {
  if (!isRecord(payload) || !isRecord(payload.billing)) {
    return null;
  }

  const billing = payload.billing;
  if (
    typeof billing.featureGateEnabled !== "boolean" ||
    typeof billing.hasActivePlan !== "boolean" ||
    typeof billing.checkoutRequired !== "boolean"
  ) {
    return null;
  }

  return {
    featureGateEnabled: billing.featureGateEnabled,
    hasActivePlan: billing.hasActivePlan,
    checkoutRequired: billing.checkoutRequired,
    checkoutUrl: typeof billing.checkoutUrl === "string" ? billing.checkoutUrl : null,
    portalUrl: typeof billing.portalUrl === "string" ? billing.portalUrl : null,
    price: getBillingPrice(billing.price),
    subscription: getBillingSubscription(billing.subscription),
    invoices: Array.isArray(billing.invoices)
      ? billing.invoices.flatMap((item) => {
          const invoice = getBillingInvoice(item);
          return invoice ? [invoice] : [];
        })
      : [],
    productId: typeof billing.productId === "string" ? billing.productId : null,
    benefitId: typeof billing.benefitId === "string" ? billing.benefitId : null,
  };
}

// Den requests target a control plane that does not answer CORS preflights.
// On desktop, route cross-origin Den calls (including a Den API on a different
// loopback port than the renderer) through the Electron main process so the
// renderer never issues a blocked preflight. Same-origin requests can use the
// renderer's own fetch.
const resolveFetch = (url: string): FetchLike => {
  if (!isDesktopRuntime()) return globalThis.fetch;
  try {
    if (typeof window !== "undefined" && new URL(url).origin === window.location.origin) {
      return desktopFetch;
    }
  } catch {
    // fall through to the main-process proxy on unparseable URLs
  }
  return (input, init) => desktopFetchViaMain(input, init);
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type DenRequestOptions = {
  method?: string;
  token?: string | null;
  body?: unknown;
  timeoutMs?: number;
  organizationId?: string | null;
};

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number) {
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
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function requestJsonRaw<T>(
  input: string | DenBaseUrls,
  path: string,
  options: DenRequestOptions = {},
): Promise<RawJsonResponse<T>> {
  const baseUrls = typeof input === "string" ? resolveDenBaseUrls(input) : input;
  const url = `${resolveRequestBaseUrl(baseUrls, path)}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = options.token?.trim() ?? "";
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const organizationId = options.organizationId?.trim() ?? "";
  if (organizationId) {
    headers[ORG_PROXY_HEADER] = organizationId;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetchWithTimeout(
    resolveFetch(url),
    url,
    {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "include",
    },
    options.timeoutMs ?? DEFAULT_DEN_TIMEOUT_MS,
  );

  const text = await response.text();
  let json: T | null = null;
  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json };
}

async function requestJson<T>(
  input: string | DenBaseUrls,
  path: string,
  options: DenRequestOptions = {},
): Promise<T> {
  const raw = await requestJsonRaw<T>(input, path, options);
  if (!raw.ok) {
    const payload = raw.json;
    const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "request_failed";
    const message = getErrorMessage(payload, `Request failed with ${raw.status}.`);
    throw new DenApiError(raw.status, code, message, isRecord(payload) ? payload.details : undefined);
  }
  return raw.json as T;
}

async function ensureActiveOrganization(
  baseUrls: DenBaseUrls,
  token: string | null,
  input: { organizationId?: string | null; organizationSlug?: string | null },
) {
  const organizationId = input.organizationId?.trim() ?? "";
  const organizationSlug = input.organizationSlug?.trim() ?? "";
  if (!token || (!organizationId && !organizationSlug)) {
    return;
  }

  await requestJson<unknown>(baseUrls, "/v1/me/active-organization", {
    method: "POST",
    token,
    body: {
      organizationId: organizationId || undefined,
      organizationSlug: organizationSlug || undefined,
    },
  });
}

export function createDenClient(options: { baseUrl: string; token?: string | null }) {
  const baseUrls = resolveDenBaseUrls({
    baseUrl: options.baseUrl,
  });
  const token = options.token?.trim() ?? null;

  return {
    /** The resolved deployment origin and its derived `/jwork/api` root. */
    baseUrls,

    async setActiveOrganization(input: { organizationId?: string | null; organizationSlug?: string | null }): Promise<void> {
      await ensureActiveOrganization(baseUrls, token, input);
    },

    async signInAccount(account: string, password: string): Promise<DenAuthResult> {
      const payload = await requestJson<unknown>(baseUrls, "/api/auth/sign-in/account", {
        method: "POST",
        body: {
          account: account.trim(),
          password,
        },
      });
      return { user: getUser(payload), token: getToken(payload), im: getIMLoginBootstrap(payload) };
    },

    async signUpEmail(email: string, password: string): Promise<DenAuthResult> {
      const payload = await requestJson<unknown>(baseUrls, "/api/auth/sign-up/email", {
        method: "POST",
        body: {
          name: DEFAULT_DEN_AUTH_NAME,
          email: email.trim(),
          password,
        },
      });
      return { user: getUser(payload), token: getToken(payload), im: getIMLoginBootstrap(payload) };
    },

    async signOut() {
      await requestJson<unknown>(baseUrls, "/api/auth/sign-out", {
        method: "POST",
        token,
        body: {},
      });
    },

    async getSession(): Promise<DenUser> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/me", {
        method: "GET",
        token,
      });
      const user = getUser(payload);
      if (!user) {
        throw new DenApiError(500, "invalid_session_payload", "Session response did not include a user.");
      }
      return user;
    },

    async getAppVersionMetadata(): Promise<DenAppVersionMetadata> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/app-version", {
        method: "GET",
      });
      const appVersionMetadata = getDenAppVersionMetadata(payload);
      if (!appVersionMetadata) {
        throw new DenApiError(500, "invalid_app_version_payload", "App version response was missing version details.");
      }
      return appVersionMetadata;
    },

    async getDesktopConfig(orgId?: string | null): Promise<DenDesktopConfig> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/me/desktop-config", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return normalizeDenDesktopConfig(payload);
    },

    async createDesktopRemoteEnrollmentGrant(orgId: string): Promise<DenDesktopRemoteEnrollmentGrant> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/desktop-devices/enrollment-grants", {
        method: "POST",
        token,
        organizationId: orgId,
        body: { schemaVersion: 1 },
      });
      if (
        !isRecord(payload) ||
        Object.keys(payload).some((key) => !["schemaVersion", "grant", "expiresAt"].includes(key)) ||
        payload.schemaVersion !== 1 ||
        typeof payload.grant !== "string" ||
        !/^jwenroll_[A-Za-z0-9_-]+$/.test(payload.grant) ||
        typeof payload.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(payload.expiresAt))
      ) {
        throw new DenApiError(500, "invalid_enrollment_grant_payload", "Enrollment grant response was invalid.");
      }
      return { schemaVersion: 1, grant: payload.grant, expiresAt: payload.expiresAt };
    },

    async getResourceSnapshot(orgId?: string | null): Promise<DenResourceSnapshot> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/resources", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      const snapshot = normalizeDenResourceSnapshot(payload);
      if (!snapshot) {
        throw new DenApiError(500, "invalid_resource_snapshot_payload", "Resource snapshot response was invalid.");
      }
      return snapshot;
    },

    async exchangeDesktopHandoff(grant: string): Promise<DenDesktopHandoffExchange> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/auth/desktop-handoff/exchange", {
        method: "POST",
        body: { grant },
      });
      return { user: getUser(payload), token: getToken(payload), im: getIMLoginBootstrap(payload) };
    },

    async listOrgs(): Promise<{ orgs: DenOrgSummary[]; activeOrgId: string | null; activeOrgSlug: string | null; defaultOrgId: string | null }> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/me/orgs", {
        method: "GET",
        token,
      });

      const activeOrgId = isRecord(payload) && typeof payload.activeOrgId === "string"
        ? payload.activeOrgId
        : null;
      const activeOrgSlug = isRecord(payload) && typeof payload.activeOrgSlug === "string"
        ? payload.activeOrgSlug
        : null;

      return {
        orgs: getOrgList(payload),
        activeOrgId,
        activeOrgSlug,
        defaultOrgId: activeOrgId,
      };
    },

    async getTenantAccount(orgId?: string | null): Promise<DenTenantAccount> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/tenant-account", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      const account = getTenantAccount(payload);
      if (!account) {
        throw new DenApiError(500, "invalid_tenant_account_payload", "Tenant account response was invalid.");
      }
      return account;
    },

    async listWorkers(orgId: string, limit = 20): Promise<DenWorkerSummary[]> {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      const payload = await requestJson<unknown>(baseUrls, `/v1/workers?${params.toString()}`, {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return getWorkers(payload);
    },

    /** 读取自动化稳定 envelope、投影和资源限制能力。 */
    async getAutomationCapabilities(orgId: string): Promise<DenAutomationCapabilities> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/automations/capabilities", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return normalizeAutomationCapabilities(payload);
    },

    /** 分页读取组织内的自动化定义镜像，可按执行设备和生命周期过滤。 */
    async listAutomationMirrors(orgId: string, options: DenAutomationListOptions = {}): Promise<DenAutomationPage<DenAutomationMirror>> {
      const params = automationQuery(options);
      const payload = await requestJson<unknown>(baseUrls, `/v1/automations${params}`, {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return normalizeAutomationPage(payload);
    },

    /** 读取一个自动化定义的完整稳定 envelope。 */
    async getAutomationMirror(orgId: string, automationId: string): Promise<DenAutomationMirror> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/automations/${encodeURIComponent(automationId)}`, {
        method: "GET",
        token,
        organizationId: orgId,
      });
      if (!isRecord(payload)) throw new DenApiError(500, "invalid_automation_payload", "Automation response was invalid.");
      return payload;
    },

    /** 幂等上传一个客户端拥有的自动化定义 envelope。 */
    async upsertAutomationMirror(orgId: string, automationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
      return await requestJson<Record<string, unknown>>(baseUrls, `/v1/automations/${encodeURIComponent(automationId)}`, {
        method: "PUT",
        token,
        organizationId: orgId,
        body,
      });
    },

    /** 写入版本化任务墓碑，防止旧离线写复活任务。 */
    async deleteAutomationMirror(orgId: string, automationId: string, body: { baseRevision: number; mutationId: string }): Promise<Record<string, unknown>> {
      return await requestJson<Record<string, unknown>>(baseUrls, `/v1/automations/${encodeURIComponent(automationId)}`, {
        method: "DELETE",
        token,
        organizationId: orgId,
        body,
      });
    },

    /** 幂等上传一个自动化运行详情 envelope。 */
    async upsertAutomationRunMirror(orgId: string, runId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
      return await requestJson<Record<string, unknown>>(baseUrls, `/v1/automation-runs/${encodeURIComponent(runId)}`, {
        method: "PUT",
        token,
        organizationId: orgId,
        body,
      });
    },

    /** 分页读取自动化运行镜像，可按任务、状态、触发来源和时间区间过滤。 */
    async listAutomationRunMirrors(orgId: string, options: DenAutomationRunListOptions = {}): Promise<DenAutomationPage<DenAutomationRunMirror>> {
      const params = automationQuery(options);
      const payload = await requestJson<unknown>(baseUrls, `/v1/automation-runs${params}`, {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return normalizeAutomationPage(payload);
    },

    /** 获取绑定任务、运行和定义版本的短期 MCP scope。 */
    async mintAutomationMcpToken(orgId: string, input: { automationId: string; runId: string; definitionRevision: number }): Promise<DenMcpToken> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/mcp/token", {
        method: "POST",
        token,
        organizationId: orgId,
        body: { scopes: ["mcp:read", "mcp:write"], ...input },
      });
      const minted = getMcpToken(payload);
      if (!minted) throw new DenApiError(500, "invalid_mcp_token_payload", "Automation MCP token response was invalid.");
      return minted;
    },

    async listMemory(orgId: string): Promise<DenMemory[]> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/memory", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return getMemories(payload);
    },

    async deleteMemory(orgId: string, memoryId: string): Promise<void> {
      const result = await requestJsonRaw<unknown>(baseUrls, `/v1/memory/${encodeURIComponent(memoryId)}`, {
        method: "DELETE",
        token,
        organizationId: orgId,
      });
      // 404 means the memory is already gone (or not owned) — idempotent from the caller's view.
      if (!result.ok && result.status !== 404) {
        const payload = result.json;
        const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "request_failed";
        throw new DenApiError(result.status, code, getErrorMessage(payload, `Delete failed with ${result.status}.`));
      }
    },

    /**
     * 铸造一枚组织级 MCP 访问令牌。
     *
     * TIPS：带 workspaceKey 的令牌是**执行令牌**，服务端按工作区策略过滤它能看到的
     * 组织连接；不带的是账号级**目录令牌**，不受任何工作区开关影响。服务端按
     * (会话, 组织, workspaceKey) 原地轮换，重复铸造不会堆积令牌行。
     *
     * @param orgId 组织 id
     * @param options.workspaceKey 工作区键；省略或空串即账号级目录令牌
     */
    async mintMcpToken(orgId: string, options?: { workspaceKey?: string | null }): Promise<DenMcpToken> {
      const workspaceKey = options?.workspaceKey?.trim() ?? "";
      const payload = await requestJson<unknown>(baseUrls, "/v1/mcp/token", {
        method: "POST",
        token,
        organizationId: orgId,
        body: {
          scopes: ["mcp:read", "mcp:write"],
          ...(workspaceKey ? { workspaceKey } : {}),
        },
      });
      const minted = getMcpToken(payload);
      if (!minted) {
        throw new DenApiError(500, "invalid_mcp_token_payload", "MCP token response was missing required values.");
      }
      return minted;
    },

    /**
     * 读取一个工作区的组织连接开关视图。
     *
     * @param orgId 组织 id
     * @param workspaceKey 工作区键
     * @returns 成员当前可用的全部连接，每条带上它在该工作区的开关状态
     */
    async getMcpWorkspacePolicy(orgId: string, workspaceKey: string): Promise<DenMcpWorkspacePolicy> {
      const query = `?workspaceKey=${encodeURIComponent(workspaceKey)}`;
      return getMcpWorkspacePolicy(await requestJson<unknown>(baseUrls, `/v1/mcp-connections/workspace-policy${query}`, {
        method: "GET",
        token,
        organizationId: orgId,
      }));
    },

    /**
     * 用提交的关闭集合整体替换工作区策略。
     *
     * TIPS：整体替换而非逐条 PATCH —— 面板上连续拨动多个开关时，逐条写入会因请求
     * 乱序产生错误终态，而全量替换的最后一次提交总是正确的。
     *
     * @param orgId 组织 id
     * @param workspaceKey 工作区键
     * @param disabledConnectionIds 在该工作区关闭的连接 id 集合
     */
    async replaceMcpWorkspacePolicy(
      orgId: string,
      workspaceKey: string,
      disabledConnectionIds: string[],
    ): Promise<DenMcpWorkspacePolicy> {
      return getMcpWorkspacePolicy(await requestJson<unknown>(baseUrls, "/v1/mcp-connections/workspace-policy", {
        method: "PUT",
        token,
        organizationId: orgId,
        body: { workspaceKey, disabledConnectionIds },
      }));
    },

    /** 清空一个工作区的策略，使其回到「全部启用」。 */
    async clearMcpWorkspacePolicy(orgId: string, workspaceKey: string): Promise<void> {
      const query = `?workspaceKey=${encodeURIComponent(workspaceKey)}`;
      const result = await requestJsonRaw<unknown>(baseUrls, `/v1/mcp-connections/workspace-policy${query}`, {
        method: "DELETE",
        token,
        organizationId: orgId,
      });
      if (!result.ok && result.status !== 404) {
        const payload = result.json;
        const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "request_failed";
        throw new DenApiError(result.status, code, getErrorMessage(payload, `Request failed with ${result.status}.`));
      }
    },

    async getWorkerTokens(workerId: string, orgId: string): Promise<DenWorkerTokens> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/workers/${encodeURIComponent(workerId)}/tokens`, {
        method: "POST",
        token,
        organizationId: orgId,
        body: {},
      });
      const tokens = getWorkerTokens(payload);
      if (!tokens) {
        throw new DenApiError(500, "invalid_worker_token_payload", "Worker token response was missing token values.");
      }
      return tokens;
    },

    async listOrgLlmProviders(orgId: string): Promise<DenOrgLlmProvider[]> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/llm-providers", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return getDenOrgLlmProviders(payload);
    },

    async getOrgLlmProviderConnection(orgId: string, llmProviderId: string): Promise<DenOrgLlmProviderConnection> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/llm-providers/${encodeURIComponent(llmProviderId)}/connect`,
        {
          method: "GET",
          token,
          organizationId: orgId,
        },
      );
      const provider = getDenOrgLlmProviderConnection(payload);
      if (!provider) {
        throw new DenApiError(500, "invalid_llm_provider_payload", "LLM provider response was missing connection details.");
      }
      return provider;
    },

    async listMcpConnections(orgId: string, scope: "usable" | "manageable" = "usable"): Promise<DenExternalMcpConnection[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/mcp-connections?scope=${scope}`,
        { method: "GET", token, organizationId: orgId },
      );
      return getDenExternalMcpConnections(payload);
    },

    async startMcpConnectionConnect(orgId: string, connectionId: string): Promise<DenMcpConnectionConnectStart> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/start`,
        { method: "GET", token, organizationId: orgId },
      );
      const result = getDenMcpConnectionConnectStart(payload);
      if (!result) {
        throw new DenApiError(500, "invalid_mcp_connection_payload", "MCP connection connect response was invalid.");
      }
      return result;
    },

    async disconnectOauthProviderAccount(orgId: string, providerId: string): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/oauth-providers/${encodeURIComponent(providerId)}/disconnect`,
        { method: "POST", token, organizationId: orgId },
      );
    },

    /**
     * 断开当前成员在某个组织 MCP 连接上的授权（成员凭证模式）。
     * 仅清除调用者自己的授权，连接本身仍由组织保留，之后可再次 connect。
     * @param orgId 组织 id
     * @param connectionId 组织 MCP 连接 id
     */
    async disconnectMcpConnection(orgId: string, connectionId: string): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/disconnect`,
        { method: "POST", token, organizationId: orgId },
      );
    },

    async listOrgMarketplaces(orgId: string): Promise<DenOrgMarketplace[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/marketplaces?status=active&limit=100`,
        { method: "GET", token, organizationId: orgId },
      );
      return getOrgMarketplaces(payload);
    },

    async getOrgMarketplaceResolved(orgId: string, marketplaceId: string): Promise<DenOrgMarketplaceResolved> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/marketplaces/${encodeURIComponent(marketplaceId)}/resolved`,
        { method: "GET", token, organizationId: orgId },
      );
      const resolved = getOrgMarketplaceResolved(payload);
      if (!resolved) {
        throw new DenApiError(500, "invalid_marketplace_payload", "Marketplace response was missing plugin details.");
      }
      return resolved;
    },

    async getOrgPluginResolved(orgId: string, plugin: DenOrgPlugin): Promise<DenOrgPluginResolved> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/plugins/${encodeURIComponent(plugin.id)}/resolved`,
        { method: "GET", token, organizationId: orgId },
      );
      return getOrgPluginResolved(plugin, payload);
    },

    async getBillingStatus(options: { includePortal?: boolean; includeInvoices?: boolean } = {}): Promise<DenBillingSummary> {
      const params = new URLSearchParams();
      if (options.includePortal === false) {
        params.set("excludePortal", "1");
      }
      if (options.includeInvoices === false) {
        params.set("excludeInvoices", "1");
      }

      const path = params.size > 0 ? `/v1/workers/billing?${params.toString()}` : "/v1/workers/billing";
      const payload = await requestJson<unknown>(baseUrls, path, {
        method: "GET",
        token,
      });
      const summary = getBillingSummary(payload);
      if (!summary) {
        throw new DenApiError(500, "invalid_billing_payload", "Billing response was missing details.");
      }
      return summary;
    },

    async updateSubscriptionCancellation(cancelAtPeriodEnd: boolean): Promise<{ subscription: DenBillingSubscription | null; billing: DenBillingSummary }> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/workers/billing/subscription", {
        method: "POST",
        token,
        body: { cancelAtPeriodEnd },
      });
      const billing = getBillingSummary(payload);
      if (!billing) {
        throw new DenApiError(500, "invalid_billing_payload", "Subscription update response was missing billing details.");
      }

      return {
        subscription: isRecord(payload) ? getBillingSubscription(payload.subscription) : null,
        billing,
      };
    },
  };
}

export type DenClient = ReturnType<typeof createDenClient>;

function automationQuery(values: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function normalizeAutomationCapabilities(payload: unknown): DenAutomationCapabilities {
  if (!isRecord(payload)) throw new DenApiError(500, "invalid_automation_capabilities", "Automation capabilities response was invalid.");
  const projections = isRecord(payload.projections)
    ? Object.fromEntries(Object.entries(payload.projections).map(([kind, versions]) => [kind, numberArray(versions)]))
    : {};
  const limits = isRecord(payload.limits)
    ? Object.fromEntries(Object.entries(payload.limits).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])))
    : {};
  return {
    envelopeVersions: numberArray(payload.envelopeVersions),
    documentMediaTypes: stringArray(payload.documentMediaTypes),
    projections,
    limits,
  };
}

function normalizeAutomationPage<T extends Record<string, unknown>>(payload: unknown): DenAutomationPage<T> {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new DenApiError(500, "invalid_automation_page", "Automation list response was invalid.");
  }
  const items = payload.items.filter(isRecord) as T[];
  return {
    items,
    ...(typeof payload.nextCursor === "string" && payload.nextCursor ? { nextCursor: payload.nextCursor } : {}),
  };
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isInteger(item)) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Mint an org-scoped MCP access token for the Den cloud MCP using the
 * current desktop Den session. Returns null when signed out or no active
 * organization is selected.
 */
export type DenMcpTokenMintContext = {
  baseUrl: string;
  authToken: string | null;
  orgId: string | null;
  /** 工作区键；省略即铸造账号级目录令牌。 */
  workspaceKey?: string | null;
};

export async function mintCloudControlMcpToken(context?: DenMcpTokenMintContext): Promise<DenMcpToken | null> {
  const settings = context ?? readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const orgId = ("orgId" in settings ? settings.orgId : settings.activeOrgId)?.trim() ?? "";
  if (!token || !orgId) {
    return null;
  }
  const client = createDenClient({
    baseUrl: settings.baseUrl,
    token,
  });
  return client.mintMcpToken(orgId, { workspaceKey: context?.workspaceKey ?? null });
}
