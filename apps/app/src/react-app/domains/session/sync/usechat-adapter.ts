/** @jsxImportSource react */
import type { UIMessage } from "ai";
import type { FilePart, Part, ToolPart } from "@opencode-ai/sdk/v2/client";

import type { JuggleWorkSessionSnapshot } from "../../../../app/lib/jugglework-server";
import { safeStringify } from "../../../../app/utils";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../../../../app/types";
import { createSessionCompactionUIPart } from "../../../../app/lib/session-compaction";
import { t } from "../../../../i18n";
import {
  classifyProviderLimit,
  type ProviderLimitKind,
} from "./provider-limit-classify";
import {
  classifyProviderError,
  extractProviderErrorSignals,
} from "./provider-error-classify";
import {
  parseDynamicToolUIPart,
  parseStructuredOutputUIPart,
  STRUCTURED_OUTPUT_TOOL,
} from "./parse-tool-parts";

function defaultErrorMessage(name: string | null, fallback: string) {
  if (name === "ProviderAuthError") return "Provider authentication failed";
  if (name === "MessageOutputLengthError") return "The model reached its output limit before finishing";
  if (name === "StructuredOutputError") return "The model could not produce valid structured output";
  if (name === "ContextOverflowError") return "The conversation is too large for the model context window";
  if (name === "MessageAbortedError") return "The message was interrupted";
  return fallback;
}

/**
 * Unsupported file parts live in server-side session history, so the same
 * provider error replays on every later prompt. Tell the user how to escape.
 */
function withAttachmentRecoveryHint(text: string) {
  if (!text.includes("file part media type") || !text.includes("not supported")) return text;
  return `${text}\nAn attached file in this conversation uses a format the model can't read. Revert the conversation to before the attachment was sent, or start a new session.`;
}

/**
 * OpenCode Codex/ChatGPT OAuth refresh failures surface as a raw engine string.
 * Narrowly rewrite the 401 case so users reconnect OpenAI — not JuggleWork Cloud.
 */
function withOpenAiTokenRefreshHint(text: string) {
  if (!/Token refresh failed:\s*401/i.test(text)) return text;
  return "OpenAI couldn’t renew the ChatGPT sign-in for this worker. Retry once. If it happens again, reconnect OpenAI under Connect providers → OpenAI → ChatGPT Pro/Plus.";
}

function withSessionErrorHints(text: string) {
  return withOpenAiTokenRefreshHint(withAttachmentRecoveryHint(text));
}

/**
 * Terminal provider limits get a localized heading plus an actionable hint
 * (switch model / check quota, or recover context overflow), keeping the raw
 * provider text as a diagnostic line below.
 */
function limitHeadingAndHint(kind: ProviderLimitKind): [string, string] {
  return kind === "usage_limit"
    ? [t("app.error_usage_limit"), t("app.error_usage_limit_hint")]
    : [t("app.error_context_overflow"), t("app.error_context_overflow_hint")];
}

function describeLimitedError(kind: ProviderLimitKind, detail: string | null, fallback: string): string {
  const [heading, hint] = limitHeadingAndHint(kind);
  const lines = [heading, hint];
  if (detail && detail.trim() && detail !== heading) lines.push(detail);
  return withSessionErrorHints(lines.join("\n"));
}

export function describeOpencodeSessionError(error: unknown, fallback = "Session failed") {
  const providerError = classifyProviderError(error);
  const signals = extractProviderErrorSignals(error);
  if (providerError === "ip_not_authorized") {
    const lines = [t("app.error_ip_authorization"), t("app.error_ip_authorization_hint")];
    if (signals.message && !lines.includes(signals.message)) lines.push(signals.message);
    if (signals.status) lines.push(`Status: ${signals.status}`);
    if (signals.provider) lines.push(`Provider: ${signals.provider}`);
    if (signals.code) lines.push(`Code: ${signals.code}`);
    if (signals.responseBody && signals.responseBody !== signals.message) {
      lines.push(`Response: ${signals.responseBody}`);
    }
    return lines.join("\n");
  }

  if (error instanceof Error) {
    const limit = classifyProviderLimit({ text: error.message });
    if (limit) return describeLimitedError(limit, error.message, fallback);
    return withSessionErrorHints(error.message || fallback);
  }
  if (typeof error === "string") {
    const limit = classifyProviderLimit({ text: error });
    if (limit) return describeLimitedError(limit, error, fallback);
    return withSessionErrorHints(error.trim() || fallback);
  }
  if (!error || typeof error !== "object") return fallback;

  const name = signals.type;
  const message = signals.message;
  const status = signals.status;
  const provider = signals.provider;
  const code = signals.code;
  const retries = signals.retries;
  const responseBody = signals.responseBody;

  const lines = (() => {
    const limit = classifyProviderLimit({
      status,
      code,
      name,
      text: [message, responseBody].filter(Boolean).join("\n"),
    });
    if (!limit) return [message ?? defaultErrorMessage(name, fallback)];
    const [heading, hint] = limitHeadingAndHint(limit);
    const limited = [heading, hint];
    if (message && message !== heading) limited.push(message);
    return limited;
  })();
  if (status && !lines[0]?.includes(String(status))) lines.push(`Status: ${status}`);
  if (provider && !lines[0]?.includes(provider)) lines.push(`Provider: ${provider}`);
  if (code) lines.push(`Code: ${code}`);
  if (retries !== null) lines.push(`Retries: ${retries}`);
  if (responseBody && responseBody !== message) lines.push(`Response: ${responseBody}`);
  if (lines.some((line) => line !== fallback)) return withSessionErrorHints(lines.join("\n"));

  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : fallback;
}

function sessionErrorMessageId(turnKey: string) {
  return `${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}${turnKey}`;
}

/**
 * Build the synthetic chat message that surfaces a session error.
 *
 * The error is keyed to the *turn* that failed (`turnKey`), not the session.
 * Both the live `session.error` event and the snapshot reload derive the same
 * `turnKey` from the errored assistant message id, so they reconcile to one
 * message instead of duplicating — while a brand new error on a later turn
 * still produces its own message instead of overwriting the previous one.
 */
export function createSessionErrorUIMessage(turnKey: string, text: string, options?: { created?: number }): UIMessage {
  const id = sessionErrorMessageId(turnKey);
  const created = options?.created;
  return {
    id,
    role: "assistant",
    ...(typeof created === "number" ? { metadata: { opencode: { created } } } : {}),
    parts: [{
      type: "text",
      text,
      state: "done",
      providerMetadata: { opencode: { partId: `${id}:text` } },
    }],
  };
}

function fileProviderMetadata(part: FilePart) {
  if (part.source) {
    return { opencode: { partId: part.id, source: part.source } };
  }
  return { opencode: { partId: part.id } };
}

function getTextPartValue(part: Part) {
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "reasoning") {
    return part.text;
  }
  return "";
}

function mapFilePart(part: FilePart): UIMessage["parts"][number] {
  return {
    type: "file",
    url: part.url,
    filename: part.filename,
    mediaType: part.mime,
    providerMetadata: fileProviderMetadata(part),
  };
}

function mapFileSourcePart(part: FilePart): UIMessage["parts"][number] | null {
  const source = part.source;
  if (!source) return null;

  const sourceId = `${part.id}:source`;
  const providerMetadata = { opencode: { partId: sourceId, sourcePartId: part.id, source } };

  if (source.type === "resource") {
    if (source.uri.startsWith("http://")) {
      return { type: "source-url", sourceId, url: source.uri, title: source.uri, providerMetadata };
    }
    if (source.uri.startsWith("https://")) {
      return { type: "source-url", sourceId, url: source.uri, title: source.uri, providerMetadata };
    }
    return { type: "source-document", sourceId, mediaType: part.mime, title: source.uri, providerMetadata };
  }

  if (source.type === "symbol") {
    return { type: "source-document", sourceId, mediaType: part.mime, title: source.name, filename: source.path, providerMetadata };
  }

  return { type: "source-document", sourceId, mediaType: part.mime, title: source.path, filename: source.path, providerMetadata };
}

function mapFileParts(part: FilePart): UIMessage["parts"] {
  const sourcePart = mapFileSourcePart(part);
  if (sourcePart) return [mapFilePart(part), sourcePart];
  return [mapFilePart(part)];
}

function mapSnapshotToolParts(part: ToolPart): UIMessage["parts"] {
  if (part.tool === STRUCTURED_OUTPUT_TOOL) {
    const mapped = parseStructuredOutputUIPart(part);
    return mapped ? [mapped] : [];
  }

  const mapped = parseDynamicToolUIPart(part);
  if (!mapped) return [];

  if (part.state.status === "completed" && part.state.attachments) {
    return [mapped, ...part.state.attachments.flatMap(mapFileParts)];
  }

  return [mapped];
}

export function snapshotToUIMessages(snapshot: JuggleWorkSessionSnapshot): UIMessage[] {
  let pendingCompactionMode: "auto" | "manual" | null = null;
  return snapshot.messages.flatMap((message) => {
    const created = message.info.time?.created;
    const completed = message.info.time && "completed" in message.info.time
      ? message.info.time.completed
      : undefined;
    const timingMetadata = {
      ...(typeof created === "number" ? { created } : {}),
      ...(typeof completed === "number" ? { completed } : {}),
      ...(message.info.role === "assistant" && typeof message.info.finish === "string"
        ? { finish: message.info.finish }
        : {}),
      ...(message.info.role === "assistant" && message.info.summary === true
        ? { summary: true }
        : {}),
    };
    const boundary = message.parts.findLast((part) => part.type === "compaction");
    if (boundary?.type === "compaction") {
      pendingCompactionMode = boundary.auto ? "auto" : "manual";
    }
    const isSummary = message.info.role === "assistant" && message.info.summary === true;
    const summaryMode = isSummary ? pendingCompactionMode : null;
    if (isSummary) pendingCompactionMode = null;
    const uiMessage = {
      id: message.info.id,
      role: message.info.role,
      ...(Object.keys(timingMetadata).length > 0 ? { metadata: { opencode: timingMetadata } } : {}),
      parts: [
        ...message.parts.flatMap<UIMessage["parts"][number]>((part) => {
        if (part.type === "text") {
          if (part.synthetic || part.ignored) return [];
          return [{
            type: "text",
            text: getTextPartValue(part),
            state: "done" as const,
            providerMetadata: { opencode: { partId: part.id } },
          }];
        }
        if (part.type === "reasoning") {
          return [{
            type: "reasoning",
            text: getTextPartValue(part),
            state: "done" as const,
            providerMetadata: { opencode: { partId: part.id } },
          }];
        }
        if (part.type === "file") {
          return mapFileParts(part);
        }
        if (part.type === "tool") {
          return mapSnapshotToolParts(part);
        }
        if (part.type === "agent") {
          return [{
            type: "text",
            text: part.name ? `@${part.name}` : "@agent",
            state: "done",
            providerMetadata: { opencode: { partId: part.id } },
          }];
        }
        if (part.type === "step-start") {
          return [{ type: "step-start", providerMetadata: { opencode: { partId: part.id } } }];
        }
        if (part.type === "compaction") {
          // This is a persisted context-boundary marker, not a completion
          // receipt. The associated summary message carries authoritative
          // in-progress/completed timing for presentation.
          return [];
        }
        return [];
        }),
        ...(isSummary ? [createSessionCompactionUIPart({
          partId: `${message.info.id}:compaction`,
          mode: summaryMode ?? "unknown",
          running: typeof completed !== "number",
          startedAt: typeof created === "number" ? created : null,
          finishedAt: typeof completed === "number" ? completed : null,
        })] : []),
      ],
    };

    // Surface a failed turn as its own synthetic error message keyed by the
    // errored assistant message id. The live `session.error` event keys its
    // message off the latest assistant turn the same way, so the two
    // reconcile to one message instead of duplicating — while a later turn's
    // error still gets its own message. An empty assistant carcass for the
    // errored turn is dropped so the error reads as that turn's outcome.
    const error = message.info.role === "assistant" && "error" in message.info ? message.info.error : undefined;
    if (!error) return [uiMessage];

    const errorMessage = createSessionErrorUIMessage(message.info.id, describeOpencodeSessionError(error), { created });
    return uiMessage.parts.length > 0 ? [uiMessage, errorMessage] : [errorMessage];
  });
}
