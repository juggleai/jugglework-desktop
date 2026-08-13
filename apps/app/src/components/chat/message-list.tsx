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
  Pencil,
  Split,
  Undo2,
} from "lucide-react"
import { PaperGrainGradient } from "@jugglework/ui/react"
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
import type { ThreadStatus } from "@/lib/messages"
import {
  collectToolParts,
  getActiveToolLabel,
  getToolActivityLabel,
  isToolPartInFlight,
} from "@/lib/tool-activity"
import { cn } from "@/lib/utils"
import { currentLocale, t } from "@/i18n"
import { groupMessages, isMessageGroup, getLastTextPart, getAssistantRenderGroups, getFileTitle, getMediaBadge, getMessageCreated, formatMessageTimestamp, formatTaskDuration, getTaskTiming, splitAssistantTaskMessages, mergeAssistantProcessItems, type UIMessageWithIndex, getMessagesText, getSafeFileDownloadUrl } from "./utils"

const SEARCH_HIGHLIGHT_MARK_CLASS = "rounded px-0.5 bg-amber-4/70 text-current"

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
        <span className="min-w-0 flex-1 truncate">{label}</span>
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

function TaskStatusTool({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const { workspaceId } = useMessageList()
  const metadata = part.type === "dynamic-tool"
    ? (part.callProviderMetadata?.opencode as { toolMetadata?: { sessionId?: unknown } } | undefined)?.toolMetadata
    : undefined
  const childSessionId = typeof metadata?.sessionId === "string" ? metadata.sessionId : ""
  const status = useSessionActivityStore((state) => (
    childSessionId ? state.getStatus(workspaceId, childSessionId) : "idle"
  ))
  const input = part.input && typeof part.input === "object"
    ? part.input as { description?: unknown }
    : null
  const description = typeof input?.description === "string" && input.description.trim()
    ? input.description.trim()
    : "Subagent task"
  const title = status === "stalled"
    ? `Agent: ${description} · Possibly stuck — stop and retry`
    : undefined

  return <Tool title={title} toolPart={part} />
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
        size="icon"
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

const USER_SKILL_TOKEN_RE = /(Load \[skill [^\]]+\] and follow its instructions\.|\[skill [^\]]+\])/

function UserSkillChip(props: { name: string }) {
  return (
    <span className="mx-0.5 inline-flex items-center rounded-full border border-violet-6/35 bg-violet-3/20 px-2.5 py-1 text-xs font-medium text-violet-11 align-middle" title={`Skill: ${props.name}`}>
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

function renderUserTextWithSkillChips(text: string, highlightQuery: string | undefined) {
  if (!USER_SKILL_TOKEN_RE.test(text)) return renderPlainTextWithSearchHighlights(text, highlightQuery, "text")
  let offset = 0
  return text.split(USER_SKILL_TOKEN_RE).map((segment) => {
    const key = `${offset}:${segment}`
    offset += segment.length
    const skillMatch = segment.match(/^(?:Load )?\[skill ([^\]]+)\](?: and follow its instructions\.)?$/)
    if (skillMatch?.[1]) return <UserSkillChip key={key} name={skillMatch[1]} />
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
                className="group flex w-full flex-col items-end gap-1 !select-text"
                style={{ userSelect: "text" }}
              >
                {hasContent ? (
                  <MessageContent
                    className="bg-muted text-foreground max-w-[85%] rounded-3xl px-4 py-2.5 leading-6 sm:max-w-[75%] !select-text not-prose"
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
                  <MessageActions
                    className={cn(
                      "flex items-center gap-0 opacity-60 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100"
                    )}
                  >
                    <MessageTimestamp message={message} className="mr-1.5" />
                    <CopyMessageButton messages={[message]} />
                    {messageText ? (
                      <MessageAction tooltip={t("session.edit_message_label")}>
                        <Button
                          variant="ghost"
                          size="icon"
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
                        size="icon"
                        aria-label={t("session.branch_new_chat")}
                        onClick={() => onForkAtMessage(message.id)}
                      >
                        <Split className="rotate-90" />
                      </Button>
                    </MessageAction>
                    <MessageAction tooltip={t("session.revert_label")}>
                      <Button
                        variant="ghost"
                        size="icon"
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

const LoadingMessage = React.memo(({ label }: { label?: string }) => (
  <Message className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10">
    <div className="group flex w-full flex-col gap-0">
      <div className="flex items-center gap-1.5 px-1 py-1 text-sm text-muted-foreground">
        <div style={{ width: 20, height: 20, borderRadius: "50%", overflow: "hidden" }}>
          <PaperGrainGradient
            speed={12}
            softness={0.1}
            intensity={1}
            noise={0.05}
            shape="sphere"
            colors={["#818cf8", "#fb7185", "#fbbf24", "#34d399"]}
            colorBack="#ffffff00"
            style={{ backgroundColor: "#818cf8", width: "100%", height: "100%", borderRadius: "50%" }}
          />
        </div>
        <span>{label ?? "Thinking…"}</span>
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

  const { processItems, summaryItems } = splitAssistantTaskMessages(items, isLiveGroup)
  const processDisplayItem = mergeAssistantProcessItems(processItems)
  const renderableItems = getRenderableMessages(summaryItems)
  const summaryItem = summaryItems.at(-1)
  const lastTextMessage = summaryItem ? getLastTextPart(summaryItem.message) : null
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
    <div className="group/message-group mt-5 flex flex-col gap-0">
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
      {lastTextMessage && !isStreaming && (
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-3 pt-1 text-muted-foreground opacity-60 transition-opacity duration-200 group-hover/message-group:opacity-100 focus-within:opacity-100 md:px-8">
          <MessageActions className="flex gap-0">
            <CopyMessageButton messages={renderableItems.map((item) => item.message)} />
            {lastRealItem ? (
              <>
                <MessageAction tooltip={t("session.branch_new_chat")}>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("session.branch_new_chat")}
                    onClick={() => onForkAtMessage(lastRealItem.message.id)}
                  >
                    <Split className="rotate-90" />
                  </Button>
                </MessageAction>
                <MessageAction tooltip={t("session.revert_label")}>
                  <Button
                    variant="ghost"
                    size="icon"
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
}

export function MessageList({ messages, status, retryStatus }: MessageListProps) {
  const isStreaming = status === "streaming" || status === "retrying"
  const items = React.useMemo(() => groupMessages(messages, status), [messages, status]);
  const error = useSessionErrorMessage();
  const hasSessionErrorMessage = React.useMemo(() => messages.some(isSessionErrorMessage), [messages])
  const liveActionLabel = isStreaming
    ? getActiveToolLabel(collectToolParts(messages))
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

      {status === "streaming" && <LoadingMessage label={liveActionLabel ?? undefined} />}
      {retryStatus ? <RetryMessage status={retryStatus} /> : null}
      {error && !hasSessionErrorMessage ? <ErrorMessage error={error} /> : null}
    </div>
  )
}
