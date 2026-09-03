import { isReasoningUIPart, isToolUIPart, type DynamicToolUIPart, type FileUIPart, type ToolUIPart, type UIMessage } from "ai"
import type { ThreadStatus } from "@/lib/messages"
import { redactSensitiveReasoning } from "./reasoning-redaction"
import {
  getSessionCompactionFromMessage,
  getSessionCompactionFromPart,
  isSessionCompactionUIPart,
  toCompactionPresentationMessage,
  type SessionCompactionPresentation,
} from "@/app/lib/session-compaction"

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const SAFE_DOWNLOAD_PROTOCOLS = new Set(["blob:", "data:"])

interface MessageGroup {
  messages: UIMessageWithIndex[]
}

export type UIMessageWithIndex = { index: number, message: UIMessage }
type MessageListItem = MessageGroup | UIMessageWithIndex

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
}

export function getMessagesText(messages: UIMessage[]): string {
  return messages
    .map(getMessageText)
    .filter(Boolean)
    .join("\n\n")
}

export function getLastTextPart(message: UIMessage): UIMessage | null {
  const lastTextPart = message.parts.findLast((part) => part.type === "text")

  return lastTextPart ? { ...message, parts: [lastTextPart] } : null
}

export function splitAssistantTaskMessages(items: UIMessageWithIndex[], isLive = false) {
  // While streaming, don't extract a summary from the last item — the last
  // text part is likely an interim step description whose tool calls are
  // still running, not the final summary. Putting everything in process
  // preserves the correct text→tools ordering.
  if (isLive) {
    return { processItems: items, summaryItems: [] as UIMessageWithIndex[] }
  }

  const finalItemIndex = items.findLastIndex((item) =>
    item.message.parts.some((part) => part.type === "text" && part.text.trim().length > 0),
  )
  if (finalItemIndex === -1) {
    return { processItems: items, summaryItems: [] as UIMessageWithIndex[] }
  }

  const processItems: UIMessageWithIndex[] = []
  let summaryItem: UIMessageWithIndex | null = null

  items.forEach((item, itemIndex) => {
    if (itemIndex !== finalItemIndex) {
      processItems.push(item)
      return
    }

    const lastTextPartIndex = item.message.parts.findLastIndex(
      (part) => part.type === "text" && part.text.trim().length > 0,
    )
    const lastProcessPartIndex = item.message.parts.findLastIndex(
      (part) => isSessionCompactionUIPart(part) || (part.type !== "text" && part.type !== "file"),
    )
    const summaryTextIndexes = new Set(
      item.message.parts.flatMap((part, partIndex) =>
        part.type === "text" && part.text.trim().length > 0 && partIndex > lastProcessPartIndex
          ? [partIndex]
          : [],
      ),
    )
    if (summaryTextIndexes.size === 0) summaryTextIndexes.add(lastTextPartIndex)
    const summaryParts = item.message.parts.filter(
      (part, partIndex) => part.type === "file" || summaryTextIndexes.has(partIndex),
    )
    const processParts = item.message.parts.filter(
      (part, partIndex) => part.type !== "file" && !summaryTextIndexes.has(partIndex),
    )

    if (processParts.length > 0) {
      processItems.push({ ...item, message: { ...item.message, parts: processParts } })
    }
    summaryItem = { ...item, message: { ...item.message, parts: summaryParts } }
  })

  return {
    processItems,
    summaryItems: summaryItem ? [summaryItem] : [],
  }
}

export function getFileTitle(part: Pick<FileUIPart, "filename" | "url">) {
  if (part.filename) {
    return part.filename
  }

  if (part.url.startsWith("data:")) {
    return "Attached file"
  }

  return part.url || "File"
}

function extensionBadge(filename: string | undefined) {
  const extension = filename?.split(".").pop()?.trim().toUpperCase() ?? ""
  return /^[A-Z0-9]{1,8}$/.test(extension) ? extension : null
}

export function getMediaBadge(part: Pick<FileUIPart, "filename" | "mediaType">) {
  const mime = part.mediaType?.trim().toLowerCase().split(";")[0] ?? ""

  if (mime === DOCX_MIME) return "DOCX"
  if (mime === PPTX_MIME) return "PPTX"
  if (mime === XLSX_MIME) return "XLSX"

  const fromExtension = extensionBadge(part.filename)
  if (fromExtension === "DOCX" || fromExtension === "PPTX" || fromExtension === "XLSX") return fromExtension

  if (mime && mime !== "application/octet-stream") {
    return mime.replace(/^application\//, "").replace(/^text\//, "").toUpperCase()
  }

  return fromExtension
}

export function getSafeFileDownloadUrl(part: Pick<FileUIPart, "url">) {
  try {
    const url = new URL(part.url)
    return SAFE_DOWNLOAD_PROTOCOLS.has(url.protocol) ? part.url : null
  } catch {
    return null
  }
}

export function getMessageCreated(message: UIMessage): number | null {
  const metadata: unknown = message.metadata
  if (!metadata || typeof metadata !== "object" || !("opencode" in metadata)) return null

  const opencode: unknown = metadata.opencode
  if (!opencode || typeof opencode !== "object" || !("created" in opencode)) return null

  const created: unknown = opencode.created
  return typeof created === "number" ? created : null
}

export function getMessageCompleted(message: UIMessage): number | null {
  const metadata: unknown = message.metadata
  if (!metadata || typeof metadata !== "object" || !("opencode" in metadata)) return null

  const opencode: unknown = metadata.opencode
  if (!opencode || typeof opencode !== "object" || !("completed" in opencode)) return null

  const completed: unknown = opencode.completed
  return typeof completed === "number" ? completed : null
}

function normalizeTimestamp(timestamp: number): number {
  return timestamp < 1e12 ? timestamp * 1000 : timestamp
}

function getToolEndedAt(message: UIMessage): number[] {
  return message.parts.flatMap((part) => {
    if (!isToolUIPart(part)) return []
    const metadata = part.callProviderMetadata?.opencode
    if (!metadata || typeof metadata !== "object" || !("toolEndedAt" in metadata)) return []
    const endedAt = metadata.toolEndedAt
    return typeof endedAt === "number" ? [normalizeTimestamp(endedAt)] : []
  })
}

export interface TaskTiming {
  startedAt: number
  endedAt: number
  running: boolean
}

export function getTaskTiming(
  messages: UIMessage[],
  userMessageIndex: number,
  isStreaming: boolean,
  now = Date.now(),
): TaskTiming | null {
  const userMessage = messages[userMessageIndex]
  const created = userMessage ? getMessageCreated(userMessage) : null
  if (!userMessage || userMessage.role !== "user" || created === null) return null

  const startedAt = normalizeTimestamp(created)
  let nextUserIndex = messages.findIndex(
    (message, index) => index > userMessageIndex && message.role === "user",
  )
  if (nextUserIndex === -1) nextUserIndex = messages.length

  const running = isStreaming && nextUserIndex === messages.length
  if (running) {
    return { startedAt, endedAt: Math.max(startedAt, now), running: true }
  }

  const taskMessages = messages.slice(userMessageIndex + 1, nextUserIndex)
  const observedTimes = taskMessages.flatMap((message) => {
    const completed = getMessageCompleted(message)
    const messageCreated = getMessageCreated(message)
    return [
      ...(completed === null ? [] : [normalizeTimestamp(completed)]),
      ...getToolEndedAt(message),
      ...(messageCreated === null ? [] : [normalizeTimestamp(messageCreated)]),
    ]
  })
  const nextUserCreated = messages[nextUserIndex] ? getMessageCreated(messages[nextUserIndex]) : null
  if (observedTimes.length === 0 && nextUserCreated !== null) {
    observedTimes.push(normalizeTimestamp(nextUserCreated))
  }

  return {
    startedAt,
    endedAt: Math.max(startedAt, ...observedTimes),
    running: false,
  }
}

export function formatTaskDuration(durationMs: number, locale: "en" | "zh" = "en"): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)

  if (locale === "zh") {
    if (hours > 0) return `${hours}小时 ${minutes}分钟 ${seconds}秒`
    if (totalMinutes > 0) return `${totalMinutes}分钟 ${seconds}秒`
    return `${totalSeconds}秒`
  }

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (totalMinutes > 0) return `${totalMinutes}m ${seconds}s`
  return `${totalSeconds}s`
}

export function formatMessageTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs)
  const now = new Date()
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

  if (date.toDateString() === now.toDateString()) {
    return time
  }

  const sameYear = date.getFullYear() === now.getFullYear()
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })

  return `${day}, ${time}`
}

export function isMessageGroup(item: MessageListItem): item is MessageGroup {
  return "messages" in item
}

function asAssistantPresentationMessage(message: UIMessage): UIMessage | null {
  const presentationMessage = toCompactionPresentationMessage(message)
  if (presentationMessage.role === "assistant") return presentationMessage

  const hasUserContent = presentationMessage.parts.some(
    (part) => (part.type === "text" && part.text.trim().length > 0) || part.type === "file",
  )
  if (hasUserContent) return null

  const hasAssistantProcess = presentationMessage.parts.some(
    (part) => isReasoningUIPart(part) || isToolUIPart(part) || part.type === "step-start" || isSessionCompactionUIPart(part),
  )
  return hasAssistantProcess ? { ...presentationMessage, role: "assistant" } : null
}

/**
 * Empty user messages render nothing (MessageComponent drops them), but they
 * arrive for engine-internal markers — e.g. the synthetic continue prompt
 * OpenCode injects after auto compaction. Letting one act as a task boundary
 * would split a still-running task into two assistant groups, so grouping
 * skips them entirely; timing then anchors to the original user prompt.
 */
const isTransparentUserMessage = (message: UIMessage): boolean =>
  message.role === "user" && message.parts.length === 0;

export function groupMessages(messages: UIMessage[], status: ThreadStatus): MessageListItem[] {
  const items: MessageListItem[] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]
    const assistantMessage = asAssistantPresentationMessage(message)

    if (!assistantMessage) {
      if (isTransparentUserMessage(message)) {
        index++
        continue
      }
      items.push({ index, message })
      index++
      continue
    }

    const assistantMessages: UIMessageWithIndex[] = []

    while (index < messages.length) {
      const nextAssistantMessage = asAssistantPresentationMessage(messages[index])
      if (!nextAssistantMessage) {
        // Transparent engine markers (autocontinue prompt) must not end the
        // current assistant run either — skip and keep collecting.
        if (isTransparentUserMessage(messages[index])) {
          index++
          continue
        }
        break
      }
      const compaction = getSessionCompactionFromMessage(nextAssistantMessage)
      // `/compact` does not create a visible user message, so without an
      // explicit boundary its output would be absorbed into the preceding
      // assistant run. A manual compaction is intentionally its own task.
      if (compaction && compaction.mode !== "auto" && assistantMessages.length > 0) break
      assistantMessages.push({ message: nextAssistantMessage, index });
      index++
      if (compaction && compaction.mode !== "auto") break
    }

    items.push({ messages: assistantMessages });
  }

  return items
}

type AssistantRenderGroup =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; isStreaming: boolean }
  | { kind: "file"; part: FileUIPart }
  | { kind: "tools"; parts: Array<ToolUIPart | DynamicToolUIPart> }
  | { kind: "compaction"; state: SessionCompactionPresentation }

export function getAssistantRenderGroups(
  parts: UIMessage["parts"],
  showThinking: boolean
): AssistantRenderGroup[] {
  const filteredParts = parts.filter((part) => showThinking || !isReasoningUIPart(part))
  const groups: AssistantRenderGroup[] = []

  const appendText = (text: string) => {
    if (!text) {
      return
    }

    const previous = groups.at(-1)
    if (previous?.kind === "text") {
      previous.text += text
      return
    }

    groups.push({ kind: "text", text })
  }

  const appendReasoning = (part: UIMessage["parts"][number]) => {
    if (!isReasoningUIPart(part)) {
      return
    }

    const previous = groups.at(-1)
    if (previous?.kind === "reasoning") {
      previous.text += part.text
      previous.isStreaming = previous.isStreaming || part.state === "streaming"
      return
    }

    if (!part.text.trim()) {
      return
    }

    groups.push({ kind: "reasoning", text: part.text, isStreaming: part.state === "streaming" })
  }

  for (const part of filteredParts) {
    const compaction = getSessionCompactionFromPart(part)
    if (compaction) {
      groups.push({ kind: "compaction", state: compaction })
      continue
    }
    if (part.type === "text") {
      appendText(part.text)
      continue
    }

    if (isReasoningUIPart(part)) {
      if (showThinking) {
        appendReasoning(part)
      }
      continue
    }

    if (part.type === "file") {
      groups.push({ kind: "file", part })
      continue
    }

    if (isToolUIPart(part)) {
      const previous = groups.at(-1)
      if (previous?.kind === "tools") {
        previous.parts.push(part)
      } else {
        groups.push({ kind: "tools", parts: [part] })
      }
    }
  }

  for (const group of groups) {
    if (group.kind === "reasoning") {
      group.text = redactSensitiveReasoning(group.text)
    }
  }

  return groups
}

export function mergeAssistantProcessItems(items: UIMessageWithIndex[]): UIMessageWithIndex | null {
  const first = items[0]
  const last = items.at(-1)
  if (!first || !last) return null

  return {
    index: last.index,
    message: {
      ...last.message,
      // Keep a stable, real message id while streamed process messages are appended.
      id: first.message.id,
      parts: items.flatMap((item) => item.message.parts),
    },
  }
}
