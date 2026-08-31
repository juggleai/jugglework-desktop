/** @jsxImportSource react */
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UIMessage } from "ai";

import type { JuggleWorkSessionMessage } from "@/app/lib/jugglework-server";
import type { ModelRef } from "@/app/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getLocaleSnapshot, subscribeLocale } from "@/i18n";
import {
  deriveContextUsage,
  formatTokenCount,
} from "./context-usage-data";

type ContextUsageProps = {
  messages: JuggleWorkSessionMessage[];
  transcript: UIMessage[];
  model: ModelRef;
  contextLimit: number;
  streaming: boolean;
};

const COPY = {
  en: {
    title: "Context usage",
    currentContext: "Current active context",
    used: "used",
    unknownLimit: "Context limit unavailable",
    input: "Non-cached input",
    totalInput: "Total input",
    cacheRead: "Cached input",
    cacheWrite: "Cache write",
    output: "Model output",
    reasoning: "Reasoning",
    latestCall: "Latest provider report",
    sessionUsage: "Loaded history diagnostics",
    calls: "model calls",
    cost: "provider-reported cost",
    estimateNote: "Estimated from loaded conversation content. Hidden system prompts, tool schemas, skills, MCP definitions, and provider tokenization can change the final total.",
    providerNote: "Calibrated from the provider's latest usable report for the selected model.",
    historyNote: "These totals cover provider reports in the loaded history window. They are not the current active context or a complete lifetime bill.",
  },
  zh: {
    title: "上下文用量",
    currentContext: "当前有效上下文",
    used: "已使用",
    unknownLimit: "模型未提供上下文上限",
    input: "非缓存输入",
    totalInput: "输入合计",
    cacheRead: "缓存读取",
    cacheWrite: "缓存写入",
    output: "模型输出",
    reasoning: "推理用量",
    latestCall: "最近一次提供商计量",
    sessionUsage: "已加载记录诊断",
    calls: "次模型调用",
    cost: "提供商返回的费用",
    estimateNote: "根据已加载的对话内容估算。隐藏的系统提示词、工具 Schema、技能、MCP 定义和提供商分词方式会影响最终结果。",
    providerNote: "已使用当前所选模型最近一次可用的提供商计量校准。",
    historyNote: "这些累计值只覆盖已加载记录中的提供商计量，不代表当前有效上下文，也不是完整会话账单。",
  },
} as const;

function formatPercentage(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function BreakdownRow(props: {
  color: string;
  label: string;
  value: number | null;
  limit: number;
}) {
  const percentage = props.value !== null && props.limit > 0
    ? `${((props.value / props.limit) * 100).toFixed(1)}%`
    : "—";
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className={`size-2.5 shrink-0 rounded-full ${props.color}`} />
      <span className="min-w-0 flex-1 text-gray-12">{props.label}</span>
      <span className="tabular-nums text-gray-10">{props.value === null ? "—" : formatTokenCount(props.value)}</span>
      <span className="w-12 text-right tabular-nums text-gray-9">{percentage}</span>
    </div>
  );
}

/**
 * 会话输入栏中的上下文用量入口，悬浮展示摘要，点击展示估算状态与 Provider 诊断。
 * @param props.messages 当前会话快照中的原始消息
 * @param props.transcript 已合并实时事件的当前会话消息
 * @param props.model 当前模型
 * @param props.contextLimit 当前模型上下文窗口
 * @param props.streaming 当前会话是否正在运行
 */
export function ContextUsage(props: ContextUsageProps) {
  const [open, setOpen] = useState(false);
  const skipFinalFocusRef = useRef(false);
  const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
  const copy = locale === "zh" ? COPY.zh : COPY.en;
  const usage = useMemo(() => deriveContextUsage(
    props.messages,
    props.transcript,
    props.model,
    props.contextLimit,
    props.streaming,
  ), [props.contextLimit, props.messages, props.model, props.streaming, props.transcript]);
  const progress = Math.min(100, Math.max(0, usage.percentage ?? 0));
  const tooltip = usage.contextLimit > 0
    ? `${formatPercentage(usage.percentage)} · ${formatTokenCount(usage.currentUsed)} / ${formatTokenCount(usage.contextLimit)}`
    : `${formatTokenCount(usage.currentUsed)} ${copy.used} · ${copy.unknownLimit}`;
  const latest = usage.latestCall;
  const latestUsesSelectedLimit = latest?.providerID === props.model.providerID && latest.modelID === props.model.modelID;
  const latestLimit = latestUsesSelectedLimit ? usage.contextLimit : 0;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={(
            <button
              type="button"
              data-testid="context-usage-trigger"
              className="flex size-9 items-center justify-center rounded-full text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
              aria-label={copy.title}
              onClick={() => setOpen(true)}
            />
          )}
        >
          <span className="relative block size-[22px]">
            <svg viewBox="0 0 24 24" className="size-[22px] -rotate-90" aria-hidden="true">
              <circle cx="12" cy="12" r="7.48" fill="none" stroke="#cccccc" strokeWidth="2.5" />
              <circle
                cx="12"
                cy="12"
                r="7.48"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                pathLength="100"
                strokeDasharray={`${progress} 100`}
                className={`transition-[stroke-dasharray] ${usage.currentSource === "provider-reported" ? "text-blue-9" : "text-amber-9"}`}
              />
            </svg>
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>

      <Dialog
        open={open}
        onOpenChange={(nextOpen, eventDetails) => {
          // TIPS: Esc 关闭时 Base UI 默认会把键盘焦点还给触发按钮，随后 focus-visible
          // 把整个 36px 点击区画成外圈。只跳过这一次焦点恢复，保留正常 Tab 导航提示。
          skipFinalFocusRef.current = !nextOpen && eventDetails.reason === "escape-key";
          setOpen(nextOpen);
        }}
      >
        <DialogContent
          data-testid="context-usage-dialog"
          className="w-full max-w-md gap-5 sm:max-w-md"
          finalFocus={() => {
            const shouldRestoreFocus = !skipFinalFocusRef.current;
            skipFinalFocusRef.current = false;
            return shouldRestoreFocus;
          }}
        >
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.currentContext}</DialogDescription>
          </DialogHeader>

          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-gray-12">{formatPercentage(usage.percentage)}</span>
              <span className="text-sm text-gray-10">
                {copy.used} {formatTokenCount(usage.currentUsed)}
                {usage.contextLimit > 0 ? ` / ${formatTokenCount(usage.contextLimit)}` : ""}
              </span>
            </div>
            {usage.contextLimit <= 0 ? <div className="mt-1 text-xs text-amber-10">{copy.unknownLimit}</div> : null}
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-gray-3">
              <div
                className={`h-full min-w-px rounded-full ${usage.currentSource === "provider-reported" ? "bg-blue-9" : "bg-amber-9"}`}
                style={{ width: usage.contextLimit > 0 ? `${progress}%` : "0" }}
              />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-gray-9">
              {usage.currentSource === "provider-reported" ? copy.providerNote : copy.estimateNote}
            </p>
          </div>

          {latest ? (
            <div className="border-t border-gray-4 pt-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-9">{copy.latestCall}</div>
                <div className="truncate text-[11px] text-gray-9">{latest.providerID} / {latest.modelID}</div>
              </div>
              <div className="mt-3 space-y-3">
                <BreakdownRow color="bg-teal-9" label={copy.input} value={latest.tokens.input} limit={latestLimit} />
                {usage.optionalFields.cacheRead ? (
                  <BreakdownRow color="bg-amber-8" label={copy.cacheRead} value={latest.tokens.cacheRead} limit={latestLimit} />
                ) : null}
                {usage.optionalFields.cacheWrite ? (
                  <BreakdownRow color="bg-violet-9" label={copy.cacheWrite} value={latest.tokens.cacheWrite} limit={latestLimit} />
                ) : null}
                <BreakdownRow color="bg-blue-9" label={copy.output} value={latest.tokens.output} limit={latestLimit} />
                {usage.optionalFields.reasoning ? (
                  <BreakdownRow color="bg-pink-9" label={copy.reasoning} value={latest.tokens.reasoning} limit={latestLimit} />
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="rounded-2xl bg-gray-2/70 px-4 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-9">{copy.sessionUsage}</div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-10">
              <span>{usage.sessionCalls} {copy.calls}</span>
              <span>{copy.totalInput} {formatTokenCount(usage.session.input + usage.session.cacheRead + usage.session.cacheWrite)}</span>
              <span>{copy.output} {formatTokenCount(usage.session.output)}</span>
              {usage.sessionOptionalFields.reasoning ? <span>{copy.reasoning} {formatTokenCount(usage.session.reasoning)}</span> : null}
              {usage.sessionCost > 0 ? <span>{copy.cost} ${usage.sessionCost.toFixed(4)}</span> : null}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-gray-9">{copy.historyNote}</p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
