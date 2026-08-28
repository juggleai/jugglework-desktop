import type { JuggleWorkSessionMessage } from "@/app/lib/jugglework-server";
import type { ModelRef } from "@/app/types";

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

export type ContextUsageDetails = {
  current: ContextTokenBreakdown | null;
  currentUsed: number;
  contextLimit: number;
  percentage: number | null;
  session: ContextTokenBreakdown;
  sessionCalls: number;
  sessionCost: number;
};

const EMPTY_TOKENS: ContextTokenBreakdown = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

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

/**
 * 从引擎最终生效的模型配置中读取服务端下发的上下文窗口上限。
 * @param model 当前选择的模型；未选择模型时返回 0
 * @param providers OpenCode 当前工作区可见的提供商列表
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
 * 根据引擎返回的逐步 token 计量，计算当前上下文占用和会话累计用量。
 * @param messages 当前会话的原始消息与 parts
 * @param model 当前选择的模型；当前占用只采用该模型最近一次调用的数据
 * @param contextLimit 当前模型的上下文窗口上限
 * @returns 可直接用于上下文入口与明细弹窗的数据
 */
export function deriveContextUsage(
  messages: JuggleWorkSessionMessage[],
  model: ModelRef,
  contextLimit: number,
): ContextUsageDetails {
  let latest: { tokens: ContextTokenBreakdown; providerID: string; modelID: string } | null = null;
  let session = EMPTY_TOKENS;
  let sessionCalls = 0;
  let sessionCost = 0;

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
      if (sample.finishReason === "unknown" && !hasMeasuredTokens(normalized)) continue;
      session = addTokens(session, normalized);
      sessionCalls += 1;
      // TIPS: assistant.info 是整轮累计值；step-finish 才是最后一次真正送进模型的上下文。
      // 这里始终覆盖 latest，避免切换模型后把旧模型或更早轮次的用量冒充为当前占用。
      latest = { tokens: normalized, providerID: message.info.providerID, modelID: message.info.modelID };
    }
  }

  const current = latest?.providerID === model.providerID && latest.modelID === model.modelID
    ? latest.tokens
    : null;
  const currentUsed = current ? contextTotal(current) : 0;
  const normalizedLimit = Math.max(0, contextLimit || 0);
  return {
    current,
    currentUsed,
    contextLimit: normalizedLimit,
    percentage: current && normalizedLimit > 0 ? (currentUsed / normalizedLimit) * 100 : null,
    session,
    sessionCalls,
    sessionCost,
  };
}

/** 格式化 token 数量，兼顾工具栏紧凑展示与明细可读性。 */
export function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString();
}
