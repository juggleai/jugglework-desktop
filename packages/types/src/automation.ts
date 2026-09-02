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
export type AutomationTriggerSource = "scheduled" | "catchup" | "manual" | "event";
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
  /** 每月可选择多个执行日；`dayOfMonth` 仅用于兼容旧版已保存任务。 */
  | { frequency: "monthly"; dayOfMonths: number[]; dayOfMonth?: number }
  /** 每年可选择多个执行月份，并在这些月份的同一天执行；`month` 仅用于兼容旧版已保存任务。 */
  | { frequency: "yearly"; months: number[]; dayOfMonth: number; month?: number }
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
  /**
   * 连接器来源。
   * TIPS: `github-app` 不代表某个具体连接的凭据，它只标记"这个自动化可以
   * 在运行期向服务端换取一次限时的 GitHub App 写回授权"（见 `add-github-event-trigger-relay`
   * 的运行期授权铸造接口），设备永远不会持有该 App 的 installation token 本身。
   */
  source: "local-mcp" | "cloud" | "directory" | "github-app";
  label: string;
};

/** 事件触发的通用过滤条件；任何事件源都有对应概念，未来接入非 GitHub 事件源时原样复用。 */
export type AutomationEventCommonFilter = {
  labels?: string[];
  authorFilter?: { mode: "allow" | "deny"; logins: string[] };
  mentionText?: string;
  keyword?: string;
};

/** GitHub 专属的过滤条件；git 托管平台特有，不下沉进通用结构。 */
export type AutomationGithubEventFilter = {
  branches?: { base?: string[]; head?: string[] };
  changedPaths?: string[];
};

/** GitHub 支持订阅的事件类型；`issue_comment` 在解析层已按 PR/Issue 语义拆分为独立取值。 */
export type AutomationGithubEventType =
  | "pull_request"
  | "pull_request_review"
  | "pull_request_review_comment"
  | "issues"
  | "issue_comment"
  | "issue_comment_on_pull_request"
  | "push"
  | "release";

export type AutomationGithubEventMatch = {
  event: AutomationGithubEventType;
  actions?: string[];
  common?: AutomationEventCommonFilter;
  github?: AutomationGithubEventFilter;
};

/** 事件投递方式：自动按服务端就绪态选择，或用户手动强制。 */
export type AutomationEventDeliveryMode = "auto" | "im" | "poll";

/**
 * 事件触发的完整配置。
 * TIPS: `entity_ref` 命名空间约定为 `${provider}:${resourceType}:${id}`（如
 * `github:pull_request:482`），由执行侧在处理投递记录时生成，不是这里存储的字段。
 */
export type AutomationEventTrigger = {
  version: 1;
  kind: "event";
  provider: "github";
  connectorId: string;
  repository: { owner: string; name: string };
  matches: AutomationGithubEventMatch[];
  /** 同一实体的防抖窗口（秒），默认 60。 */
  debounceSeconds?: number;
  /** 并发/防抖粒度，默认 "entity"（同一 PR/Issue 编号）。 */
  concurrencyKey: "entity" | "repository" | "none";
  deliveryMode: AutomationEventDeliveryMode;
  /** 每小时触发上限；不设置则不限。 */
  hourlyTriggerCap?: number;
  /**
   * 权限档位。`"auto"` 由设备按仓库可见性解析出的 `inputTrustLevel` 决定；
   * 显式值表示用户已完成升级确认（见 4.3 权限分级）。
   */
  permissionTier: "auto" | AutomationPermissionProfile;
};

/** 自动化的触发方式：定时（既有）或事件（本次新增）。 */
export type AutomationTrigger = AutomationSchedule | AutomationEventTrigger;

/** 判断给定触发配置是否为事件触发。 */
export function isAutomationEventTrigger(trigger: AutomationTrigger): trigger is AutomationEventTrigger {
  return trigger.kind === "event";
}

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
 *
 * TIPS: `trigger` 取代了早期版本里的 `schedule` 字段，现在是
 * `AutomationSchedule | AutomationEventTrigger` 的联合类型。旧版本只写过
 * `schedule` 的已持久化记录，在读取时由仓储层做一次性归一化补上 `trigger`
 * （见 `apps/server/src/automation/repository.ts` 的 `normalizeStoredAutomationDefinition`），
 * 这里的类型定义本身不再声明 `schedule` 作为一等字段。
 */
export type AutomationDefinition = {
  schema: typeof AUTOMATION_DEFINITION_SCHEMA;
  id: string;
  name: string;
  workspace: AutomationWorkspaceSnapshot;
  prompt: AutomationPromptTemplate;
  trigger: AutomationTrigger;
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
  trigger?: AutomationTrigger;
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
  /**
   * 事件触发运行的展示态元数据；只有 `triggerSource === "event"` 时才有意义。
   * TIPS: `entityRef` 命名空间约定为 `${provider}:${resourceType}:${id}`（如 `github:pull_request:482`）。
   */
  eventMetadata?: {
    entityRef?: string;
    sourceDeliveryId?: string;
    /** 防抖窗口内被合并掉的事件数量，见桌面 PRD 4.4。 */
    mergedEventCount?: number;
    /** 归属会话不可解析、已回退新建会话时置真，见桌面 PRD 4.8 exception。 */
    previousSessionUnavailable?: boolean;
    /** 离线补投丢弃的事件数量与覆盖时间范围，见桌面 PRD 4.5。 */
    backlogDropped?: { count: number; sinceAt: number; untilAt: number };
  };
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
  | "invalid_event_trigger"
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
  | "sync_unavailable"
  /** 事件补投窗口耗尽，事件被丢弃且不可追溯执行（见事件触发 PRD 4.5）。 */
  | "event_backlog_dropped"
  /** 触发频率超过用户设置的每小时上限（见事件触发 PRD 4.7）。 */
  | "rate_limited"
  /**
   * 会话归属所依赖的上游连接器/仓库绑定被收回（解绑、卸载、转移），
   * 与 `session_lost`（本地会话本身不可解析）刻意区分，因为排查和处理动作不同。
   */
  | "upstream_connector_revoked";

export type AutomationListResponse = {
  items: AutomationDefinitionRecord[];
  nextCursor?: string;
};

export type AutomationRunListResponse = {
  items: AutomationRun[];
  nextCursor?: string;
};
