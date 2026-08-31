import type { UIMessage } from "ai";

import type { JuggleWorkSessionMessage } from "@/app/lib/jugglework-server";
import type { ModelRef } from "@/app/types";
import {
  SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX,
} from "@/app/types";

type ContextLimitProvider = {
  id: string;
  models?: Record<string, {
    limit?: { context?: number };
  }>;
};

type ServerContextLimitProvider = {
  id: string;
  providerId?: string;
  models?: Array<{
    id: string;
    config?: Record<string, unknown>;
  }>;
};

export type ContextTokenBreakdown = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ContextMeasurementSource =
  | "estimated"
  | "streaming-estimate"
  | "provider-reported"
  | "post-compaction-estimate";

export type ContextProviderCall = {
  tokens: ContextTokenBreakdown;
  used: number;
  providerID: string;
  modelID: string;
  messageID: string;
  interrupted: boolean;
};

export type ContextUsageDetails = {
  currentUsed: number;
  currentSource: ContextMeasurementSource;
  currentTokens: ContextTokenBreakdown | null;
  contextLimit: number;
  percentage: number | null;
  latestCall: ContextProviderCall | null;
  session: ContextTokenBreakdown;
  sessionCalls: number;
  sessionCost: number;
  optionalFields: {
    reasoning: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
  };
  sessionOptionalFields: {
    reasoning: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
  };
};

const EMPTY_TOKENS: ContextTokenBreakdown = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const MESSAGE_OVERHEAD_TOKENS = 4;
const PART_OVERHEAD_TOKENS = 2;

function normalizeTokens(tokens: {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}): ContextTokenBreakdown {
  return {
    input: Math.max(0, tokens.input || 0),
    output: Math.max(0, tokens.output || 0),
    reasoning: Math.max(0, tokens.reasoning || 0),
    cacheRead: Math.max(0, tokens.cache.read || 0),
    cacheWrite: Math.max(0, tokens.cache.write || 0),
  };
}

function addTokens(left: ContextTokenBreakdown, right: ContextTokenBreakdown): ContextTokenBreakdown {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  };
}

function contextTotal(tokens: ContextTokenBreakdown) {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

function hasMeasuredTokens(tokens: ContextTokenBreakdown) {
  return contextTotal(tokens) > 0 || tokens.reasoning > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeJson(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * 使用轻量、与模型无关的启发式算法估算文本 token 数。
 * @param text 需要估算的文本
 * @returns 估算 token 数；空文本返回 0
 */
export function estimateTextTokens(text: string) {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (/\s/u.test(character)) {
      ascii += 0.25;
    } else if (character.codePointAt(0)! <= 0x7f) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

function estimatePartTokens(part: UIMessage["parts"][number]) {
  if (part.type === "text" || part.type === "reasoning") {
    const content = estimateTextTokens(part.text);
    return content > 0 ? content + PART_OVERHEAD_TOKENS : 0;
  }
  if (part.type === "file") {
    const content = estimateTextTokens([part.filename, part.mediaType].filter(Boolean).join(" "));
    return content > 0 ? content + PART_OVERHEAD_TOKENS : 0;
  }
  if (part.type === "source-url" || part.type === "source-document") {
    const content = estimateTextTokens([
      "title" in part ? part.title : "",
      "filename" in part ? part.filename : "",
    ].filter(Boolean).join(" "));
    return content > 0 ? content + PART_OVERHEAD_TOKENS : 0;
  }
  if (part.type === "dynamic-tool") {
    const content = estimateTextTokens([
      part.toolName,
      safeJson(part.input),
      "output" in part ? safeJson(part.output) : "",
      "errorText" in part ? part.errorText : "",
    ].filter(Boolean).join("\n"));
    return content > 0 ? content + PART_OVERHEAD_TOKENS : 0;
  }
  return 0;
}

function isSyntheticMessage(message: UIMessage) {
  return message.id.startsWith(SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX) ||
    message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX);
}

function completedCompactionBoundary(messages: UIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = asRecord(messages[index]?.metadata);
    const opencode = asRecord(metadata?.opencode);
    if (opencode?.summary !== true) continue;
    if (typeof opencode.completed === "number" && Number.isFinite(opencode.completed)) return index;
  }
  return -1;
}

function messageIsCompletedCompaction(message: UIMessage | undefined) {
  if (!message) return false;
  const metadata = asRecord(message.metadata);
  const opencode = asRecord(metadata?.opencode);
  return opencode?.summary === true && typeof opencode.completed === "number" && Number.isFinite(opencode.completed);
}

function messageHasStreamingContent(message: UIMessage | undefined) {
  if (!message) return false;
  return message.parts.some((part) =>
    "state" in part && (
      part.state === "streaming" ||
      part.state === "input-streaming" ||
      part.state === "input-available" ||
      part.state === "output-available"
    )
  );
}

function estimateMessages(messages: UIMessage[], startIndex: number) {
  let total = 0;
  for (let index = Math.max(0, startIndex); index < messages.length; index += 1) {
    const message = messages[index]!;
    if (isSyntheticMessage(message)) continue;
    const partTokens = message.parts.reduce((sum, part) => sum + estimatePartTokens(part), 0);
    if (partTokens > 0) total += MESSAGE_OVERHEAD_TOKENS + partTokens;
  }
  return total;
}

/**
 * 从引擎最终生效的模型配置中读取服务端下发的上下文窗口上限。
 * @param model 当前选择的模型；未选择模型时返回 0
 * @param providers OpenCode 当前工作区可见的提供商列表
 * @param serverProviders Den 下发的提供商配置，仅在引擎目录缺少上限时兜底
 * @returns 上下文 token 上限；字段缺失或数值无效时返回 0
 */
export function resolveModelContextLimit(
  model: ModelRef | null,
  providers: ContextLimitProvider[],
  serverProviders: ServerContextLimitProvider[] = [],
) {
  if (!model) return 0;
  const engineLimit = providers
    .find((provider) => provider.id === model.providerID)
    ?.models?.[model.modelID]
    ?.limit?.context;
  if (typeof engineLimit === "number" && Number.isFinite(engineLimit) && engineLimit > 0) {
    return engineLimit;
  }

  // TIPS: 云端 Provider 刚同步或引擎尚未刷新时，Provider List 可能暂时缺少 limit。
  // 直接使用 Den 已下发的模型配置兜底，但始终让引擎值优先，以保留网关路由修正后的真实上限。
  const serverConfig = serverProviders
    .find((provider) =>
      provider.id === model.providerID || provider.providerId === model.providerID
    )
    ?.models?.find((candidate) => candidate.id === model.modelID)
    ?.config;
  const rawLimit = serverConfig?.limit;
  const serverLimit = rawLimit && typeof rawLimit === "object" && !Array.isArray(rawLimit)
    ? (rawLimit as Record<string, unknown>).context
    : undefined;
  return typeof serverLimit === "number" && Number.isFinite(serverLimit) && serverLimit > 0
    ? serverLimit
    : 0;
}

/**
 * 结合已加载的 Provider 计量和实时 Transcript，计算当前上下文与诊断数据。
 * @param messages 当前会话快照中的原始消息，用于读取 Provider 最终计量
 * @param transcript 已合并快照与实时事件的会话消息，用于本地估算
 * @param model 当前选择的模型
 * @param contextLimit 当前模型的上下文窗口上限
 * @param streaming 当前会话是否仍在运行
 * @returns 可直接用于上下文入口与明细弹窗的数据
 */
export function deriveContextUsage(
  messages: JuggleWorkSessionMessage[],
  transcript: UIMessage[],
  model: ModelRef,
  contextLimit: number,
  streaming = false,
): ContextUsageDetails {
  let latestCall: ContextProviderCall | null = null;
  let session = EMPTY_TOKENS;
  let sessionCalls = 0;
  let sessionCost = 0;
  let reasoningAvailable = false;
  let cacheReadAvailable = false;
  let cacheWriteAvailable = false;
  const optionalFieldsByModel = new Map<string, { reasoning: boolean; cacheRead: boolean; cacheWrite: boolean }>();

  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    sessionCost += Math.max(0, message.info.cost || 0);
    const steps = message.parts.filter((part) => part.type === "step-finish");
    const samples = steps.length > 0
      ? steps.map((part) => ({ tokens: part.tokens, finishReason: part.reason }))
      : [{ tokens: message.info.tokens, finishReason: message.info.finish }];
    for (const sample of samples) {
      const normalized = normalizeTokens(sample.tokens);
      // TIPS: Provider 在工具循环异常退出时可能追加 reason=unknown 的零 token step。
      // 它不是一次真实模型调用，既不能覆盖最近一次有效上下文，也不能计入会话调用次数。
      // TIPS: SDK 会把“不提供用量”和“真实为 0”都归一为数值 0。完整模型调用不可能
      // 在有请求/响应的同时消耗 0 token，因此零样本不能作为可校准的 Provider 计量。
      if (!hasMeasuredTokens(normalized)) continue;
      session = addTokens(session, normalized);
      sessionCalls += 1;
      reasoningAvailable ||= normalized.reasoning > 0;
      cacheReadAvailable ||= normalized.cacheRead > 0;
      cacheWriteAvailable ||= normalized.cacheWrite > 0;
      const modelKey = `${message.info.providerID}\u0000${message.info.modelID}`;
      const previousAvailability = optionalFieldsByModel.get(modelKey);
      optionalFieldsByModel.set(modelKey, {
        reasoning: previousAvailability?.reasoning === true || normalized.reasoning > 0,
        cacheRead: previousAvailability?.cacheRead === true || normalized.cacheRead > 0,
        cacheWrite: previousAvailability?.cacheWrite === true || normalized.cacheWrite > 0,
      });
      // TIPS: assistant.info 是整轮累计值；step-finish 才是一轮工具循环里的单次模型调用。
      latestCall = {
        tokens: normalized,
        used: contextTotal(normalized),
        providerID: message.info.providerID,
        modelID: message.info.modelID,
        messageID: message.info.id,
        interrupted: message.info.finish === "unknown" || ("error" in message.info && Boolean(message.info.error)),
      };
    }
  }

  const activeMessages = transcript.filter((message) => !isSyntheticMessage(message));
  const compactionIndex = completedCompactionBoundary(activeMessages);
  const reportIndex = latestCall
    ? activeMessages.findIndex((message) => message.id === latestCall?.messageID)
    : -1;
  const matchingLatestCall = latestCall?.providerID === model.providerID && latestCall.modelID === model.modelID
    ? latestCall
    : null;
  const reportMessage = reportIndex >= 0 ? activeMessages[reportIndex] : undefined;
  const reportIsCompactionCall = reportIndex === compactionIndex && messageIsCompletedCompaction(reportMessage);
  const reportHasUnsettledContent = Boolean(
    matchingLatestCall &&
    (
      matchingLatestCall.interrupted ||
      (streaming && (messageHasStreamingContent(reportMessage) || reportIndex === activeMessages.length - 1))
    ),
  );
  const hasContentAfterReport = reportIndex >= 0 && activeMessages.slice(reportIndex + 1).some((message) =>
    message.parts.some((part) => estimatePartTokens(part) > 0)
  );
  const reportIsCurrent = Boolean(
    matchingLatestCall &&
    reportIndex >= 0 &&
    !reportIsCompactionCall &&
    !reportHasUnsettledContent &&
    compactionIndex <= reportIndex &&
    !hasContentAfterReport &&
    !streaming,
  );

  let currentUsed: number;
  let currentSource: ContextMeasurementSource;
  let currentTokens: ContextTokenBreakdown | null = null;
  if (reportIsCurrent && matchingLatestCall) {
    currentUsed = matchingLatestCall.used;
    currentSource = "provider-reported";
    currentTokens = matchingLatestCall.tokens;
  } else {
    const baselineCall = matchingLatestCall ?? latestCall;
    const baselineMatchesSelectedModel = baselineCall === matchingLatestCall;
    const canExtendReport = Boolean(
      baselineCall &&
      reportIndex >= 0 &&
      !reportIsCompactionCall &&
      compactionIndex <= reportIndex,
    );
    // TIPS: 同一 Assistant 消息在工具循环中可先写 step-finish，再继续追加工具结果或文本。
    // 此时无法从 UI Part 精确定位计量边界，保留 Provider 基线并保守估算整条未收口消息，避免中断后误报为精确值。
    const estimateStart = canExtendReport
      ? reportIndex + (reportHasUnsettledContent ? 0 : 1)
      : Math.max(0, compactionIndex);
    const estimated = estimateMessages(activeMessages, estimateStart);
    // TIPS: 切换模型后无法重放被 140 条加载窗口截断的完整历史。沿用旧模型最近一次
    // Provider 总量作为近似基线，比只数可见尾部更不容易严重低估；状态仍明确标记为估算。
    currentUsed = (canExtendReport ? baselineCall!.used : 0) + estimated;
    currentSource = streaming
      ? "streaming-estimate"
      : compactionIndex >= 0 && (!canExtendReport || !baselineMatchesSelectedModel)
        ? "post-compaction-estimate"
        : "estimated";
  }

  const normalizedLimit = Math.max(0, contextLimit || 0);
  const latestModelOptionalFields = latestCall
    ? optionalFieldsByModel.get(`${latestCall.providerID}\u0000${latestCall.modelID}`)
    : undefined;
  return {
    currentUsed,
    currentSource,
    currentTokens,
    contextLimit: normalizedLimit,
    percentage: normalizedLimit > 0 ? (currentUsed / normalizedLimit) * 100 : null,
    latestCall,
    session,
    sessionCalls,
    sessionCost,
    optionalFields: {
      reasoning: latestModelOptionalFields?.reasoning ?? false,
      cacheRead: latestModelOptionalFields?.cacheRead ?? false,
      cacheWrite: latestModelOptionalFields?.cacheWrite ?? false,
    },
    sessionOptionalFields: {
      reasoning: reasoningAvailable,
      cacheRead: cacheReadAvailable,
      cacheWrite: cacheWriteAvailable,
    },
  };
}

/** 格式化 token 数量，兼顾工具栏紧凑展示与明细可读性。 */
export function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString();
}
