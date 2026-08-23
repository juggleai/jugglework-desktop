/** @jsxImportSource react */
import { useRef, useState, useSyncExternalStore } from "react";

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
import { deriveContextUsage, formatTokenCount } from "./context-usage-data";

type ContextUsageProps = {
  messages: JuggleWorkSessionMessage[];
  model: ModelRef;
  contextLimit: number;
};

const COPY = {
  en: {
    title: "Context usage",
    used: "used",
    noData: "Usage will appear after this model completes a response.",
    unknownLimit: "Context limit unavailable",
    input: "Non-cached input",
    cacheRead: "Cached input",
    cacheWrite: "Cache write",
    output: "Model output",
    reasoning: "Reasoning",
    currentCall: "Latest model call",
    sessionUsage: "Loaded history usage",
    calls: "model calls",
    cost: "provider-reported cost",
    note: "The provider reports aggregate input usage, so system prompts, tools, skills, messages, and MCP content cannot be separated reliably.",
    excluded: "Reported separately; not added to the context bar.",
  },
  zh: {
    title: "上下文用量",
    used: "已使用",
    noData: "该模型完成一次响应后，将显示实际用量。",
    unknownLimit: "模型未提供上下文上限",
    input: "非缓存输入",
    cacheRead: "缓存读取",
    cacheWrite: "缓存写入",
    output: "模型输出",
    reasoning: "推理用量",
    currentCall: "最近一次模型调用",
    sessionUsage: "已加载记录累计用量",
    calls: "次模型调用",
    cost: "提供商返回的费用",
    note: "提供商只返回聚合后的输入用量，暂时无法可靠拆分系统提示词、工具、技能、对话消息与 MCP 内容。",
    excluded: "单独统计，不计入上方上下文占用。",
  },
} as const;

function formatPercentage(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function BreakdownRow(props: {
  color: string;
  label: string;
  value: number;
  limit: number;
  suffix?: string;
}) {
  const percentage = props.limit > 0 ? `${((props.value / props.limit) * 100).toFixed(1)}%` : "—";
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className={`size-2.5 shrink-0 rounded-full ${props.color}`} />
      <span className="min-w-0 flex-1 text-gray-12">{props.label}</span>
      <span className="tabular-nums text-gray-10">{formatTokenCount(props.value)}</span>
      <span className="w-12 text-right tabular-nums text-gray-9">{percentage}</span>
      {props.suffix ? <span className="sr-only">{props.suffix}</span> : null}
    </div>
  );
}

/**
 * 会话输入栏中的上下文用量入口，悬浮展示摘要，点击展示真实计量明细。
 * @param props.messages 当前会话消息
 * @param props.model 当前模型
 * @param props.contextLimit 当前模型上下文窗口
 */
export function ContextUsage(props: ContextUsageProps) {
  const [open, setOpen] = useState(false);
  const skipFinalFocusRef = useRef(false);
  const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
  const copy = locale === "zh" ? COPY.zh : COPY.en;
  const usage = deriveContextUsage(props.messages, props.model, props.contextLimit);
  const progress = Math.min(100, Math.max(0, usage.percentage ?? 0));
  const tooltip = usage.current
    ? usage.contextLimit > 0
      ? `${formatPercentage(usage.percentage)} · ${formatTokenCount(usage.currentUsed)} / ${formatTokenCount(usage.contextLimit)} ${copy.used}`
      : `${formatTokenCount(usage.currentUsed)} ${copy.used} · ${copy.unknownLimit}`
    : copy.noData;
  const segments = usage.current
    ? [
        { key: "input", value: usage.current.input, color: "bg-teal-9" },
        { key: "cacheRead", value: usage.current.cacheRead, color: "bg-amber-8" },
        { key: "cacheWrite", value: usage.current.cacheWrite, color: "bg-violet-9" },
        { key: "output", value: usage.current.output, color: "bg-blue-9" },
      ]
    : [];

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
                className="text-blue-9 transition-[stroke-dasharray]"
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
            <DialogDescription>{copy.currentCall}</DialogDescription>
          </DialogHeader>

          {usage.current ? (
            <>
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-semibold tabular-nums text-gray-12">{formatPercentage(usage.percentage)}</span>
                  <span className="text-sm text-gray-10">
                    {copy.used} {formatTokenCount(usage.currentUsed)}
                    {usage.contextLimit > 0 ? ` / ${formatTokenCount(usage.contextLimit)}` : ""}
                  </span>
                </div>
                {usage.contextLimit <= 0 ? <div className="mt-1 text-xs text-amber-10">{copy.unknownLimit}</div> : null}
                <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-gray-3">
                  {segments.map((segment) => (
                    <span
                      key={segment.key}
                      className={`${segment.color} ${segment.value > 0 ? "min-w-px" : ""}`}
                      style={{ width: usage.contextLimit > 0 ? `${Math.min(100, (segment.value / usage.contextLimit) * 100)}%` : "0" }}
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <BreakdownRow color="bg-teal-9" label={copy.input} value={usage.current.input} limit={usage.contextLimit} />
                <BreakdownRow color="bg-amber-8" label={copy.cacheRead} value={usage.current.cacheRead} limit={usage.contextLimit} />
                <BreakdownRow color="bg-violet-9" label={copy.cacheWrite} value={usage.current.cacheWrite} limit={usage.contextLimit} />
                <BreakdownRow color="bg-blue-9" label={copy.output} value={usage.current.output} limit={usage.contextLimit} />
                <BreakdownRow color="bg-pink-9" label={copy.reasoning} value={usage.current.reasoning} limit={usage.contextLimit} suffix={copy.excluded} />
                <div className="pl-[22px] text-xs text-gray-9">{copy.excluded}</div>
              </div>
            </>
          ) : (
            <div className="rounded-2xl bg-gray-2 px-4 py-6 text-center text-sm text-gray-10">{copy.noData}</div>
          )}

          <div className="rounded-2xl bg-gray-2/70 px-4 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-9">{copy.sessionUsage}</div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-10">
              <span>{usage.sessionCalls} {copy.calls}</span>
              <span>{copy.input} {formatTokenCount(usage.session.input + usage.session.cacheRead + usage.session.cacheWrite)}</span>
              <span>{copy.output} {formatTokenCount(usage.session.output)}</span>
              <span>{copy.reasoning} {formatTokenCount(usage.session.reasoning)}</span>
              {usage.sessionCost > 0 ? <span>{copy.cost} ${usage.sessionCost.toFixed(4)}</span> : null}
            </div>
          </div>

          <p className="text-xs leading-relaxed text-gray-9">{copy.note}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
