/** @jsxImportSource react */
import { useState } from "react";
import { Sparkles } from "lucide-react";
import type { AutomationPromptPart } from "@jugglework/types/automation";
import { t } from "@/i18n";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

/**
 * 任务 5.2 "模拟测试"依赖的外部边界——只读，只做一次 GitHub 历史 PR/Issue 抓取 +
 * prompt 组装，不接触任何能创建运行/会话的接口。
 * TIPS: 这个接口本身的窄，就是"不会创建运行"这个要求的一部分——它没有暴露任何写操作，
 * 结构上就做不到误用成真正执行。
 */
export type EventPromptPreviewClient = {
  previewPrompt: (input: { url: string; promptParts: AutomationPromptPart[] }) => Promise<{
    entityRef: string;
    entityUrl: string;
    promptParts: AutomationPromptPart[];
  }>;
};

/** 把单条 prompt part 渲染成预览文本——非文本类型（文件/技能）只显示占位标签，不展开内容。 */
function renderPromptPart(part: AutomationPromptPart, index: number): string {
  if (part.type === "text") return part.text;
  if (part.type === "file") return `[${t("automation.prompt_part_file")}：${part.label ?? part.relativePath}]`;
  return `[${t("automation.prompt_part_skill")}：${part.label ?? part.skillId}]`;
}

/**
 * "模拟测试"入口 + 结果面板：粘贴一个历史 PR/Issue 链接，看看这个自动化的 prompt
 * 真实触发时会被组装成什么样子。
 *
 * TIPS: 只读——按钮点击到结果展示之间只经过 `client.previewPrompt` 这一个调用，
 * 没有任何路径会创建运行或会话（服务端那一侧的实现见 routes/automations.ts 的
 * `/automations/preview-event-prompt`，同样结构上不触碰 claimEventRun/executor）。
 *
 * @param client 只读预览客户端
 * @param promptParts 当前草稿的 prompt 内容（未保存也可以预览，草稿本身不需要落盘）
 */
export function EventPromptPreview(props: { client: EventPromptPreviewClient; promptParts: AutomationPromptPart[] }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ entityRef: string; entityUrl: string; promptParts: AutomationPromptPart[] } | null>(null);

  const run = async () => {
    if (!url.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const preview = await props.client.previewPrompt({ url: url.trim(), promptParts: props.promptParts });
      setResult(preview);
    } catch (previewError) {
      setResult(null);
      setError(describeError(previewError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-dls-border p-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 text-left text-sm font-medium"
      >
        <Sparkles className="size-4" />
        {t("automation.event_preview_toggle")}
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-dls-secondary">{t("automation.event_preview_hint")}</p>
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/owner/repo/issues/1"
              className="h-10 flex-1 rounded-xl border border-[#ebebeb] bg-background px-3 text-sm outline-none focus:border-dls-accent dark:border-dls-border"
            />
            <button
              type="button"
              onClick={() => void run()}
              disabled={!url.trim() || loading}
              className="h-10 shrink-0 rounded-xl bg-dls-text px-4 text-sm font-medium text-background disabled:opacity-50"
            >
              {loading ? t("automation.event_preview_loading") : t("automation.event_preview_run")}
            </button>
          </div>
          {error ? <p className="text-xs text-red-9">{error}</p> : null}
          {result ? (
            <div className="space-y-2 rounded-xl bg-dls-hover/60 p-3">
              <p className="text-xs text-dls-secondary">{result.entityRef} · {result.entityUrl}</p>
              <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed">
                {result.promptParts.map(renderPromptPart).join("\n\n")}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
