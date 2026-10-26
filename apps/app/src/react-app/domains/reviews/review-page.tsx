/** @jsxImportSource react */
import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Columns2,
  Copy,
  Ellipsis,
  Filter,
  FileCode2,
  FileSearch,
  FolderOpen,
  GitCommitHorizontal,
  GitPullRequestArrow,
  ListFilter,
  LoaderCircle,
  Pin,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  SmilePlus,
  Users,
  WrapText,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { AppNavigationRail } from "@/react-app/shell/app-navigation-rail";
import { AppInsetSurface } from "@/react-app/shell/app-inset-surface";
import { AppSecondarySidebarResizeHandle } from "@/react-app/shell/app-secondary-sidebar-resize-handle";
import { AppSecondarySidebarTopControls } from "@/react-app/shell/app-secondary-sidebar-top-controls";
import { ListPanelHeader } from "@/react-app/shell/list-panel-header";
import { useUiStateStore } from "@/react-app/shell/ui-state-store";
import { appInsetSidebarCssWidth, useWorkspaceShellLayout } from "@/react-app/shell/workspace-shell-layout";
import type { OpenCreateWorkspace } from "@/react-app/domains/workspace/types";
import type { ReviewConnectionStatus } from "@jugglework/types/reviews";

import {
  useReviewChecks,
  useReviewConnection,
  useReviewDetail,
  useReviewFiles,
  useReviewInbox,
  useReviewThreads,
  reviewQueryKeys,
} from "./review-queries";
import { reviewViewModel } from "./review-view-model";
import { useReviewWorkspaceEndpoint } from "./use-review-workspace-endpoint";
import { ReviewWorkflowControls } from "./review-workflow-controls";
import { ReviewConversationPanel, type ReviewConversationLayout } from "./review-conversation-panel";
import { ReviewHeaderActions } from "./review-header-actions";
import { ReviewGitHubConnection } from "./review-github-connection";
import { MarkdownBlock } from "@/react-app/domains/session/surface/markdown";
import type {
  ReviewCheckState,
  ReviewDetailTab,
  ReviewPreview,
  ReviewRelationship,
} from "./review-types";

type ReviewPageProps = {
  workspaceId: string;
  reviewId: string | null;
  active: boolean;
  onSelectReview: (reviewId: string | null) => void;
  onOpenReviewSession?: (sessionId: string) => void;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
  onOpenConnect: () => void;
  onOpenTaskSearch: () => void;
  onOpenCreateWorkspace: OpenCreateWorkspace;
};

const INBOX_SECTIONS: Array<{ value: ReviewRelationship; en: string; zh: string }> = [
  { value: "authored", en: "My pull requests", zh: "我创建的" },
  { value: "requested", en: "Review requests", zh: "待我审查" },
  { value: "team", en: "My team's review requests", zh: "需要我的团队审查" },
  { value: "recently_merged", en: "Recently merged", zh: "最近合并" },
];

type ReviewInboxSectionKey = ReviewRelationship | "pinned";
type ReviewInboxViewMode = "compact" | "detailed";

const PINNED_SECTION = { value: "pinned" as const, en: "Pinned", zh: "置顶" };

const REVIEW_INBOX_PREFERENCES_KEY = "jugglework:review-inbox-preferences";

function readReviewInboxPreferences(): { viewMode: ReviewInboxViewMode; visibleSections: ReviewRelationship[] } {
  const defaults = { viewMode: "detailed" as const, visibleSections: INBOX_SECTIONS.map((section) => section.value) };
  try {
    const value = JSON.parse(localStorage.getItem(REVIEW_INBOX_PREFERENCES_KEY) ?? "null") as {
      viewMode?: unknown;
      visibleSections?: unknown;
    } | null;
    if (!value) return defaults;
    const allowedSections = new Set(INBOX_SECTIONS.map((section) => section.value));
    return {
      viewMode: value.viewMode === "compact" ? "compact" : "detailed",
      visibleSections: Array.isArray(value.visibleSections)
        ? value.visibleSections.filter((section): section is ReviewRelationship => typeof section === "string" && allowedSections.has(section as ReviewRelationship))
        : defaults.visibleSections,
    };
  } catch {
    return defaults;
  }
}

function pinnedStorageKey(workspaceId: string) { return `jugglework:review-pins:${workspaceId}`; }
type PinnedReviewState = { ids: string[]; reviews: ReviewPreview[] };

function isPinnedReviewSnapshot(value: unknown): value is ReviewPreview {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<ReviewPreview>;
  return typeof review.id === "string"
    && typeof review.title === "string"
    && typeof review.author === "string"
    && typeof review.authorInitials === "string"
    && typeof review.owner === "string"
    && typeof review.repository === "string"
    && typeof review.number === "number"
    && Array.isArray(review.labels);
}

function pinnedReviewSnapshot(review: ReviewPreview): ReviewPreview {
  return {
    ...review,
    body: "",
    summary: [],
    files: [],
    checks: [],
    threads: [],
    pinned: true,
  };
}

function readPinnedReviews(workspaceId: string): PinnedReviewState {
  try {
    const value = JSON.parse(localStorage.getItem(pinnedStorageKey(workspaceId)) ?? "[]");
    if (Array.isArray(value)) {
      return { ids: value.filter((item): item is string => typeof item === "string").slice(0, 100), reviews: [] };
    }
    if (!value || typeof value !== "object") return { ids: [], reviews: [] };
    const stored = value as { ids?: unknown; reviews?: unknown };
    const ids = Array.isArray(stored.ids) ? stored.ids.filter((item): item is string => typeof item === "string").slice(0, 100) : [];
    const reviews = Array.isArray(stored.reviews) ? stored.reviews.filter(isPinnedReviewSnapshot).filter((review) => ids.includes(review.id)).slice(0, 100) : [];
    return { ids, reviews };
  } catch { return { ids: [], reviews: [] }; }
}

function text(en: string, zh: string) {
  return currentLocale() === "zh" ? zh : en;
}

function ReviewToolbarTip(props: { label: string; children: ReactNode }) {
  return <Tooltip><TooltipTrigger render={<span className="inline-flex" />}>{props.children}</TooltipTrigger><TooltipContent hideArrow>{props.label}</TooltipContent></Tooltip>;
}

export function reviewMatches(review: ReviewPreview, query: string, relationship: "all" | ReviewRelationship) {
  if (relationship !== "all" && review.relationship !== relationship) return false;
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [review.title, review.owner, review.repository, review.author, `#${review.number}`, ...review.labels]
    .join(" ")
    .toLocaleLowerCase()
    .includes(normalized);
}

function ReviewAvatar({ review, size = "md" }: { review: ReviewPreview; size?: "xs" | "sm" | "md" }) {
  const sizeClass = size === "xs" ? "size-5" : size === "sm" ? "size-6" : "size-8";
  if (review.authorAvatarUrl) {
    return <img src={review.authorAvatarUrl} alt="" className={cn("shrink-0 rounded-full object-cover ring-1 ring-dls-border", sizeClass)} />;
  }
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-5 to-blue-5 font-semibold text-violet-11 ring-1 ring-violet-7/40",
      size === "xs" ? "size-5 text-[8px]" : size === "sm" ? "size-6 text-[9px]" : "size-8 text-xs",
    )} aria-hidden="true">
      {review.authorInitials}
    </span>
  );
}

function GitHubUserAvatar({ name, avatarUrl, size = "md" }: { name: string; avatarUrl?: string; size?: "xs" | "sm" | "md" }) {
  const sizeClass = size === "xs" ? "size-5 text-[8px]" : size === "sm" ? "size-7 text-[9px]" : "size-9 text-[11px]";
  const initials = name.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "GH";
  if (avatarUrl) return <img src={avatarUrl} alt={name} className={cn("shrink-0 rounded-full object-cover ring-1 ring-dls-border", sizeClass)} />;
  return <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-5 to-blue-5 font-semibold text-violet-11 ring-1 ring-violet-7/40", sizeClass)} aria-hidden="true">{initials}</span>;
}

const GITHUB_REACTIONS = [
  { emoji: "👍", value: "+1" },
  { emoji: "👎", value: "-1" },
  { emoji: "😄", value: "laugh" },
  { emoji: "🎉", value: "hooray" },
  { emoji: "😕", value: "confused" },
  { emoji: "❤️", value: "heart" },
  { emoji: "🚀", value: "rocket" },
  { emoji: "👀", value: "eyes" },
] as const;

function reactionEmoji(content: ReviewPreview["reactions"][number]["content"]) {
  return GITHUB_REACTIONS.find((reaction) => reaction.value === content)?.emoji ?? content;
}

function InboxRow({ review, selected, viewMode, onSelect }: { review: ReviewPreview; selected: boolean; viewMode: ReviewInboxViewMode; onSelect: () => void }) {
  const compact = viewMode === "compact";
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`review-inbox-item-${review.id}`}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "group flex w-full gap-2 rounded-lg px-2.5 text-left transition-colors hover:bg-dls-hover/70",
        compact ? "items-center py-1" : "items-start py-1.5",
        selected && "bg-dls-hover/60",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className={cn("block font-normal text-dls-text", compact ? "truncate text-[13px] leading-6" : "line-clamp-2 text-[14px] leading-5")}>{review.title}</span>
        {!compact ? <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-dls-secondary">
          <ReviewAvatar review={review} size="xs" />
          <span className="truncate">{review.author}</span>
          <span>·</span>
          <span className="shrink-0">{review.updatedAt}</span>
          {review.draft ? <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{text("Draft", "草稿")}</Badge> : null}
          {review.pinned ? <Pin className="ml-auto size-3 fill-current text-dls-secondary" aria-label={text("Pinned", "已固定")} /> : null}
          {selected ? <span className={cn("size-2 rounded-full bg-blue-9", !review.pinned && "ml-auto")} aria-hidden="true" /> : null}
        </span> : null}
      </span>
      {compact && review.draft ? <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px]">{text("Draft", "草稿")}</Badge> : null}
      {compact && review.pinned ? <Pin className="size-3 shrink-0 fill-current text-dls-secondary" aria-label={text("Pinned", "已固定")} /> : null}
      {compact && selected ? <span className="size-2 shrink-0 rounded-full bg-blue-9" aria-hidden="true" /> : null}
    </button>
  );
}

type ReviewInboxSectionState = {
  relationship: ReviewInboxSectionKey;
  reviews: ReviewPreview[];
  loading?: boolean;
  refreshing?: boolean;
  hasNextPage?: boolean;
  loadingNextPage?: boolean;
  error?: string | null;
  onLoadMore?: () => void;
  onRetry?: () => void;
};

function ReviewInbox(props: {
  sections: ReviewInboxSectionState[];
  expandedSections: ReviewInboxSectionKey[];
  pinnedReviews: ReviewPreview[];
  visibleSections: ReviewRelationship[];
  viewMode: ReviewInboxViewMode;
  reviewId: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onToggleSection: (relationship: ReviewInboxSectionKey) => void;
  onToggleSectionVisibility: (relationship: ReviewRelationship) => void;
  onViewModeChange: (viewMode: ReviewInboxViewMode) => void;
  onSelectReview: (reviewId: string) => void;
}) {
  const refreshing = props.sections.some((section) => props.expandedSections.includes(section.relationship) && section.refreshing);
  const sectionDefinitions = props.pinnedReviews.length
    ? [PINNED_SECTION, ...INBOX_SECTIONS.filter((definition) => props.visibleSections.includes(definition.value))]
    : INBOX_SECTIONS.filter((definition) => props.visibleSections.includes(definition.value));
  return (
    <aside className={cn(
      "h-full min-h-0 w-full shrink-0 flex-col overflow-hidden border-r border-dls-border bg-[var(--app-secondary-sidebar-bg)] md:flex md:w-[var(--jugglework-left-sidebar-width)]",
      props.reviewId ? "hidden" : "flex",
    )} aria-label={text("Pull request inbox", "拉取请求收件箱")}>
      <ListPanelHeader
        title={text("Code Review", "代码审查")}
        searchValue={props.query}
        searchPlaceholder={text("Search or paste Pull Request URL", "搜索或粘贴 Pull Request 链接")}
        onSearchChange={props.onQueryChange}
        onSearchKeyDown={(event) => {
          if (event.key !== "Escape" || !props.query) return;
          event.preventDefault();
          props.onQueryChange("");
        }}
        onClearSearch={() => props.onQueryChange("")}
        showClear={Boolean(props.query)}
        insetDivider
        titleEnd={<>
          {refreshing ? <RefreshCw className="size-3 animate-spin text-dls-secondary" aria-label={text("Refreshing", "正在刷新")} /> : null}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button className="jw-list-panel-icon-button" variant="ghost" size="icon-sm" aria-label={text("Review view options", "代码审查视图选项")} />}>
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4} className="w-56 rounded-2xl p-1.5">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="px-2.5 py-1.5 text-[12px]">{text("View", "视图")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={props.viewMode} onValueChange={(value) => props.onViewModeChange(value as ReviewInboxViewMode)}>
                  <DropdownMenuRadioItem value="compact" className="rounded-lg px-2.5 py-1.5 text-[14px] font-normal">{text("Compact", "紧凑")}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="detailed" className="rounded-lg px-2.5 py-1.5 text-[14px] font-normal">{text("Detailed", "详细")}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator className="my-1" />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="px-2.5 py-1.5 text-[12px]">{text("Sections", "板块")}</DropdownMenuLabel>
                {INBOX_SECTIONS.map((definition) => <DropdownMenuCheckboxItem
                  key={definition.value}
                  checked={props.visibleSections.includes(definition.value)}
                  onCheckedChange={() => props.onToggleSectionVisibility(definition.value)}
                  className="rounded-lg px-2.5 py-1.5 pe-8 text-[14px] font-normal"
                >
                  {text(definition.en, definition.zh)}
                </DropdownMenuCheckboxItem>)}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-5 pt-1.5">
        <nav className="space-y-1" aria-label={text("Review sections", "代码审查分组")}>
          {sectionDefinitions.map((definition) => {
            const section = props.sections.find((candidate) => candidate.relationship === definition.value) ?? { relationship: definition.value, reviews: [] };
            const expanded = props.expandedSections.includes(definition.value);
            return <section key={definition.value} aria-labelledby={`review-section-${definition.value}`}>
            <button
              type="button"
              id={`review-section-${definition.value}`}
              aria-expanded={expanded}
              onClick={() => props.onToggleSection(definition.value)}
              className="flex h-8 w-full items-center gap-1 rounded-lg px-2.5 text-left text-[14px] font-normal text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            >
              <span>{text(definition.en, definition.zh)}</span>
              {expanded ? <ChevronDown className="size-3.5" strokeWidth={2} /> : <ChevronRight className="size-3.5" strokeWidth={2} />}
            </button>
            {expanded ? <div className="pb-2" role="list">
              {section.loading ? (
                <div className="flex min-h-20 items-center justify-center gap-2 text-xs text-dls-secondary"><LoaderCircle className="size-4 animate-spin" />{text("Loading pull requests…", "正在加载拉取请求…")}</div>
              ) : section.error && !section.reviews.length ? (
                <div className="flex min-h-24 flex-col items-center justify-center px-5 text-center"><AlertCircle className="size-5 text-amber-10" /><p className="mt-2 text-xs font-medium text-dls-text">{text("Pull requests could not be loaded", "无法加载拉取请求")}</p><p className="mt-1 text-xs text-dls-secondary">{section.error}</p><Button variant="outline" size="sm" className="mt-3" onClick={section.onRetry}><RefreshCw />{text("Retry", "重试")}</Button></div>
              ) : section.reviews.length ? <>
                <div className="space-y-0.5">
                  {section.reviews.map((review) => <div role="listitem" key={review.id}><InboxRow review={review} selected={review.id === props.reviewId} viewMode={props.viewMode} onSelect={() => props.onSelectReview(review.id)} /></div>)}
                </div>
                {section.hasNextPage ? <div className="p-2"><Button variant="outline" size="sm" className="w-full" disabled={section.loadingNextPage} onClick={section.onLoadMore}>{section.loadingNextPage ? <LoaderCircle className="animate-spin" /> : null}{text("Load more", "加载更多")}</Button></div> : null}
              </> : <p className="px-2 pb-2 text-xs leading-5 text-dls-secondary">{props.query.trim() ? text("No matching pull requests", "没有匹配的拉取请求") : text("No pull requests", "暂无 Pull Request")}</p>}
            </div> : null}
            </section>;
          })}
        </nav>
      </div>
    </aside>
  );
}

function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-violet-4 text-violet-11"><GitPullRequestArrow className="size-7" /></span>
      <h2 className="mt-4 text-base font-semibold text-dls-text">{text("Select a pull request", "选择一个拉取请求")}</h2>
      <p className="mt-1 max-w-sm text-sm leading-6 text-dls-secondary">{text("Choose an item from the Inbox to inspect its summary, changed files, checks, and review threads.", "从收件箱选择一项，查看摘要、变更文件、检查结果和审查讨论。")}</p>
    </div>
  );
}

function UnknownDetail({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center" data-testid="review-not-found">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-amber-4 text-amber-11"><GitPullRequestArrow className="size-7" /></span>
      <h2 className="mt-4 text-base font-semibold text-dls-text">{text("Pull request not found", "未找到拉取请求")}</h2>
      <p className="mt-1 max-w-sm text-sm leading-6 text-dls-secondary">{text("This preview link does not match an available item.", "该预览链接与当前可用条目不匹配。")}</p>
      <Button variant="outline" className="mt-5" onClick={onBack}><ArrowLeft />{text("Return to Inbox", "返回收件箱")}</Button>
    </div>
  );
}

function ReviewHeader(props: {
  review: ReviewPreview;
  onBack: () => void;
  actions?: ReactNode;
  endpoint?: ReturnType<typeof useReviewWorkspaceEndpoint>["endpoint"];
  operations?: ReviewConnectionStatus["operations"];
  pinned?: boolean;
  onTogglePin?: () => void;
  onChanged?: () => void | Promise<void>;
  viewSwitcher?: ReactNode;
  changesTools?: ReactNode;
  showDetails?: boolean;
}) {
  const { review, onBack } = props;
  return (
    <header className="shrink-0 bg-background px-5 pb-4 pt-2 md:px-6 mac:pt-2">
      <div className="flex items-center gap-2 md:hidden"><Button variant="ghost" size="icon-sm" onClick={onBack} aria-label={text("Back to Inbox", "返回收件箱")}><ArrowLeft /></Button></div>
      {props.endpoint ? <ReviewHeaderActions endpoint={props.endpoint} review={review} operations={props.operations} pinned={Boolean(props.pinned)} onTogglePin={props.onTogglePin ?? (() => undefined)} onChanged={props.onChanged ?? (() => undefined)} workflowActions={props.actions} viewSwitcher={props.viewSwitcher} changesTools={props.changesTools} showStatus={props.showDetails !== false} /> : <>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          {props.viewSwitcher}
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{props.changesTools}{props.actions ?? <>
            <Button variant="outline" className="h-8 rounded-full px-3.5 text-sm" disabled title={text("Available after AI Review is connected", "接入 AI Review 后可用")}><Bot />{text("Review with JuggleWork", "使用 JuggleWork 审查")}</Button>
            <Button className="h-8 rounded-full px-3.5 text-sm" disabled title={text("Available after provider write access is connected", "接入平台写权限后可用")}>{text("Submit review", "提交审查")}</Button>
          </>}</div>
        </div>
        {props.showDetails !== false ? <div className="mt-3 flex items-center gap-3">{review.draft ? <Badge variant="outline" className="h-8 rounded-full px-3 text-xs">{text("Draft", "草稿")}</Badge> : <Badge variant="secondary" className="h-8 rounded-full bg-green-4 px-3 text-xs text-green-11"><GitPullRequestArrow className="mr-1 size-3.5" />Open</Badge>}<div className="min-w-0 text-xs text-dls-secondary"><span>{review.repository}</span> <span>#{review.number}</span></div></div> : null}
      </>}
      {props.showDetails !== false ? <><h2 className="mt-3 text-[20px] font-semibold leading-7 tracking-tight text-dls-text">{review.title}</h2>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs leading-5 text-dls-secondary">
        <ReviewAvatar review={review} size="sm" />
        <span className="font-medium text-dls-text">{review.author}</span>
        <span>{review.updatedAt}</span>
        <span>·</span>
        <span className="max-w-52 truncate font-mono">{review.headBranch}</span>
        <span>→</span>
        <span className="font-mono">{review.baseBranch}</span>
        <span className="hidden font-mono text-[10px] xl:inline">{review.headRevision.slice(0, 8)}</span>
      </div></> : null}
    </header>
  );
}

function SummaryView(props: {
  review: ReviewPreview;
  endpoint?: ReturnType<typeof useReviewWorkspaceEndpoint>["endpoint"];
  operations?: ReviewConnectionStatus["operations"];
  viewerLogin?: string;
  viewerAvatarUrl?: string;
  isOwnPullRequest?: boolean;
  onChanged?: () => void | Promise<void>;
  onTabChange: (tab: ReviewDetailTab) => void;
}) {
  const { review, onTabChange } = props;
  const [comment, setComment] = useState("");
  const [activityFilter, setActivityFilter] = useState<"all" | "commits" | "comments">("all");
  const [editing, setEditing] = useState(false);
  const [checksExpanded, setChecksExpanded] = useState(false);
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const [reviewerOpen, setReviewerOpen] = useState(false);
  const [reviewerQuery, setReviewerQuery] = useState("");
  const [editTitle, setEditTitle] = useState(review.title);
  const [editBody, setEditBody] = useState(review.body);
  useEffect(() => {
    setEditTitle(review.title);
    setEditBody(review.body);
    setEditing(false);
    setComment("");
    setChecksExpanded(false);
    setCommentsExpanded(false);
    setReviewerOpen(false);
    setReviewerQuery("");
  }, [review.id, review.title, review.body]);
  const revisionKnown = /^[a-f0-9]{40,64}$/i.test(review.headRevision);
  const commentMutation = useMutation({
    retry: false,
    mutationFn: (body: string) => props.endpoint!.client.publishReview(props.endpoint!.workspaceId, review.id, {
      requestId: crypto.randomUUID(), expectedHeadRevision: review.headRevision, kind: "comment", body,
    }),
    onSuccess: async () => {
      setComment("");
      toast.success(text("Comment published to GitHub.", "评论已发布到 GitHub。"));
      await props.onChanged?.();
    },
  });
  const reactionMutation = useMutation({
    retry: false,
    mutationFn: ({ commentId, reaction, target }: { commentId?: string; reaction: string; target: "pull_request" | "issue_comment" | "pull_request_review_comment" }) => props.endpoint!.client.publishReview(props.endpoint!.workspaceId, review.id, {
      requestId: crypto.randomUUID(), expectedHeadRevision: review.headRevision, kind: "reaction", body: reaction, reactionTarget: target, ...(commentId ? { commentId } : {}),
    }),
    onSuccess: async () => {
      toast.success(text("Emoji response published to GitHub.", "表情回应已发布到 GitHub。"));
      await props.onChanged?.();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : text("Could not add the reaction.", "添加表情失败。")),
  });
  const editMutation = useMutation({
    retry: false,
    mutationFn: () => props.endpoint!.client.mutatePullRequest(props.endpoint!.workspaceId, review.id, {
      requestId: crypto.randomUUID(), expectedHeadRevision: review.headRevision, action: "edit", title: editTitle.trim(), body: editBody,
    }),
    onSuccess: async () => {
      setEditing(false);
      toast.success(text("Pull request updated.", "Pull Request 已更新。"));
      await props.onChanged?.();
    },
  });
  const reviewerMutation = useMutation({
    retry: false,
    mutationFn: (username: string) => props.endpoint!.client.mutatePullRequest(props.endpoint!.workspaceId, review.id, {
      requestId: crypto.randomUUID(), expectedHeadRevision: review.headRevision, action: "request_reviewers", reviewers: [username],
    }),
    onSuccess: async () => {
      setReviewerQuery("");
      setReviewerOpen(false);
      toast.success(text("Reviewer requested on GitHub.", "已在 GitHub 请求评审人。"));
      await props.onChanged?.();
    },
  });
  const activityComments = review.threads.flatMap((thread) => thread.comments?.length
    ? thread.comments.map((item, index) => ({ ...item, threadId: thread.id, root: index === 0, path: thread.path, line: thread.line, decision: thread.reviewDecision }))
    : [{ id: thread.id, threadId: thread.id, root: true, author: thread.author, authorLogin: thread.authorLogin, avatarUrl: thread.authorAvatarUrl, body: thread.body, age: thread.age, path: thread.path, line: thread.line, decision: thread.reviewDecision }]);
  const reviewComments = review.threads.filter((thread) => (thread.kind ?? (thread.path ? "review_thread" : "issue_comment")) === "review_thread" && thread.body.trim());
  const scrollToReviewComment = (threadId: string) => {
    setActivityFilter("all");
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-review-thread-id="${CSS.escape(threadId)}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
  };
  const mutationError = commentMutation.error ?? reactionMutation.error ?? editMutation.error ?? reviewerMutation.error;
  // Keep the reviewer picker reachable even when capability discovery returns a
  // stale/partial operations snapshot. The mutation endpoint remains the source
  // of truth and will return an actionable error if GitHub rejects the request.
  const canRequestReviewer = Boolean(props.endpoint && revisionKnown);
  const requestReviewer = () => {
    const username = reviewerQuery.trim().replace(/^@/, "");
    if (!username || !canRequestReviewer || reviewerMutation.isPending) return;
    reviewerMutation.mutate(username);
  };
  return (
    <div className="mx-auto grid w-full max-w-[1160px] items-start gap-6 px-5 pb-10 pt-3 md:px-6 lg:grid-cols-[minmax(0,1fr)_240px] xl:grid-cols-[minmax(0,1fr)_270px]">
      <article className="min-w-0 pb-10 text-[14px] leading-6 text-dls-text">
        <section>
          {review.body ? <div className="[&_.markdown-content>:first-child]:mt-0"><MarkdownBlock text={review.body} copyCodeBlocks /></div> : <p className="text-dls-secondary">{text("No pull request description was provided.", "该 Pull Request 没有填写描述。")}</p>}
          <div className="mt-4 flex items-center justify-between border-b border-dls-border pb-4">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {(review.reactions ?? []).map((reaction) => <span key={reaction.content} className="inline-flex h-8 items-center gap-1 rounded-full border border-dls-border bg-background px-2.5 text-sm text-dls-secondary" aria-label={`${reaction.content} ${reaction.count}`} title={`${reaction.content}: ${reaction.count}`}><span aria-hidden="true">{reactionEmoji(reaction.content)}</span><span className="text-xs font-medium tabular-nums">{reaction.count}</span></span>)}
              <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={!props.endpoint || reactionMutation.isPending || !revisionKnown} aria-label={text("Quick reaction", "快速回应")} title={text("Publish an emoji response to GitHub", "向 GitHub 发布表情回应")} />}><SmilePlus /></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="grid w-72 min-w-72 grid-cols-8 gap-1 overflow-hidden p-1.5">
                {GITHUB_REACTIONS.map(({ emoji, value }) => <DropdownMenuItem key={value} className="size-8 justify-center p-0 text-base" onClick={() => reactionMutation.mutate({ reaction: value, target: "pull_request" })} aria-label={emoji}>{emoji}</DropdownMenuItem>)}
              </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {props.isOwnPullRequest ? <Button variant="ghost" size="sm" className="h-8 text-[13px] text-dls-secondary" disabled={!props.operations?.edit || !revisionKnown} onClick={() => setEditing(true)}><Pencil />{text("Edit", "编辑")}</Button> : null}
          </div>
        </section>

        <section className="pt-5" aria-labelledby="review-activity-title">
          <div className="flex items-center justify-between gap-3">
            <h3 id="review-activity-title" className="text-lg font-semibold tracking-tight">{text("Activity", "活动")}</h3>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="h-8 text-[13px] text-dls-secondary" />}><Filter />{activityFilter === "all" ? text("All activity", "全部活动") : activityFilter === "commits" ? text("Commits", "提交") : text("Comments", "评论")}<ChevronDown /></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setActivityFilter("all")}>{text("All activity", "全部活动")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setActivityFilter("commits")}>{text("Commits", "提交")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setActivityFilter("comments")}>{text("Comments and reviews", "评论与评审")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="mt-3 space-y-2">
            {activityFilter !== "comments" ? <>
              <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-dls-border px-3.5 py-2.5">
                <GitCommitHorizontal className="size-4 shrink-0 text-dls-secondary" />
                <span className="min-w-0 flex-1 truncate font-medium">{text("Latest commit on", "最新提交位于")} {review.headBranch}</span>
                <span className="shrink-0 font-mono text-xs text-dls-secondary">{review.headRevision.slice(0, 7)}</span>
                <ReviewAvatar review={review} size="xs" /><span className="shrink-0 text-xs text-dls-secondary">{review.updatedAt}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-dls-border px-3.5 py-2.5">
                <GitPullRequestArrow className="size-4 shrink-0 text-green-10" />
                <span className="min-w-0 flex-1 truncate"><strong>{review.author}</strong> {text("opened this pull request", "打开了此 Pull Request")}</span>
                <span className="shrink-0 text-xs text-dls-secondary">{review.updatedAt}</span>
              </div>
            </> : null}
            {activityFilter !== "commits" ? activityComments.map((item) => <article key={item.id} data-review-thread-id={item.root ? item.threadId : undefined} tabIndex={item.root ? -1 : undefined} className="rounded-xl border border-dls-border bg-background px-3.5 py-3 shadow-sm focus:outline-none focus:ring-2 focus:ring-dls-accent/40">
              <div className="flex min-w-0 items-start gap-2.5">
                <GitHubUserAvatar name={item.authorLogin ?? item.author} avatarUrl={item.avatarUrl} />
                <div className="min-w-0 flex-1">
                  <header className="flex min-w-0 items-center gap-2">
                    <strong className="min-w-0 truncate text-sm font-semibold text-dls-text">{item.author}</strong>
                    {item.decision ? <Badge variant="secondary">{item.decision === "approved" ? text("Approved", "已批准") : text("Requested changes", "请求修改")}</Badge> : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="ml-auto rounded-full text-dls-secondary" aria-label={text("Comment actions", "评论操作")} />}><Ellipsis /></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => { void navigator.clipboard.writeText(item.body); toast.success(text("Comment copied.", "评论已复制。")); }}><Copy />{text("Copy comment", "复制评论")}</DropdownMenuItem>
                        {item.url ? <DropdownMenuItem onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}><ArrowUpRight />{text("Open in GitHub", "在 GitHub 中打开")}</DropdownMenuItem> : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <span className="shrink-0 text-xs text-dls-secondary">{item.age}</span>
                  </header>
                  {item.path ? <p className="mt-2 truncate rounded-lg bg-dls-hover px-2.5 py-1 font-mono text-[11px] text-dls-secondary">{item.path}{item.line ? `:${item.line}` : ""}</p> : null}
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-dls-text">{item.body}</p>
                  <div className="mt-2 flex items-center">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="rounded-full text-dls-secondary" disabled={!props.endpoint || reactionMutation.isPending || !revisionKnown} aria-label={text("Add emoji response", "添加表情回应")} title={text("Publish an emoji response to GitHub", "向 GitHub 发布表情回应")} />}>
                        {reactionMutation.isPending && reactionMutation.variables?.commentId === item.id ? <LoaderCircle className="animate-spin" /> : <SmilePlus />}
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="grid w-72 min-w-72 grid-cols-8 gap-1 overflow-hidden p-1.5">
                        {GITHUB_REACTIONS.map(({ emoji, value }) => <DropdownMenuItem key={value} className="size-8 justify-center p-0 text-base" onClick={() => reactionMutation.mutate({ commentId: item.id, reaction: value, target: item.path ? "pull_request_review_comment" : "issue_comment" })} aria-label={emoji}>{emoji}</DropdownMenuItem>)}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </div>
            </article>) : null}
            {activityFilter === "comments" && !activityComments.length ? <p className="rounded-2xl border border-dashed border-dls-border px-4 py-6 text-center text-sm text-dls-secondary">{text("No comments or reviews yet.", "暂无评论或评审。")}</p> : null}
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-dls-border p-3.5" aria-label={text("Leave a comment", "发表评论")}>
          <div className="flex items-start gap-3">
            <GitHubUserAvatar name={props.viewerLogin ?? review.author} avatarUrl={props.viewerAvatarUrl ?? (props.isOwnPullRequest ? review.authorAvatarUrl : undefined)} size="sm" />
            <textarea className="min-h-16 flex-1 resize-y bg-transparent text-sm leading-6 outline-none placeholder:text-dls-secondary" placeholder={text("Leave a comment", "发表评论")} value={comment} onChange={(event) => setComment(event.target.value)} disabled={!props.operations?.comment || commentMutation.isPending} maxLength={60_000} />
          </div>
          <div className="mt-2.5 flex justify-end"><Button size="sm" className="h-8" disabled={!props.operations?.comment || !revisionKnown || !comment.trim() || commentMutation.isPending} onClick={() => commentMutation.mutate(comment.trim())}>{commentMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Send />}{text("Comment", "评论")}</Button></div>
        </section>
        {mutationError ? <p role="alert" className="mt-3 rounded-xl bg-red-3 px-3 py-2 text-sm text-red-11">{mutationError instanceof Error ? mutationError.message : String(mutationError)}</p> : null}

        <Dialog open={editing} onOpenChange={(open) => { if (!editMutation.isPending) setEditing(open); }}>
          <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-[720px]">
            <DialogTitle>{text("Edit pull request", "编辑 Pull Request")}</DialogTitle>
            <DialogDescription>{review.owner}/{review.repository} #{review.number}</DialogDescription>
            <label className="text-sm font-medium">{text("Title", "标题")}<input className="mt-2 h-10 w-full rounded-xl border border-dls-border bg-background px-3 font-normal outline-none focus:border-dls-accent" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={1_000} /></label>
            <label className="min-h-0 text-sm font-medium">{text("Description", "描述")}<textarea className="mt-2 min-h-64 w-full resize-y rounded-xl border border-dls-border bg-background p-3 font-normal leading-6 outline-none focus:border-dls-accent" value={editBody} onChange={(event) => setEditBody(event.target.value)} maxLength={100_000} /></label>
            {editMutation.error ? <p role="alert" className="text-sm text-red-11">{editMutation.error instanceof Error ? editMutation.error.message : String(editMutation.error)}</p> : null}
            <DialogFooter><Button variant="outline" disabled={editMutation.isPending} onClick={() => setEditing(false)}>{text("Cancel", "取消")}</Button><Button disabled={editMutation.isPending || !editTitle.trim() || (editTitle === review.title && editBody === review.body)} onClick={() => editMutation.mutate()}>{editMutation.isPending ? <LoaderCircle className="animate-spin" /> : null}{text("Save", "保存")}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </article>
      <aside className="relative z-10 divide-y divide-dls-border bg-background text-[13px] lg:-mt-28 lg:pl-5 xl:pl-6">
        <button type="button" onClick={() => onTabChange("changes")} className="group w-full py-3.5 text-left">
          <span className="text-xs text-dls-secondary">{text("Changes", "变更")}</span>
          <span className="mt-2 flex items-center gap-3 font-medium text-dls-text"><FileCode2 className="size-4" />{review.changedFiles} {text(review.changedFiles === 1 ? "file" : "files", "个文件")} <span className="ml-auto text-green-11">+{review.additions}</span><span className="text-red-11">-{review.deletions}</span><ArrowUpRight className="size-4 text-dls-secondary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" /></span>
        </button>
        <div className="py-3.5" data-testid="review-comments-summary">
          {!reviewComments.length ? <p className="text-dls-secondary">{text("No comments", "暂无评论")}</p> : <>
            <button type="button" className="flex w-full items-center gap-3 text-left font-medium text-dls-text" aria-expanded={commentsExpanded} onClick={() => setCommentsExpanded((expanded) => !expanded)}>
              <span>{text(reviewComments.length === 1 ? "1 comment" : `${reviewComments.length} comments`, `${reviewComments.length} 条评论`)}</span>
              <span className="ml-auto flex -space-x-1.5" aria-hidden="true">{reviewComments.slice(0, 2).map((thread) => <GitHubUserAvatar key={thread.id} name={thread.authorLogin ?? thread.author} avatarUrl={thread.authorAvatarUrl} size="xs" />)}{new Set(reviewComments.map((thread) => thread.authorLogin ?? thread.author)).size > 2 ? <span className="flex size-5 items-center justify-center rounded-full border border-background bg-dls-hover text-[9px]">+{new Set(reviewComments.map((thread) => thread.authorLogin ?? thread.author)).size - 2}</span> : null}</span>
              <ChevronDown className={cn("size-4 text-dls-secondary transition-transform", commentsExpanded && "rotate-180")} />
            </button>
            {commentsExpanded ? <div className="mt-2 space-y-1.5" data-testid="review-comments-list">{reviewComments.map((thread) => <button key={thread.id} type="button" className="flex w-full items-start gap-2 rounded-lg px-1.5 py-2 text-left hover:bg-dls-hover" onClick={() => scrollToReviewComment(thread.id)}>
              <GitHubUserAvatar name={thread.authorLogin ?? thread.author} avatarUrl={thread.authorAvatarUrl} size="xs" />
              <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-dls-text">{thread.author}</span><span className="mt-0.5 line-clamp-2 block text-xs leading-4 text-dls-secondary">{thread.body || text("View comment", "查看评论")}</span></span>
              {thread.resolved ? <Check className="mt-0.5 size-3.5 shrink-0 text-green-10" aria-label={text("Resolved", "已解决")} /> : null}
            </button>)}</div> : null}
          </>}
        </div>
        <div className="py-3.5">
          <span className="flex items-center text-xs text-dls-secondary">
            <span>{text("Reviewers", "评审人")}</span>
            <Popover open={reviewerOpen} onOpenChange={setReviewerOpen}>
              <PopoverTrigger render={<Button variant="ghost" size="icon-sm" className="ml-auto size-7 rounded-full bg-dls-hover" disabled={reviewerMutation.isPending} aria-label={text("Request a reviewer", "请求评审人")} />}>
                {reviewerMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 gap-0 rounded-2xl p-2">
                <div className="flex h-10 items-center gap-2 border-b border-dls-border px-2">
                  <Search className="size-4 text-dls-secondary" />
                  <input
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-dls-secondary"
                    value={reviewerQuery}
                    onChange={(event) => setReviewerQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); requestReviewer(); } }}
                    placeholder={text("Request review from…", "输入 GitHub 用户名…")}
                    maxLength={256}
                  />
                </div>
                <button type="button" className="mt-1 flex min-h-10 w-full items-center rounded-xl px-3 text-left text-sm text-dls-secondary hover:bg-dls-hover disabled:opacity-50" disabled={!reviewerQuery.trim() || !canRequestReviewer || reviewerMutation.isPending} onClick={requestReviewer}>
                  {reviewerQuery.trim() ? text(`Request review from @${reviewerQuery.trim().replace(/^@/, "")}`, `请求 @${reviewerQuery.trim().replace(/^@/, "")} 评审`) : text("Search by GitHub username", "按 GitHub 用户名添加")}
                </button>
              </PopoverContent>
            </Popover>
          </span>
          {review.reviewers.length ? <div className="mt-2 space-y-2">{review.reviewers.map((reviewer) => <div key={reviewer.login} className="flex items-center gap-2 text-dls-text">
            {reviewer.avatarUrl ? <img src={reviewer.avatarUrl} alt="" className="size-5 rounded-full object-cover" /> : <span className="flex size-5 items-center justify-center rounded-full bg-dls-hover text-[9px] font-medium">{reviewer.login.slice(0, 2).toUpperCase()}</span>}
            <span className="min-w-0 truncate text-xs">{reviewer.displayName ?? reviewer.login}</span>
          </div>)}</div> : <span className="mt-2 flex items-center gap-3 text-dls-secondary"><Users className="size-4" />{text("No reviewers", "暂无评审人")}</span>}
        </div>
        <div className="py-4">
          <span className="block text-xs text-dls-secondary">{text("Checks", "检查")}</span>
          {!review.checks.length ? <span className="mt-2 block text-dls-secondary">{text("No checks", "暂无检查")}</span> : <div className="mt-2 space-y-2">
            {review.checks.slice(0, checksExpanded ? undefined : 5).map((check) => <div key={check.id} className="flex min-w-0 items-center gap-2"><CheckIcon state={check.state} /><span className="truncate text-xs text-dls-text">{check.name}</span></div>)}
            {review.checks.length > 5 ? <button type="button" className="text-xs text-dls-secondary hover:text-dls-text" onClick={() => setChecksExpanded((expanded) => !expanded)}>{checksExpanded ? text("Show less", "收起") : text("Show more", "显示更多")}</button> : null}
          </div>}
        </div>
        {review.labels.length ? <div className="py-4"><span className="text-xs text-dls-secondary">{text("Labels", "标签")}</span><div className="mt-2 flex flex-wrap gap-2">{review.labels.map((label) => <Badge key={label} variant="outline">{label}</Badge>)}</div></div> : null}
      </aside>
    </div>
  );
}

function EmptyTab({ children }: { children: string }) {
  return <div className="flex min-h-64 items-center justify-center p-8 text-center text-sm text-dls-secondary">{children}</div>;
}

type ReviewDiffLayout = "unified" | "split";

function ChangesView({ review, truncated, showFileTree, showFileSearch, diffLayout, hideWhitespaceOnly, wrapLines }: { review: ReviewPreview; truncated?: boolean; showFileTree: boolean; showFileSearch: boolean; diffLayout: ReviewDiffLayout; hideWhitespaceOnly: boolean; wrapLines: boolean }) {
  const firstPath = review.files[0]?.path ?? "";
  const [selectedPath, setSelectedPath] = useState(firstPath);
  const [fileQuery, setFileQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setSelectedPath(firstPath);
    setFileQuery("");
  }, [firstPath, review.id]);
  useEffect(() => {
    if (showFileSearch) searchInputRef.current?.focus();
  }, [showFileSearch]);
  const filteredFiles = review.files.filter((file) => file.path.toLocaleLowerCase().includes(fileQuery.trim().toLocaleLowerCase()));
  const selectedFile = review.files.find((file) => file.path === selectedPath) ?? review.files[0];
  const visiblePatch = selectedFile?.patch.filter((line) => !hideWhitespaceOnly || line.kind === "context" || line.kind === "meta" || line.text.trim().length > 0) ?? [];
  const fileGroups = useMemo(() => {
    const groups = new Map<string, typeof filteredFiles>();
    for (const file of filteredFiles) {
      const slash = file.path.lastIndexOf("/");
      const directory = slash >= 0 ? file.path.slice(0, slash) : ".";
      groups.set(directory, [...(groups.get(directory) ?? []), file]);
    }
    return [...groups.entries()];
  }, [filteredFiles]);
  return (
    <div className={cn("grid min-h-[560px] w-full", showFileTree && "lg:grid-cols-[minmax(0,1fr)_280px]")}>
      <div className="min-w-0">
        {truncated ? <div className="mb-4 rounded-xl border border-amber-7 bg-amber-3 px-4 py-3 text-xs text-amber-11">{text("Some patches were truncated to keep this review responsive.", "部分补丁已截断，以保持审查页面流畅。")}</div> : null}
        {!selectedFile ? <EmptyTab>{text("No changed files were returned.", "没有返回变更文件。")}</EmptyTab> : <section className="overflow-hidden border-b border-dls-border bg-background">
          <header className="flex items-center gap-2 border-b border-dls-border bg-dls-hover/50 px-4 py-3"><FileCode2 className="size-4 text-dls-secondary" /><span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-dls-text">{selectedFile.path}</span><span className="text-[11px] text-green-11">+{selectedFile.additions}</span><span className="text-[11px] text-red-11">-{selectedFile.deletions}</span></header>
          {visiblePatch.length ? diffLayout === "unified" ? <div className="overflow-x-auto bg-[#0d1117] py-2 font-mono text-[12px] leading-5 text-[#c9d1d9]">
            {visiblePatch.map((line, index) => <div key={`${line.kind}-${index}`} className={cn("grid min-w-[720px] grid-cols-[46px_46px_1fr] px-2", line.kind === "addition" && "bg-[#1b4721]/55", line.kind === "deletion" && "bg-[#5a1e24]/55")}>
              <span className="select-none pr-2 text-right text-[#6e7681]">{line.oldLine ?? ""}</span><span className="select-none pr-3 text-right text-[#6e7681]">{line.newLine ?? ""}</span><code className={wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre"}>{line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}{line.text}</code>
            </div>)}
          </div> : <div className="overflow-x-auto bg-[#0d1117] py-2 font-mono text-[12px] leading-5 text-[#c9d1d9]">
            {visiblePatch.map((line, index) => line.kind === "meta" ? <div key={`meta-${index}`} className="min-w-[900px] bg-[#161b22] px-3 py-1 text-[#8b949e]">{line.text}</div> : <div key={`${line.kind}-${index}`} className="grid min-w-[900px] grid-cols-2 border-b border-white/5 last:border-b-0">
              <div className={cn("grid grid-cols-[46px_1fr] px-2", line.kind === "deletion" && "bg-[#5a1e24]/55")}><span className="select-none pr-2 text-right text-[#6e7681]">{line.kind === "addition" ? "" : line.oldLine ?? ""}</span><code className={cn(wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre", line.kind === "addition" && "opacity-0")}>{line.kind === "deletion" ? "-" : " "}{line.text}</code></div>
              <div className={cn("grid grid-cols-[46px_1fr] border-l border-white/10 px-2", line.kind === "addition" && "bg-[#1b4721]/55")}><span className="select-none pr-2 text-right text-[#6e7681]">{line.kind === "deletion" ? "" : line.newLine ?? ""}</span><code className={cn(wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre", line.kind === "deletion" && "opacity-0")}>{line.kind === "addition" ? "+" : " "}{line.text}</code></div>
            </div>)}
          </div> : <EmptyTab>{text("No text diff is available for this file.", "此文件没有可显示的文本差异。")}</EmptyTab>}
        </section>}
      </div>
      {showFileTree ? <aside className="border-t border-dls-border p-4 lg:border-l lg:border-t-0">
        {showFileSearch ? <label className="flex h-9 items-center gap-2 rounded-full border border-dls-border px-3">
          <Search className="size-4 text-dls-secondary" />
          <input ref={searchInputRef} value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-dls-secondary" placeholder={text("Filter files…", "筛选文件…")} />
        </label> : null}
        <div className="mt-4 space-y-1">
          {fileGroups.map(([directory, files]) => <div key={directory} className="pb-2"><div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-dls-secondary"><FolderOpen className="size-3.5" /><span className="truncate">{directory}</span></div>{files.map((file) => {
            const slash = file.path.lastIndexOf("/");
            const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
            return <button key={file.path} type="button" onClick={() => setSelectedPath(file.path)} className={cn("flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs transition-colors hover:bg-dls-hover", selectedFile?.path === file.path && "bg-dls-hover")}>
              <FileCode2 className="size-4 shrink-0 text-green-10" />
              <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{name}</span>
              <span className="shrink-0 text-green-11">+{file.additions}</span>
              <span className="shrink-0 text-red-11">-{file.deletions}</span>
            </button>;
          })}</div>)}
          {!filteredFiles.length ? <p className="px-3 py-6 text-center text-xs text-dls-secondary">{text("No matching files", "没有匹配的文件")}</p> : null}
        </div>
      </aside> : null}
    </div>
  );
}

function CheckIcon({ state }: { state: ReviewCheckState }) {
  if (state === "success") return <CheckCircle2 className="size-5 text-green-10" />;
  if (state === "failure") return <XCircle className="size-5 text-red-10" />;
  if (state === "running") return <Clock3 className="size-5 animate-pulse text-blue-10" />;
  return <Circle className="size-5 text-dls-secondary" />;
}

function ChecksView({ review }: { review: ReviewPreview }) {
  const passed = review.checks.filter((check) => check.state === "success").length;
  return (
    <div className="mx-auto w-full max-w-4xl p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between"><div><h3 className="text-sm font-semibold text-dls-text">{text("Checks", "检查")}</h3><p className="mt-1 text-xs text-dls-secondary">{passed} / {review.checks.length} {text("checks passed", "项检查通过")}</p></div><Badge variant={passed === review.checks.length ? "secondary" : "outline"}>{passed === review.checks.length ? text("All passed", "全部通过") : text("In progress", "进行中")}</Badge></div>
      <div className="overflow-hidden rounded-2xl border border-dls-border bg-background">
        {!review.checks.length ? <EmptyTab>{text("No checks are available for this revision.", "当前版本没有可用检查。")}</EmptyTab> : null}
        {review.checks.map((check, index) => <div key={check.id} className={cn("flex items-center gap-3 px-4 py-4", index > 0 && "border-t border-dls-border")}><CheckIcon state={check.state} /><div className="min-w-0 flex-1"><p className="text-sm font-medium text-dls-text">{check.name}</p><p className="mt-0.5 truncate text-xs text-dls-secondary">{check.detail}</p></div>{check.duration ? <span className="text-xs text-dls-secondary">{check.duration}</span> : null}</div>)}
      </div>
    </div>
  );
}

function ThreadsView({ review }: { review: ReviewPreview }) {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-6">
      {!review.threads.length ? <EmptyTab>{text("No review threads yet.", "暂无审查讨论。")}</EmptyTab> : null}
      {review.threads.map((thread) => <article key={thread.id} className={cn("rounded-2xl border bg-background p-4", thread.resolved ? "border-dls-border opacity-75" : "border-dls-border")}><div className="flex items-center gap-2"><span className="flex size-7 items-center justify-center rounded-full bg-dls-hover text-[10px] font-semibold">{thread.initials}</span><span className="text-xs font-semibold text-dls-text">{thread.author}</span><span className="text-[11px] text-dls-secondary">{thread.age}</span>{thread.reviewDecision ? <Badge variant="secondary" className="ml-auto">{thread.reviewDecision === "approved" ? text("Approved", "已批准") : text("Changes requested", "请求修改")}</Badge> : null}{thread.resolved ? <Badge variant="secondary" className="ml-auto">{text("Resolved", "已解决")}</Badge> : null}</div>{thread.path ? <div className="mt-3 rounded-lg bg-dls-hover px-3 py-2 font-mono text-[11px] text-dls-secondary">{thread.path}{thread.line ? `:${thread.line}` : ""}</div> : null}{(thread.comments?.length ? thread.comments : [{ id: thread.id, author: thread.author, body: thread.body, age: thread.age }]).map((comment, index) => <div key={comment.id} className={cn("mt-3", index > 0 && "border-t border-dls-border pt-3")}>{index > 0 ? <p className="text-xs text-dls-secondary">{comment.author} · {comment.age}</p> : null}<p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-dls-text">{comment.body}</p></div>)}</article>)}
      <div className="rounded-2xl border border-dashed border-dls-border p-5 text-center text-xs text-dls-secondary">{text("Use Submit review to publish a review or discussion comment to GitHub.", "接入平台写权限后，可回复或解决讨论。")}</div>
    </div>
  );
}

function DetailState(props: { loading?: boolean; error?: boolean; onRetry?: () => void }) {
  return <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-dls-secondary">{props.loading ? <><LoaderCircle className="size-6 animate-spin" /><span>{text("Loading pull request…", "正在加载拉取请求…")}</span></> : <><AlertCircle className="size-6 text-amber-10" /><span>{text("This section could not be loaded.", "无法加载此内容。")}</span>{props.onRetry ? <Button variant="outline" onClick={props.onRetry}><RefreshCw />{text("Retry", "重试")}</Button> : null}</>}</div>;
}

function ReviewDetail({ review, unknown, loading, actions, endpoint, operations, viewerLogin, viewerAvatarUrl, isOwnPullRequest, pinned, onTogglePin, onChanged, tab, onTabChange, tabLoading, tabError, truncated, revisionChanged, onRetryTab, onBack }: { review: ReviewPreview | null; unknown: boolean; loading?: boolean; actions?: ReactNode; endpoint?: ReturnType<typeof useReviewWorkspaceEndpoint>["endpoint"]; operations?: ReviewConnectionStatus["operations"]; viewerLogin?: string; viewerAvatarUrl?: string; isOwnPullRequest?: boolean; pinned?: boolean; onTogglePin?: () => void; onChanged?: () => void | Promise<void>; tab: ReviewDetailTab; onTabChange: (tab: ReviewDetailTab) => void; tabLoading?: boolean; tabError?: boolean; truncated?: boolean; revisionChanged?: boolean; onRetryTab?: () => void; onBack: () => void }) {
  const [showFileTree, setShowFileTree] = useState(true);
  const [showFileSearch, setShowFileSearch] = useState(true);
  const [diffLayout, setDiffLayout] = useState<ReviewDiffLayout>("unified");
  const [hideWhitespaceOnly, setHideWhitespaceOnly] = useState(false);
  const [wrapDiffLines, setWrapDiffLines] = useState(false);

  useEffect(() => {
    setShowFileTree(true);
    setShowFileSearch(true);
    setDiffLayout("unified");
    setHideWhitespaceOnly(false);
    setWrapDiffLines(false);
  }, [review?.id]);

  const copyChangedFilePaths = async () => {
    if (!review) return;
    await navigator.clipboard.writeText(review.files.map((file) => file.path).join("\n"));
    toast.success(text("Changed file paths copied.", "已复制变更文件路径。"));
  };

  const copyDiff = async () => {
    if (!review) return;
    const value = review.files.map((file) => [`diff -- ${file.path}`, ...file.patch.map((line) => `${line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}${line.text}`)].join("\n")).join("\n\n");
    await navigator.clipboard.writeText(value);
    toast.success(text("Pull request diff copied.", "已复制 Pull Request 差异。"));
  };

  const viewSwitcher = review && (tab === "summary" || tab === "changes") ? <div className="flex shrink-0 rounded-full border border-dls-border bg-dls-hover/50 p-0.5" role="tablist" aria-label={text("Pull request view", "Pull Request 视图")}>
    <button type="button" role="tab" aria-selected={tab === "summary"} className={cn("h-7 rounded-full px-3.5 text-[13px] transition-colors", tab === "summary" ? "bg-background font-medium text-dls-text shadow-sm" : "text-dls-secondary hover:text-dls-text")} onClick={() => onTabChange("summary")}>{text("Summary", "摘要")}</button>
    <button type="button" role="tab" aria-selected={tab === "changes"} className={cn("flex h-7 items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-colors", tab === "changes" ? "bg-background font-medium text-dls-text shadow-sm" : "text-dls-secondary hover:text-dls-text")} onClick={() => onTabChange("changes")}><span>{text("Changes", "变更")}</span><span className="text-green-11">+{review.additions}</span><span className="text-red-11">-{review.deletions}</span></button>
  </div> : null;

  const changesTools = review && tab === "changes" ? <div className="flex h-8 shrink-0 items-center rounded-full border border-dls-border bg-background p-0.5 shadow-sm" aria-label={text("Changes tools", "变更工具")}>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="size-7 rounded-full" aria-label={text("More changes actions", "更多变更操作")} />}><Ellipsis /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onClick={() => void copyChangedFilePaths()}><Copy />{text("Copy changed file paths", "复制变更文件路径")}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void copyDiff()}><FileCode2 />{text("Copy pull request diff", "复制 Pull Request 差异")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <DropdownMenu>
      <ReviewToolbarTip label={text("Diff display options", "差异显示选项")}><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="size-7 rounded-full" aria-label={text("Diff display options", "差异显示选项")} />}><ListFilter /></DropdownMenuTrigger></ReviewToolbarTip>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>{text("Diff display", "差异显示")}</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={hideWhitespaceOnly} onCheckedChange={setHideWhitespaceOnly}>{text("Hide whitespace-only lines", "隐藏仅空白字符的变更")}</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={wrapDiffLines} onCheckedChange={setWrapDiffLines}><WrapText />{text("Wrap long lines", "长行自动换行")}</DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <ReviewToolbarTip label={showFileSearch ? text("Hide file search", "隐藏文件搜索") : text("Search changed files", "搜索变更文件")}><Button variant="ghost" size="icon-sm" className={cn("size-7 rounded-full", showFileSearch && "bg-dls-hover")} aria-label={showFileSearch ? text("Hide file search", "隐藏文件搜索") : text("Search changed files", "搜索变更文件")} aria-pressed={showFileSearch} onClick={() => { setShowFileTree(true); setShowFileSearch((value) => !value); }}><FileSearch /></Button></ReviewToolbarTip>
    <ReviewToolbarTip label={diffLayout === "unified" ? text("Use split diff", "切换为并排差异") : text("Use unified diff", "切换为统一差异")}><Button variant="ghost" size="icon-sm" className={cn("size-7 rounded-full", diffLayout === "split" && "bg-dls-hover")} aria-label={diffLayout === "unified" ? text("Use split diff", "切换为并排差异") : text("Use unified diff", "切换为统一差异")} aria-pressed={diffLayout === "split"} onClick={() => setDiffLayout((value) => value === "unified" ? "split" : "unified")}><Columns2 /></Button></ReviewToolbarTip>
    <ReviewToolbarTip label={showFileTree ? text("Hide file tree", "隐藏文件树") : text("Show file tree", "显示文件树")}><Button variant="ghost" size="icon-sm" className={cn("size-7 rounded-full", showFileTree && "bg-blue-4 text-blue-11")} aria-label={showFileTree ? text("Hide file tree", "隐藏文件树") : text("Show file tree", "显示文件树")} aria-pressed={showFileTree} onClick={() => setShowFileTree((value) => !value)}><FolderOpen /></Button></ReviewToolbarTip>
  </div> : null;

  return (
    <main className={cn("min-h-0 min-w-0 flex-1 flex-col bg-background", review || unknown || loading ? "flex" : "hidden md:flex")}>
      {loading ? <DetailState loading /> : unknown ? <UnknownDetail onBack={onBack} /> : review ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ReviewHeader review={review} onBack={onBack} actions={actions} endpoint={endpoint} operations={operations} pinned={pinned} onTogglePin={onTogglePin} onChanged={onChanged} viewSwitcher={viewSwitcher} changesTools={changesTools} showDetails={tab !== "changes"} />
          <div>
            {tab !== "summary" && tab !== "changes" ? <div className="border-b border-dls-border px-5 py-2 md:px-6"><Button variant="ghost" size="sm" onClick={() => onTabChange("summary")}><ArrowLeft />{text("Back to pull request", "返回 Pull Request")}</Button></div> : null}
            {revisionChanged ? <div className="m-4 rounded-xl border border-amber-7 bg-amber-3 px-4 py-3 text-xs text-amber-11">{text("The pull request revision changed while this tab was loading. Refresh before relying on line positions.", "加载期间拉取请求版本发生变化，请刷新后再依赖行位置。")}</div> : null}
            {tabLoading || tabError ? <DetailState loading={tabLoading} error={tabError} onRetry={onRetryTab} /> : null}
            {!tabLoading && !tabError && tab === "summary" ? <SummaryView review={review} endpoint={endpoint} operations={operations} viewerLogin={viewerLogin} viewerAvatarUrl={viewerAvatarUrl} isOwnPullRequest={isOwnPullRequest} onChanged={onChanged} onTabChange={onTabChange} /> : null}
            {!tabLoading && !tabError && tab === "changes" ? <ChangesView review={review} truncated={truncated} showFileTree={showFileTree} showFileSearch={showFileSearch} diffLayout={diffLayout} hideWhitespaceOnly={hideWhitespaceOnly} wrapLines={wrapDiffLines} /> : null}
            {!tabLoading && !tabError && tab === "checks" ? <ChecksView review={review} /> : null}
            {!tabLoading && !tabError && tab === "threads" ? <ThreadsView review={review} /> : null}
          </div>
        </div>
      ) : <EmptyDetail />}
    </main>
  );
}

export function ReviewPage(props: ReviewPageProps) {
  const queryClient = useQueryClient();
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);
  const { leftSidebarResizing, leftSidebarWidth, startLeftSidebarResize } = useWorkspaceShellLayout({ expandedRightWidth: 520 });
  const pageStyle = {
    "--jugglework-left-sidebar-width": appInsetSidebarCssWidth(leftSidebarWidth),
  } as CSSProperties;
  const [query, setQuery] = useState("");
  const [expandedSections, setExpandedSections] = useState<ReviewInboxSectionKey[]>(["pinned", "authored"]);
  const [inboxPreferences, setInboxPreferences] = useState(readReviewInboxPreferences);
  const [tab, setTab] = useState<ReviewDetailTab>("summary");
  // Bind the panel to a concrete PR instead of keeping a page-global boolean.
  // This prevents a late query response from one PR appearing in another PR's
  // conversation when the selection changes quickly.
  const [reviewPanelReviewId, setReviewPanelReviewId] = useState<string | null>(null);
  const [reviewPanelLayout, setReviewPanelLayout] = useState<ReviewConversationLayout>("minimized");
  const [reviewRequestId, setReviewRequestId] = useState(0);
  const [dismissedReviewPanels, setDismissedReviewPanels] = useState<Set<string>>(() => new Set());
  const [pinnedReviewState, setPinnedReviewState] = useState<PinnedReviewState>(() => readPinnedReviews(props.workspaceId));
  useEffect(() => setPinnedReviewState(readPinnedReviews(props.workspaceId)), [props.workspaceId]);
  const pinnedReviewIds = pinnedReviewState.ids;
  const togglePinnedReview = (review: ReviewPreview) => setPinnedReviewState((current) => {
    const removing = current.ids.includes(review.id);
    const next = removing
      ? { ids: current.ids.filter((id) => id !== review.id), reviews: current.reviews.filter((item) => item.id !== review.id) }
      : {
          ids: [review.id, ...current.ids.filter((id) => id !== review.id)].slice(0, 100),
          reviews: [pinnedReviewSnapshot(review), ...current.reviews.filter((item) => item.id !== review.id)].slice(0, 100),
        };
    localStorage.setItem(pinnedStorageKey(props.workspaceId), JSON.stringify(next));
    return next;
  });
  const deferredQuery = useDeferredValue(query);
  const workspace = useReviewWorkspaceEndpoint(props.workspaceId, props.active);
  useEffect(() => { setExpandedSections(["pinned", "authored"]); }, [props.workspaceId, workspace.endpoint]);
  useEffect(() => { setReviewPanelReviewId(null); setReviewRequestId(0); setDismissedReviewPanels(new Set()); }, [props.workspaceId]);
  const toggleInboxSection = (relationship: ReviewInboxSectionKey) => setExpandedSections((current) => current.includes(relationship) ? current.filter((item) => item !== relationship) : [...current, relationship]);
  const updateInboxPreferences = (next: { viewMode: ReviewInboxViewMode; visibleSections: ReviewRelationship[] }) => {
    setInboxPreferences(next);
    localStorage.setItem(REVIEW_INBOX_PREFERENCES_KEY, JSON.stringify(next));
  };
  const toggleInboxSectionVisibility = (relationship: ReviewRelationship) => updateInboxPreferences({
    ...inboxPreferences,
    visibleSections: inboxPreferences.visibleSections.includes(relationship)
      ? inboxPreferences.visibleSections.filter((item) => item !== relationship)
      : INBOX_SECTIONS.map((section) => section.value).filter((item) => item === relationship || inboxPreferences.visibleSections.includes(item)),
  });
  const connection = useReviewConnection(workspace.endpoint, props.active);
  const inboxReady = connection.data?.state === "ready";
  const authoredInbox = useReviewInbox(workspace.endpoint, { active: props.active && inboxPreferences.visibleSections.includes("authored") && expandedSections.includes("authored"), ready: inboxReady, relationship: "authored", query: deferredQuery });
  const requestedInbox = useReviewInbox(workspace.endpoint, { active: props.active && inboxPreferences.visibleSections.includes("requested") && expandedSections.includes("requested"), ready: inboxReady, relationship: "review_requested", query: deferredQuery });
  const teamInbox = useReviewInbox(workspace.endpoint, { active: props.active && inboxPreferences.visibleSections.includes("team") && expandedSections.includes("team"), ready: inboxReady, relationship: "team_review_requested", query: deferredQuery });
  const mergedInbox = useReviewInbox(workspace.endpoint, { active: props.active && inboxPreferences.visibleSections.includes("recently_merged") && expandedSections.includes("recently_merged"), ready: inboxReady, relationship: "recently_merged", query: deferredQuery });
  const detail = useReviewDetail(workspace.endpoint, props.reviewId, props.active);
  const selectedReviewActive = props.active && Boolean(props.reviewId);
  const files = useReviewFiles(workspace.endpoint, props.reviewId, selectedReviewActive && tab === "changes");
  const checks = useReviewChecks(workspace.endpoint, props.reviewId, selectedReviewActive);
  const threads = useReviewThreads(workspace.endpoint, props.reviewId, selectedReviewActive);
  const listItems = useMemo(() => [authoredInbox.data, requestedInbox.data, teamInbox.data, mergedInbox.data].flatMap((data) => data?.pages.flatMap((page) => page.items) ?? []), [authoredInbox.data, mergedInbox.data, requestedInbox.data, teamInbox.data]);
  const selectedItem = detail.data?.item ?? listItems.find((item) => item.id === props.reviewId) ?? null;
  const selectedReviewIsAuthored = Boolean(selectedItem && (
    connection.data?.accountLogin?.toLocaleLowerCase() === selectedItem.author.login.toLocaleLowerCase()
    || selectedItem.relationships.includes("authored")
    || authoredInbox.data?.pages.some((page) => page.items.some((item) => item.id === selectedItem.id))
  ));
  const review = useMemo(() => selectedItem ? { ...reviewViewModel({ item: selectedItem, detail: detail.data, files: files.data, checks: checks.data, threads: threads.data }), pinned: pinnedReviewIds.includes(selectedItem.id) } : null, [checks.data, detail.data, files.data, pinnedReviewIds, selectedItem, threads.data]);
  useEffect(() => {
    if (!review) {
      setReviewPanelReviewId(null);
      setReviewRequestId(0);
      return;
    }
    if (dismissedReviewPanels.has(review.id) || reviewPanelReviewId === review.id) return;
    setReviewPanelReviewId(review.id);
    setReviewPanelLayout("minimized");
    setReviewRequestId(0);
  }, [dismissedReviewPanels, review, reviewPanelReviewId]);
  const reviewsFor = (data: typeof authoredInbox.data) => (data?.pages.flatMap((page) => page.items) ?? []).map((item) => ({ ...reviewViewModel({ item }), pinned: pinnedReviewIds.includes(item.id) })).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const pinnedReviews = useMemo(() => {
    const available = new Map(pinnedReviewState.reviews.map((item) => [item.id, item]));
    for (const item of listItems) available.set(item.id, reviewViewModel({ item }));
    if (review) available.set(review.id, review);
    return pinnedReviewIds
      .map((id) => available.get(id))
      .filter((item): item is ReviewPreview => Boolean(item))
      .map((item) => ({ ...item, pinned: true }))
      .filter((item) => reviewMatches(item, deferredQuery, "all"));
  }, [deferredQuery, listItems, pinnedReviewIds, pinnedReviewState.reviews, review]);
  const inboxSections: ReviewInboxSectionState[] = [
    ...(pinnedReviews.length ? [{ relationship: "pinned" as const, reviews: pinnedReviews }] : []),
    { relationship: "authored", reviews: reviewsFor(authoredInbox.data), loading: authoredInbox.isLoading, refreshing: authoredInbox.isFetching && !authoredInbox.isLoading, error: authoredInbox.error instanceof Error ? authoredInbox.error.message : null, hasNextPage: authoredInbox.hasNextPage, loadingNextPage: authoredInbox.isFetchingNextPage, onLoadMore: () => void authoredInbox.fetchNextPage(), onRetry: () => void authoredInbox.refetch() },
    { relationship: "requested", reviews: reviewsFor(requestedInbox.data), loading: requestedInbox.isLoading, refreshing: requestedInbox.isFetching && !requestedInbox.isLoading, error: requestedInbox.error instanceof Error ? requestedInbox.error.message : null, hasNextPage: requestedInbox.hasNextPage, loadingNextPage: requestedInbox.isFetchingNextPage, onLoadMore: () => void requestedInbox.fetchNextPage(), onRetry: () => void requestedInbox.refetch() },
    { relationship: "team", reviews: reviewsFor(teamInbox.data), loading: teamInbox.isLoading, refreshing: teamInbox.isFetching && !teamInbox.isLoading, error: teamInbox.error instanceof Error ? teamInbox.error.message : null, hasNextPage: teamInbox.hasNextPage, loadingNextPage: teamInbox.isFetchingNextPage, onLoadMore: () => void teamInbox.fetchNextPage(), onRetry: () => void teamInbox.refetch() },
    { relationship: "recently_merged", reviews: reviewsFor(mergedInbox.data), loading: mergedInbox.isLoading, refreshing: mergedInbox.isFetching && !mergedInbox.isLoading, error: mergedInbox.error instanceof Error ? mergedInbox.error.message : null, hasNextPage: mergedInbox.hasNextPage, loadingNextPage: mergedInbox.isFetchingNextPage, onLoadMore: () => void mergedInbox.fetchNextPage(), onRetry: () => void mergedInbox.refetch() },
  ];
  const unknown = props.reviewId !== null && detail.isError;
  const tabQuery = tab === "changes" ? files : tab === "checks" ? checks : tab === "threads" ? threads : detail;
  useEffect(() => setTab("summary"), [props.reviewId]);

  return (
    <div
      className="flex h-full min-h-0 w-full overflow-hidden bg-dls-sidebar mac:titlebar-drag"
      style={pageStyle}
      data-testid="review-page"
      data-workspace-id={props.workspaceId}
    >
      <AppNavigationRail
        workspaceId={props.workspaceId}
        reviewsActive
        onOpenAccount={props.onOpenAccount}
        onOpenHome={props.onOpenHome}
        onOpenApps={props.onOpenApps}
        onOpenChat={props.onOpenChat}
        onOpenReviews={() => undefined}
        onOpenSettings={props.onOpenSettings}
        onOpenTaskSearch={props.onOpenTaskSearch}
        onOpenCreateWorkspace={props.onOpenCreateWorkspace}
      />
      <AppSecondarySidebarTopControls
        sidebarOpen={sidebarOpen}
        onOpenTaskSearch={props.onOpenTaskSearch}
        onToggleSidebar={toggleSidebar}
      />
      <AppInsetSurface className="relative" testId="review-inset-surface">
        {workspace.loading || connection.isLoading ? <ConnectedState loading /> : connection.data?.state !== "ready" ? <ReviewGitHubConnection key={props.workspaceId} connectionId={connection.data?.connectionId} onConnected={() => { void connection.refetch(); }}>
          {(open) => <ConnectedState connection={connection.data} error={workspace.error ?? (connection.error instanceof Error ? connection.error.message : null)} onConnect={connection.data?.state === "disabled_in_workspace" ? props.onOpenConnect : open} onRetry={() => void connection.refetch()} />}
        </ReviewGitHubConnection> : (
          <ReviewWorkbench
          endpoint={workspace.endpoint}
          operations={connection.data.operations}
          viewerLogin={connection.data.accountLogin ?? (selectedReviewIsAuthored ? review?.author : undefined)}
          viewerAvatarUrl={connection.data.accountAvatarUrl ?? (selectedReviewIsAuthored ? review?.authorAvatarUrl : undefined)}
          isOwnPullRequest={selectedReviewIsAuthored}
          pinned={Boolean(review?.pinned)}
          onTogglePin={() => { if (review) togglePinnedReview(review); }}
          onChanged={async () => {
            if (!workspace.endpoint) return;
            await queryClient.invalidateQueries({ queryKey: ["reviews", workspace.endpoint.baseUrl, workspace.endpoint.workspaceId] });
          }}
          actions={workspace.endpoint && review ? <ReviewWorkflowControls
            key={`${workspace.endpoint.baseUrl}:${workspace.endpoint.workspaceId}:${review.id}`}
            endpoint={workspace.endpoint} review={review} isOwnPullRequest={selectedReviewIsAuthored} active={props.active}
            operations={connection.data.operations}
            onOpenSession={(id) => props.onOpenReviewSession?.(id)}
            onOpenReviewPanel={() => {
              setDismissedReviewPanels((current) => {
                const next = new Set(current);
                next.delete(review.id);
                return next;
              });
              setReviewPanelReviewId(review.id);
              setReviewPanelLayout("right");
              setReviewRequestId(Date.now());
            }}
          /> : undefined}
          reviewPanel={reviewPanelReviewId === review?.id && workspace.endpoint && review ? <ReviewConversationPanel
            endpoint={workspace.endpoint}
            review={review}
            active={props.active}
            layout={reviewPanelLayout}
            reviewRequestId={reviewRequestId}
            onLayoutChange={setReviewPanelLayout}
            onClose={() => {
              setDismissedReviewPanels((current) => new Set(current).add(review.id));
              setReviewPanelReviewId(null);
            }}
          /> : undefined}
          reviewPanelPlacement={reviewPanelLayout}
          sections={inboxSections}
          expandedSections={expandedSections}
          pinnedReviews={pinnedReviews}
          visibleSections={inboxPreferences.visibleSections}
          viewMode={inboxPreferences.viewMode}
          reviewId={props.reviewId}
          query={query}
          review={review}
          unknown={unknown}
          loading={Boolean(props.reviewId && detail.isLoading)}
          tab={tab}
          onTabChange={setTab}
          tabLoading={tab !== "summary" && tabQuery.isLoading}
          tabError={tab !== "summary" && tabQuery.isError}
          truncated={tab === "changes" ? files.data?.truncated : tab === "threads" ? threads.data?.truncated : false}
          revisionChanged={tab !== "summary" && Boolean((tab === "changes" ? files.data?.headRevision : tab === "checks" ? checks.data?.headRevision : threads.data?.headRevision) && detail.data?.item.headRevision !== "unknown" && (tab === "changes" ? files.data?.headRevision : tab === "checks" ? checks.data?.headRevision : threads.data?.headRevision) !== "unknown" && (tab === "changes" ? files.data?.headRevision : tab === "checks" ? checks.data?.headRevision : threads.data?.headRevision) !== detail.data?.item.headRevision)}
          onRetryTab={() => void tabQuery.refetch()}
          onQueryChange={setQuery}
          onToggleSection={toggleInboxSection}
          onToggleSectionVisibility={toggleInboxSectionVisibility}
          onViewModeChange={(viewMode) => updateInboxPreferences({ ...inboxPreferences, viewMode })}
          onSelectReview={props.onSelectReview}
          sidebarOpen={sidebarOpen}
          />
        )}
        {connection.data?.state === "ready" && sidebarOpen ? (
          <AppSecondarySidebarResizeHandle
            resizing={leftSidebarResizing}
            onPointerDown={startLeftSidebarResize}
          />
        ) : null}
      </AppInsetSurface>
    </div>
  );
}

export function ReviewWorkbench(props: {
  actions?: ReactNode;
  reviewPanel?: ReactNode;
  reviewPanelPlacement?: ReviewConversationLayout;
  endpoint?: ReturnType<typeof useReviewWorkspaceEndpoint>["endpoint"];
  operations?: ReviewConnectionStatus["operations"];
  viewerLogin?: string;
  viewerAvatarUrl?: string;
  isOwnPullRequest?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  onChanged?: () => void | Promise<void>;
  sections: ReviewInboxSectionState[];
  expandedSections: ReviewInboxSectionKey[];
  pinnedReviews?: ReviewPreview[];
  visibleSections?: ReviewRelationship[];
  viewMode?: ReviewInboxViewMode;
  reviewId: string | null;
  query: string;
  review: ReviewPreview | null;
  unknown: boolean;
  loading?: boolean;
  tab?: ReviewDetailTab;
  onTabChange?: (tab: ReviewDetailTab) => void;
  tabLoading?: boolean;
  tabError?: boolean;
  truncated?: boolean;
  revisionChanged?: boolean;
  onRetryTab?: () => void;
  onQueryChange: (query: string) => void;
  onToggleSection: (relationship: ReviewInboxSectionKey) => void;
  onToggleSectionVisibility?: (relationship: ReviewRelationship) => void;
  onViewModeChange?: (viewMode: ReviewInboxViewMode) => void;
  onSelectReview: (reviewId: string | null) => void;
  sidebarOpen?: boolean;
}) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="review-workbench">
      <div className={cn(
        "h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-linear",
        props.sidebarOpen !== false ? "w-full md:w-[var(--jugglework-left-sidebar-width)]" : "w-0",
        props.reviewId && "hidden md:block",
      )} data-app-secondary-sidebar-frame>
      {props.sidebarOpen !== false ? <ReviewInbox
        sections={props.sections}
        expandedSections={props.expandedSections}
        pinnedReviews={props.pinnedReviews ?? []}
        visibleSections={props.visibleSections ?? INBOX_SECTIONS.map((section) => section.value)}
        viewMode={props.viewMode ?? "detailed"}
        reviewId={props.reviewId}
        query={props.query}
        onQueryChange={props.onQueryChange}
        onToggleSection={props.onToggleSection}
        onToggleSectionVisibility={props.onToggleSectionVisibility ?? (() => undefined)}
        onViewModeChange={props.onViewModeChange ?? (() => undefined)}
        onSelectReview={props.onSelectReview}
      /> : null}
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="review-detail-region">
        {props.reviewPanelPlacement === "left" ? props.reviewPanel : null}
        {props.reviewPanelPlacement !== "full" ? <ReviewDetail actions={props.actions} endpoint={props.endpoint} operations={props.operations} viewerLogin={props.viewerLogin} viewerAvatarUrl={props.viewerAvatarUrl} isOwnPullRequest={props.isOwnPullRequest} pinned={props.pinned} onTogglePin={props.onTogglePin} onChanged={props.onChanged} review={props.review} unknown={props.unknown} loading={props.loading} tab={props.tab ?? "summary"} onTabChange={props.onTabChange ?? (() => undefined)} tabLoading={props.tabLoading} tabError={props.tabError} truncated={props.truncated} revisionChanged={props.revisionChanged} onRetryTab={props.onRetryTab} onBack={() => props.onSelectReview(null)} /> : null}
        {props.reviewPanelPlacement !== "left" ? props.reviewPanel : null}
      </div>
    </div>
  );
}

export function ConnectedState(props: { loading?: boolean; connection?: ReviewConnectionStatus; error?: string | null; onConnect?: () => void; onRetry?: () => void }) {
  const state = props.connection?.state;
  const requiresAdministrator = state === "not_connected"
    || state === "organization_admin_action_required"
    || state === "provider_admin_action_required";
  if (!props.loading && !props.error && (requiresAdministrator || state === "member_authorization_required")) {
    return (
      <section
        className="relative isolate flex min-h-0 min-w-0 flex-1 overflow-y-auto bg-dls-surface px-6 py-12 mac:titlebar-no-drag sm:px-10"
        aria-labelledby="review-setup-title"
        data-testid="review-connection-state"
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden font-mono text-3xl text-dls-text/[0.025] select-none">
          <span className="absolute left-[4%] top-[8%] -rotate-12">{"{ / }"}</span>
          <span className="absolute bottom-[12%] left-[6%] rotate-12">{"< + >"}</span>
          <span className="absolute right-[5%] top-[24%] rotate-12">{"( )"}</span>
          <span className="absolute bottom-[8%] right-[7%] -rotate-12">{"[ ; ]"}</span>
        </div>
        <div className="relative m-auto flex w-full max-w-xl flex-col items-center text-center" data-testid="review-github-setup">
          <div aria-hidden="true" className="mb-7 flex size-14 items-center justify-center rounded-2xl bg-black text-white sm:mb-8 sm:size-16 sm:rounded-[18px]">
            <GitPullRequestArrow className="size-9 sm:size-10" strokeWidth={2.25} />
          </div>
          <h1 id="review-setup-title" className="text-2xl font-semibold tracking-tight text-dls-text sm:text-[28px] sm:leading-9">
            {text("Code review", "代码审查")}
          </h1>
          <p className="mt-4 text-sm leading-6 text-dls-text sm:text-base">
            {requiresAdministrator
              ? text(
                "Code Review only uses GitHub connections provided by your organization. Ask an organization administrator to add and configure GitHub.",
                "代码评审只使用组织下发的 GitHub 连接。请联系组织管理员添加并配置 GitHub。",
              )
              : text(
                "Your organization provides GitHub. Authorize your account in Connect settings to start reviewing pull requests.",
                "你的组织已提供 GitHub。请在连接设置中授权你的账号，然后开始评审 Pull Request。",
              )}
          </p>
          <Button size="lg" className="mt-7 h-10 w-48 max-w-full gap-2 rounded-full text-sm sm:mt-8" onClick={props.onConnect}>
            {text("Open Connect settings", "打开连接设置")}
          </Button>
        </div>
      </section>
    );
  }
  const unavailable = !props.loading && (!state || state === "unavailable");
  const title = props.loading
    ? text("Checking GitHub connection…", "正在检查 GitHub 连接…")
    : state === "disabled_in_workspace"
      ? text("GitHub is disabled for this workspace", "当前工作区已停用 GitHub")
      : state === "organization_admin_action_required" || state === "provider_admin_action_required"
        ? text("GitHub needs administrator setup", "GitHub 需要管理员配置")
        : unavailable
          ? text("GitHub connection needs attention", "需要检查 GitHub 连接")
          : text("Connect your GitHub account", "连接你的 GitHub 账号");
  const description = props.connection?.hint
    ?? props.error
    ?? (unavailable
      ? text(
        "Open Connect settings to check whether GitHub is available to you and authorize your account, then retry.",
        "请打开连接设置，检查组织是否已提供 GitHub，并授权你自己的 GitHub 账号，然后重试。",
      )
      : text(
        "JuggleWork uses your member-authorized GitHub account through Connect.",
        "JuggleWork 通过 Connect 使用你本人授权的 GitHub 账号。",
      ));

  return <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-dls-surface/40 p-8" data-testid="review-connection-state"><div className="max-w-md rounded-2xl border border-dls-border bg-background p-7 text-center shadow-[var(--dls-card-shadow)]">{props.loading ? <LoaderCircle className="mx-auto size-7 animate-spin text-violet-11" /> : <GitPullRequestArrow className="mx-auto size-8 text-violet-11" />}<h2 className="mt-4 text-base font-semibold text-dls-text">{title}</h2><p className="mt-2 text-sm leading-6 text-dls-secondary">{description}</p><div className="mt-5 flex flex-wrap justify-center gap-2">{!props.loading ? <Button onClick={props.onConnect}>{text("Open Connect settings", "打开连接设置")}</Button> : null}{unavailable ? <Button variant="outline" onClick={props.onRetry}><RefreshCw />{text("Retry", "重试")}</Button> : null}</div></div></div>;
}
