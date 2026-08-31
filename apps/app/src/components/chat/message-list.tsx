"use memo";

import * as React from "react"
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileIcon,
  LoaderCircle,
  NotebookTabs,
  Pencil,
  Split,
  Undo2,
} from "lucide-react"
import {
  DynamicToolUIPart,
  isFileUIPart,
  ToolUIPart,
  type FileUIPart,
  type UIMessage,
} from "ai"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { openDesktopUrl } from "@/app/lib/desktop"
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types"
import { ApplyPatchTool } from "@/components/tools/apply-patch"
import { BashTool } from "@/components/tools/bash"
import { EditTool } from "@/components/tools/edit"
import { EnvVarRequestTool } from "@/components/tools/env-var-request"
import { ReadFileTool, WriteFileTool } from "@/components/tools/file"
import { GlobTool } from "@/components/tools/glob"
import { GrepTool } from "@/components/tools/grep"
import { LspTool } from "@/components/tools/lsp"
import { JuggleWorkSessionCreateTool } from "@/components/tools/jugglework-session-create"
import { QuestionTool } from "@/components/tools/question"
import { SkillTool } from "@/components/tools/skill"
import { TodoWriteTool } from "@/components/tools/todowrite"
import { WebfetchTool } from "@/components/tools/webfetch"
import { WebsearchTool } from "@/components/tools/websearch"
import { useMessageList, useSessionErrorMessage } from "@/components/chat/message-list-provider"
import { ArtifactList } from "@/components/chat/artifact"
import { TaskSuggestions } from "@/components/chat/task-suggestions"
import {
  DescriptiveButtonContent,
  DescriptiveButtonDescription,
  DescriptiveButtonIcon,
  DescriptiveButtonTitle,
} from "@/components/descriptive-button"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { ImageAttachmentBadge } from "@/components/chat/image-attachment-badge"
import { Image } from "@/components/ui/image"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ui/message"
import { Tool } from "@/components/ui/tool"
import { redactSensitiveCommand } from "@/components/chat/reasoning-redaction"
import {
  isApplyPatchToolPart,
  isBashToolPart,
  isEditToolPart,
  isEnvVarRequestToolPart,
  isGlobToolPart,
  isGrepToolPart,
  isLspToolPart,
  isQuestionToolPart,
  isReadToolPart,
  isSkillToolPart,
  isTaskToolPart,
  isTodoWriteToolPart,
  isWebFetchToolPart,
  isWebSearchToolPart,
  isWriteToolPart,
} from "@/lib/build-in-tools"
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store"
import { useQueryCacheState } from "@/react-app/infra/query-cache-state"
import {
  taskHasPendingInteraction,
  type WorkspaceInteractionState,
  workspaceInteractionsKey,
} from "@/react-app/domains/session/sync/workspace-interactions"
import type { ThreadStatus } from "@/lib/messages"
import { getToolActivityLabel, isToolPartInFlight } from "@/lib/tool-activity"
import { cn } from "@/lib/utils"
import { getLiveActivityKind, liveActivityLabel } from "@/lib/live-activity"
import {
  CAPABILITY_INSTRUCTION_RE,
  composerCapabilityTagClassName,
  composerCapabilityTagTitlePrefix,
  parseCapabilityInstruction,
  type ComposerCapabilityKind,
} from "@/react-app/domains/session/surface/composer/capability-tags"
import { currentLocale, t } from "@/i18n"
import { groupMessages, isMessageGroup, getLastTextPart, getAssistantRenderGroups, getFileTitle, getMediaBadge, getMessageCreated, formatMessageTimestamp, formatTaskDuration, getTaskTiming, splitAssistantTaskMessages, mergeAssistantProcessItems, type UIMessageWithIndex, getMessagesText, getSafeFileDownloadUrl } from "./utils"
import {
  getSessionCompactionFromMessage,
  type SessionCompactionPresentation,
} from "@/app/lib/session-compaction"

const SEARCH_HIGHLIGHT_MARK_CLASS = "rounded px-0.5 bg-amber-4/70 text-current"
const EMPTY_WORKSPACE_INTERACTIONS: WorkspaceInteractionState = {
  permissions: [],
  questions: [],
  sessions: {},
  revision: 0,
  appliedSnapshotFences: {},
  invalidSnapshotBeforeRevision: 0,
  tombstones: {},
}

/**
 * 消息操作条（时间 + 复制/分支/回退图标）的显隐样式。
 *
 * TIPS: 操作条常驻会让每条消息多出一段视觉噪音，这里默认完全透明且不接收指针事件，
 * 仅在悬停所在消息（group/message-actions）或键盘聚焦到条内按钮时浮现；
 * 元素始终占位，避免悬停时产生布局抖动。
 */
const MESSAGE_ACTIONS_REVEAL_CLASS =
  "pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message-actions:pointer-events-auto group-hover/message-actions:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"

function TaskDuration({ messages, userMessageIndex, isStreaming }: {
  messages: UIMessage[]
  userMessageIndex: number
  isStreaming: boolean
}) {
  const timing = React.useMemo(
    () => getTaskTiming(messages, userMessageIndex, isStreaming),
    [messages, userMessageIndex, isStreaming],
  )
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!timing?.running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [timing?.running, timing?.startedAt])

  if (!timing) return null

  const endedAt = timing.running ? Math.max(timing.startedAt, now) : timing.endedAt
  const locale = currentLocale() === "zh" ? "zh" : "en"
  const label = locale === "zh" ? "耗时" : "Elapsed"
  const duration = formatTaskDuration(endedAt - timing.startedAt, locale)

  return (
    <span
      className="inline-flex items-center text-sm font-medium tracking-[-0.01em] tabular-nums text-muted-foreground"
      data-testid="task-duration"
      title={`${label}: ${duration}`}
    >
      {label} {duration}
    </span>
  )
}

function CompactionStatusRow({ state }: { state: SessionCompactionPresentation }) {
  const zh = currentLocale() === "zh"
  const label = state.running
    ? state.mode === "auto"
      ? (zh ? "上下文压缩中" : "Context compaction in progress")
      : (zh ? "正在压缩上下文" : "Compacting context")
    : state.mode === "auto"
      ? (zh ? "上下文已自动压缩" : "Context automatically compacted")
      : (zh ? "上下文已压缩" : "Context compacted")

  return (
    <div
      className="flex items-center gap-2 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
      data-testid="session-compaction-status"
    >
      <NotebookTabs className="size-4 shrink-0" strokeWidth={1.8} />
      <span className={cn("font-medium tracking-[-0.01em]", state.running && "live-activity-text")}>
        {label}
      </span>
    </div>
  )
}

function StandaloneManualCompactionTask({ state }: { state: SessionCompactionPresentation }) {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!state.running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [state.running, state.startedAt])

  const startedAt = state.startedAt ?? now
  const finishedAt = state.finishedAt ?? now
  const locale = currentLocale() === "zh" ? "zh" : "en"
  const duration = formatTaskDuration(Math.max(0, finishedAt - startedAt), locale)
  const processed = locale === "zh" ? `已处理 ${duration}` : `Processed for ${duration}`

  return (
    <div className="group/message-group mt-5 mx-auto w-full max-w-5xl px-3 md:px-8" data-testid="manual-compaction-task">
      {state.running ? (
        <div className="mb-5 border-b border-border/65 pb-3 text-sm font-medium tabular-nums text-muted-foreground">
          {processed}
        </div>
      ) : null}
      <CompactionStatusRow state={state} />
    </div>
  )
}

function MessageTimestamp({ message, className }: { message: UIMessage; className?: string }) {
  const created = getMessageCreated(message)
  if (created === null) return null

  return (
    <span
      className={cn(
        "select-none whitespace-nowrap text-[11px] tabular-nums text-muted-foreground/70",
        className
      )}
      title={new Date(created).toLocaleString()}
    >
      {formatMessageTimestamp(created)}
    </span>
  )
}

interface ToolMessageProps {
  part: ToolUIPart | DynamicToolUIPart
}

export function toolRunPreviewLabel(part: ToolUIPart | DynamicToolUIPart): string {
  if (isBashToolPart(part)) {
    const command = redactSensitiveCommand(part.input?.command).trim()
    const description = redactSensitiveCommand(part.input?.description).trim()
    return description || command || getToolActivityLabel(part)
  }

  return getToolActivityLabel(part)
}

function ToolRunGroup({
  parts,
  isStreaming,
}: {
  parts: Array<ToolUIPart | DynamicToolUIPart>
  isStreaming: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const firstRunningPart = parts.find(isToolPartInFlight)
  const previewPart = firstRunningPart ?? parts[0]
  if (!previewPart) return null

  const running = parts.some(isToolPartInFlight)
  const label = toolRunPreviewLabel(previewPart)

  React.useEffect(() => {
    if (!isStreaming) setOpen(false)
  }, [isStreaming])

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full" data-testid="task-tool-run">
      <CollapsibleTrigger
        className="group/tool-run flex w-full min-w-0 cursor-pointer items-center gap-2 py-0.5 text-left text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-2"
        aria-label={`${open ? "Collapse" : "Expand"} ${parts.length} tool ${parts.length === 1 ? "call" : "calls"}`}
        data-testid="task-tool-run-toggle"
      >
        {running ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : null}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronRight className="size-4 shrink-0 opacity-0 transition-all duration-200 group-hover/tool-run:opacity-100 group-data-panel-open/tool-run:rotate-90 group-data-panel-open/tool-run:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-200 ease-out data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="space-y-2 pb-1 pl-6 pt-2">
          {parts.map((part, index) => (
            <ToolMessage
              key={part.type === "dynamic-tool" ? part.toolCallId : `tool-${index}`}
              part={part}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Error boundary around tool-part rendering. Tool inputs from streamed or
 * interrupted runs can violate their type contracts (partial/undefined
 * input); without this boundary a single bad part unmounts the entire app
 * (white screen). Seen in production on v0.15.3 via a todowrite part with
 * missing input.todos.
 */
class ToolMessage extends React.Component<ToolMessageProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error("[tool-part] render failed", error)
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="text-xs text-muted-foreground">Tool step unavailable</div>
      )
    }
    return <ToolMessageInner part={this.props.part} />
  }
}

const ToolMessageInner = ({ part }: ToolMessageProps) => {
  const { onMcpReconnect, onMcpReopenAuthorization, onMcpRetry } = useMessageList()

  if (isBashToolPart(part)) {
    return <BashTool part={part} />
  }

  if (isEditToolPart(part)) {
    return <EditTool part={part} />
  }

  if (isWriteToolPart(part)) {
    return <WriteFileTool part={part} />
  }

  if (isReadToolPart(part)) {
    return <ReadFileTool part={part} />
  }

  if (isGrepToolPart(part)) {
    return <GrepTool part={part} />
  }

  if (isGlobToolPart(part)) {
    return <GlobTool part={part} />
  }

  if (isLspToolPart(part)) {
    return <LspTool part={part} />
  }

  if (isApplyPatchToolPart(part)) {
    return <ApplyPatchTool part={part} />
  }

  if (isSkillToolPart(part)) {
    return <SkillTool part={part} />
  }

  if (isTodoWriteToolPart(part)) {
    return <TodoWriteTool part={part} />
  }

  if (isTaskToolPart(part)) {
    return <TaskStatusTool part={part} />
  }

  if (isWebFetchToolPart(part)) {
    return <WebfetchTool part={part} />
  }

  if (isWebSearchToolPart(part)) {
    return <WebsearchTool part={part} />
  }

  if (isQuestionToolPart(part)) {
    return <QuestionTool part={part} />
  }

  if (isEnvVarRequestToolPart(part)) {
    return <EnvVarRequestTool part={part} />
  }

  if (part.type === "dynamic-tool" && part.toolName === "jugglework_session_create") {
    return <JuggleWorkSessionCreateTool part={part} />
  }

  return (
    <Tool
      toolPart={part}
      onReconnect={onMcpReconnect}
      onReopenAuthorization={onMcpReopenAuthorization}
      onRetry={onMcpRetry}
    />
  )
}

export function taskStatusTitle(
  description: string,
  status: string,
  waitingForApproval: boolean,
  inFlight: boolean,
): string | undefined {
  if (waitingForApproval && inFlight) return `Agent: ${description} · Waiting for approval`
  if (status === "stalled") return `Agent: ${description} · Possibly stuck — stop and retry`
  return undefined
}

function TaskStatusTool({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const { workspaceId, sessionId } = useMessageList()
  const metadata = part.type === "dynamic-tool"
    ? (part.callProviderMetadata?.opencode as {
        toolMetadata?: { parentSessionId?: unknown; sessionId?: unknown }
      } | undefined)?.toolMetadata
    : undefined
  const childSessionId = typeof metadata?.sessionId === "string" ? metadata.sessionId : ""
  const parentSessionId = typeof metadata?.parentSessionId === "string" ? metadata.parentSessionId : ""
  const interactions = useQueryCacheState<WorkspaceInteractionState>(
    workspaceInteractionsKey(workspaceId),
    EMPTY_WORKSPACE_INTERACTIONS,
  )
  const waitingForApproval = Boolean(childSessionId) && (!parentSessionId || parentSessionId === sessionId)
    ? taskHasPendingInteraction(interactions, sessionId, childSessionId)
    : false
  const inFlight = isToolPartInFlight(part)
  const status = useSessionActivityStore((state) => (
    childSessionId ? state.getStatus(workspaceId, childSessionId) : "idle"
  ))
  const input = part.input && typeof part.input === "object"
    ? part.input as { description?: unknown }
    : null
  const description = typeof input?.description === "string" && input.description.trim()
    ? input.description.trim()
    : "Subagent task"
  const title = taskStatusTitle(description, status, waitingForApproval, inFlight)

  return (
    <div data-task-waiting-for-approval={waitingForApproval && inFlight ? "true" : undefined}>
      <Tool title={title} toolPart={part} />
    </div>
  )
}

const isEmptyMessage = (message: UIMessage): boolean => message.parts.length === 0

type RetryStatus = Extract<SessionStatus, { type: "retry" }>

function isSessionErrorMessage(message: UIMessage) {
  return message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX)
}

function retryDelaySeconds(status: RetryStatus) {
  return Math.max(0, Math.round((status.next - Date.now()) / 1000))
}

interface FileMessageProps {
  part: FileUIPart
  tone: "user" | "assistant"
}

function FileMessage({ part, tone }: FileMessageProps) {
  const title = getFileTitle(part)
  const badge = getMediaBadge(part)
  const isImage = part.mediaType.startsWith("image/") && Boolean(part.url)
  const downloadUrl = getSafeFileDownloadUrl(part)

  const handleDownload = React.useCallback(() => {
    if (!downloadUrl) return
    const anchor = document.createElement("a")
    anchor.href = downloadUrl
    anchor.download = title
    anchor.rel = "noopener noreferrer"
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  }, [downloadUrl, title])

  if (isImage && tone === "user") {
    return <ImageAttachmentBadge src={part.url} alt={title} />
  }

  if (isImage) {
    return (
      <Image
        src={part.url}
        alt={title}
        loading="lazy"
        decoding="async"
        previewMaxWidth={280}
        previewMaxHeight={160}
        className="rounded-xl border border-border/70"
      />
    )
  }

  return (
    <div className="flex h-auto w-fit min-w-0 max-w-full shrink items-center justify-start gap-2 rounded-xl border border-border/70 bg-background/40 ps-2 pe-2 py-1 text-left text-sm font-medium whitespace-normal">
      <div className="flex min-w-0 items-center gap-2 pe-2">
        <DescriptiveButtonIcon>
          <FileIcon className="size-5 shrink-0" />
        </DescriptiveButtonIcon>
        <DescriptiveButtonContent className="gap-0">
          <DescriptiveButtonTitle className="truncate text-xs">{title}</DescriptiveButtonTitle>
          {badge ? (
            <DescriptiveButtonDescription className="text-[10px]">
              {badge}
            </DescriptiveButtonDescription>
          ) : null}
        </DescriptiveButtonContent>
      </div>
      {downloadUrl ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={handleDownload}
          aria-label={`Download ${title}`}
        >
          <Download className="size-3" />
          Download
        </Button>
      ) : null}
    </div>
  )
}

interface CopyMessageButtonProps {
  messages: UIMessage[]
}

function CopyMessageButton({ messages }: CopyMessageButtonProps) {
  const [copied, setCopied] = React.useState(false)
  const text = React.useMemo(() => getMessagesText(messages), [messages])

  const onCopy = React.useCallback(async () => {
    if (!text) {
      return
    }

    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore clipboard failures
    }
  }, [text])

  if (!text) {
    return null
  }

  return (
    <MessageAction tooltip={copied ? t("session.message_copied") : t("session.message_copy")}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t("session.message_copy")}
        onClick={() => void onCopy()}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </MessageAction>
  )
}

type AssistantMessageProps = {
  message: UIMessage
  isLastMessage: boolean
  isStreaming: boolean
  isLastStep: boolean
  presentation?: "default" | "process" | "summary"
}

const AssistantMessage = React.memo(
  ({ message, isStreaming, presentation = "default" }: AssistantMessageProps) => {
    const { showThinking, highlightQuery } = useMessageList()
    const isProcess = presentation === "process"
    const assistantRenderGroups = React.useMemo(
      () => getAssistantRenderGroups(message.parts, showThinking),
      [message.parts, showThinking]
    )

    if (assistantRenderGroups.length === 0) return null

    return (
      <Message
        className={cn(
          "flex w-full flex-col items-start gap-2",
          isProcess ? "px-0" : "mx-auto max-w-5xl px-3 md:px-8",
        )}
        data-message-id={message.id}
        data-message-role={message.role}
      >
        <div className="group flex w-full flex-col gap-0 space-y-2">
          {assistantRenderGroups.map((group, index) => {
            if (group.kind === "text") {
              return (
                <MessageContent
                  key={`text-${index}`}
                  className={cn(
                    "prose w-full min-w-0 flex-1 rounded-lg bg-transparent p-0 text-foreground",
                    isProcess
                      ? "text-sm leading-6 text-foreground/90 [&_li]:my-1 [&_p]:my-2 [&_p]:leading-6"
                      : "text-[15px] leading-7 [&_li]:my-1.5 [&_p]:my-2.5 [&_p]:leading-7",
                  )}
                  markdown
                  highlightQuery={highlightQuery}
                >
                  {group.text}
                </MessageContent>
              )
            }

            if (group.kind === "reasoning") {
              return (
                <MessageContent
                  key={`reasoning-${index}`}
                  className={cn(
                    "prose w-full min-w-0 flex-1 rounded-lg bg-transparent p-0 text-muted-foreground",
                    isProcess
                      ? "text-sm leading-6 [&_li]:my-1 [&_p]:my-2 [&_p]:leading-6"
                      : "text-[15px] leading-7 [&_p]:leading-7",
                  )}
                  markdown
                >
                  {group.text}
                </MessageContent>
              )
            }

            if (group.kind === "compaction") {
              return <CompactionStatusRow key={`compaction-${index}`} state={group.state} />
            }

            if (group.kind === "file") {
              return (
                <div key={`file-${index}`} className="w-fit max-w-full">
                  <FileMessage part={group.part} tone="assistant" />
                </div>
              )
            }

            return (
              <div key={`tools-${index}`} className={cn("w-full", isProcess && "py-0.5")}>
                <ToolRunGroup parts={group.parts} isStreaming={isStreaming} />
              </div>
            )
          })}
        </div>
      </Message>
    )
  }
)

AssistantMessage.displayName = "AssistantMessage"

type UserMessageProps = {
  message: UIMessage
  isStreaming: boolean
}

function UserSkillChip(props: { kind: ComposerCapabilityKind; name: string }) {
  return (
    <span
      className={`mx-0.5 align-middle ${composerCapabilityTagClassName(props.kind)}`}
      title={`${composerCapabilityTagTitlePrefix(props.kind)}: ${props.name}`}
    >
      {props.name}
    </span>
  )
}

function renderPlainTextWithSearchHighlights(text: string, highlightQuery: string | undefined, keyPrefix: string) {
  const needle = highlightQuery?.trim().toLowerCase() ?? ""
  if (needle.length < 2) return text

  const lower = text.toLowerCase()
  if (!lower.includes(needle)) return text

  const nodes: React.ReactNode[] = []
  let cursor = 0
  let matchIndex = lower.indexOf(needle)
  while (matchIndex >= 0) {
    if (matchIndex > cursor) {
      nodes.push(text.slice(cursor, matchIndex))
    }
    const end = matchIndex + needle.length
    nodes.push(
      <mark
        key={`${keyPrefix}:match:${matchIndex}`}
        data-search-highlight="true"
        className={SEARCH_HIGHLIGHT_MARK_CLASS}
      >
        {text.slice(matchIndex, end)}
      </mark>
    )
    cursor = end
    matchIndex = lower.indexOf(needle, cursor)
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor))
  }

  return nodes
}

/**
 * 把用户消息里的能力指令整句折叠成一枚 tag
 *
 * TIPS: 展示与提交是同一套语法（capability-tags）。此前这里只认 `[skill x]`，
 * 云端技能/扩展/MCP 因此在会话记录里裸露成一整句文本。
 */
function renderUserTextWithSkillChips(text: string, highlightQuery: string | undefined) {
  if (!CAPABILITY_INSTRUCTION_RE.test(text)) return renderPlainTextWithSearchHighlights(text, highlightQuery, "text")
  let offset = 0
  return text.split(CAPABILITY_INSTRUCTION_RE).map((segment) => {
    const key = `${offset}:${segment}`
    offset += segment.length
    const capability = segment ? parseCapabilityInstruction(segment) : null
    if (capability) return <UserSkillChip key={key} kind={capability.kind} name={capability.name} />
    return <React.Fragment key={key}>{renderPlainTextWithSearchHighlights(segment, highlightQuery, key)}</React.Fragment>
  })
}

const UserMessage = React.memo(
  ({ message, isStreaming }: UserMessageProps) => {
    const { onRevertToUserMessage, onForkAtMessage, onEditUserMessage, highlightQuery } = useMessageList()
    const messageText = React.useMemo(() => getMessagesText([message]), [message])
    const inlineParts = React.useMemo(
      () => message.parts.filter((part) => (part.type === "text" && Boolean(part.text)) || isFileUIPart(part)),
      [message.parts],
    )
    const hasContent = inlineParts.length > 0

    if (!hasContent) return null

    return (
      <Message
        className="mx-auto flex w-full max-w-5xl flex-col items-end gap-2 px-3 md:px-8"
        data-message-id={message.id}
        data-message-role={message.role}
      >
        <ContextMenu>
          <ContextMenuTrigger
            // Override Trigger's select-none so user bubbles stay copyable.
            className="!select-text"
            render={
              <div
                className="group/message-actions group flex w-full flex-col items-end gap-1 !select-text"
                style={{ userSelect: "text" }}
              >
                {hasContent ? (
                  /* 发送消息气泡背景统一 token --app-msg-sent-bg（定义于 app/index.css，消息页同源） */
                  <MessageContent
                    className="bg-[var(--app-msg-sent-bg)] text-foreground max-w-[85%] rounded-3xl px-4 py-2.5 leading-6 sm:max-w-[75%] !select-text not-prose"
                    style={{ userSelect: "text" }}
                  >
                    {inlineParts.map((part, index) => {
                      if (part.type === "text") {
                        return (
                          <span key={`text-${index}`} className="whitespace-pre-wrap">
                            {renderUserTextWithSkillChips(part.text, highlightQuery)}
                          </span>
                        )
                      }
                      if (isFileUIPart(part)) {
                        return (
                          <span
                            key={`file-${part.url}-${index}`}
                            className="mx-1 inline-flex align-middle not-prose"
                          >
                            <FileMessage part={part} tone="user" />
                          </span>
                        )
                      }
                      return null
                    })}
                  </MessageContent>
                ) : null}
                {!isStreaming && (
                  <MessageActions className={cn("flex items-center gap-0", MESSAGE_ACTIONS_REVEAL_CLASS)}>
                    <MessageTimestamp message={message} className="mr-1.5" />
                    <CopyMessageButton messages={[message]} />
                    {messageText ? (
                      <MessageAction tooltip={t("session.edit_message_label")}>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t("session.edit_message_label")}
                          onClick={() => onEditUserMessage(message.id, messageText)}
                        >
                          <Pencil />
                        </Button>
                      </MessageAction>
                    ) : null}
                    <MessageAction tooltip={t("session.branch_new_chat")}>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("session.branch_new_chat")}
                        onClick={() => onForkAtMessage(message.id)}
                      >
                        <Split className="rotate-90" />
                      </Button>
                    </MessageAction>
                    <MessageAction tooltip={t("session.revert_label")}>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("session.revert_label")}
                        onClick={() => onRevertToUserMessage(message.id)}
                      >
                        <Undo2 />
                      </Button>
                    </MessageAction>
                  </MessageActions>
                )}
              </div>
            }
          />
          <ContextMenuContent className="w-56">
            {messageText ? (
              <ContextMenuItem onClick={() => onEditUserMessage(message.id, messageText)}>
                <Pencil className="size-4" />
                {t("session.edit_message_label")}
              </ContextMenuItem>
            ) : null}
            {messageText ? (
              <ContextMenuItem onClick={() => void navigator.clipboard.writeText(messageText)}>
                <Copy className="size-4" />
                {t("session.message_copy")}
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem onClick={() => onForkAtMessage(message.id)}>
              <Split className="size-4 rotate-90" />
              {t("session.branch_new_chat")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRevertToUserMessage(message.id)}>
              <Undo2 className="size-4" />
              {t("session.revert_label")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </Message>
    )
  }
)

UserMessage.displayName = "UserMessage"

type MessageComponentProps = {
  message: UIMessage
  isLastMessage: boolean
  isStreaming: boolean
  isLastStep: boolean
  presentation?: "default" | "process" | "summary"
}

const MessageComponent = React.memo(
  ({ message, isLastMessage, isStreaming, isLastStep, presentation }: MessageComponentProps) => {
    if (isSessionErrorMessage(message)) {
      return <ErrorMessage error={getMessagesText([message]) || "Session failed"} />
    }

    if (isEmptyMessage(message)) {
      return null
    }

    if (message.role === "assistant") {
      return (
        <AssistantMessage
          message={message}
          isLastMessage={isLastMessage}
          isStreaming={isStreaming}
          isLastStep={isLastStep}
          presentation={presentation}
        />
      )
    }

    return (
      <UserMessage
        message={message}
        isStreaming={isStreaming}
      />
    )
  }
)

MessageComponent.displayName = "MessageComponent"

// TIPS: 容器与消息正文/「耗时」行保持同一套 max-w-5xl + px-3/md:px-8，
// 左边缘才能和上下文对齐；此前用的是 max-w-3xl + px-2/md:px-10，会偏右十几像素。
const LoadingMessage = React.memo(({ label }: { label?: string }) => (
  <Message className="mx-auto -mt-1 flex w-full max-w-5xl flex-col items-start gap-0 px-3 md:px-8">
    <div className="group flex w-full flex-col gap-0">
      <div className="flex items-center py-0 text-sm" role="status" aria-live="polite">
        <span className="live-activity-text font-medium tracking-[-0.01em]">
          {`${label ?? liveActivityLabel("responding")}...`}
        </span>
      </div>
    </div>
  </Message>
))

LoadingMessage.displayName = "LoadingMessage"

interface ErrorMessageProps {
  error: string | null
}

function ErrorMessage({ error }: ErrorMessageProps) {
  return (
    <Message className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-0 md:px-10">
      <div className="group flex w-full flex-col items-start gap-0">
        <div className="text-foreground flex min-w-0 flex-1 flex-row items-start gap-2 rounded-lg border-2 border-red-300 bg-red-300/20 px-2 py-1">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
          <p className="whitespace-pre-wrap text-destructive">{error}</p>
        </div>
      </div>
    </Message>
  )
}

interface RetryMessageProps {
  status: RetryStatus
}

function RetryActionButton(props: { link: string; label: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 border-amber-500/70 bg-amber-50 text-xs text-amber-950 hover:bg-amber-100"
      onClick={() => void openDesktopUrl(props.link)}
    >
      {props.label}
    </Button>
  )
}

const RetryMessage = React.memo(({ status }: RetryMessageProps) => {
  const [seconds, setSeconds] = React.useState(() => retryDelaySeconds(status))

  React.useEffect(() => {
    const update = () => setSeconds(retryDelaySeconds(status))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [status])

  const info = seconds > 0
    ? `Retrying in ${seconds}s · attempt ${status.attempt}`
    : `Retrying · attempt ${status.attempt}`
  const action = status.action

  return (
    <Message className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-0 md:px-10">
      <div className="group flex w-full flex-col items-start gap-0">
        <div className="text-foreground flex min-w-0 flex-1 flex-col gap-2 rounded-lg border-2 border-amber-300 bg-amber-300/20 px-3 py-2">
          <div className="flex items-start gap-2">
            <LoaderCircle size={16} className="mt-0.5 shrink-0 animate-spin text-amber-700" />
            <div className="min-w-0 space-y-1">
              <p className="whitespace-pre-wrap text-sm font-medium text-amber-900">{status.message}</p>
              <p className="text-xs text-amber-800">{info}</p>
            </div>
          </div>
          {action ? (
            <div className="ml-6 space-y-1 border-t border-amber-400/60 pt-2">
              <p className="text-xs font-medium text-amber-950">{action.title}</p>
              <p className="text-xs text-amber-900">{action.message}</p>
              {action.link ? (
                <RetryActionButton link={action.link} label={action.label} />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Message>
  )
})

RetryMessage.displayName = "RetryMessage"

const isMessageEmptyGroup = (messages: UIMessageWithIndex[]) =>
  messages.every(message => isEmptyMessage(message.message));

const getRenderableMessages = (messages: UIMessageWithIndex[]) =>
  messages.flatMap((item) => {
    const renderableMessage = getRenderableMessage(item.message);

    return renderableMessage ? [{ ...item, message: renderableMessage }] : []
  })

function getRenderableMessage(message: UIMessage) {
  const parts = message.parts.filter((part) => part.type === "text" || part.type === "file");

  return parts.length > 0 ? { ...message, parts } : null;
}

function MessageArtifacts(props: { message: UIMessage }) {
  return <ArtifactList messages={[props.message]} includeTargetFallbacks={false} />;
}

interface AssistantMessageGroupProps {
  items: UIMessageWithIndex[]
  messages: UIMessage[]
  isStreaming: boolean
}

function MessageGroup({
  items,
  messages,
  isStreaming,
}: AssistantMessageGroupProps) {
  const { onRevertToUserMessage, onForkAtMessage } = useMessageList()
  const lastItem = items[items.length - 1]
  // Branch/revert must target a real server-side message id. Synthetic
  // client-side messages (e.g. session errors) don't exist on the server and
  // silently corrupt fork/revert boundaries.
  const lastRealItem = items.findLast((item) => !isSessionErrorMessage(item.message))
  const isLiveGroup = isStreaming && lastItem !== undefined && lastItem.index === messages.length - 1
  const [processOpen, setProcessOpen] = React.useState(() => isLiveGroup)

  React.useEffect(() => {
    setProcessOpen(isLiveGroup)
  }, [isLiveGroup])

  if (!lastItem || isMessageEmptyGroup(items)) {
    return null;
  }

  const manualCompaction = items.length === 1
    ? getSessionCompactionFromMessage(items[0]!.message)
    : null
  if (manualCompaction?.mode === "manual") {
    return <StandaloneManualCompactionTask state={manualCompaction} />
  }

  const { processItems, summaryItems } = splitAssistantTaskMessages(items, isLiveGroup)
  const processDisplayItem = mergeAssistantProcessItems(processItems)
  const renderableItems = getRenderableMessages(summaryItems)
  const summaryItem = summaryItems.at(-1)
  const lastTextMessage = summaryItem ? getLastTextPart(summaryItem.message) : null
  // 只要有过程内容就保留折叠器：运行中默认展开，结束后收起但仍可展开。
  // TIPS: 此前的条件是 `processItems.length > 0 && (isLiveGroup || summaryItems.length === 0)`，
  // 任务一结束并产出结论，整个折叠器（连同「耗时」后面的箭头）就消失，
  // 于是流式期间折起来的过程再也展不开。
  const showProcessDisclosure = processItems.length > 0
  let userMessageIndex = items[0]?.index ?? -1
  while (userMessageIndex > 0 && messages[userMessageIndex - 1]?.role !== "user") {
    userMessageIndex -= 1
  }
  userMessageIndex = messages[userMessageIndex - 1]?.role === "user" ? userMessageIndex - 1 : -1
  const showTaskTiming = userMessageIndex >= 0 && getMessageCreated(messages[userMessageIndex]) !== null

  const renderItem = (
    item: UIMessageWithIndex,
    groupIndex: number,
    presentation: "process" | "summary",
  ) => {
    const isLastMessage = item.index === messages.length - 1

    return (
      <React.Fragment key={item.message.id}>
        <MessageComponent
          message={item.message}
          isLastMessage={isLastMessage}
          isStreaming={isLastMessage && isStreaming}
          isLastStep={groupIndex === items.length - 1}
          presentation={presentation}
        />
        <MessageArtifacts message={item.message} />
      </React.Fragment>
    )
  }

  return (
    <div className="group/message-actions group/message-group mt-5 flex flex-col gap-0">
      {showProcessDisclosure ? (
        <Collapsible open={processOpen} onOpenChange={setProcessOpen} className="mx-auto w-full max-w-5xl px-3 md:px-8">
          <CollapsibleTrigger
            className="group/process flex w-full cursor-pointer items-center gap-1.5 border-b border-border/65 pb-3 text-left text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-4"
            data-testid="task-process-toggle"
          >
            {showTaskTiming ? (
              <TaskDuration
                messages={messages}
                userMessageIndex={userMessageIndex}
                isStreaming={isLiveGroup}
              />
            ) : (
              <span className="text-sm font-medium">
                {currentLocale() === "zh" ? "执行过程" : "Process"}
              </span>
            )}
            <ChevronRight className="size-4 shrink-0 transition-transform duration-200 group-data-panel-open/process:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-200 ease-out data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 [&[hidden]:not([hidden='until-found'])]:hidden">
            <div className={cn("pt-4", isLiveGroup ? "pb-1" : "pb-5")}>
              {processDisplayItem ? (
                <MessageComponent
                  message={processDisplayItem.message}
                  isLastMessage={processDisplayItem.index === messages.length - 1}
                  isStreaming={isLiveGroup}
                  isLastStep={processItems.length === items.length}
                  presentation="process"
                />
              ) : null}
              <ArtifactList messages={processItems.map((item) => item.message)} includeTargetFallbacks={false} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : showTaskTiming ? (
        <div className="mx-auto w-full max-w-5xl px-3 md:px-8">
          <div className="border-b border-border/65 pb-3">
            <TaskDuration
              messages={messages}
              userMessageIndex={userMessageIndex}
              isStreaming={isLiveGroup}
            />
          </div>
        </div>
      ) : null}
      <div className={cn(
        (showProcessDisclosure || showTaskTiming) && (isLiveGroup && processOpen ? "pt-2" : "pt-5"),
      )}>
        {summaryItems.map((item, groupIndex) => renderItem(item, processItems.length + groupIndex, "summary"))}
      </div>
      {/* 用分组级 isLiveGroup 而非列表级 isStreaming：流式期间历史任务块
          仍要能 hover 出复制/分支/撤销/时间，只有正在输出的块隐藏操作栏。 */}
      {lastTextMessage && !isLiveGroup && (
        <div
          className={cn(
            "mx-auto flex w-full max-w-5xl flex-wrap items-center gap-1.5 px-3 text-muted-foreground md:px-8",
            MESSAGE_ACTIONS_REVEAL_CLASS,
          )}
        >
          <MessageActions className="flex gap-0">
            <CopyMessageButton messages={renderableItems.map((item) => item.message)} />
            {lastRealItem ? (
              <>
                <MessageAction tooltip={t("session.branch_new_chat")}>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("session.branch_new_chat")}
                    onClick={() => onForkAtMessage(lastRealItem.message.id)}
                  >
                    <Split className="rotate-90" />
                  </Button>
                </MessageAction>
                <MessageAction tooltip={t("session.revert_label")}>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("session.revert_label")}
                    onClick={() => onRevertToUserMessage(lastRealItem.message.id)}
                  >
                    <Undo2 />
                  </Button>
                </MessageAction>
              </>
            ) : null}
          </MessageActions>
          <MessageTimestamp message={lastItem.message} />
          {/* <MessageSources messages={items.map((item) => item.message)} /> */}
        </div>
      )}
      </div>
  )
}

interface MessageListProps {
  messages: UIMessage[]
  status: ThreadStatus
  retryStatus?: RetryStatus | null
  compactionRunning?: boolean
}

export function MessageList({ messages, status, retryStatus, compactionRunning = false }: MessageListProps) {
  const isStreaming = status === "streaming" || status === "retrying"
  const items = React.useMemo(() => groupMessages(messages, status), [messages, status]);
  const error = useSessionErrorMessage();
  const hasSessionErrorMessage = React.useMemo(() => messages.some(isSessionErrorMessage), [messages])
  // TIPS: 底部提示展示的是当前真实动作（执行命令 / 写文件 / 工具调用…），
  // 而不是一个恒定的「Thinking…」；推不出具体动作时落到「生成回复中」。
  const liveActionLabel = isStreaming
    ? liveActivityLabel(getLiveActivityKind(messages))
    : null

  return (
    <div className={cn("flex flex-col gap-2 @container/message-list")}>
      {messages.length === 0 && <TaskSuggestions className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-3 md:px-5 md:pb-5 grow" />}

      {items.map((item) => {
        if (isMessageGroup(item)) {
          return (
            <MessageGroup
              key={item.messages[0]?.message.id ?? "empty-assistant-group"}
              items={item.messages}
              messages={messages}
              isStreaming={isStreaming}
            />
          )
        }

        const isLastMessage = item.index === messages.length - 1
        const isLastStep =
          !messages[item.index + 1] || messages[item.index + 1].role !== item.message.role

        return (
          <div key={item.message.id}>
            <MessageComponent
              message={item.message}
              isLastMessage={isLastMessage}
              isStreaming={isLastMessage && isStreaming}
              isLastStep={isLastStep}
            />
            <MessageArtifacts message={item.message} />
          </div>
        )
      })}

      {status === "streaming" && !compactionRunning && <LoadingMessage label={liveActionLabel ?? undefined} />}
      {retryStatus ? <RetryMessage status={retryStatus} /> : null}
      {error && !hasSessionErrorMessage ? <ErrorMessage error={error} /> : null}
    </div>
  )
}
