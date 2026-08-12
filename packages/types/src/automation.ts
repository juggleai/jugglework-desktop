/** 自动化任务定义文档的当前版本。 */
export const AUTOMATION_DEFINITION_SCHEMA = "automation-definition/v1" as const;

/** 自动化运行详情文档的当前版本。 */
export const AUTOMATION_RUN_SCHEMA = "automation-run/v1" as const;

/** 无人值守完整访问权限配置版本。 */
export const AUTOMATION_PERMISSION_PROFILE = "unattended-full-access-v1" as const;

/**
 * 交互式默认权限配置版本。
 *
 * TIPS: 该模式下敏感操作仍需用户确认，无人值守时会停在等待状态，只适合本地调试或人工监管，
 * 因此不是默认值——默认仍是完整访问。
 */
export const AUTOMATION_DEFAULT_PERMISSION_PROFILE = "interactive-default-v1" as const;

export type AutomationPermissionProfile =
  | typeof AUTOMATION_PERMISSION_PROFILE
  | typeof AUTOMATION_DEFAULT_PERMISSION_PROFILE;

/** 判断权限模式是否为当前客户端与服务端都识别的版本。 */
export function isAutomationPermissionProfile(value: unknown): value is AutomationPermissionProfile {
  return value === AUTOMATION_PERMISSION_PROFILE || value === AUTOMATION_DEFAULT_PERMISSION_PROFILE;
}

export type AutomationCompatibility = "compatible" | "incompatible-read-only";
export type AutomationSyncState = "pending" | "synced" | "error" | "incompatible-read-only";
export type AutomationLifecycle = "enabled" | "paused" | "completed" | "tombstoned";
export type AutomationTriggerSource = "scheduled" | "catchup" | "manual";
export type AutomationRunState = "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export type AutomationActiveRange = {
  startDate: string;
  endDate: string;
};

export type AutomationOnceSchedule = {
  version: 1;
  kind: "once";
  timezone: string;
  localDate: string;
  localTime: string;
};

export type AutomationIntervalSchedule = {
  version: 1;
  kind: "interval";
  timezone: string;
  every: number;
  unit: "minute" | "hour" | "day";
  anchorLocalDate: string;
  anchorLocalTime: string;
  /** 仅在选中的星期（1=周一 … 7=周日）触发；留空或省略表示不限制。 */
  weekdays?: number[];
};

export type AutomationCalendarSchedule = {
  version: 1;
  kind: "calendar";
  timezone: string;
  localTime: string;
} & (
  | { frequency: "daily" }
  | { frequency: "weekly"; weekdays: number[] }
  | { frequency: "monthly"; dayOfMonth: number }
  | { frequency: "yearly"; month: number; dayOfMonth: number }
);

/** 客户端和 Embedded Server 共同识别的版本化调度联合类型。 */
export type AutomationSchedule = AutomationOnceSchedule | AutomationIntervalSchedule | AutomationCalendarSchedule;

export type AutomationTextPromptPart = {
  type: "text";
  text: string;
};

export type AutomationFilePromptPart = {
  type: "file";
  relativePath: string;
  label?: string;
};

export type AutomationSkillPromptPart = {
  type: "skill";
  skillId: string;
  label?: string;
};

export type AutomationPromptPart = AutomationTextPromptPart | AutomationFilePromptPart | AutomationSkillPromptPart;

export type AutomationPromptTemplate = {
  version: 1;
  parts: AutomationPromptPart[];
};

export type AutomationModelSelection =
  | { mode: "auto" }
  | { mode: "explicit"; providerId: string; modelId: string; variant?: string };

export type AutomationConnectorSelection = {
  id: string;
  source: "local-mcp" | "cloud" | "directory";
  label: string;
};

export type AutomationWorkspaceSnapshot = {
  id: string;
  name: string;
  path: string;
  workspaceType: "local";
};

export type AutomationPermissionAcknowledgement = {
  profile: AutomationPermissionProfile;
  acknowledgedAt: number;
};

/**
 * Desktop 拥有的完整自动化任务定义。
 *
 * `extensions` 用于保留当前客户端尚未理解的增量字段；服务端同步时仍以
 * `rawDocument` 的精确字节为准，不能通过闭合 DTO 重写未知字段。
 */
export type AutomationDefinition = {
  schema: typeof AUTOMATION_DEFINITION_SCHEMA;
  id: string;
  name: string;
  workspace: AutomationWorkspaceSnapshot;
  prompt: AutomationPromptTemplate;
  schedule: AutomationSchedule;
  activeRange?: AutomationActiveRange;
  model: AutomationModelSelection;
  agentId?: string;
  skillIds: string[];
  connectors: AutomationConnectorSelection[];
  permission: AutomationPermissionAcknowledgement;
  lifecycle: Exclude<AutomationLifecycle, "tombstoned">;
  executorDeviceId: string;
  revision: number;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  extensions?: Record<string, unknown>;
};

/** 创建或编辑页面使用的未持久化草稿。 */
export type AutomationDraft = {
  name: string;
  workspace?: AutomationWorkspaceSnapshot;
  prompt: AutomationPromptTemplate;
  timezone: string;
  schedule?: AutomationSchedule;
  activeRange?: AutomationActiveRange;
  model: AutomationModelSelection;
  agentId?: string;
  skillIds: string[];
  connectors: AutomationConnectorSelection[];
  permission?: AutomationPermissionAcknowledgement;
  lifecycle: "enabled" | "paused";
  executorDeviceId: string;
  extensions?: Record<string, unknown>;
};

export type AutomationDefinitionRecord = {
  definition: AutomationDefinition;
  compatibility: AutomationCompatibility;
  syncState: AutomationSyncState;
  syncErrorCode?: AutomationErrorCode;
  rawDocument: Record<string, unknown>;
  deletedAt?: number;
};

export type AutomationRun = {
  schema: typeof AUTOMATION_RUN_SCHEMA;
  id: string;
  automationId: string;
  automationName: string;
  definitionRevision: number;
  triggerSource: AutomationTriggerSource;
  state: AutomationRunState;
  scheduledFor: number;
  workspaceId: string;
  workspaceName: string;
  sessionId?: string;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  concreteModel?: { providerId: string; modelId: string; variant?: string };
  agentId?: string;
  connectorIds: string[];
  errorCode?: AutomationErrorCode;
  errorMessage?: string;
  revision: number;
  syncState: AutomationSyncState;
};

export type AutomationProjection = {
  kind: string;
  version: number;
  mediaType: string;
  payloadBase64: string;
  digest: string;
};

export type AutomationStableEnvelope = {
  envelopeVersion: 1;
  documentSchema: string;
  documentMediaType: "application/json";
  documentBase64: string;
  documentDigest: string;
  projections: AutomationProjection[];
};

export type AutomationSyncMutation = {
  id: string;
  mutationId: string;
  entityType: "definition" | "run";
  entityId: string;
  localRevision: number;
  operation: "upsert" | "delete";
  payloadVersion: 1;
  payload: AutomationStableEnvelope | { baseRevision: number };
  attempts: number;
  nextAttemptAt: number;
  lastErrorCode?: AutomationErrorCode;
  createdAt: number;
};

export type AutomationErrorCode =
  | "automation_not_found"
  | "automation_revision_conflict"
  | "automation_read_only"
  | "invalid_automation_definition"
  | "invalid_schedule"
  | "workspace_unavailable"
  | "model_unavailable"
  | "agent_unavailable"
  | "skill_unavailable"
  | "file_unavailable"
  | "connector_unavailable"
  | "connector_reauth_required"
  | "connector_scope_unavailable"
  | "automation_projection_unsupported"
  | "overlap_blocked"
  | "missed_deadline"
  | "session_lost"
  | "execution_failed"
  | "sync_conflict"
  | "sync_unavailable";

export type AutomationListResponse = {
  items: AutomationDefinitionRecord[];
  nextCursor?: string;
};

export type AutomationRunListResponse = {
  items: AutomationRun[];
  nextCursor?: string;
};
