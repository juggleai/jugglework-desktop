/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy, ExternalLink, Github, GitMerge, GitPullRequestArrow, LoaderCircle, Pin, PinOff } from "lucide-react";
import { toast } from "sonner";

import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { currentLocale } from "@/i18n";
import { usePlatform } from "@/react-app/kernel/platform";
import type { ReviewConnectionStatus, ReviewPullRequestAction } from "@jugglework/types/reviews";

import type { ReviewPreview } from "./review-types";

const text = (en: string, zh: string) => currentLocale() === "zh" ? zh : en;

const actionCopy: Record<ReviewPullRequestAction, { en: string; zh: string; detailEn: string; detailZh: string }> = {
  edit: { en: "Edit pull request", zh: "编辑 Pull Request", detailEn: "The pull request title or description will be updated.", detailZh: "将更新此 Pull Request 的标题或描述。" },
  request_reviewers: { en: "Request reviewers", zh: "请求评审人", detailEn: "The selected GitHub users will be asked to review this pull request.", detailZh: "将请求所选 GitHub 用户评审此 Pull Request。" },
  mark_draft: { en: "Convert to draft", zh: "转为草稿", detailEn: "This pull request will no longer be ready for review.", detailZh: "此 Pull Request 将不再处于可评审状态。" },
  mark_ready: { en: "Mark ready for review", zh: "标记为可评审", detailEn: "Reviewers will see that this pull request is ready.", detailZh: "评审人将看到此 Pull Request 已可评审。" },
  close: { en: "Close pull request", zh: "关闭 Pull Request", detailEn: "The pull request will be closed without merging.", detailZh: "此 Pull Request 将在不合并的情况下关闭。" },
  reopen: { en: "Reopen pull request", zh: "重新打开 Pull Request", detailEn: "The pull request will return to the open state.", detailZh: "此 Pull Request 将恢复为打开状态。" },
  merge: { en: "Merge pull request", zh: "合并 Pull Request", detailEn: "GitHub will merge the current reviewed revision.", detailZh: "GitHub 将合并当前已查看的版本。" },
  enable_auto_merge: { en: "Enable auto-merge", zh: "启用自动合并", detailEn: "GitHub will merge after all required checks and reviews pass.", detailZh: "所有必要检查和评审通过后，GitHub 将自动合并。" },
};

function IconTip(props: { label: string; children: ReactNode }) {
  return <Tooltip><TooltipTrigger render={<span className="inline-flex" />}>{props.children}</TooltipTrigger><TooltipContent hideArrow>{props.label}</TooltipContent></Tooltip>;
}

export function ReviewHeaderActions(props: {
  endpoint?: ResolvedWorkspaceEndpoint;
  review: ReviewPreview;
  operations?: ReviewConnectionStatus["operations"];
  pinned: boolean;
  onTogglePin: () => void;
  onChanged: () => void | Promise<void>;
  workflowActions?: ReactNode;
  viewSwitcher?: ReactNode;
  changesTools?: ReactNode;
  showStatus?: boolean;
}) {
  const platform = usePlatform();
  const [pending, setPending] = useState<ReviewPullRequestAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writable = Boolean(props.endpoint && /^[a-f0-9]{40,64}$/i.test(props.review.headRevision));
  const operationAvailable = (action: ReviewPullRequestAction) => {
    if (!writable) return false;
    if (action === "edit") return Boolean(props.operations?.edit);
    if (action === "request_reviewers") return Boolean(props.operations?.requestReviewers);
    if (action === "mark_draft") return Boolean(props.operations?.markDraft);
    if (action === "mark_ready") return Boolean(props.operations?.markReady || (props.review.state === "closed" && props.operations?.reopen));
    if (action === "close") return Boolean(props.operations?.close);
    if (action === "reopen") return Boolean(props.operations?.reopen);
    if (action === "merge") return Boolean(props.operations?.merge) && props.review.state === "open" && !props.review.draft && props.review.mergeable !== "conflicting";
    return Boolean(props.operations?.enableAutoMerge) && props.review.state === "open" && !props.review.draft;
  };
  const request = (action: ReviewPullRequestAction) => { setError(null); setPending(action); };
  const confirm = async () => {
    if (!pending || !props.endpoint) return;
    setBusy(true); setError(null);
    try {
      await props.endpoint.client.mutatePullRequest(props.endpoint.workspaceId, props.review.id, {
        requestId: crypto.randomUUID(),
        expectedHeadRevision: props.review.headRevision,
        action: pending,
        ...(pending === "merge" ? { mergeMethod: "merge" as const } : {}),
      });
      const copy = actionCopy[pending];
      toast.success(text(`${copy.en} completed.`, `${copy.zh}成功。`));
      setPending(null);
      await props.onChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally { setBusy(false); }
  };
  const copyUrl = async () => {
    await navigator.clipboard.writeText(props.review.url);
    toast.success(text("Pull request URL copied.", "Pull Request 链接已复制。"));
  };
  const statusLabel = props.review.state === "merged" ? text("Merged", "已合并") : props.review.state === "closed" ? text("Closed", "已关闭") : props.review.draft ? text("Draft", "草稿") : "Open";
  const statusTone = props.review.state === "open" && !props.review.draft ? "bg-green-4 text-green-11" : props.review.state === "merged" ? "bg-violet-4 text-violet-11" : "bg-dls-hover text-dls-text";
  const statusDisabled = props.review.state === "merged" || !writable;

  return <>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      {props.viewSwitcher}
      <div className="relative z-20 ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
        {props.changesTools}
        <div className="flex h-8 items-center rounded-full border border-dls-border bg-background p-0.5 shadow-sm">
          <IconTip label={props.pinned ? text("Unpin from sidebar", "从侧边栏取消固定") : text("Pin to sidebar", "固定到侧边栏")}><Button variant="ghost" size="icon-sm" className="size-7 rounded-full" onClick={props.onTogglePin} aria-label={props.pinned ? text("Unpin from sidebar", "从侧边栏取消固定") : text("Pin to sidebar", "固定到侧边栏")}>{props.pinned ? <PinOff /> : <Pin />}</Button></IconTip>
          <IconTip label={text("Copy URL", "复制链接")}><Button variant="ghost" size="icon-sm" className="size-7 rounded-full" onClick={() => void copyUrl()} aria-label={text("Copy URL", "复制链接")}><Copy /></Button></IconTip>
          <IconTip label={text("Open in GitHub", "在 GitHub 中打开")}><Button variant="ghost" size="icon-sm" className="size-7 rounded-full" onClick={() => platform.openLink(props.review.url)} aria-label={text("Open in GitHub", "在 GitHub 中打开")}><Github /><span className="sr-only"><ExternalLink /></span></Button></IconTip>
        </div>
        {props.workflowActions}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button className="h-8 rounded-full bg-dls-text px-3.5 text-sm text-background hover:bg-dls-text/90" disabled={!operationAvailable("merge") && !operationAvailable("enable_auto_merge")} />}>
            <GitMerge />{text("Merge", "合并")}<ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem disabled={!operationAvailable("merge")} onClick={() => request("merge")}>{text("Merge", "合并")}</DropdownMenuItem>
            <DropdownMenuItem disabled={!operationAvailable("enable_auto_merge")} onClick={() => request("enable_auto_merge")}>{text("Enable auto-merge", "启用自动合并")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
    {props.showStatus !== false ? <div className="mt-3 flex min-w-0 items-center gap-3">
      <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" disabled={statusDisabled} className={`h-8 rounded-full px-3 text-xs ${statusTone}`} aria-label={text("Change pull request status", "更改 Pull Request 状态")} />}>
        <GitPullRequestArrow className="size-3.5" />{statusLabel}<ChevronDown className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuItem disabled={props.review.state !== "open" || props.review.draft || !operationAvailable("mark_draft")} onClick={() => request("mark_draft")}>
          {text("Draft", "草稿")}{props.review.state === "open" && props.review.draft ? <Check className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={(props.review.state === "open" && !props.review.draft) || (props.review.state === "open" ? !operationAvailable("mark_ready") : !operationAvailable("reopen"))} onClick={() => request(props.review.state === "closed" ? "reopen" : "mark_ready")}>
          {text("Ready for review", "可供评审")}{props.review.state === "open" && !props.review.draft ? <Check className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={props.review.state !== "open" || !operationAvailable("close")} onClick={() => request("close")}>
          {text("Closed", "已关闭")}{props.review.state === "closed" ? <Check className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
      </DropdownMenu>
      <div className="min-w-0 text-xs text-dls-secondary"><span>{props.review.repository}</span> <span>#{props.review.number}</span></div>
    </div> : null}
    <Dialog open={Boolean(pending)} onOpenChange={(open) => { if (!open && !busy) { setPending(null); setError(null); } }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogTitle>{pending ? text(actionCopy[pending].en, actionCopy[pending].zh) : ""}</DialogTitle>
        <DialogDescription>{pending ? text(actionCopy[pending].detailEn, actionCopy[pending].detailZh) : ""}</DialogDescription>
        {error ? <p role="alert" className="rounded-xl bg-red-3 px-3 py-2 text-sm text-red-11">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setPending(null)}>{text("Cancel", "取消")}</Button>
          <Button disabled={busy} onClick={() => void confirm()}>{busy ? <LoaderCircle className="animate-spin" /> : null}{text("Continue", "继续")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
