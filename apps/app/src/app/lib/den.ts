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
  dispatchDenSessionRevoked,
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
const STORAGE_REVOKED_DEV_AUTH_FINGERPRINT = "jugglework.den.revokedDevAuthFingerprint";
const STORAGE_IM_LOGIN_BOOTSTRAP = "jugglework.den.imLoginBootstrap";
const STORAGE_ACTIVE_ORG_ID = "jugglework.den.activeOrgId";
const STORAGE_ACTIVE_ORG_SLUG = "jugglework.den.activeOrgSlug";
const STORAGE_ACTIVE_ORG_NAME = "jugglework.den.activeOrgName";
const STORAGE_LAST_ORG_BY_USER = "jugglework.den.lastOrgByUser";
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

export type DenProductTaskStatus = "todo" | "completed" | "canceled";
export type DenProductTaskPriority = "none" | "low" | "medium" | "high";
export type DenProductTaskVisibility = "private" | "members" | "organization";
export type DenProductTaskCompletionPolicy = "any_assignee" | "all_assignees";
export type DenProductTaskView = "today" | "inbox" | "assigned" | "created" | "delegated" | "following" | "all" | "completed" | "trash";
export type DenProductTaskMemberRole = "assignee" | "follower" | "viewer";
export type DenProductTaskMember = { memberId: string; role: DenProductTaskMemberRole; createdByMemberId?: string; createdAt?: string; completedAt?: string | null };
export type DenOrganizationMember = {
  id: string;
  userId: string;
  role: string;
  user: { id: string; name: string | null; account: string | null; email: string | null; avatar: string | null };
};
export type DenOrganizationMemberPage = { members: DenOrganizationMember[]; total: number; limit: number; offset: number };
export type DenProductTask = {
  id: string;
  /** Organization-scoped human-readable number. Null when reading an older server. */
  displayNumber: number | null;
  creatorMemberId: string;
  listId: string | null;
  title: string;
  description: string;
  priority: DenProductTaskPriority;
  visibility: DenProductTaskVisibility;
  completionPolicy: DenProductTaskCompletionPolicy;
  status: DenProductTaskStatus;
  version: number;
  startAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  completedByMemberId: string | null;
  canceledAt: string | null;
  canceledByMemberId: string | null;
  deletedAt: string | null;
  restoreUntil: string | null;
  createdAt: string;
  updatedAt: string;
};
export type DenProductTaskPermissions = {
  canView: boolean; canEditContent: boolean; canEditTime: boolean; canManageMembers: boolean;
  canManageVisibility: boolean; canComplete: boolean; canReopen: boolean; canCancel: boolean;
  canComment: boolean; canDelete: boolean; canRestore: boolean;
};
export type DenProductTaskResult = { task: DenProductTask; members: DenProductTaskMember[]; permissions: DenProductTaskPermissions; tombstone: boolean; replayed: boolean };
export type DenProductTaskPage = {
  items: DenProductTask[];
  /** Optional for callers and older servers; the Den client normalizes it when present. */
  membersByTaskId?: Record<string, DenProductTaskMember[]>;
  memberProjectionKnownByTaskId?: Record<string, boolean>;
  nextCursor: string;
};
export type DenProductTaskListOptions = {
  view?: DenProductTaskView; search?: string; status?: DenProductTaskStatus[]; priority?: DenProductTaskPriority[];
  listId?: string[]; creatorMemberId?: string[]; creatorMemberOperator?: DenProductTaskPersonFilterOperator; assigneeMemberId?: string[]; assigneeMemberOperator?: DenProductTaskPersonFilterOperator;
  assignerMemberId?: string[]; assignerMemberOperator?: DenProductTaskPersonFilterOperator; followerMemberId?: string[]; followerMemberOperator?: DenProductTaskPersonFilterOperator;
  startAtFrom?: string; startAtBefore?: string; dueAtFrom?: string; dueAtBefore?: string; overdue?: boolean;
  sort?: "due_at" | "created_at" | "updated_at" | "completed_at" | "priority"; direction?: "asc" | "desc";
  timezone?: string; cursor?: string; limit?: number;
};
export type DenProductTaskPersonFilterOperator = "contains" | "not_contains" | "empty" | "not_empty";
export type DenProductTaskCreateInput = {
  idempotencyKey: string; title: string; description?: string; priority?: DenProductTaskPriority;
  visibility?: DenProductTaskVisibility; listId?: string; startAt?: string | null; dueAt?: string | null;
  completionPolicy?: DenProductTaskCompletionPolicy;
  members?: Array<{ memberId: string; role: DenProductTaskMemberRole }>;
};
export type DenProductTaskUpdateInput = Partial<Omit<DenProductTaskCreateInput, "idempotencyKey" | "listId">> & { expectedVersion: number; idempotencyKey: string };
export type DenProductTaskMoveInput = {
  expectedVersion: number;
  idempotencyKey: string;
  destinationListId: string;
  confirmedVisibility?: DenProductTaskVisibility;
};
export type DenProductTaskMoveResult = {
  taskId: string;
  version: number;
  listId: string | null;
  visibility: DenProductTaskVisibility;
  replayed: boolean;
};
export type DenProductTaskList = { id: string; creatorMemberId: string; name: string; description: string; marker: string; visibility: DenProductTaskVisibility; version: number; archivedAt: string | null; createdAt: string; updatedAt: string };
export type DenProductTaskListPage = { items: DenProductTaskList[]; nextCursor: string };
export type DenProductTaskListResult = { list: DenProductTaskList; members: Array<{ memberId: string; role: "administrator" | "member" }>; permissions: { canView: boolean; canEdit: boolean; canManageMembers: boolean; canAddTasks: boolean; canArchive: boolean; canRestore: boolean }; replayed: boolean };
export type DenProductTaskActivity = {
  comments: Array<{ id: string; authorMemberId: string; body: string; createdAt: string; updatedAt: string }>;
  events: Array<{ id: string; eventType: string; actorMemberId: string; affectedMemberId: string | null; taskVersion: number; createdAt: string }>;
};
export type DenProductTaskActivityAttentionLevel = "ambient" | "attention" | "urgent";
export type DenProductTaskActivityEvent = {
  id: string;
  sequence: number;
  eventType: string;
  payloadVersion: number;
  taskId: string;
  taskVersion: number;
  listId: string | null;
  actorMemberId: string | null;
  affectedMemberId: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
};
export type DenProductTaskActivityItem = {
  event: DenProductTaskActivityEvent;
  readAt: string | null;
  attentionLevel: DenProductTaskActivityAttentionLevel;
  task: { id: string; displayNumber: number | null; title: string | null; accessible: boolean; deleted: boolean };
  list: { id: string; name: string; marker: string } | null;
  actor: { memberId: string; name: string; avatar: string | null } | null;
};
export type DenProductTaskActivityPage = {
  items: DenProductTaskActivityItem[];
  nextCursor: string;
  hasMore: boolean;
  unreadCount: number;
  latestSequence: number;
};
export type DenProductTaskReminder = { id: string; recipientMemberId: string; scheduledAt: string; timezone: string; mode: "absolute" | "due_relative"; dueOffsetSeconds: number; state: "scheduled" | "delivered" | "canceled"; deliveredEventId: string | null };
export type DenProductTaskNotificationEvent = { sequence: number; id: string; type: "reminder_due"; occurredAt: string; task: { id: string; title: string }; reminder: { scheduledAt: string } };
export type DenProductTaskNotificationPage = { items: DenProductTaskNotificationEvent[]; nextSequence: number; hasMore: boolean };

export type DenCalendar = {
  id: string;
  organizationId: string;
  ownerMemberId: string;
  name: string;
  color: string | null;
  isDefault: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type DenCalendarCollaborationRole = "free-busy" | "viewer" | "editor" | "manager";
export type DenCalendarCollaborationCapabilities = {
  canViewFreeBusy: boolean;
  canViewDetails: boolean;
  canEditEvents: boolean;
  canManage: boolean;
};
export type DenCalendarCollaborationResource = {
  id: string;
  organizationId: string;
  ownerMemberId: string;
  kind: "personal" | "team";
  name: string;
  color: string | null;
  role: DenCalendarCollaborationRole;
  capabilities: DenCalendarCollaborationCapabilities;
  version: number;
  authorizationVersion: number;
  createdAt: string;
  updatedAt: string;
};
export type DenCalendarCollaborationList = {
  items: DenCalendarCollaborationResource[];
  authorizationGeneration: number;
  reset: { mode: "replace"; namespace: "calendar-collaboration" };
};
export type DenTeamCalendarSnapshot = {
  calendar: DenCalendarCollaborationResource;
  events: DenCalendarEvent[];
  coverage: { startDate: string; endDateExclusive: string; calendarIds: string[] };
  authorizationVersion: number;
  reset: { mode: "replace"; namespace: string };
};
export type DenTeamCalendarCreateInput = { name: string; color?: string | null };
export type DenTeamCalendarCreateResult = { calendar: DenCalendarCollaborationResource };
export type DenCalendarMembership = {
  memberId: string;
  role: DenCalendarCollaborationRole;
  createdByMemberId: string;
  createdAt: string;
  updatedAt: string;
};
export type DenCalendarMembershipList = {
  items: DenCalendarMembership[];
  authorizationVersion: number;
};
export type DenCalendarMembershipPutInput = {
  role: DenCalendarCollaborationRole;
  expectedAuthorizationVersion: number;
};
export type DenCalendarMembershipPutResult = {
  membership: DenCalendarMembership;
  authorizationVersion: number;
};
export type DenCalendarMembershipRevokeInput = { expectedAuthorizationVersion: number };
export type DenCalendarMembershipRevokeResult = { authorizationVersion: number };
export type DenTeamCalendarEventCreateInput = {
  title: string;
  description: string;
  time: DenCalendarEventTime;
};
export type DenTeamCalendarEventUpdateInput = {
  expectedVersion: number;
  title?: string;
  description?: string;
  time?: DenCalendarEventTime;
};
export type DenTeamCalendarEventDeleteInput = { expectedVersion: number };
export type DenCalendarEventTime =
  | { kind: "allDay"; startDate: string; endDateExclusive: string }
  | { kind: "timed"; startInstant: string; endInstantExclusive: string; timeZone: string };
export type DenCalendarEvent = {
  id: string;
  organizationId: string;
  ownerMemberId: string;
  calendarId: string;
  title: string;
  description: string;
  time: DenCalendarEventTime;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type DenCalendarTombstone = {
  entityType: "calendar" | "event";
  entityId: string;
  version: number;
  deletedAt: string;
};
export type DenCalendarResult = { calendar: DenCalendar; replayed: boolean };
export type DenCalendarEventResult = { event: DenCalendarEvent; replayed: boolean };
export type DenCalendarDeleteResult = { tombstone: DenCalendarTombstone; replayed: boolean };
export type DenCalendarEventPage = {
  items: DenCalendarEvent[];
  nextCursor: string | null;
  hasMore: boolean;
};
export type DenCalendarBootstrap = {
  calendars: DenCalendar[];
  events: DenCalendarEvent[];
  coverage: { startDate: string; endDateExclusive: string; calendarIds: string[] };
  cursor: string;
};
export type DenCalendarChange =
  | { sequence: number; kind: "upsert"; entityType: "calendar"; entity: DenCalendar }
  | { sequence: number; kind: "upsert"; entityType: "event"; entity: DenCalendarEvent }
  | { sequence: number; kind: "delete"; entityType: "calendar" | "event"; entityId: string; version: number; deletedAt: string };
export type DenCalendarChangePage = { items: DenCalendarChange[]; nextCursor: string; hasMore: boolean };
export type DenCalendarRangeOptions = {
  startDate: string;
  endDateExclusive: string;
  calendarIds?: string[];
  cursor?: string;
  limit?: number;
};
export type DenCalendarSearchOptions = {
  query: string;
  calendarIds?: string[];
  cursor?: string;
  limit?: number;
};
export type DenCalendarCreateInput = { idempotencyKey: string; name: string; color?: string | null };
export type DenCalendarUpdateInput = { idempotencyKey: string; expectedVersion: number; name?: string; color?: string | null };
export type DenCalendarEventCreateInput = {
  idempotencyKey: string;
  calendarId: string;
  title: string;
  description?: string;
  time: DenCalendarEventTime;
};
export type DenCalendarEventUpdateInput = {
  idempotencyKey: string;
  expectedVersion: number;
  calendarId?: string;
  title?: string;
  description?: string;
  time?: DenCalendarEventTime;
};
export type DenCalendarDeleteInput = { idempotencyKey: string; expectedVersion: number };

export type DenCalendarSchedulingRecurrence = {
  frequency: "daily" | "weekly" | "monthly";
  interval: number;
  end: { kind: "never" } | { kind: "until"; until: string } | { kind: "count"; count: number };
};
export type DenCalendarSchedulingAttendeeInput = { memberId: string };
export type DenCalendarSchedulingAttendee = DenCalendarSchedulingAttendeeInput & {
  responseStatus: "needs-action" | "accepted" | "declined" | "tentative";
};
export type DenCalendarSchedulingEvent = DenCalendarEvent & {
  status: "active";
  attendees: DenCalendarSchedulingAttendee[];
  recurrence: DenCalendarSchedulingRecurrence | null;
};
export type DenCalendarSchedulingEventCreateInput = {
  idempotencyKey: string;
  calendarId: string;
  title: string;
  description: string;
  time: DenCalendarEventTime;
  attendees: DenCalendarSchedulingAttendeeInput[];
  recurrence: DenCalendarSchedulingRecurrence | null;
};
export type DenCalendarSchedulingEventUpdateInput = {
  idempotencyKey: string;
  expectedVersion: number;
  calendarId?: string;
  title?: string;
  description?: string;
  time?: DenCalendarEventTime;
  attendees?: DenCalendarSchedulingAttendeeInput[];
  recurrence?: DenCalendarSchedulingRecurrence | null;
};
export type DenCalendarSchedulingEventResult = { event: DenCalendarSchedulingEvent; replayed: boolean };
export type DenCalendarSchedulingOccurrence = { event: DenCalendarSchedulingEvent; occurrenceIndex: number; time: DenCalendarEventTime };
export type DenCalendarSchedulingOccurrenceList = { items: DenCalendarSchedulingOccurrence[] };
export type DenCalendarSchedulingRange = { startInstant: string; endInstantExclusive: string; timeZone: string };
export type DenCalendarAvailabilityInput = DenCalendarSchedulingRange & { memberIds: string[] };
export type DenCalendarBusyInterval = { startInstant: string; endInstantExclusive: string };
export type DenCalendarAvailabilityMember = { memberId: string; busy: DenCalendarBusyInterval[] } | { memberId: string; unknown: true };
export type DenCalendarAvailability = { members: DenCalendarAvailabilityMember[] };

export const DEFAULT_DEN_AUTH_NAME = "JuggleWork User";
const BUILD_DEN_BASE_URL =
  (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_BASE_URL === "string"
    ? import.meta.env.VITE_DEN_BASE_URL
    : "").trim() || "https://work.jugglechat.cn";
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

export type DenDesktopConfig = SharedDesktopConfig & {
  calendarEnabled?: boolean;
  calendarWriteEnabled?: boolean;
  calendarCollaborationEnabled?: boolean;
};

export type DenOrgSummary = {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
  kind?: "personal" | "organization";
  tier?: DenTenantTier | null;
  accountStatus?: string | null;
  orgMemberId?: string;
  membershipId?: string;
};

export function isPersonalDenOrganization(
  organization: Pick<DenOrgSummary, "id" | "kind" | "slug"> | null | undefined,
): boolean {
  return organization?.kind === "personal"
    || organization?.id?.trim().toLowerCase().startsWith("personal_") === true
    || organization?.slug?.trim().toLowerCase() === "personal";
}

export type DenTenantTier = "normal" | "pro" | "power" | "lite_team" | "team" | "business";

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
  billing: {
    paid: boolean;
    fundingKind: string;
    plan: DenTenantTier | null;
    period: "monthly" | "annual" | null;
    seats: number;
    cycleStart: string | null;
    cycleEnd: string | null;
    paidThrough: string | null;
    nextGrantAt: string | null;
    allowancePerCycle: string;
  } | null;
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
  managedIdentity?: "jwork_router" | null;
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

export type DenMembershipBillingCatalogPlan = {
  plan: DenTenantTier;
  tenantKind: "personal" | "organization";
  monthlyAmountFen: string;
  annualAmountFen: string;
  allowancePerCycle: string;
  minimumSeats: number;
  pricedPerSeat: boolean;
};

export type DenMembershipBillingCatalog = {
  version: string;
  currency: string;
  payment: {
    alipayPageAvailable: boolean;
    alipayQrAvailable: boolean;
  };
  plans: DenMembershipBillingCatalogPlan[];
};

export type DenMembershipCheckout = {
  method: "alipay_page";
  url: string;
  status: "pending";
  expiresAt: string | null;
};

export type DenMembershipPaymentCode = {
  status: string;
  content: string;
  expiresAt: string | null;
};

export type DenMembershipOrder = {
  id: string;
  organizationId: string | null;
  targetMode: string;
  targetKind: string;
  plan: DenTenantTier;
  period: "monthly" | "annual";
  seats: number;
  unitAmountFen: string;
  totalAmountFen: string;
  currency: string;
  allowancePerCycle: string;
  quoteKind: string;
  status: string;
  fulfillmentStatus: string;
  expiresAt: string | null;
  paidAt: string | null;
  fulfilledAt: string | null;
  nextAction: string;
  checkout: DenMembershipCheckout | null;
  paymentCode: DenMembershipPaymentCode | null;
};

export type DenMembershipOrderSelection = {
  targetMode: "existing_tenant" | "new_organization";
  plan: DenTenantTier;
  period: "monthly" | "annual";
  seats: number;
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

function normalizeProductTask(value: unknown): DenProductTask | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.creatorMemberId !== "string" ||
    typeof value.title !== "string" || typeof value.description !== "string" || typeof value.version !== "number" ||
    !["none", "low", "medium", "high"].includes(String(value.priority)) ||
    !["private", "members", "organization"].includes(String(value.visibility)) ||
    ("completionPolicy" in value && !["any_assignee", "all_assignees"].includes(String(value.completionPolicy))) ||
    !["todo", "completed", "canceled"].includes(String(value.status)) ||
    typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return null;
  const nullableString = (input: unknown) => typeof input === "string" ? input : null;
  return {
    id: value.id,
    displayNumber: Number.isSafeInteger(value.displayNumber) && Number(value.displayNumber) > 0 ? Number(value.displayNumber) : null,
    creatorMemberId: value.creatorMemberId,
    listId: nullableString(value.listId),
    title: value.title,
    description: value.description,
    priority: value.priority as DenProductTaskPriority,
    visibility: value.visibility as DenProductTaskVisibility,
    completionPolicy: (value.completionPolicy ?? "any_assignee") as DenProductTaskCompletionPolicy,
    status: value.status as DenProductTaskStatus,
    version: value.version,
    startAt: nullableString(value.startAt),
    dueAt: nullableString(value.dueAt),
    completedAt: nullableString(value.completedAt),
    completedByMemberId: nullableString(value.completedByMemberId),
    canceledAt: nullableString(value.canceledAt),
    canceledByMemberId: nullableString(value.canceledByMemberId),
    deletedAt: nullableString(value.deletedAt),
    restoreUntil: nullableString(value.restoreUntil),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeProductTaskResult(value: unknown): DenProductTaskResult {
  if (!isRecord(value)) throw new DenApiError(500, "invalid_task_payload", "Task response was invalid.");
  const task = normalizeProductTask(value.task);
  if (!task || !Array.isArray(value.members) || !isRecord(value.permissions)) {
    throw new DenApiError(500, "invalid_task_payload", "Task response was invalid.");
  }
  const members = value.members.flatMap((member) => isRecord(member) && typeof member.memberId === "string" &&
    ["assignee", "follower", "viewer"].includes(String(member.role)) && validOptionalNullableString(member, "completedAt")
    ? [{ memberId: member.memberId, role: member.role as DenProductTaskMemberRole, createdByMemberId: typeof member.createdByMemberId === "string" ? member.createdByMemberId : undefined, createdAt: typeof member.createdAt === "string" ? member.createdAt : undefined, completedAt: typeof member.completedAt === "string" ? member.completedAt : null }]
    : []);
  if (members.length !== value.members.length) throw new DenApiError(500, "invalid_task_payload", "Task response was invalid.");
  const permissions = value.permissions;
  const permissionNames = ["canView", "canEditContent", "canEditTime", "canManageMembers", "canManageVisibility", "canComplete", "canReopen", "canCancel", "canComment", "canDelete", "canRestore"] as const;
  if (permissionNames.some((name) => typeof permissions[name] !== "boolean")) throw new DenApiError(500, "invalid_task_payload", "Task response was invalid.");
  return { task, members, permissions: permissions as DenProductTaskPermissions, tombstone: value.tombstone === true, replayed: value.replayed === true };
}

function normalizeProductTaskMember(value: unknown): DenProductTaskMember | null {
  if (!isRecord(value) || typeof value.memberId !== "string" || !["assignee", "follower", "viewer"].includes(String(value.role)) || !validOptionalNullableString(value, "completedAt")) return null;
  return {
    memberId: value.memberId,
    role: value.role as DenProductTaskMemberRole,
    createdByMemberId: typeof value.createdByMemberId === "string" ? value.createdByMemberId : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
    completedAt: typeof value.completedAt === "string" ? value.completedAt : null,
  };
}

function validOptionalNullableString(value: Record<string, unknown>, key: string) {
  return !(key in value) || value[key] === null || typeof value[key] === "string";
}

function normalizeOrganizationMember(value: unknown): DenOrganizationMember | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.userId !== "string" || typeof value.role !== "string" || !isRecord(value.user) || typeof value.user.id !== "string") return null;
  const optionalString = (input: unknown) => typeof input === "string" ? input : null;
  return {
    id: value.id,
    userId: value.userId,
    role: value.role,
    user: {
      id: value.user.id,
      name: optionalString(value.user.name),
      account: optionalString(value.user.account),
      email: optionalString(value.user.email),
      avatar: optionalString(value.user.avatar),
    },
  };
}

function normalizeProductTaskMoveResult(value: unknown): DenProductTaskMoveResult {
  if (!isRecord(value) || typeof value.taskId !== "string" || !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
    value.listId !== null && typeof value.listId !== "string" ||
    !["private", "members", "organization"].includes(String(value.visibility)) || typeof value.replayed !== "boolean") {
    throw new DenApiError(500, "invalid_task_move_payload", "Task move response was invalid.");
  }
  return {
    taskId: value.taskId,
    version: Number(value.version),
    listId: value.listId,
    visibility: value.visibility as DenProductTaskVisibility,
    replayed: value.replayed,
  };
}

function normalizeProductTaskList(value: unknown): DenProductTaskList | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.creatorMemberId !== "string" ||
    typeof value.name !== "string" || typeof value.description !== "string" || typeof value.marker !== "string" ||
    !["private", "members", "organization"].includes(String(value.visibility)) || typeof value.version !== "number" ||
    typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return null;
  return { id: value.id, creatorMemberId: value.creatorMemberId, name: value.name, description: value.description, marker: value.marker,
    visibility: value.visibility as DenProductTaskVisibility, version: value.version, archivedAt: typeof value.archivedAt === "string" ? value.archivedAt : null,
    createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function normalizeProductTaskListResult(value: unknown): DenProductTaskListResult {
  if (!isRecord(value) || !Array.isArray(value.members) || !isRecord(value.permissions)) throw new DenApiError(500, "invalid_task_list_payload", "Task list response was invalid.");
  const list = normalizeProductTaskList(value.list);
  const members = value.members.flatMap((member) => isRecord(member) && typeof member.memberId === "string" && ["administrator", "member"].includes(String(member.role)) ? [{ memberId: member.memberId, role: member.role as "administrator" | "member" }] : []);
  if (!list || members.length !== value.members.length) throw new DenApiError(500, "invalid_task_list_payload", "Task list response was invalid.");
  return { list, members, permissions: value.permissions as DenProductTaskListResult["permissions"], replayed: value.replayed === true };
}

function normalizeProductTaskNotificationPage(value: unknown): DenProductTaskNotificationPage {
  if (!isRecord(value) || !Array.isArray(value.items) || !Number.isSafeInteger(value.nextSequence) || Number(value.nextSequence) < 0 || typeof value.hasMore !== "boolean") {
    throw new DenApiError(500, "invalid_task_events", "Task event response was invalid.");
  }
  const items = value.items.flatMap((item) => isRecord(item) && Number.isSafeInteger(item.sequence) && Number(item.sequence) > 0 && typeof item.id === "string" && item.type === "reminder_due" && typeof item.occurredAt === "string" && isRecord(item.task) && typeof item.task.id === "string" && typeof item.task.title === "string" && isRecord(item.reminder) && typeof item.reminder.scheduledAt === "string" ? [{ sequence: Number(item.sequence), id: item.id, type: "reminder_due" as const, occurredAt: item.occurredAt, task: { id: item.task.id, title: item.task.title }, reminder: { scheduledAt: item.reminder.scheduledAt } }] : []);
  if (items.length !== value.items.length) throw new DenApiError(500, "invalid_task_events", "Task event response was invalid.");
  return { items, nextSequence: Number(value.nextSequence), hasMore: value.hasMore };
}

function normalizeProductTaskActivityItem(value: unknown): DenProductTaskActivityItem | null {
  if (!isRecord(value) || !isRecord(value.event) || !isRecord(value.task) ||
    value.readAt !== null && typeof value.readAt !== "string" ||
    !["ambient", "attention", "urgent"].includes(String(value.attentionLevel))) return null;
  const event = value.event;
  const task = value.task;
  if (typeof event.id !== "string" || !event.id || !Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1 ||
    typeof event.eventType !== "string" || !event.eventType || !Number.isSafeInteger(event.payloadVersion) || Number(event.payloadVersion) < 1 ||
    typeof event.taskId !== "string" || !event.taskId || !Number.isSafeInteger(event.taskVersion) || Number(event.taskVersion) < 1 ||
    event.listId !== null && typeof event.listId !== "string" || event.actorMemberId !== null && typeof event.actorMemberId !== "string" ||
    event.affectedMemberId !== null && typeof event.affectedMemberId !== "string" || typeof event.occurredAt !== "string" || !isRecord(event.payload) ||
    typeof task.id !== "string" || task.displayNumber !== null && (!Number.isSafeInteger(task.displayNumber) || Number(task.displayNumber) < 1) ||
    task.title !== null && typeof task.title !== "string" || typeof task.accessible !== "boolean" || typeof task.deleted !== "boolean") return null;
  const list = value.list === null ? null : isRecord(value.list) && typeof value.list.id === "string" && typeof value.list.name === "string" && typeof value.list.marker === "string"
    ? { id: value.list.id, name: value.list.name, marker: value.list.marker }
    : undefined;
  const actor = value.actor === null ? null : isRecord(value.actor) && typeof value.actor.memberId === "string" && typeof value.actor.name === "string" && (value.actor.avatar === null || typeof value.actor.avatar === "string")
    ? { memberId: value.actor.memberId, name: value.actor.name, avatar: value.actor.avatar as string | null }
    : undefined;
  if (list === undefined || actor === undefined || event.taskId !== task.id) return null;
  return {
    event: {
      id: event.id,
      sequence: Number(event.sequence),
      eventType: event.eventType,
      payloadVersion: Number(event.payloadVersion),
      taskId: event.taskId,
      taskVersion: Number(event.taskVersion),
      listId: event.listId as string | null,
      actorMemberId: event.actorMemberId as string | null,
      affectedMemberId: event.affectedMemberId as string | null,
      occurredAt: event.occurredAt,
      payload: event.payload,
    },
    readAt: value.readAt as string | null,
    attentionLevel: value.attentionLevel as DenProductTaskActivityAttentionLevel,
    task: { id: task.id, displayNumber: task.displayNumber as number | null, title: task.title as string | null, accessible: task.accessible, deleted: task.deleted },
    list,
    actor,
  };
}

function normalizeProductTaskActivityPage(value: unknown): DenProductTaskActivityPage {
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.nextCursor !== "string" || typeof value.hasMore !== "boolean" ||
    !Number.isSafeInteger(value.unreadCount) || Number(value.unreadCount) < 0 || !Number.isSafeInteger(value.latestSequence) || Number(value.latestSequence) < 0) {
    throw new DenApiError(500, "invalid_task_activity_page", "Task activity page response was invalid.");
  }
  const items = value.items.map(normalizeProductTaskActivityItem);
  if (items.some((item) => item === null)) throw new DenApiError(500, "invalid_task_activity_page", "Task activity page response was invalid.");
  return { items: items as DenProductTaskActivityItem[], nextCursor: value.nextCursor, hasMore: value.hasMore, unreadCount: Number(value.unreadCount), latestSequence: Number(value.latestSequence) };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function normalizeCalendarTime(value: unknown): DenCalendarEventTime | null {
  if (!isRecord(value)) return null;
  if (value.kind === "allDay") {
    if (!hasExactKeys(value, ["kind", "startDate", "endDateExclusive"]) || !isCalendarDate(value.startDate) || !isCalendarDate(value.endDateExclusive) || value.endDateExclusive <= value.startDate) return null;
    return { kind: "allDay", startDate: value.startDate, endDateExclusive: value.endDateExclusive };
  }
  if (value.kind === "timed") {
    if (!hasExactKeys(value, ["kind", "startInstant", "endInstantExclusive", "timeZone"]) || !isUtcTimestamp(value.startInstant) || !isUtcTimestamp(value.endInstantExclusive) || Date.parse(value.endInstantExclusive) <= Date.parse(value.startInstant) || typeof value.timeZone !== "string" || !value.timeZone || value.timeZone.length > 128) return null;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
    } catch {
      return null;
    }
    return { kind: "timed", startInstant: value.startInstant, endInstantExclusive: value.endInstantExclusive, timeZone: value.timeZone };
  }
  return null;
}

export function normalizeDenCalendar(value: unknown): DenCalendar | null {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "organizationId", "ownerMemberId", "name", "color", "isDefault", "version", "createdAt", "updatedAt"]) ||
    typeof value.id !== "string" || !value.id || typeof value.organizationId !== "string" || !value.organizationId || typeof value.ownerMemberId !== "string" || !value.ownerMemberId ||
    typeof value.name !== "string" || !value.name || value.name.length > 100 || value.color !== null && (typeof value.color !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value.color)) ||
    typeof value.isDefault !== "boolean" || !isPositiveSafeInteger(value.version) || !isUtcTimestamp(value.createdAt) || !isUtcTimestamp(value.updatedAt)) return null;
  return {
    id: value.id,
    organizationId: value.organizationId,
    ownerMemberId: value.ownerMemberId,
    name: value.name,
    color: value.color,
    isDefault: value.isDefault,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function normalizeDenCalendarEvent(value: unknown): DenCalendarEvent | null {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "organizationId", "ownerMemberId", "calendarId", "title", "description", "time", "version", "createdAt", "updatedAt"]) ||
    typeof value.id !== "string" || !value.id || typeof value.organizationId !== "string" || !value.organizationId || typeof value.ownerMemberId !== "string" || !value.ownerMemberId ||
    typeof value.calendarId !== "string" || !value.calendarId || typeof value.title !== "string" || !value.title || value.title.length > 500 || typeof value.description !== "string" || value.description.length > 20_000 ||
    !isPositiveSafeInteger(value.version) || !isUtcTimestamp(value.createdAt) || !isUtcTimestamp(value.updatedAt)) return null;
  const time = normalizeCalendarTime(value.time);
  if (!time) return null;
  return {
    id: value.id,
    organizationId: value.organizationId,
    ownerMemberId: value.ownerMemberId,
    calendarId: value.calendarId,
    title: value.title,
    description: value.description,
    time,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function normalizeDenCalendarSchedulingRecurrence(value: unknown): DenCalendarSchedulingRecurrence | null {
  if (!isRecord(value) || !hasExactKeys(value, ["frequency", "interval", "end"]) || !["daily", "weekly", "monthly"].includes(String(value.frequency)) || !isPositiveSafeInteger(value.interval) || value.interval > 365 || !isRecord(value.end)) return null;
  let end: DenCalendarSchedulingRecurrence["end"];
  if (value.end.kind === "never" && hasExactKeys(value.end, ["kind"])) end = { kind: "never" };
  else if (value.end.kind === "until" && hasExactKeys(value.end, ["kind", "until"]) && isCalendarDate(value.end.until)) end = { kind: "until", until: value.end.until };
  else if (value.end.kind === "count" && hasExactKeys(value.end, ["kind", "count"]) && isPositiveSafeInteger(value.end.count) && value.end.count <= 1000) end = { kind: "count", count: value.end.count };
  else return null;
  return { frequency: value.frequency as DenCalendarSchedulingRecurrence["frequency"], interval: value.interval, end };
}

export function normalizeDenCalendarSchedulingEvent(value: unknown): DenCalendarSchedulingEvent | null {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "organizationId", "ownerMemberId", "calendarId", "title", "description", "time", "status", "attendees", "recurrence", "version", "createdAt", "updatedAt"]) ||
    value.status !== "active" || !Array.isArray(value.attendees)) return null;
  const core = normalizeDenCalendarEvent(Object.fromEntries(Object.entries(value).filter(([key]) => !["status", "attendees", "recurrence"].includes(key))));
  const attendees = value.attendees.map((attendee): DenCalendarSchedulingAttendee | null => isRecord(attendee) && hasExactKeys(attendee, ["memberId", "responseStatus"]) && typeof attendee.memberId === "string" && attendee.memberId && ["needs-action", "accepted", "declined", "tentative"].includes(String(attendee.responseStatus)) ? { memberId: attendee.memberId, responseStatus: attendee.responseStatus as DenCalendarSchedulingAttendee["responseStatus"] } : null);
  const recurrence = value.recurrence === null ? null : normalizeDenCalendarSchedulingRecurrence(value.recurrence);
  if (!core || attendees.some((attendee) => !attendee) || new Set(attendees.map((attendee) => attendee?.memberId)).size !== attendees.length || value.recurrence !== null && !recurrence) return null;
  return { ...core, status: value.status as DenCalendarSchedulingEvent["status"], attendees: attendees as DenCalendarSchedulingAttendee[], recurrence };
}

export function normalizeDenCalendarAvailability(value: unknown): DenCalendarAvailability | null {
  if (!isRecord(value) || !hasExactKeys(value, ["members"]) || !Array.isArray(value.members)) return null;
  const members = value.members.map((member): DenCalendarAvailabilityMember | null => {
    if (!isRecord(member) || typeof member.memberId !== "string" || !member.memberId) return null;
    if (hasExactKeys(member, ["memberId", "unknown"]) && member.unknown === true) return { memberId: member.memberId, unknown: true };
    if (!hasExactKeys(member, ["memberId", "busy"]) || !Array.isArray(member.busy)) return null;
    const busy = member.busy.map((interval): DenCalendarBusyInterval | null => isRecord(interval) && hasExactKeys(interval, ["startInstant", "endInstantExclusive"]) && isUtcTimestamp(interval.startInstant) && isUtcTimestamp(interval.endInstantExclusive) && Date.parse(interval.endInstantExclusive) > Date.parse(interval.startInstant) ? { startInstant: interval.startInstant, endInstantExclusive: interval.endInstantExclusive } : null);
    return busy.some((interval) => !interval) ? null : { memberId: member.memberId, busy: busy as DenCalendarBusyInterval[] };
  });
  if (members.some((member) => !member) || new Set(members.map((member) => member?.memberId)).size !== members.length) return null;
  return { members: members as DenCalendarAvailabilityMember[] };
}

export function normalizeDenCalendarCollaborationResource(value: unknown): DenCalendarCollaborationResource | null {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "organizationId", "ownerMemberId", "kind", "name", "color", "role", "capabilities", "version", "authorizationVersion", "createdAt", "updatedAt"]) ||
    typeof value.id !== "string" || !value.id || typeof value.organizationId !== "string" || !value.organizationId || typeof value.ownerMemberId !== "string" || !value.ownerMemberId ||
    !["personal", "team"].includes(String(value.kind)) || typeof value.name !== "string" || !value.name || value.name.length > 100 || value.color !== null && (typeof value.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value.color)) ||
    !["free-busy", "viewer", "editor", "manager"].includes(String(value.role)) || !isPositiveSafeInteger(value.version) || !isPositiveSafeInteger(value.authorizationVersion) ||
    !isUtcTimestamp(value.createdAt) || !isUtcTimestamp(value.updatedAt) || !isRecord(value.capabilities) ||
    !hasExactKeys(value.capabilities, ["canViewFreeBusy", "canViewDetails", "canEditEvents", "canManage"]) || Object.values(value.capabilities).some((capability) => typeof capability !== "boolean")) return null;
  const role = value.role as DenCalendarCollaborationRole;
  const expected = {
    "free-busy": [true, false, false, false],
    viewer: [true, true, false, false],
    editor: [true, true, true, false],
    manager: [true, true, true, true],
  }[role];
  const actual = [value.capabilities.canViewFreeBusy, value.capabilities.canViewDetails, value.capabilities.canEditEvents, value.capabilities.canManage];
  if (actual.some((capability, index) => capability !== expected[index])) return null;
  return {
    id: value.id,
    organizationId: value.organizationId,
    ownerMemberId: value.ownerMemberId,
    kind: value.kind as "personal" | "team",
    name: value.name,
    color: value.color as string | null,
    role,
    capabilities: {
      canViewFreeBusy: value.capabilities.canViewFreeBusy as boolean,
      canViewDetails: value.capabilities.canViewDetails as boolean,
      canEditEvents: value.capabilities.canEditEvents as boolean,
      canManage: value.capabilities.canManage as boolean,
    },
    version: value.version,
    authorizationVersion: value.authorizationVersion,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function normalizeDenCalendarMembership(value: unknown): DenCalendarMembership | null {
  if (!isRecord(value) || !hasExactKeys(value, ["memberId", "role", "createdByMemberId", "createdAt", "updatedAt"]) ||
    typeof value.memberId !== "string" || !value.memberId || !["free-busy", "viewer", "editor", "manager"].includes(String(value.role)) ||
    typeof value.createdByMemberId !== "string" || !value.createdByMemberId || !isUtcTimestamp(value.createdAt) || !isUtcTimestamp(value.updatedAt)) return null;
  return {
    memberId: value.memberId,
    role: value.role as DenCalendarCollaborationRole,
    createdByMemberId: value.createdByMemberId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function denCalendarFromCollaborationResource(value: DenCalendarCollaborationResource): DenCalendar {
  return { id: value.id, organizationId: value.organizationId, ownerMemberId: value.ownerMemberId, name: value.name, color: value.color, isDefault: false, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function invalidCalendarPayload(message: string): never {
  throw new DenApiError(500, "invalid_calendar_payload", message);
}

const CALENDAR_ERROR_STATUS = {
  invalid_calendar_request: 400,
  calendar_not_found: 404,
  calendar_disabled: 404,
  calendar_write_disabled: 403,
  calendar_version_conflict: 409,
  calendar_idempotency_conflict: 409,
  calendar_cursor_resync_required: 409,
  calendar_result_too_large: 422,
  calendar_authorization_version_conflict: 409,
  calendar_last_manager: 409,
  calendar_member_invalid: 400,
} as const;

type CalendarErrorCode = keyof typeof CALENDAR_ERROR_STATUS;

function normalizeCalendarApiError(status: number, value: unknown): DenApiError | null {
  if (!isRecord(value) || Array.isArray(value) || typeof value.error !== "string" || !Object.prototype.hasOwnProperty.call(CALENDAR_ERROR_STATUS, value.error)) return null;
  const code = value.error as CalendarErrorCode;
  const invalid = () => new DenApiError(500, "invalid_calendar_payload", "Calendar error response was invalid.");
  if (status !== CALENDAR_ERROR_STATUS[code] || typeof value.message !== "string" || !value.message ||
    !hasExactKeys(value, value.details === undefined ? ["error", "message"] : ["error", "message", "details"])) return invalid();

  if (code === "invalid_calendar_request") {
    if (value.details === undefined) return new DenApiError(status, code, value.message);
    if (!isRecord(value.details) || Array.isArray(value.details) || Object.entries(value.details).some(([field, reason]) => !field || typeof reason !== "string" || !reason)) return invalid();
    return new DenApiError(status, code, value.message, { ...value.details });
  }

  if (["calendar_not_found", "calendar_disabled", "calendar_write_disabled", "calendar_idempotency_conflict", "calendar_authorization_version_conflict", "calendar_last_manager", "calendar_member_invalid"].includes(code)) {
    return value.details === undefined ? new DenApiError(status, code, value.message) : invalid();
  }

  if (!isRecord(value.details) || Array.isArray(value.details)) return invalid();
  if (code === "calendar_version_conflict") {
    if (!hasExactKeys(value.details, ["current"])) return invalid();
    const current = normalizeDenCalendar(value.details.current) ?? normalizeDenCalendarSchedulingEvent(value.details.current) ?? normalizeDenCalendarEvent(value.details.current);
    return current ? new DenApiError(status, code, value.message, { current }) : invalid();
  }
  if (code === "calendar_cursor_resync_required") {
    if (!hasExactKeys(value.details, ["reason"]) || !["invalid", "scope_mismatch", "expired", "version_unsupported"].includes(String(value.details.reason))) return invalid();
    return new DenApiError(status, code, value.message, { reason: value.details.reason });
  }
  if (!hasExactKeys(value.details, ["limit"]) || value.details.limit !== 5000) return invalid();
  return new DenApiError(status, code, value.message, { limit: 5000 });
}

function normalizeCalendarList(value: unknown): DenCalendar[] {
  if (!Array.isArray(value)) invalidCalendarPayload("Calendar list response was invalid.");
  const items = value.map(normalizeDenCalendar);
  if (items.some((item) => !item)) invalidCalendarPayload("Calendar list response was invalid.");
  return items as DenCalendar[];
}

function normalizeCalendarCollaborationList(value: unknown, organizationId: string): DenCalendarCollaborationList {
  if (!isRecord(value) || !hasExactKeys(value, ["items", "authorizationGeneration", "reset"]) || !Array.isArray(value.items) || !isPositiveSafeInteger(value.authorizationGeneration) ||
    !isRecord(value.reset) || !hasExactKeys(value.reset, ["mode", "namespace"]) || value.reset.mode !== "replace" || value.reset.namespace !== "calendar-collaboration") invalidCalendarPayload("Calendar collaboration list response was invalid.");
  const items = value.items.map(normalizeDenCalendarCollaborationResource);
  if (items.some((item) => !item || item.organizationId !== organizationId)) invalidCalendarPayload("Calendar collaboration list response was invalid.");
  return { items: items as DenCalendarCollaborationResource[], authorizationGeneration: value.authorizationGeneration, reset: { mode: "replace", namespace: "calendar-collaboration" } };
}

function normalizeTeamCalendarCreateResult(value: unknown, organizationId: string): DenTeamCalendarCreateResult {
  if (!isRecord(value) || !hasExactKeys(value, ["calendar"])) invalidCalendarPayload("Team calendar mutation response was invalid.");
  const calendar = normalizeDenCalendarCollaborationResource(value.calendar);
  if (!calendar || calendar.organizationId !== organizationId || calendar.kind !== "team" || calendar.role !== "manager" || !calendar.capabilities.canManage) invalidCalendarPayload("Team calendar mutation response was invalid.");
  return { calendar };
}

function normalizeCalendarMembershipList(value: unknown): DenCalendarMembershipList {
  if (!isRecord(value) || !hasExactKeys(value, ["items", "authorizationVersion"]) || !Array.isArray(value.items) || !isPositiveSafeInteger(value.authorizationVersion)) invalidCalendarPayload("Calendar membership list response was invalid.");
  const items = value.items.map(normalizeDenCalendarMembership);
  if (items.some((item) => !item)) invalidCalendarPayload("Calendar membership list response was invalid.");
  return { items: items as DenCalendarMembership[], authorizationVersion: value.authorizationVersion };
}

function normalizeCalendarMembershipPutResult(value: unknown, memberId: string): DenCalendarMembershipPutResult {
  if (!isRecord(value) || !hasExactKeys(value, ["membership", "authorizationVersion"]) || !isPositiveSafeInteger(value.authorizationVersion)) invalidCalendarPayload("Calendar membership mutation response was invalid.");
  const membership = normalizeDenCalendarMembership(value.membership);
  if (!membership || membership.memberId !== memberId) invalidCalendarPayload("Calendar membership mutation response was invalid.");
  return { membership, authorizationVersion: value.authorizationVersion };
}

function normalizeCalendarMembershipRevokeResult(value: unknown): DenCalendarMembershipRevokeResult {
  if (!isRecord(value) || !hasExactKeys(value, ["authorizationVersion"]) || !isPositiveSafeInteger(value.authorizationVersion)) invalidCalendarPayload("Calendar membership mutation response was invalid.");
  return { authorizationVersion: value.authorizationVersion };
}

function normalizeTeamCalendarSnapshot(value: unknown, organizationId: string, calendarId: string, range: { startDate: string; endDateExclusive: string }): DenTeamCalendarSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ["calendar", "events", "coverage", "authorizationVersion", "reset"]) || !isPositiveSafeInteger(value.authorizationVersion) ||
    !isRecord(value.coverage) || !hasExactKeys(value.coverage, ["startDate", "endDateExclusive", "calendarIds"]) || !isCalendarDate(value.coverage.startDate) || !isCalendarDate(value.coverage.endDateExclusive) || value.coverage.endDateExclusive <= value.coverage.startDate ||
    !Array.isArray(value.coverage.calendarIds) || value.coverage.calendarIds.length !== 1 || value.coverage.calendarIds[0] !== calendarId ||
    !isRecord(value.reset) || !hasExactKeys(value.reset, ["mode", "namespace"]) || value.reset.mode !== "replace" || value.reset.namespace !== `calendar:${calendarId}`) invalidCalendarPayload("Team calendar snapshot response was invalid.");
  const calendar = normalizeDenCalendarCollaborationResource(value.calendar);
  if (!calendar || calendar.id !== calendarId || calendar.organizationId !== organizationId || calendar.kind !== "team" || calendar.authorizationVersion !== value.authorizationVersion || value.coverage.startDate !== range.startDate || value.coverage.endDateExclusive !== range.endDateExclusive) invalidCalendarPayload("Team calendar snapshot response was invalid.");
  const events = normalizeCalendarEventList(value.events);
  if (events.some((event) => event.organizationId !== organizationId || event.calendarId !== calendarId || event.ownerMemberId !== calendar.ownerMemberId)) invalidCalendarPayload("Team calendar snapshot response was invalid.");
  return { calendar, events, coverage: { startDate: value.coverage.startDate, endDateExclusive: value.coverage.endDateExclusive, calendarIds: [calendarId] }, authorizationVersion: value.authorizationVersion, reset: { mode: "replace", namespace: `calendar:${calendarId}` } };
}

function normalizeCalendarEventList(value: unknown): DenCalendarEvent[] {
  if (!Array.isArray(value)) invalidCalendarPayload("Calendar event list response was invalid.");
  const items = value.map(normalizeDenCalendarEvent);
  if (items.some((item) => !item)) invalidCalendarPayload("Calendar event list response was invalid.");
  return items as DenCalendarEvent[];
}

function normalizeCalendarResult(value: unknown): DenCalendarResult {
  if (!isRecord(value) || !hasExactKeys(value, ["calendar", "replayed"]) || typeof value.replayed !== "boolean") invalidCalendarPayload("Calendar mutation response was invalid.");
  const calendar = normalizeDenCalendar(value.calendar);
  if (!calendar) invalidCalendarPayload("Calendar mutation response was invalid.");
  return { calendar, replayed: value.replayed };
}

function normalizeCalendarEventResult(value: unknown): DenCalendarEventResult {
  if (!isRecord(value) || !hasExactKeys(value, ["event", "replayed"]) || typeof value.replayed !== "boolean") invalidCalendarPayload("Calendar event mutation response was invalid.");
  const event = normalizeDenCalendarEvent(value.event);
  if (!event) invalidCalendarPayload("Calendar event mutation response was invalid.");
  return { event, replayed: value.replayed };
}

function invalidCalendarSchedulingPayload(message: string): never {
  throw new DenApiError(500, "invalid_calendar_scheduling_payload", message);
}

function normalizeCalendarSchedulingEventResult(value: unknown): DenCalendarSchedulingEventResult {
  if (!isRecord(value) || !hasExactKeys(value, ["event", "replayed"]) || typeof value.replayed !== "boolean") invalidCalendarSchedulingPayload("Calendar scheduling mutation response was invalid.");
  const event = normalizeDenCalendarSchedulingEvent(value.event);
  if (!event) invalidCalendarSchedulingPayload("Calendar scheduling mutation response was invalid.");
  return { event, replayed: value.replayed };
}

function normalizeCalendarSchedulingOccurrenceList(value: unknown): DenCalendarSchedulingOccurrenceList {
  if (!isRecord(value) || !hasExactKeys(value, ["items"]) || !Array.isArray(value.items)) invalidCalendarSchedulingPayload("Calendar scheduling occurrence response was invalid.");
  const items = value.items.map((item): DenCalendarSchedulingOccurrence | null => {
    if (!isRecord(item) || !hasExactKeys(item, ["event", "occurrenceIndex", "time"]) || !isPositiveSafeInteger(item.occurrenceIndex)) return null;
    const event = normalizeDenCalendarSchedulingEvent(item.event);
    const time = normalizeCalendarTime(item.time);
    return event && time ? { event, occurrenceIndex: item.occurrenceIndex, time } : null;
  });
  if (items.some((item) => !item)) invalidCalendarSchedulingPayload("Calendar scheduling occurrence response was invalid.");
  return { items: items as DenCalendarSchedulingOccurrence[] };
}

function normalizeCalendarDeleteResult(value: unknown, expectedEntityType: "calendar" | "event"): DenCalendarDeleteResult {
  if (!isRecord(value) || !hasExactKeys(value, ["tombstone", "replayed"]) || typeof value.replayed !== "boolean" || !isRecord(value.tombstone) ||
    !hasExactKeys(value.tombstone, ["entityType", "entityId", "version", "deletedAt"]) || value.tombstone.entityType !== expectedEntityType ||
    typeof value.tombstone.entityId !== "string" || !value.tombstone.entityId || !isPositiveSafeInteger(value.tombstone.version) || !isUtcTimestamp(value.tombstone.deletedAt)) {
    invalidCalendarPayload("Calendar delete response was invalid.");
  }
  return { tombstone: value.tombstone as DenCalendarTombstone, replayed: value.replayed };
}

function normalizeCalendarEventPage(value: unknown): DenCalendarEventPage {
  if (!isRecord(value) || !hasExactKeys(value, ["items", "nextCursor", "hasMore"]) || typeof value.hasMore !== "boolean" ||
    value.nextCursor !== null && (typeof value.nextCursor !== "string" || !value.nextCursor) || value.hasMore && (typeof value.nextCursor !== "string" || !value.nextCursor)) {
    invalidCalendarPayload("Calendar event page response was invalid.");
  }
  return { items: normalizeCalendarEventList(value.items), nextCursor: value.nextCursor as string | null, hasMore: value.hasMore };
}

function normalizeCalendarBootstrap(value: unknown): DenCalendarBootstrap {
  if (!isRecord(value) || !hasExactKeys(value, ["calendars", "events", "coverage", "cursor"]) || typeof value.cursor !== "string" || !value.cursor || !isRecord(value.coverage) ||
    !hasExactKeys(value.coverage, ["startDate", "endDateExclusive", "calendarIds"]) || !isCalendarDate(value.coverage.startDate) || !isCalendarDate(value.coverage.endDateExclusive) || value.coverage.endDateExclusive <= value.coverage.startDate ||
    !Array.isArray(value.coverage.calendarIds) || value.coverage.calendarIds.some((id) => typeof id !== "string" || !id)) invalidCalendarPayload("Calendar bootstrap response was invalid.");
  return {
    calendars: normalizeCalendarList(value.calendars),
    events: normalizeCalendarEventList(value.events),
    coverage: { startDate: value.coverage.startDate, endDateExclusive: value.coverage.endDateExclusive, calendarIds: value.coverage.calendarIds as string[] },
    cursor: value.cursor,
  };
}

function normalizeCalendarChange(value: unknown): DenCalendarChange | null {
  if (!isRecord(value) || !isPositiveSafeInteger(value.sequence)) return null;
  if (value.kind === "upsert" && value.entityType === "calendar" && hasExactKeys(value, ["sequence", "kind", "entityType", "entity"])) {
    const entity = normalizeDenCalendar(value.entity);
    return entity ? { sequence: value.sequence, kind: "upsert", entityType: "calendar", entity } : null;
  }
  if (value.kind === "upsert" && value.entityType === "event" && hasExactKeys(value, ["sequence", "kind", "entityType", "entity"])) {
    const entity = normalizeDenCalendarEvent(value.entity);
    return entity ? { sequence: value.sequence, kind: "upsert", entityType: "event", entity } : null;
  }
  if (value.kind === "delete" && (value.entityType === "calendar" || value.entityType === "event") && hasExactKeys(value, ["sequence", "kind", "entityType", "entityId", "version", "deletedAt"]) &&
    typeof value.entityId === "string" && value.entityId && isPositiveSafeInteger(value.version) && isUtcTimestamp(value.deletedAt)) {
    return { sequence: value.sequence, kind: "delete", entityType: value.entityType, entityId: value.entityId, version: value.version, deletedAt: value.deletedAt };
  }
  return null;
}

function normalizeCalendarChangePage(value: unknown): DenCalendarChangePage {
  if (!isRecord(value) || !hasExactKeys(value, ["items", "nextCursor", "hasMore"]) || !Array.isArray(value.items) || typeof value.nextCursor !== "string" || !value.nextCursor || typeof value.hasMore !== "boolean") invalidCalendarPayload("Calendar changes response was invalid.");
  const items = value.items.map(normalizeCalendarChange);
  if (items.some((item) => !item)) invalidCalendarPayload("Calendar changes response was invalid.");
  for (let index = 1; index < items.length; index += 1) {
    if (items[index]!.sequence <= items[index - 1]!.sequence) invalidCalendarPayload("Calendar changes response was not ordered.");
  }
  return { items: items as DenCalendarChange[], nextCursor: value.nextCursor, hasMore: value.hasMore };
}

function calendarQuery(input: { calendarIds?: string[]; cursor?: string; limit?: number } & Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (key === "calendarIds" || key === "cursor" || key === "limit" || value === undefined) continue;
    params.set(key, String(value));
  }
  [...new Set(input.calendarIds ?? [])].sort().forEach((id) => params.append("calendarId", id));
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  return `?${params.toString()}`;
}

function productTaskQuery(options: DenProductTaskListOptions): string {
  const params = new URLSearchParams();
  if (options.view) params.set("view", options.view);
  if (options.search?.trim()) params.set("search", options.search.trim());
  options.status?.forEach((value) => params.append("status", value));
  options.priority?.forEach((value) => params.append("priority", value));
  options.listId?.forEach((value) => params.append("listId", value));
  options.creatorMemberId?.forEach((value) => params.append("creatorMemberId", value));
  if (options.creatorMemberOperator) params.set("creatorMemberOperator", options.creatorMemberOperator);
  options.assigneeMemberId?.forEach((value) => params.append("assigneeMemberId", value));
  if (options.assigneeMemberOperator) params.set("assigneeMemberOperator", options.assigneeMemberOperator);
  options.assignerMemberId?.forEach((value) => params.append("assignerMemberId", value));
  if (options.assignerMemberOperator) params.set("assignerMemberOperator", options.assignerMemberOperator);
  options.followerMemberId?.forEach((value) => params.append("followerMemberId", value));
  if (options.followerMemberOperator) params.set("followerMemberOperator", options.followerMemberOperator);
  if (options.startAtFrom) params.set("startAtFrom", options.startAtFrom);
  if (options.startAtBefore) params.set("startAtBefore", options.startAtBefore);
  if (options.dueAtFrom) params.set("dueAtFrom", options.dueAtFrom);
  if (options.dueAtBefore) params.set("dueAtBefore", options.dueAtBefore);
  if (options.overdue !== undefined) params.set("overdue", String(options.overdue));
  if (options.sort) params.set("sort", options.sort);
  if (options.direction) params.set("direction", options.direction);
  if (options.timezone) params.set("timezone", options.timezone);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  return query ? `?${query}` : "";
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
  const config = normalizeDesktopConfig(payload);
  const raw = isRecord(payload) ? payload : null;
  const calendarEnabled = raw?.calendarEnabled === true;
  return {
    ...config,
    calendarEnabled,
    calendarWriteEnabled: calendarEnabled && raw?.calendarWriteEnabled === true,
    calendarCollaborationEnabled: calendarEnabled && raw?.calendarCollaborationEnabled === true,
  };
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
export function denControlPlaneBaseUrl(baseUrl: string): string {
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

export type DenMembershipUpgradeContext = "personal" | "team";

/** Opens the server-owned tier selector; Desktop never chooses a plan itself. */
export function buildDenMembershipUpgradeUrl(
  baseUrl: string | null | undefined,
  context: DenMembershipUpgradeContext,
): string {
  const url = new URL(`${DEN_DASHBOARD_PATH}/dashboard/`, resolveDenBaseUrls(baseUrl).baseUrl);
  url.searchParams.set("membership", context);
  return url.toString();
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
    authToken: resolveDenAuthToken({
      developmentToken: BUILD_DEN_DEV_AUTH_TOKEN,
      persistedToken: window.localStorage.getItem(STORAGE_AUTH_TOKEN),
      revokedDevelopmentFingerprint: window.localStorage.getItem(
        STORAGE_REVOKED_DEV_AUTH_FINGERPRINT,
      ),
    }),
    activeOrgId: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_ID) ?? "").trim() || null,
    activeOrgSlug: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_SLUG) ?? "").trim() || null,
    activeOrgName: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_NAME) ?? "").trim() || null,
  };
}

export function readDenUserId(): string | null {
  if (typeof window === "undefined") return null;
  return (window.localStorage.getItem(STORAGE_USER_ID) ?? "").trim() || null;
}

function readLastOrgByUser(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_LAST_ORG_BY_USER) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([userId, orgId]) => {
        const user = userId.trim();
        const organization = typeof orgId === "string" ? orgId.trim() : "";
        return user && organization ? [[user, organization]] : [];
      }),
    );
  } catch {
    return {};
  }
}

/** Return the last organization selected for one confirmed Den identity. */
export function readDenLastOrganization(userId: string | null | undefined): string | null {
  const id = userId?.trim() ?? "";
  return id ? readLastOrgByUser()[id] ?? null : null;
}

/** Persist an organization preference without coupling it to the disposable auth session. */
export function writeDenLastOrganization(
  userId: string | null | undefined,
  organizationId: string | null | undefined,
) {
  if (typeof window === "undefined") return;
  const id = userId?.trim() ?? "";
  const organization = organizationId?.trim() ?? "";
  if (!id || !organization) return;
  const next = { ...readLastOrgByUser(), [id]: organization };
  window.localStorage.setItem(STORAGE_LAST_ORG_BY_USER, JSON.stringify(next));
}

/**
 * Resolve the organization used during bootstrap without asking the member.
 * The Cloud account's active organization is shared with other clients. A
 * remembered choice is the local fallback when the Cloud does not report one.
 */
export function resolveDenDefaultOrganization(
  orgs: readonly DenOrgSummary[] | null | undefined,
  input?: {
    rememberedOrgId?: string | null;
    currentOrgId?: string | null;
    currentOrgSlug?: string | null;
    serverActiveOrgId?: string | null;
    serverActiveOrgSlug?: string | null;
  },
): DenOrgSummary | null {
  const list = orgs ?? [];
  const byId = (value: string | null | undefined) => {
    const id = value?.trim() ?? "";
    return id ? list.find((org) => org.id === id) ?? null : null;
  };
  const bySlug = (value: string | null | undefined) => {
    const slug = value?.trim() ?? "";
    return slug ? list.find((org) => org.slug === slug) ?? null : null;
  };
  return (
    byId(input?.serverActiveOrgId) ??
    bySlug(input?.serverActiveOrgSlug) ??
    byId(input?.rememberedOrgId) ??
    byId(input?.currentOrgId) ??
    bySlug(input?.currentOrgSlug) ??
    list[0] ??
    null
  );
}

export function denCredentialFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${hash >>> 0}`;
}

/** 忽略旧登录请求迟到的撤权事件，避免清理已切换账号后的当前页面。 */
export function isCurrentDenSessionRevocation(event: Event): boolean {
  const fingerprint = (event as CustomEvent<{ authFingerprint?: string }>).detail?.authFingerprint;
  return !fingerprint || fingerprint === denCredentialFingerprint(readDenSettings().authToken ?? "");
}

export function resolveDenAuthToken(input: {
  developmentToken?: string | null;
  persistedToken?: string | null;
  revokedDevelopmentFingerprint?: string | null;
}): string | null {
  const developmentToken = input.developmentToken?.trim() ?? "";
  const persistedToken = input.persistedToken?.trim() ?? "";
  const revokedFingerprint = input.revokedDevelopmentFingerprint?.trim() ?? "";
  if (
    developmentToken &&
    revokedFingerprint !== denCredentialFingerprint(developmentToken)
  ) {
    return developmentToken;
  }
  return persistedToken || null;
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
    const stored = JSON.parse(raw) as { authFingerprint?: unknown; organizationId?: unknown; im?: unknown };
    const settings = readDenSettings();
    const authToken = settings.authToken?.trim() ?? "";
    const activeOrgId = settings.activeOrgId?.trim() ?? "";
    if (!authToken || stored.authFingerprint !== denCredentialFingerprint(authToken)) return null;
    if (!activeOrgId || stored.organizationId !== activeOrgId) return null;
    return getIMLoginBootstrap({ im: stored.im });
  } catch {
    return null;
  }
}

export function writeDenIMLoginBootstrap(
  value: DenIMLoginBootstrap | null,
  organizationId?: string | null,
) {
  if (typeof window === "undefined") return;
  if (value) {
    const settings = readDenSettings();
    const authToken = settings.authToken?.trim() ?? "";
    const scopedOrganizationId = organizationId?.trim() || settings.activeOrgId?.trim() || "";
    if (!authToken || !scopedOrganizationId) {
      window.localStorage.removeItem(STORAGE_IM_LOGIN_BOOTSTRAP);
      dispatchDenSettingsChanged({ settings: readDenSettings() });
      return;
    }
    window.localStorage.setItem(STORAGE_IM_LOGIN_BOOTSTRAP, JSON.stringify({
      authFingerprint: denCredentialFingerprint(authToken),
      organizationId: scopedOrganizationId,
      im: value,
    }));
  } else {
    window.localStorage.removeItem(STORAGE_IM_LOGIN_BOOTSTRAP);
  }
  // Chat is eagerly mounted and its Den user object may remain unchanged when
  // an organization switch or startup repair provisions new IM credentials.
  // Notify subscribers so JuggleChat reconnects without requiring a reload.
  dispatchDenSettingsChanged({ settings: readDenSettings() });
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

  // A Vite development token normally wins over persisted handoff tokens so
  // rotating the local .env credential is enough to repair a stale session.
  // Once that exact token is explicitly signed out or confirmed revoked,
  // remember its non-secret fingerprint so readDenSettings() does not
  // immediately resurrect it and trap the user outside the sign-in screen.
  // Changing the .env token changes the fingerprint and re-enables the dev
  // shortcut automatically.
  if (BUILD_DEN_DEV_AUTH_TOKEN) {
    window.localStorage.setItem(
      STORAGE_REVOKED_DEV_AUTH_FINGERPRINT,
      denCredentialFingerprint(BUILD_DEN_DEV_AUTH_TOKEN),
    );
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
  const userId = readDenUserId();
  const targetOrg = resolveDenDefaultOrganization(response.orgs, {
    rememberedOrgId: readDenLastOrganization(userId),
    currentOrgId: settings.activeOrgId,
    currentOrgSlug: settings.activeOrgSlug,
    serverActiveOrgId: response.activeOrgId,
    serverActiveOrgSlug: response.activeOrgSlug,
  });

  if (!targetOrg) {
    writeDenSettings({
      ...settings,
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    }, { persistBootstrap: false });
    return null;
  }

  const missingIMBootstrap = !readDenIMLoginBootstrap();
  const shouldRefreshOrganizationBootstrap = options?.forceServerSync && (
    !response.activeOrgId ||
    response.activeOrgId !== targetOrg.id ||
    (missingIMBootstrap && targetOrg.kind !== "personal")
  );
  if (shouldRefreshOrganizationBootstrap) {
    // TIPS: 服务端会为请求指定的非个人组织重新供给 IM 凭据（可能是 null，比如组织没开
    // IM 或临时供给失败），因此真正切换组织和本地 bootstrap 缺失时都要写回响应。
    // 已有有效 bootstrap 且服务端组织一致时不请求，避免每次刷新都重新供给；个人工作区
    // 按服务端契约永远不带 IM，也不做无意义的自愈请求。
    const result = await client.setActiveOrganization({ organizationId: targetOrg.id });
    writeDenSettings({
      ...settings,
      activeOrgId: targetOrg.id,
      activeOrgSlug: targetOrg.slug,
      activeOrgName: targetOrg.name,
    }, { persistBootstrap: false });
    writeDenIMLoginBootstrap(result?.im ?? null, targetOrg.id);
  } else {
    writeDenSettings({
      ...settings,
      activeOrgId: targetOrg.id,
      activeOrgSlug: targetOrg.slug,
      activeOrgName: targetOrg.name,
    }, { persistBootstrap: false });
  }
  writeDenLastOrganization(userId, targetOrg.id);

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
        orgMemberId: typeof entry.orgMemberId === "string" ? entry.orgMemberId : undefined,
        membershipId: typeof entry.membershipId === "string" ? entry.membershipId : undefined,
      } satisfies DenOrgSummary,
    ];
  });
}

function getOrgSummary(payload: unknown): DenOrgSummary | null {
  return getOrgList({ orgs: [payload] })[0] ?? null;
}

function isDenTenantTier(value: unknown): value is DenTenantTier {
  return value === "normal" || value === "pro" || value === "power" || value === "lite_team" || value === "team" || value === "business";
}

function isDenTenantTierForKind(kind: "personal" | "organization", tier: unknown): tier is DenTenantTier {
  return kind === "personal"
    ? tier === "normal" || tier === "pro" || tier === "power"
    : tier === "lite_team" || tier === "team" || tier === "business";
}

function readSafeInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readSignedSafeInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== "string" || !/^(0|-?[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readDecimalString(value: unknown): string | null {
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) return value;
  return null;
}

function readBillingSafeInteger(value: unknown): number | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isPositiveDecimalString(value: string): boolean {
  return value !== "0";
}

function readOptionalTimestamp(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
  if (!match) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const date = new Date(parsed);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
    ? value
    : undefined;
}

function getTenantBilling(value: unknown, kind: "personal" | "organization"): DenTenantAccount["billing"] | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.paid !== "boolean" || typeof value.fundingKind !== "string") return undefined;
  const plan = value.plan === "" || value.plan === null ? null : value.plan;
  const period = value.period === "" || value.period === null ? null : value.period;
  const seats = readBillingSafeInteger(value.seats);
  const allowancePerCycle = readDecimalString(value.allowancePerCycle);
  const cycleStart = readOptionalTimestamp(value.cycleStart);
  const cycleEnd = readOptionalTimestamp(value.cycleEnd);
  const paidThrough = readOptionalTimestamp(value.paidThrough);
  const nextGrantAt = readOptionalTimestamp(value.nextGrantAt);
  if (
    (plan !== null && !isDenTenantTierForKind(kind, plan)) ||
    (period !== null && period !== "monthly" && period !== "annual") ||
    seats === null || allowancePerCycle === null ||
    cycleStart === undefined || cycleEnd === undefined || paidThrough === undefined || nextGrantAt === undefined ||
    (value.paid
      ? value.fundingKind !== "paid" || plan === null || period === null || seats < 1 || !isPositiveDecimalString(allowancePerCycle)
      : value.fundingKind === "community"
        ? kind !== "personal" || plan !== "normal" || period !== null || seats !== 1 || cycleStart === null || cycleEnd === null || paidThrough !== null || nextGrantAt === null || !isPositiveDecimalString(allowancePerCycle)
        : value.fundingKind === "unpaid"
          ? kind !== "organization" || (plan !== "lite_team" && plan !== "team") || period !== null || seats !== 0 || cycleStart !== null || cycleEnd !== null || paidThrough !== null || nextGrantAt !== null || allowancePerCycle !== "0"
          : true)
  ) return undefined;
  return {
    paid: value.paid,
    fundingKind: value.fundingKind,
    plan,
    period,
    seats,
    cycleStart,
    cycleEnd,
    paidThrough,
    nextGrantAt,
    allowancePerCycle,
  };
}

function getTenantAccount(payload: unknown): DenTenantAccount | null {
  if (!isRecord(payload) || !isRecord(payload.points) || !isRecord(payload.permissions)) return null;
  if (
    (payload.kind !== "personal" && payload.kind !== "organization") ||
    !isDenTenantTierForKind(payload.kind, payload.tier) ||
    typeof payload.status !== "string" ||
    readSafeInteger(payload.tierVersion) === null ||
    readSignedSafeInteger(payload.points.available) === null ||
    readSafeInteger(payload.points.reserved) === null ||
    readSafeInteger(payload.points.version) === null ||
    typeof payload.permissions.canViewLedger !== "boolean" ||
    typeof payload.permissions.canManageBilling !== "boolean"
  ) {
    return null;
  }
  const billing = getTenantBilling(payload.billing, payload.kind);
  if (billing === undefined) return null;
  return {
    kind: payload.kind,
    tier: payload.tier,
    status: payload.status,
    tierVersion: readSafeInteger(payload.tierVersion)!,
    points: {
      available: readSignedSafeInteger(payload.points.available)!,
      reserved: readSafeInteger(payload.points.reserved)!,
      version: readSafeInteger(payload.points.version)!,
    },
    permissions: {
      canViewLedger: payload.permissions.canViewLedger,
      canManageBilling: payload.permissions.canManageBilling,
    },
    billing,
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
    ...(value.managedIdentity === "jwork_router" || value.managedIdentity === null
      ? { managedIdentity: value.managedIdentity }
      : value.managedIdentity === undefined && value.managedKind === "juggle_router"
        ? { managedIdentity: "jwork_router" as const }
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
    (value.url != null && typeof value.url !== "string") ||
    (value.authType !== "oauth" && value.authType !== "apikey" && value.authType !== "none") ||
    (value.credentialMode !== "shared" && value.credentialMode !== "per_member")
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    // Member-safe responses omit the endpoint. Keep the connection identity
    // so members can still authorize it by ID through Connect.
    url: typeof value.url === "string" ? value.url : "",
    authType: value.authType,
    credentialMode: value.credentialMode,
    connected: typeof value.connected === "boolean" ? value.connected : value.connectedForMe === true,
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
    ...(value.delivery === "cloud" || value.delivery === "desktop" ? { delivery: value.delivery } : {}),
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
    ...(value.delivery === "cloud" || value.delivery === "desktop" ? { delivery: value.delivery } : {}),
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
    marketplaces: Array.isArray(value.marketplaces)
      ? value.marketplaces.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") return [];
        return [{ id: entry.id, name: entry.name }];
      })
      : [],
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
    ...(value.delivery === "cloud" || value.delivery === "desktop" ? { delivery: value.delivery } : {}),
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

function getMembershipCatalogPlan(value: unknown): DenMembershipBillingCatalogPlan | null {
  if (!isRecord(value) || !isDenTenantTier(value.plan)) return null;
  if (value.tenantKind !== "personal" && value.tenantKind !== "organization") return null;
  const monthlyAmountFen = readDecimalString(value.monthlyAmountFen);
  const annualAmountFen = readDecimalString(value.annualAmountFen);
  const allowancePerCycle = readDecimalString(value.allowancePerCycle);
  const minimumSeats = readBillingSafeInteger(value.minimumSeats);
  if (
    monthlyAmountFen === null ||
    annualAmountFen === null ||
    allowancePerCycle === null ||
    minimumSeats === null ||
    minimumSeats < 1 ||
    typeof value.pricedPerSeat !== "boolean"
  ) {
    return null;
  }
  return {
    plan: value.plan,
    tenantKind: value.tenantKind,
    monthlyAmountFen,
    annualAmountFen,
    allowancePerCycle,
    minimumSeats,
    pricedPerSeat: value.pricedPerSeat,
  };
}

const MEMBERSHIP_CATALOG_KINDS: Record<DenTenantTier, "personal" | "organization"> = {
  normal: "personal",
  pro: "personal",
  power: "personal",
  lite_team: "organization",
  team: "organization",
  business: "organization",
};

export function normalizeDenMembershipBillingCatalog(payload: unknown): DenMembershipBillingCatalog | null {
  if (
    !isRecord(payload) ||
    typeof payload.version !== "string" ||
    !payload.version.trim() ||
    payload.currency !== "CNY" ||
    !isRecord(payload.payment) ||
    typeof payload.payment.alipayPageAvailable !== "boolean" ||
    typeof payload.payment.alipayQrAvailable !== "boolean" ||
    !Array.isArray(payload.plans)
  ) {
    return null;
  }
  const plans = payload.plans.flatMap((value) => {
    const plan = getMembershipCatalogPlan(value);
    return plan ? [plan] : [];
  });
  const expectedPlanCount = Object.keys(MEMBERSHIP_CATALOG_KINDS).length;
  if (plans.length !== payload.plans.length || plans.length !== expectedPlanCount) return null;
  const plansByName = new Map(plans.map((plan) => [plan.plan, plan]));
  if (
    plansByName.size !== expectedPlanCount ||
    Object.entries(MEMBERSHIP_CATALOG_KINDS).some(([name, kind]) => plansByName.get(name as DenTenantTier)?.tenantKind !== kind) ||
    plans.some((plan) => !isPositiveDecimalString(plan.allowancePerCycle)) ||
    plans.some((plan) => plan.plan === "normal"
      ? plan.monthlyAmountFen !== "0" || plan.annualAmountFen !== "0" || plan.minimumSeats !== 1 || plan.pricedPerSeat
      : !isPositiveDecimalString(plan.monthlyAmountFen) || !isPositiveDecimalString(plan.annualAmountFen)) ||
    plans.some((plan) => plan.tenantKind === "personal"
      ? plan.minimumSeats !== 1 || plan.pricedPerSeat
      : !plan.pricedPerSeat)
  ) return null;
  return {
    version: payload.version.trim(),
    currency: payload.currency.trim(),
    payment: {
      alipayPageAvailable: payload.payment.alipayPageAvailable === true,
      alipayQrAvailable: payload.payment.alipayQrAvailable === true,
    },
    plans,
  };
}

function getMembershipCheckout(value: unknown): DenMembershipCheckout | null {
  if (
    !isRecord(value) ||
    value.method !== "alipay_page" ||
    typeof value.url !== "string" ||
    value.status !== "pending"
  ) {
    return null;
  }
  const expiresAt = readOptionalTimestamp(value.expiresAt);
  if (expiresAt === undefined) return null;
  return {
    method: value.method,
    url: value.url,
    status: value.status,
    expiresAt,
  };
}

function getMembershipPaymentCode(value: unknown): DenMembershipPaymentCode | null {
  if (!isRecord(value) || value.status !== "pending" || typeof value.content !== "string" || !value.content) return null;
  const expiresAt = readOptionalTimestamp(value.expiresAt);
  if (expiresAt === undefined) return null;
  return {
    status: value.status,
    content: value.content,
    expiresAt,
  };
}

const MEMBERSHIP_ORDER_STATUSES = new Set([
  "quoted", "payment_pending", "paid_pending_fulfillment", "paid_pending_activation",
  "fulfilled", "expired", "closed", "reconciliation_required",
]);

function validMembershipOrderState(input: {
  status: string;
  fulfillmentStatus: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  nextAction: string;
  checkout: DenMembershipCheckout | null;
  paymentCode: DenMembershipPaymentCode | null;
}): boolean {
  const noArtifact = input.checkout === null && input.paymentCode === null;
  switch (input.status) {
    case "quoted":
      return input.fulfillmentStatus === "unfulfilled" && input.paidAt === null && input.fulfilledAt === null && noArtifact && (input.nextAction === "refresh_checkout" || input.nextAction === "refresh_payment_code");
    case "payment_pending":
      if (input.fulfillmentStatus !== "unfulfilled" || input.paidAt !== null || input.fulfilledAt !== null) return false;
       if (input.nextAction === "open_checkout") return input.checkout?.method === "alipay_page" && input.checkout.status === "pending" && input.paymentCode === null;
      if (input.nextAction === "scan_payment") return input.paymentCode !== null && input.checkout === null;
      return noArtifact && (input.nextAction === "refresh_checkout" || input.nextAction === "refresh_payment_code");
    case "paid_pending_fulfillment":
      return input.fulfillmentStatus === "pending" && input.paidAt !== null && input.fulfilledAt === null && noArtifact && input.nextAction === "none";
    case "paid_pending_activation":
      return input.fulfillmentStatus === "unfulfilled" && input.paidAt !== null && input.fulfilledAt === null && noArtifact && input.nextAction === "create_organization";
    case "fulfilled":
      return input.fulfillmentStatus === "fulfilled" && input.paidAt !== null && input.fulfilledAt !== null && noArtifact && input.nextAction === "refresh_tenant_account";
    case "expired":
    case "closed":
      return input.fulfillmentStatus === "unfulfilled" && input.paidAt === null && input.fulfilledAt === null && noArtifact && input.nextAction === "none";
    case "reconciliation_required":
      return input.fulfillmentStatus === "reconciliation_required" && input.paidAt !== null && input.fulfilledAt === null && noArtifact && input.nextAction === "contact_support";
    default:
      return false;
  }
}

export function normalizeDenMembershipOrder(payload: unknown): DenMembershipOrder | null {
  if (!isRecord(payload) || typeof payload.id !== "string" || !payload.id.trim()) return null;
  const organizationId = payload.organizationId === null
    ? null
    : typeof payload.organizationId === "string" && payload.organizationId.trim()
      ? payload.organizationId.trim()
      : undefined;
  if (organizationId === undefined) return null;
  if (!isDenTenantTier(payload.plan) || (payload.period !== "monthly" && payload.period !== "annual")) return null;
  if (payload.targetMode !== "existing_tenant" && payload.targetMode !== "new_organization") return null;
  if (payload.targetKind !== "personal" && payload.targetKind !== "organization") return null;
  if (typeof payload.status !== "string" || !MEMBERSHIP_ORDER_STATUSES.has(payload.status)) return null;
  const seats = readBillingSafeInteger(payload.seats);
  const unitAmountFen = readDecimalString(payload.unitAmountFen);
  const totalAmountFen = readDecimalString(payload.totalAmountFen);
  const allowancePerCycle = readDecimalString(payload.allowancePerCycle);
  const expiresAt = readOptionalTimestamp(payload.expiresAt);
  const paidAt = readOptionalTimestamp(payload.paidAt);
  const fulfilledAt = readOptionalTimestamp(payload.fulfilledAt);
  const checkout = payload.checkout === null || payload.checkout === undefined ? null : getMembershipCheckout(payload.checkout);
  const paymentCode = payload.paymentCode === null || payload.paymentCode === undefined ? null : getMembershipPaymentCode(payload.paymentCode);
  const targetCombinationValid = payload.targetMode === "new_organization"
    ? organizationId === null && payload.targetKind === "organization" && (payload.plan === "lite_team" || payload.plan === "team" || payload.plan === "business") && payload.quoteKind === "activation"
    : payload.targetKind === "personal"
      ? organizationId !== null && (payload.plan === "pro" || payload.plan === "power") && seats === 1
      : organizationId !== null && (payload.plan === "lite_team" || payload.plan === "team" || payload.plan === "business");
  if (
    seats === null || seats < 1 || unitAmountFen === null || unitAmountFen === "0" ||
    totalAmountFen === null || totalAmountFen === "0" || allowancePerCycle === null || allowancePerCycle === "0" ||
    payload.currency !== "CNY" ||
    (payload.quoteKind !== "activation" && payload.quoteKind !== "renewal" && payload.quoteKind !== "upgrade") ||
    expiresAt === undefined || expiresAt === null || paidAt === undefined || fulfilledAt === undefined ||
    (payload.checkout !== null && payload.checkout !== undefined && checkout === null) ||
    (payload.paymentCode !== null && payload.paymentCode !== undefined && paymentCode === null) ||
    typeof payload.fulfillmentStatus !== "string" || typeof payload.nextAction !== "string" ||
    !targetCombinationValid ||
    (payload.status === "paid_pending_activation" && payload.targetMode !== "new_organization") ||
    (payload.status === "paid_pending_fulfillment" && payload.targetMode !== "existing_tenant") ||
    (checkout !== null && (checkout.expiresAt === null || Date.parse(checkout.expiresAt) > Date.parse(expiresAt))) ||
    (paidAt !== null && fulfilledAt !== null && Date.parse(fulfilledAt) < Date.parse(paidAt)) ||
    !validMembershipOrderState({ status: payload.status, fulfillmentStatus: payload.fulfillmentStatus, paidAt, fulfilledAt, nextAction: payload.nextAction, checkout, paymentCode })
  ) return null;
  return {
    id: payload.id.trim(),
    organizationId,
    targetMode: payload.targetMode,
    targetKind: payload.targetKind,
    plan: payload.plan,
    period: payload.period,
    seats,
    unitAmountFen,
    totalAmountFen,
    currency: payload.currency,
    allowancePerCycle,
    quoteKind: payload.quoteKind,
    status: payload.status,
    fulfillmentStatus: payload.fulfillmentStatus,
    expiresAt,
    paidAt,
    fulfilledAt,
    nextAction: payload.nextAction,
    checkout,
    paymentCode,
  };
}

export function isAllowedAlipayCheckoutUrl(input: string, options?: { allowSandbox?: boolean }): boolean {
  try {
    if (new TextEncoder().encode(input).byteLength > 4096 || /[\u0000-\u001f\u007f]/.test(input) || input.trim() !== input) return false;
    const url = new URL(input);
    const expected = url.hostname === "openapi.alipay.com"
      ? "https://openapi.alipay.com/gateway.do"
      : options?.allowSandbox === true && url.hostname === "openapi-sandbox.dl.alipaydev.com"
        ? "https://openapi-sandbox.dl.alipaydev.com/gateway.do"
        : "";
    return expected !== "" && url.href === input && input.startsWith(`${expected}?`) && url.protocol === "https:" && url.origin + url.pathname === expected &&
      url.username === "" && url.password === "" && url.port === "" && url.hash === "" && url.search.length > 1;
  } catch {
    return false;
  }
}

export function isMembershipCheckoutOpenable(order: DenMembershipOrder, now = Date.now()): boolean {
  const expiresAfter = (timestamp: string | null) => timestamp !== null && Date.parse(timestamp) > now;
  return order.nextAction === "open_checkout" && order.checkout?.method === "alipay_page" && order.checkout.status === "pending" && order.paymentCode === null &&
    expiresAfter(order.expiresAt) && expiresAfter(order.checkout.expiresAt) && isAllowedAlipayCheckoutUrl(order.checkout.url);
}

function invalidMembershipOrderResponse(): DenApiError {
  return new DenApiError(500, "invalid_billing_order_payload", "Billing order response was invalid.");
}

function sameMembershipOrderQuote(left: DenMembershipOrder, right: DenMembershipOrder): boolean {
  return left.id === right.id && left.organizationId === right.organizationId && left.targetMode === right.targetMode &&
    left.targetKind === right.targetKind && left.plan === right.plan && left.period === right.period && left.seats === right.seats &&
    left.unitAmountFen === right.unitAmountFen && left.totalAmountFen === right.totalAmountFen && left.currency === right.currency &&
    left.allowancePerCycle === right.allowancePerCycle && left.quoteKind === right.quoteKind && left.expiresAt === right.expiresAt;
}

function validMembershipOrderTransition(previous: DenMembershipOrder, next: DenMembershipOrder): boolean {
  const allowedStatuses: Record<string, Set<string>> = {
    quoted: new Set(["quoted", "payment_pending", "paid_pending_fulfillment", "paid_pending_activation", "fulfilled", "expired", "closed", "reconciliation_required"]),
    payment_pending: new Set(["payment_pending", "paid_pending_fulfillment", "paid_pending_activation", "fulfilled", "expired", "closed", "reconciliation_required"]),
    paid_pending_fulfillment: new Set(["paid_pending_fulfillment", "fulfilled", "reconciliation_required"]),
    paid_pending_activation: new Set(["paid_pending_activation", "fulfilled", "reconciliation_required"]),
    reconciliation_required: new Set(["reconciliation_required", "paid_pending_fulfillment", "paid_pending_activation", "fulfilled"]),
    expired: new Set(["expired", "paid_pending_fulfillment", "paid_pending_activation", "fulfilled", "reconciliation_required"]),
    closed: new Set(["closed", "paid_pending_fulfillment", "paid_pending_activation", "fulfilled", "reconciliation_required"]),
    fulfilled: new Set(["fulfilled"]),
  };
  return sameMembershipOrderQuote(previous, next) &&
    allowedStatuses[previous.status]?.has(next.status) === true &&
    (previous.paidAt === null || next.paidAt !== null) &&
    (previous.status !== "fulfilled" || next.status === "fulfilled");
}

export function isRetryableMembershipPollingError(error: unknown): boolean {
  return !(error instanceof DenApiError) || error.status === 408 || error.status === 429 || error.status >= 500;
}

export async function createMembershipClaimIdempotencyKey(orderId: string, organizationName: string): Promise<string> {
  const input = new TextEncoder().encode(`${orderId.trim()}\n${organizationName.trim()}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `desktop-membership-claim-${hex}`;
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
  idempotencyKey?: string | null;
	  signal?: AbortSignal;
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
  const idempotencyKey = options.idempotencyKey?.trim() ?? "";
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
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
	  signal: options.signal,
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
    const calendarError = normalizeCalendarApiError(raw.status, payload);
    if (calendarError) throw calendarError;
    const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "request_failed";
    const message = getErrorMessage(payload, `Request failed with ${raw.status}.`);
    const token = options.token?.trim() ?? "";
    if (token && raw.status === 401 && code !== "request_failed") {
      dispatchDenSessionRevoked({
        authFingerprint: denCredentialFingerprint(token),
        status: 401,
        code,
        message,
      });
    }
    throw new DenApiError(raw.status, code, message, isRecord(payload) ? payload.details : undefined);
  }
  return raw.json as T;
}

// TIPS: 服务端 `/v1/me/active-organization` 在真正切换活跃组织时，会用新组织重新走一遍
// IM 供给（跟登录时的 handoff exchange 走同一个 `imBootstrapContract` 投影，见服务端
// apis/cloud.go 的 setActiveOrganization），响应体带着一份新的 `im`——旧代码把这个响应整个
// 丢掉，只等它 resolve，导致"服务端已经切到正确组织、IM 也重新供给好了，本地却永远拿不到
// 这份凭据"，只能眼睁睁看着聊天/通讯录白屏。这里把 `im` 解析出来交还给调用方去持久化。
async function ensureActiveOrganization(
  baseUrls: DenBaseUrls,
  token: string | null,
  input: { organizationId?: string | null; organizationSlug?: string | null },
): Promise<{ im: DenIMLoginBootstrap | null } | null> {
  const organizationId = input.organizationId?.trim() ?? "";
  const organizationSlug = input.organizationSlug?.trim() ?? "";
  if (!token || (!organizationId && !organizationSlug)) {
    return null;
  }

  const payload = await requestJson<unknown>(baseUrls, "/v1/me/active-organization", {
    method: "POST",
    token,
    body: {
      organizationId: organizationId || undefined,
      organizationSlug: organizationSlug || undefined,
    },
  });
  return { im: getIMLoginBootstrap(payload) };
}

/** 云文档一次性交接结果，不含源长期登录凭据。 */
export type DenDocsLaunch = {
  contractVersion: 1;
  launchGrant: string;
  expiresAt: string;
  tenantId: string;
  bootstrapUrl: string;
  docsOrigin: string;
  presentation: { instanceId: string; mode: 'product' | 'manage' };
};

export function createDenClient(options: { baseUrl: string; token?: string | null }) {
  const baseUrls = resolveDenBaseUrls({
    baseUrl: options.baseUrl,
  });
  const token = options.token?.trim() ?? null;

  return {
    /** 卡片只表达定位；打开前按当前组织复核持久事件及原投递目标。 */
    validateDocsCard: (input: { tenantId: string; contractVersion: 1; eventId: string; pageId: string; commentId?: string; kind: string; occurredAt: string; part: "group" | "direct"; conversationId: string }) =>
      requestJson<{ valid: boolean }>(baseUrls, "/api/v1/docs/notifications/validate", { method: "POST", token, organizationId: input.tenantId, body: input }),
    /** 为当前明确组织申请云文档一次性登录交接。 */
    launchCloudDocs: async (input: {
      tenantId: string;
      target: { kind: 'home' | 'page' | 'manage'; pageId?: string; workspaceId?: string; commentId?: string };
      presentation: DenDocsLaunch['presentation'];
    }): Promise<DenDocsLaunch> => {
      const config = await requestJson<{ docs?: { enabled: boolean; publicOrigin: string | null } }>(baseUrls, '/api/runtime-config');
      if (!config.docs?.enabled || !config.docs.publicOrigin) throw new Error('docs_disabled');
      const launch = await requestJson<DenDocsLaunch>(baseUrls, '/api/v1/docs/launch', { method: 'POST', token, body: input });
      return { ...launch, docsOrigin: new URL(config.docs.publicOrigin).origin };
    },
    /** 读取已有运行配置中的 Docs 入口，不申请交接凭据。 */
    docsConfiguration: () => requestJson<{ docs?: { enabled: boolean; publicOrigin: string | null } }>(baseUrls, '/api/runtime-config'),
    /** The resolved deployment origin and its derived `/jwork/api` root. */
    baseUrls,

    async setActiveOrganization(
      input: { organizationId?: string | null; organizationSlug?: string | null },
    ): Promise<{ im: DenIMLoginBootstrap | null } | null> {
      return ensureActiveOrganization(baseUrls, token, input);
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

    async updateProfile(input: { name: string; avatarDataUrl?: string }): Promise<{ user: DenUser; im: DenIMLoginBootstrap | null }> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/me/profile", {
        method: "PATCH",
        token,
        body: {
          name: input.name.trim(),
          ...(input.avatarDataUrl ? { avatarDataUrl: input.avatarDataUrl } : {}),
        },
      });
      const user = getUser(payload);
      if (!user) {
        throw new DenApiError(500, "invalid_profile_payload", "Profile response did not include a user.");
      }
      return { user, im: getIMLoginBootstrap(payload) };
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

    async getMembershipBillingCatalog(orgId: string): Promise<DenMembershipBillingCatalog> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/billing/catalog", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      const catalog = normalizeDenMembershipBillingCatalog(payload);
      if (!catalog) {
        throw new DenApiError(500, "invalid_billing_catalog_payload", "Billing catalog response was invalid.");
      }
      return catalog;
    },

    async createMembershipOrder(
      orgId: string,
      selection: DenMembershipOrderSelection,
      idempotencyKey: string,
    ): Promise<DenMembershipOrder> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/billing/orders", {
        method: "POST",
        token,
        organizationId: orgId,
        idempotencyKey,
        body: selection,
      });
      const order = normalizeDenMembershipOrder(payload);
      const expectedOrganizationId = selection.targetMode === "existing_tenant" ? orgId : null;
      if (!order || order.organizationId !== expectedOrganizationId || order.targetMode !== selection.targetMode ||
        order.plan !== selection.plan || order.period !== selection.period || order.seats !== selection.seats) {
        throw invalidMembershipOrderResponse();
      }
      return order;
    },

    async listMembershipOrders(limit = 50): Promise<DenMembershipOrder[]> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/billing/orders?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}`, {
        method: "GET",
        token,
      });
      if (!isRecord(payload) || !Array.isArray(payload.orders)) {
        throw new DenApiError(500, "invalid_billing_orders_payload", "Billing orders response was invalid.");
      }
      const orders = payload.orders.flatMap((value) => {
        const order = normalizeDenMembershipOrder(value);
        return order ? [order] : [];
      });
      if (orders.length !== payload.orders.length) {
        throw new DenApiError(500, "invalid_billing_orders_payload", "Billing orders response was invalid.");
      }
      return orders;
    },

    async getMembershipOrder(orgId: string, orderId: string, previous: DenMembershipOrder): Promise<DenMembershipOrder> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/billing/orders/${encodeURIComponent(orderId)}`, {
        method: "GET",
        token,
        organizationId: orgId,
      });
      const order = normalizeDenMembershipOrder(payload);
      if (!order || order.id !== orderId || !validMembershipOrderTransition(previous, order)) {
        throw invalidMembershipOrderResponse();
      }
      return order;
    },

    async createMembershipPaymentAttempt(
      orgId: string,
      orderId: string,
      previous: DenMembershipOrder,
    ): Promise<DenMembershipOrder> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/billing/orders/${encodeURIComponent(orderId)}/payment-attempts`, {
        method: "POST",
        token,
        organizationId: orgId,
      });
      const order = normalizeDenMembershipOrder(payload);
      if (!order || order.id !== orderId || !validMembershipOrderTransition(previous, order)) {
        throw invalidMembershipOrderResponse();
      }
      return order;
    },

    async closeMembershipOrder(orgId: string, orderId: string, previous: DenMembershipOrder): Promise<DenMembershipOrder> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/billing/orders/${encodeURIComponent(orderId)}/close`, {
        method: "POST",
        token,
        organizationId: orgId,
      });
      const order = normalizeDenMembershipOrder(payload);
      if (!order || order.id !== orderId || !validMembershipOrderTransition(previous, order)) {
        throw invalidMembershipOrderResponse();
      }
      return order;
    },

    async activatePaidTeamOrganization(
      orderId: string,
      name: string,
      idempotencyKey: string,
    ): Promise<DenOrgSummary> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/billing/orders/${encodeURIComponent(orderId)}/team-organization`, {
        method: "POST",
        token,
        idempotencyKey,
        body: { name },
      });
      const organization = isRecord(payload) ? getOrgSummary(payload.organization) : null;
      if (!organization) {
        throw new DenApiError(500, "invalid_organization_payload", "Organization activation response was invalid.");
      }
      return organization;
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

    async listOrganizationMembers(orgId: string, options: { limit?: number; offset?: number } = {}, requestOptions: { signal?: AbortSignal } = {}): Promise<DenOrganizationMemberPage> {
      const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 200)));
      const offset = Math.max(0, Math.floor(options.offset ?? 0));
      const payload = await requestJson<unknown>(baseUrls, `/v1/members?limit=${limit}&offset=${offset}`, {
        method: "GET", token, organizationId: orgId, signal: requestOptions.signal,
      });
      if (!isRecord(payload) || !Array.isArray(payload.members) || !Number.isSafeInteger(payload.total) || Number(payload.total) < 0 || !Number.isSafeInteger(payload.limit) || Number(payload.limit) < 1 || !Number.isSafeInteger(payload.offset) || Number(payload.offset) < 0) {
        throw new DenApiError(500, "invalid_members_page", "Organization member response was invalid.");
      }
      const members = payload.members.map(normalizeOrganizationMember);
      if (members.some((member) => !member)) throw new DenApiError(500, "invalid_members_page", "Organization member response was invalid.");
      return { members: members as DenOrganizationMember[], total: Number(payload.total), limit: Number(payload.limit), offset: Number(payload.offset) };
    },

    async listProductTasks(orgId: string, options: DenProductTaskListOptions = {}, requestOptions: { signal?: AbortSignal } = {}): Promise<DenProductTaskPage> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/tasks${productTaskQuery(options)}`, {
        method: "GET", token, organizationId: orgId, signal: requestOptions.signal,
      });
      if (!isRecord(payload) || !Array.isArray(payload.items) || typeof payload.nextCursor !== "string") {
        throw new DenApiError(500, "invalid_task_page", "Task page response was invalid.");
      }
      const memberProjectionSupplied = payload.membersByTaskId !== undefined;
      const rawMembersByTaskId = memberProjectionSupplied ? payload.membersByTaskId : {};
      if (!isRecord(rawMembersByTaskId) || Array.isArray(rawMembersByTaskId)) {
        throw new DenApiError(500, "invalid_task_page", "Task page response was invalid.");
      }
      const items = payload.items.map(normalizeProductTask);
      if (items.some((item) => !item)) throw new DenApiError(500, "invalid_task_page", "Task page response was invalid.");
      const membersByTaskId: Record<string, DenProductTaskMember[]> = {};
      const memberProjectionKnownByTaskId: Record<string, boolean> = {};
      for (const task of items as DenProductTask[]) {
        memberProjectionKnownByTaskId[task.id] = memberProjectionSupplied && Object.prototype.hasOwnProperty.call(rawMembersByTaskId, task.id);
        const rawMembers = rawMembersByTaskId[task.id] ?? [];
        if (!Array.isArray(rawMembers)) throw new DenApiError(500, "invalid_task_page", "Task page response was invalid.");
        const members = rawMembers.map(normalizeProductTaskMember);
        if (members.some((member) => !member)) throw new DenApiError(500, "invalid_task_page", "Task page response was invalid.");
        membersByTaskId[task.id] = members as DenProductTaskMember[];
      }
      return { items: items as DenProductTask[], membersByTaskId, memberProjectionKnownByTaskId, nextCursor: payload.nextCursor };
    },

    async listProductTaskLists(orgId: string, options: { archived?: boolean; cursor?: string; limit?: number } = {}, requestOptions: { signal?: AbortSignal } = {}): Promise<DenProductTaskListPage> {
      const params = new URLSearchParams();
      if (options.archived !== undefined) params.set("archived", String(options.archived));
      if (options.cursor) params.set("cursor", options.cursor);
      if (options.limit) params.set("limit", String(options.limit));
      const payload = await requestJson<unknown>(baseUrls, `/v1/task-lists${params.size ? `?${params}` : ""}`, { method: "GET", token, organizationId: orgId, signal: requestOptions.signal });
      if (!isRecord(payload) || !Array.isArray(payload.items) || typeof payload.nextCursor !== "string") throw new DenApiError(500, "invalid_task_list_page", "Task list page response was invalid.");
      const items = payload.items.map(normalizeProductTaskList);
      if (items.some((item) => !item)) throw new DenApiError(500, "invalid_task_list_page", "Task list page response was invalid.");
      return { items: items as DenProductTaskList[], nextCursor: payload.nextCursor };
    },

    async getProductTaskList(orgId: string, listId: string): Promise<DenProductTaskListResult> {
      return normalizeProductTaskListResult(await requestJson<unknown>(baseUrls, `/v1/task-lists/${encodeURIComponent(listId)}`, { method: "GET", token, organizationId: orgId }));
    },

    async createProductTaskList(orgId: string, input: { idempotencyKey: string; name: string; description?: string; marker?: string; visibility?: DenProductTaskVisibility; members?: Array<{ memberId: string; role: "administrator" | "member" }> }): Promise<DenProductTaskListResult> {
      return normalizeProductTaskListResult(await requestJson<unknown>(baseUrls, "/v1/task-lists", { method: "POST", token, organizationId: orgId, body: input }));
    },

    async updateProductTaskList(orgId: string, listId: string, input: { expectedVersion: number; idempotencyKey: string; name?: string; description?: string; marker?: string; visibility?: DenProductTaskVisibility; members?: Array<{ memberId: string; role: "administrator" | "member" }> }): Promise<DenProductTaskListResult> {
      return normalizeProductTaskListResult(await requestJson<unknown>(baseUrls, `/v1/task-lists/${encodeURIComponent(listId)}`, { method: "PATCH", token, organizationId: orgId, body: input }));
    },

    async transitionProductTaskList(orgId: string, listId: string, operation: "archive" | "restore", input: { expectedVersion: number; idempotencyKey: string }): Promise<DenProductTaskListResult> {
      return normalizeProductTaskListResult(await requestJson<unknown>(baseUrls, `/v1/task-lists/${encodeURIComponent(listId)}/${operation}`, { method: "POST", token, organizationId: orgId, body: input }));
    },

    async getProductTask(orgId: string, taskId: string, requestOptions: { signal?: AbortSignal } = {}): Promise<DenProductTaskResult> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: "GET", token, organizationId: orgId, signal: requestOptions.signal,
      });
      return normalizeProductTaskResult(payload);
    },

    async getProductTaskActivity(orgId: string, taskId: string, requestOptions: { signal?: AbortSignal } = {}): Promise<DenProductTaskActivity> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/tasks/${encodeURIComponent(taskId)}/activity`, { method: "GET", token, organizationId: orgId, signal: requestOptions.signal });
      if (!isRecord(payload) || !Array.isArray(payload.comments) || !Array.isArray(payload.events)) throw new DenApiError(500, "invalid_task_activity", "Task activity response was invalid.");
      return payload as DenProductTaskActivity;
    },

    async listProductTaskActivity(orgId: string, options: { cursor?: string; limit?: number; unreadOnly?: boolean } = {}, requestOptions: { signal?: AbortSignal } = {}): Promise<DenProductTaskActivityPage> {
      const params = new URLSearchParams();
      if (options.cursor) params.set("cursor", options.cursor);
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (options.unreadOnly !== undefined) params.set("unreadOnly", String(options.unreadOnly));
      const payload = await requestJson<unknown>(baseUrls, `/v1/task-activity${params.size ? `?${params}` : ""}`, { method: "GET", token, organizationId: orgId, signal: requestOptions.signal });
      return normalizeProductTaskActivityPage(payload);
    },

    async markProductTaskActivityRead(orgId: string, eventId: string): Promise<void> {
      await requestJson<unknown>(baseUrls, `/v1/task-activity/${encodeURIComponent(eventId)}/read`, { method: "PUT", token, organizationId: orgId });
    },

    async markAllProductTaskActivityRead(orgId: string, throughSequence: number): Promise<void> {
      await requestJson<unknown>(baseUrls, "/v1/task-activity/read", { method: "PUT", token, organizationId: orgId, body: { throughSequence } });
    },

    async addProductTaskComment(orgId: string, taskId: string, input: { idempotencyKey: string; body: string }): Promise<void> {
      await requestJson<unknown>(baseUrls, `/v1/tasks/${encodeURIComponent(taskId)}/comments`, { method: "POST", token, organizationId: orgId, body: input });
    },

    async listProductTaskReminders(orgId: string, taskId: string): Promise<DenProductTaskReminder[]> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/tasks/${encodeURIComponent(taskId)}/reminders`, { method: "GET", token, organizationId: orgId });
      if (!isRecord(payload) || !Array.isArray(payload.items)) throw new DenApiError(500, "invalid_task_reminders", "Task reminder response was invalid.");
      return payload.items as DenProductTaskReminder[];
    },

    async listProductTaskNotificationEvents(orgId: string, options: { afterSequence?: number; limit?: number } = {}): Promise<DenProductTaskNotificationPage> {
      const params = new URLSearchParams();
      if (options.afterSequence !== undefined) params.set("afterSequence", String(options.afterSequence));
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      const payload = await requestJson<unknown>(baseUrls, `/v1/task-events${params.size ? `?${params}` : ""}`, { method: "GET", token, organizationId: orgId });
      return normalizeProductTaskNotificationPage(payload);
    },

    async setProductTaskReminder(orgId: string, taskId: string, input: { idempotencyKey: string; mode: "absolute" | "due_relative"; scheduledAt?: string; dueOffsetSeconds?: number; timezone: string }): Promise<void> {
      await requestJson<unknown>(baseUrls, `/v1/tasks/${encodeURIComponent(taskId)}/reminders`, { method: "PUT", token, organizationId: orgId, body: input });
    },

    async cancelProductTaskReminders(orgId: string, taskId: string, idempotencyKey: string): Promise<void> {
      await requestJson<unknown>(baseUrls, `/v1/tasks/${encodeURIComponent(taskId)}/reminders`, { method: "DELETE", token, organizationId: orgId, body: { expectedVersion: 1, idempotencyKey } });
    },

    async createProductTask(orgId: string, input: DenProductTaskCreateInput): Promise<DenProductTaskResult> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/tasks", { method: "POST", token, organizationId: orgId, body: input });
      return normalizeProductTaskResult(payload);
    },

    async updateProductTask(orgId: string, taskId: string, input: DenProductTaskUpdateInput): Promise<DenProductTaskResult> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", token, organizationId: orgId, body: input });
      return normalizeProductTaskResult(payload);
    },

    async moveProductTask(orgId: string, taskId: string, input: DenProductTaskMoveInput): Promise<DenProductTaskMoveResult> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/tasks/${encodeURIComponent(taskId)}/move`, { method: "POST", token, organizationId: orgId, body: input });
      return normalizeProductTaskMoveResult(payload);
    },

    async transitionProductTask(orgId: string, taskId: string, operation: "complete" | "cancel" | "reopen" | "restore", input: { expectedVersion: number; idempotencyKey: string }): Promise<DenProductTaskResult> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/tasks/${encodeURIComponent(taskId)}/${operation}`, { method: "POST", token, organizationId: orgId, body: input });
      return normalizeProductTaskResult(payload);
    },

    async deleteProductTask(orgId: string, taskId: string, input: { expectedVersion: number; idempotencyKey: string }): Promise<DenProductTaskResult> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE", token, organizationId: orgId, body: input });
      return normalizeProductTaskResult(payload);
    },

    async listCalendars(orgId: string, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendar[]> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/calendars", { method: "GET", token, organizationId: orgId, signal: requestOptions.signal });
      if (!isRecord(payload) || !hasExactKeys(payload, ["items"])) invalidCalendarPayload("Calendar list response was invalid.");
      return normalizeCalendarList(payload.items);
    },

    async getCalendar(orgId: string, calendarId: string, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendar> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/calendars/${encodeURIComponent(calendarId)}`, { method: "GET", token, organizationId: orgId, signal: requestOptions.signal });
      if (!isRecord(payload) || !hasExactKeys(payload, ["calendar"])) invalidCalendarPayload("Calendar response was invalid.");
      const calendar = normalizeDenCalendar(payload.calendar);
      if (!calendar) invalidCalendarPayload("Calendar response was invalid.");
      return calendar;
    },

    async createCalendar(orgId: string, input: DenCalendarCreateInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarResult> {
      return normalizeCalendarResult(await requestJson<unknown>(baseUrls, "/v1/calendars", { method: "POST", token, organizationId: orgId, body: input, signal: requestOptions.signal }));
    },

    async listCalendarCollaboration(orgId: string, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarCollaborationList> {
      return normalizeCalendarCollaborationList(await requestJson<unknown>(baseUrls, "/v1/calendar-collaboration/calendars", { method: "GET", token, organizationId: orgId, signal: requestOptions.signal }), orgId);
    },

    async createTeamCalendar(orgId: string, input: DenTeamCalendarCreateInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenTeamCalendarCreateResult> {
      return normalizeTeamCalendarCreateResult(await requestJson<unknown>(baseUrls, "/v1/calendar-collaboration/team-calendars", { method: "POST", token, organizationId: orgId, body: input, signal: requestOptions.signal }), orgId);
    },

    async listTeamCalendarMemberships(orgId: string, calendarId: string, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarMembershipList> {
      return normalizeCalendarMembershipList(await requestJson<unknown>(baseUrls, `/v1/calendar-collaboration/team-calendars/${encodeURIComponent(calendarId)}/memberships`, { method: "GET", token, organizationId: orgId, signal: requestOptions.signal }));
    },

    async putTeamCalendarMembership(orgId: string, calendarId: string, memberId: string, input: DenCalendarMembershipPutInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarMembershipPutResult> {
      return normalizeCalendarMembershipPutResult(await requestJson<unknown>(baseUrls, `/v1/calendar-collaboration/team-calendars/${encodeURIComponent(calendarId)}/memberships/${encodeURIComponent(memberId)}`, { method: "PUT", token, organizationId: orgId, body: input, signal: requestOptions.signal }), memberId);
    },

    async revokeTeamCalendarMembership(orgId: string, calendarId: string, memberId: string, input: DenCalendarMembershipRevokeInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarMembershipRevokeResult> {
      return normalizeCalendarMembershipRevokeResult(await requestJson<unknown>(baseUrls, `/v1/calendar-collaboration/team-calendars/${encodeURIComponent(calendarId)}/memberships/${encodeURIComponent(memberId)}`, { method: "DELETE", token, organizationId: orgId, body: input, signal: requestOptions.signal }));
    },

    async getTeamCalendarSnapshot(orgId: string, calendarId: string, options: Omit<DenCalendarRangeOptions, "calendarIds" | "cursor" | "limit">, requestOptions: { signal?: AbortSignal } = {}): Promise<DenTeamCalendarSnapshot> {
      const query = calendarQuery({ startDate: options.startDate, endDateExclusive: options.endDateExclusive });
      return normalizeTeamCalendarSnapshot(await requestJson<unknown>(baseUrls, `/v1/calendar-collaboration/team-calendars/${encodeURIComponent(calendarId)}/snapshot${query}`, { method: "GET", token, organizationId: orgId, signal: requestOptions.signal }), orgId, calendarId, options);
    },

    async createTeamCalendarEvent(orgId: string, calendarId: string, input: DenTeamCalendarEventCreateInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarEventResult> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/calendar-collaboration/team-calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", token, organizationId: orgId, body: input, signal: requestOptions.signal });
      if (!isRecord(payload) || !hasExactKeys(payload, ["event"])) invalidCalendarPayload("Team calendar event response was invalid.");
      const event = normalizeDenCalendarEvent(payload.event);
      if (!event || event.organizationId !== orgId || event.calendarId !== calendarId) invalidCalendarPayload("Team calendar event response was invalid.");
      return { event, replayed: false };
    },

    async updateTeamCalendarEvent(orgId: string, calendarId: string, eventId: string, input: DenTeamCalendarEventUpdateInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarEventResult> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/calendar-collaboration/team-calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "PATCH", token, organizationId: orgId, body: input, signal: requestOptions.signal });
      if (!isRecord(payload) || !hasExactKeys(payload, ["event"])) invalidCalendarPayload("Team calendar event response was invalid.");
      const event = normalizeDenCalendarEvent(payload.event);
      if (!event || event.id !== eventId || event.organizationId !== orgId || event.calendarId !== calendarId) invalidCalendarPayload("Team calendar event response was invalid.");
      return { event, replayed: false };
    },

    async deleteTeamCalendarEvent(orgId: string, calendarId: string, eventId: string, input: DenTeamCalendarEventDeleteInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarDeleteResult> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/calendar-collaboration/team-calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE", token, organizationId: orgId, body: input, signal: requestOptions.signal });
      if (!isRecord(payload) || !hasExactKeys(payload, ["tombstone"])) invalidCalendarPayload("Team calendar event delete response was invalid.");
      const result = normalizeCalendarDeleteResult({ tombstone: payload.tombstone, replayed: false }, "event");
      if (result.tombstone.entityId !== eventId) invalidCalendarPayload("Team calendar event delete response was invalid.");
      return result;
    },

    async updateCalendar(orgId: string, calendarId: string, input: DenCalendarUpdateInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarResult> {
      return normalizeCalendarResult(await requestJson<unknown>(baseUrls, `/v1/calendars/${encodeURIComponent(calendarId)}`, { method: "PATCH", token, organizationId: orgId, body: input, signal: requestOptions.signal }));
    },

    async deleteCalendar(orgId: string, calendarId: string, input: DenCalendarDeleteInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarDeleteResult> {
      return normalizeCalendarDeleteResult(await requestJson<unknown>(baseUrls, `/v1/calendars/${encodeURIComponent(calendarId)}`, { method: "DELETE", token, organizationId: orgId, body: input, signal: requestOptions.signal }), "calendar");
    },

    async listCalendarEvents(orgId: string, options: DenCalendarRangeOptions, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarEventPage> {
      const query = calendarQuery({ startDate: options.startDate, endDateExclusive: options.endDateExclusive, calendarIds: options.calendarIds, cursor: options.cursor, limit: options.limit });
      return normalizeCalendarEventPage(await requestJson<unknown>(baseUrls, `/v1/calendar-events${query}`, { method: "GET", token, organizationId: orgId, signal: requestOptions.signal }));
    },

    async searchCalendarEvents(orgId: string, options: DenCalendarSearchOptions, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarEventPage> {
      const query = calendarQuery({ q: options.query, calendarIds: options.calendarIds, cursor: options.cursor, limit: options.limit });
      return normalizeCalendarEventPage(await requestJson<unknown>(baseUrls, `/v1/calendar-events/search${query}`, { method: "GET", token, organizationId: orgId, signal: requestOptions.signal }));
    },

    async getCalendarEvent(orgId: string, eventId: string, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarEvent> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/calendar-events/${encodeURIComponent(eventId)}`, { method: "GET", token, organizationId: orgId, signal: requestOptions.signal });
      if (!isRecord(payload) || !hasExactKeys(payload, ["event"])) invalidCalendarPayload("Calendar event response was invalid.");
      const event = normalizeDenCalendarEvent(payload.event);
      if (!event) invalidCalendarPayload("Calendar event response was invalid.");
      return event;
    },

    async createCalendarEvent(orgId: string, input: DenCalendarEventCreateInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarEventResult> {
      return normalizeCalendarEventResult(await requestJson<unknown>(baseUrls, "/v1/calendar-events", { method: "POST", token, organizationId: orgId, body: input, signal: requestOptions.signal }));
    },

    async updateCalendarEvent(orgId: string, eventId: string, input: DenCalendarEventUpdateInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarEventResult> {
      return normalizeCalendarEventResult(await requestJson<unknown>(baseUrls, `/v1/calendar-events/${encodeURIComponent(eventId)}`, { method: "PATCH", token, organizationId: orgId, body: input, signal: requestOptions.signal }));
    },

    async deleteCalendarEvent(orgId: string, eventId: string, input: DenCalendarDeleteInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarDeleteResult> {
      return normalizeCalendarDeleteResult(await requestJson<unknown>(baseUrls, `/v1/calendar-events/${encodeURIComponent(eventId)}`, { method: "DELETE", token, organizationId: orgId, body: input, signal: requestOptions.signal }), "event");
    },

    async getCalendarBootstrap(orgId: string, options: Omit<DenCalendarRangeOptions, "cursor" | "limit">, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarBootstrap> {
      const query = calendarQuery({ startDate: options.startDate, endDateExclusive: options.endDateExclusive, calendarIds: options.calendarIds });
      return normalizeCalendarBootstrap(await requestJson<unknown>(baseUrls, `/v1/calendar/bootstrap${query}`, { method: "GET", token, organizationId: orgId, signal: requestOptions.signal }));
    },

    async getCalendarChanges(orgId: string, cursor: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<DenCalendarChangePage> {
      const query = calendarQuery({ cursor, limit: options.limit });
      return normalizeCalendarChangePage(await requestJson<unknown>(baseUrls, `/v1/calendar/changes${query}`, { method: "GET", token, organizationId: orgId, signal: options.signal }));
    },

    async listCalendarSchedulingEvents(orgId: string, options: DenCalendarSchedulingRange, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarSchedulingOccurrenceList> {
      const query = calendarQuery({ startInstant: options.startInstant, endInstantExclusive: options.endInstantExclusive, timeZone: options.timeZone });
      return normalizeCalendarSchedulingOccurrenceList(await requestJson<unknown>(baseUrls, `/v1/calendar-scheduling/events${query}`, { method: "GET", token, organizationId: orgId, signal: requestOptions.signal }));
    },

    async createCalendarSchedulingEvent(orgId: string, input: DenCalendarSchedulingEventCreateInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarSchedulingEventResult> {
      return normalizeCalendarSchedulingEventResult(await requestJson<unknown>(baseUrls, "/v1/calendar-scheduling/events", { method: "POST", token, organizationId: orgId, body: input, signal: requestOptions.signal }));
    },

    async updateCalendarSchedulingEvent(orgId: string, eventId: string, input: DenCalendarSchedulingEventUpdateInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarSchedulingEventResult> {
      return normalizeCalendarSchedulingEventResult(await requestJson<unknown>(baseUrls, `/v1/calendar-scheduling/events/${encodeURIComponent(eventId)}`, { method: "PATCH", token, organizationId: orgId, body: input, signal: requestOptions.signal }));
    },

    async getCalendarSchedulingAvailability(orgId: string, input: DenCalendarAvailabilityInput, requestOptions: { signal?: AbortSignal } = {}): Promise<DenCalendarAvailability> {
      const availability = normalizeDenCalendarAvailability(await requestJson<unknown>(baseUrls, "/v1/calendar-scheduling/availability", { method: "POST", token, organizationId: orgId, body: input, signal: requestOptions.signal }));
      if (!availability) invalidCalendarSchedulingPayload("Calendar availability response was invalid.");
      return availability;
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

    async rotateOrgLlmProviderGatewayCredential(
      orgId: string,
      llmProviderId: string,
      input: { rejectedCredentialDigest: string; requestId: string },
    ): Promise<DenOrgLlmProviderConnection> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/llm-providers/${encodeURIComponent(llmProviderId)}/gateway-credential/rotate`,
        {
          method: "POST",
          token,
          organizationId: orgId,
          body: input,
        },
      );
      const provider = getDenOrgLlmProviderConnection(payload);
      if (!provider) {
        throw new DenApiError(500, "invalid_llm_provider_payload", "LLM provider rotation response was missing connection details.");
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

    async listOrgPlugins(orgId: string): Promise<DenOrgPlugin[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/plugins?status=active&limit=100`,
        { method: "GET", token, organizationId: orgId },
      );
      if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
      return payload.items.flatMap((item) => {
        const plugin = parseOrgPlugin(item);
        return plugin ? [plugin] : [];
      });
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
