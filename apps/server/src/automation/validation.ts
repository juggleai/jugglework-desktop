import { isAbsolute, normalize, sep } from "node:path";
import {
  AUTOMATION_DEFINITION_SCHEMA,
  isAutomationPermissionProfile,
  type AutomationDefinition,
  type AutomationDraft,
  type AutomationPromptPart,
  type AutomationSchedule,
  type AutomationWorkspaceSnapshot,
} from "@jugglework/types/automation";
import { ApiError } from "../errors.js";
import { nextAutomationOccurrence } from "./schedule.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SENSITIVE_KEY_PATTERN = /(^|_)(authorization|credential|password|secret|access.?token|refresh.?token|api.?key)($|_)/i;
const SCHEDULE_KEYS = new Set([
  "version", "kind", "timezone", "localDate", "localTime", "every", "unit",
  "anchorLocalDate", "anchorLocalTime", "frequency", "weekdays", "dayOfMonth", "month",
]);

export type AutomationValidationContext = {
  now: number;
  workspaces: Array<{ id: string; name: string; path: string; workspaceType: "local" | "remote" }>;
};

/** 返回创建页默认草稿；不会生成持久化任务或权限确认。 */
export function createAutomationDraftDefaults(executorDeviceId: string): AutomationDraft {
  return {
    name: "",
    prompt: { version: 1, parts: [] },
    timezone: systemAutomationTimezone(),
    model: { mode: "auto" },
    skillIds: [],
    connectors: [],
    lifecycle: "enabled",
    executorDeviceId: executorDeviceId.trim(),
  };
}

/** 将不可信 HTTP 输入整理为可继续执行严格校验的草稿结构。 */
export function automationDraftFromUnknown(value: unknown, executorDeviceId: string): AutomationDraft {
  if (!isRecord(value)) invalid("draft", "自动化任务内容必须是对象");
  rejectCredentialShapedProperties(value);
  const defaults = createAutomationDraftDefaults(executorDeviceId);
  return {
    name: typeof value.name === "string" ? value.name : "",
    ...(isRecord(value.workspace) ? { workspace: value.workspace as AutomationWorkspaceSnapshot } : {}),
    prompt: isRecord(value.prompt) && Array.isArray(value.prompt.parts)
      ? value.prompt as AutomationDraft["prompt"]
      : defaults.prompt,
    timezone: typeof value.timezone === "string"
      ? value.timezone
      : isRecord(value.schedule) && typeof value.schedule.timezone === "string"
        ? value.schedule.timezone
        : defaults.timezone,
    ...(isRecord(value.schedule) ? { schedule: value.schedule as AutomationSchedule } : {}),
    ...(isRecord(value.activeRange) ? { activeRange: value.activeRange as AutomationDraft["activeRange"] } : {}),
    model: isRecord(value.model) ? value.model as AutomationDraft["model"] : defaults.model,
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    skillIds: Array.isArray(value.skillIds) ? value.skillIds as string[] : defaults.skillIds,
    connectors: Array.isArray(value.connectors) ? value.connectors as AutomationDraft["connectors"] : defaults.connectors,
    ...(isRecord(value.permission) ? { permission: value.permission as AutomationDraft["permission"] } : {}),
    lifecycle: value.lifecycle === "paused" ? "paused" : "enabled",
    executorDeviceId: typeof value.executorDeviceId === "string" ? value.executorDeviceId : executorDeviceId,
    ...(isRecord(value.extensions) ? { extensions: value.extensions } : {}),
  };
}

/** 返回当前系统 IANA 时区；无法解析时使用稳定的 UTC。 */
export function systemAutomationTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone && isIanaTimezone(timezone) ? timezone : "UTC";
}

/**
 * 校验并规范化自动化草稿。
 * @param draft 用户提交的自动化草稿
 * @param context 当前时间和可选工作空间清单
 * @param identity 服务端生成或已存在的任务身份与版本
 */
export function validateAutomationDraft(
  draft: AutomationDraft,
  context: AutomationValidationContext,
  identity: { id: string; revision: number; createdAt: number },
): AutomationDefinition {
  rejectCredentialShapedProperties(draft);
  const name = draft.name.trim();
  const nameLength = [...name].length;
  if (nameLength < 1 || nameLength > 100) {
    invalid("name", "名称必须为 1–100 个字符");
  }

  const workspace = validateWorkspace(draft.workspace, context.workspaces);
  const prompt = validatePrompt(draft.prompt);
  if (!isIanaTimezone(draft.timezone)) invalid("timezone", "请选择有效的 IANA 时区");
  const schedule = validateAutomationSchedule(draft.schedule ? { ...draft.schedule, timezone: draft.timezone } : undefined);
  const activeRange = validateAutomationActiveRange(draft.activeRange);
  let nextRunAt: number | null;
  try {
    nextRunAt = nextAutomationOccurrence(schedule, activeRange, context.now);
  } catch {
    invalid("schedule", "无法计算下一次执行时间");
  }
  if (schedule.kind === "once" && nextRunAt === null) {
    invalid("schedule.localDate", "单次任务的执行时间必须晚于保存时间并处于生效区间内");
  }
  if (activeRange && nextRunAt === null) {
    invalid("activeRange", "当前频率在生效日期区间内没有可执行时间");
  }
  if (!draft.executorDeviceId.trim()) invalid("executorDeviceId", "执行设备不能为空");

  if (!draft.permission || !isAutomationPermissionProfile(draft.permission.profile) || !isPositiveInteger(draft.permission.acknowledgedAt)) {
    invalid("permission", "必须选择并确认当前权限模式");
  }
  if (draft.permission.acknowledgedAt > context.now + 60_000) {
    invalid("permission.acknowledgedAt", "权限确认时间无效");
  }

  const model = normalizeModel(draft.model);
  const agentId = optionalIdentifier(draft.agentId, "agentId");
  const skillIds = uniqueIdentifiers(draft.skillIds, "skillIds");
  const connectors = normalizeConnectors(draft.connectors);

  return {
    schema: AUTOMATION_DEFINITION_SCHEMA,
    id: identity.id,
    name,
    workspace,
    prompt,
    schedule,
    ...(activeRange ? { activeRange } : {}),
    model,
    ...(agentId ? { agentId } : {}),
    skillIds,
    connectors,
    permission: draft.permission,
    lifecycle: draft.lifecycle === "paused" ? "paused" : "enabled",
    executorDeviceId: draft.executorDeviceId.trim(),
    revision: identity.revision,
    nextRunAt: draft.lifecycle === "paused" ? null : nextRunAt,
    createdAt: identity.createdAt,
    updatedAt: context.now,
    ...(draft.extensions ? { extensions: structuredClone(draft.extensions) } : {}),
  };
}

/** 将规范化定义合并回原始文档，同时保留当前客户端未知的顶层扩展字段。 */
export function mergeAutomationRawDocument(
  rawDocument: Record<string, unknown> | undefined,
  definition: AutomationDefinition,
): Record<string, unknown> {
  const raw = rawDocument ?? {};
  const rawSchedule = isRecord(raw.schedule) ? raw.schedule : {};
  const unknownSchedule = Object.fromEntries(Object.entries(rawSchedule).filter(([key]) => !SCHEDULE_KEYS.has(key)));
  return {
    ...raw,
    ...definition,
    workspace: preserveUnknownObject(raw.workspace, definition.workspace, new Set(["id", "name", "path", "workspaceType"])),
    prompt: preserveUnknownObject(raw.prompt, definition.prompt, new Set(["version", "parts"])),
    schedule: { ...unknownSchedule, ...definition.schedule },
    model: preserveUnknownObject(raw.model, definition.model, new Set(["mode", "providerId", "modelId", "variant"])),
    permission: preserveUnknownObject(raw.permission, definition.permission, new Set(["profile", "acknowledgedAt"])),
  };
}

function validateWorkspace(
  workspace: AutomationWorkspaceSnapshot | undefined,
  inventory: AutomationValidationContext["workspaces"],
): AutomationWorkspaceSnapshot {
  if (!workspace?.id.trim()) invalid("workspace", "请选择一个本地工作空间");
  const current = inventory.find((item) => item.id === workspace.id);
  if (!current) invalid("workspace", "工作空间不存在");
  if (current.workspaceType !== "local") invalid("workspace", "自动化任务仅支持本机工作空间");
  return { id: current.id, name: current.name, path: current.path, workspaceType: "local" };
}

function validatePrompt(prompt: AutomationDraft["prompt"]): AutomationDraft["prompt"] {
  if (prompt.version !== 1 || !Array.isArray(prompt.parts)) invalid("prompt", "提示词格式无效");
  const parts = prompt.parts.map(normalizePromptPart);
  if (!parts.some((part) => part.type !== "text" || part.text.trim())) {
    invalid("prompt", "提示词不能为空");
  }
  return { version: 1, parts };
}

function normalizePromptPart(part: AutomationPromptPart): AutomationPromptPart {
  if (!isRecord(part)) invalid("prompt.parts", "提示词包含无效内容");
  if (part.type === "text") {
    if (typeof part.text !== "string") invalid("prompt.parts", "文本内容无效");
    return { type: "text", text: part.text };
  }
  if (part.type === "file") {
    const relativePath = normalizeRelativePath(part.relativePath);
    return { type: "file", relativePath, ...(part.label?.trim() ? { label: part.label.trim() } : {}) };
  }
  if (part.type === "skill") {
    const skillId = requiredIdentifier(part.skillId, "prompt.parts.skillId");
    return { type: "skill", skillId, ...(part.label?.trim() ? { label: part.label.trim() } : {}) };
  }
  invalid("prompt.parts", "剪贴板、临时附件和即时命令不能用于自动化任务");
}

/** 校验并移除当前频率模式不使用的调度字段。 */
export function validateAutomationSchedule(schedule: AutomationSchedule | undefined): AutomationSchedule {
  if (!schedule || schedule.version !== 1 || !isIanaTimezone(schedule.timezone)) {
    invalid("schedule", "请选择有效的 IANA 时区和执行频率");
  }
  if (schedule.kind === "once") {
    requireDate(schedule.localDate, "schedule.localDate");
    requireTime(schedule.localTime, "schedule.localTime");
    return { ...schedule };
  }
  if (schedule.kind === "interval") {
    if (!isPositiveInteger(schedule.every)) invalid("schedule.every", "间隔必须为正整数");
    if (!(["minute", "hour", "day"] as const).includes(schedule.unit)) invalid("schedule.unit", "间隔单位无效");
    requireDate(schedule.anchorLocalDate, "schedule.anchorLocalDate");
    requireTime(schedule.anchorLocalTime, "schedule.anchorLocalTime");
    // TIPS:按间隔任务的星期限制是可选的，去重排序后写回；空数组等价于不限制，直接删除该字段避免脏数据同步到云端。
    const weekdays = [...new Set(schedule.weekdays ?? [])].sort((a, b) => a - b);
    if (weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      invalid("schedule.weekdays", "星期限制必须为 1–7 的整数");
    }
    const { weekdays: _ignored, ...rest } = schedule;
    return weekdays.length && weekdays.length < 7 ? { ...rest, weekdays } : { ...rest };
  }
  if (schedule.kind !== "calendar") invalid("schedule.kind", "执行频率类型无效");
  requireTime(schedule.localTime, "schedule.localTime");
  if (schedule.frequency === "daily") return { ...schedule };
  if (schedule.frequency === "weekly") {
    const weekdays = [...new Set(schedule.weekdays)].sort((a, b) => a - b);
    if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      invalid("schedule.weekdays", "每周任务至少选择一个有效星期");
    }
    return { ...schedule, weekdays };
  }
  if (schedule.frequency === "monthly") {
    requireRange(schedule.dayOfMonth, 1, 31, "schedule.dayOfMonth");
    return { ...schedule };
  }
  if (schedule.frequency === "yearly") {
    requireRange(schedule.month, 1, 12, "schedule.month");
    requireRange(schedule.dayOfMonth, 1, 31, "schedule.dayOfMonth");
    return { ...schedule };
  }
  invalid("schedule.frequency", "周期频率无效");
}

/** 校验可选的闭区间生效日期。 */
export function validateAutomationActiveRange(range: AutomationDraft["activeRange"]): AutomationDraft["activeRange"] {
  if (!range) return undefined;
  requireDate(range.startDate, "activeRange.startDate");
  requireDate(range.endDate, "activeRange.endDate");
  if (range.endDate < range.startDate) invalid("activeRange", "生效结束日期不能早于开始日期");
  return { startDate: range.startDate, endDate: range.endDate };
}

function normalizeModel(model: AutomationDraft["model"]): AutomationDraft["model"] {
  if (model.mode === "auto") return { mode: "auto" };
  if (model.mode !== "explicit") invalid("model", "模型选择无效");
  const providerId = requiredIdentifier(model.providerId, "model.providerId");
  const modelId = requiredIdentifier(model.modelId, "model.modelId");
  const variant = optionalIdentifier(model.variant, "model.variant");
  return { mode: "explicit", providerId, modelId, ...(variant ? { variant } : {}) };
}

function normalizeConnectors(connectors: AutomationDraft["connectors"]): AutomationDraft["connectors"] {
  if (!Array.isArray(connectors)) invalid("connectors", "连接器必须为数组");
  const seen = new Set<string>();
  return connectors.map((connector) => {
    const id = requiredIdentifier(connector.id, "connectors.id");
    if (seen.has(id)) invalid("connectors", "连接器不能重复选择");
    seen.add(id);
    if (!(["local-mcp", "cloud", "directory"] as const).includes(connector.source)) {
      invalid("connectors.source", "连接器来源无效");
    }
    return { id, source: connector.source, label: connector.label.trim() || id };
  });
}

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.startsWith("blob:") || value.startsWith("data:")) {
    invalid("prompt.parts.relativePath", "文件引用必须是可持久化的工作空间相对路径");
  }
  const candidate = value.trim().replaceAll("\\", "/");
  if (isAbsolute(candidate) || candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate)) {
    invalid("prompt.parts.relativePath", "不能引用工作空间外部绝对路径");
  }
  const normalized = normalize(candidate).split(sep).join("/");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    invalid("prompt.parts.relativePath", "文件引用不能离开工作空间");
  }
  return normalized.replace(/^\.\//, "");
}

function requireDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) invalid(field, "日期格式必须为 YYYY-MM-DD");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    invalid(field, "日期不存在");
  }
}

function requireTime(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) invalid(field, "时间格式必须为 HH:mm");
}

function isIanaTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 256) invalid(field, "标识无效");
  return value.trim();
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredIdentifier(value, field);
}

function uniqueIdentifiers(values: unknown, field: string): string[] {
  if (!Array.isArray(values)) invalid(field, "字段必须为数组");
  const normalized = values.map((value) => requiredIdentifier(value, field));
  if (new Set(normalized).size !== normalized.length) invalid(field, "字段不能包含重复值");
  return normalized;
}

function rejectCredentialShapedProperties(value: unknown, path = "draft", seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) invalid(path, "字段不能包含循环引用");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectCredentialShapedProperties(item, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) invalid(`${path}.${key}`, "自动化定义不能保存凭据或令牌");
    rejectCredentialShapedProperties(child, `${path}.${key}`, seen);
  }
}

function preserveUnknownObject(raw: unknown, current: object, known: Set<string>): Record<string, unknown> {
  const unknown = isRecord(raw)
    ? Object.fromEntries(Object.entries(raw).filter(([key]) => !known.has(key)))
    : {};
  return { ...unknown, ...current };
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function requireRange(value: unknown, min: number, max: number, field: string): void {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    invalid(field, `数值必须为 ${min}–${max} 的整数`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: string, message: string): never {
  throw new ApiError(400, "invalid_automation_definition", message, { field });
}
