import { z } from "zod";
import type {
  SessionGetResponse,
  SessionListResponse,
  // The v1 `/session/{id}/message` route returns a bare message array; the
  // `SessionMessagesResponse` name now belongs to the paginated v2 envelope.
  SessionMessagesResponse2 as SessionMessagesArrayResponse,
  SessionStatusResponse,
  SessionTodoResponse,
} from "@opencode-ai/sdk/v2/client";

import { ApiError } from "./errors.js";

const sessionTimeSchema = z
  .object({
    created: z.number().optional(),
    updated: z.number().optional(),
    completed: z.number().optional(),
    archived: z.number().optional(),
  })
  .passthrough();

const sessionSummarySchema = z
  .object({
    additions: z.number().optional(),
    deletions: z.number().optional(),
    files: z.number().optional(),
  })
  .passthrough();

export const sessionStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({ type: z.literal("retry"), attempt: z.number(), message: z.string(), next: z.number() }),
]);

export const sessionTodoSchema = z
  .object({
    content: z.string(),
    status: z.string(),
    priority: z.string(),
  })
  .passthrough();

export const sessionInfoSchema = z
  .object({
    id: z.string(),
    title: z.string().nullish(),
    slug: z.string().nullish(),
    parentID: z.string().nullish(),
    directory: z.string().nullish(),
    time: sessionTimeSchema.optional(),
    summary: sessionSummarySchema.optional(),
  })
  .passthrough();

const sessionMessageInfoSchema = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    role: z.string(),
    parentID: z.string().nullish(),
    time: sessionTimeSchema.optional(),
  })
  .passthrough();

const sessionPartSchema = z
  .object({
    id: z.string(),
    messageID: z.string(),
    sessionID: z.string(),
  })
  .passthrough();

export const sessionMessageSchema = z
  .object({
    info: sessionMessageInfoSchema,
    parts: z.array(sessionPartSchema),
  })
  .passthrough();

const sessionListSchema = z.array(sessionInfoSchema);
const sessionMessagesSchema = z.array(sessionMessageSchema);
const sessionTodosSchema = z.array(sessionTodoSchema);
const sessionStatusesSchema = z.record(z.string(), sessionStatusSchema);

const sessionSnapshotSchema = z.object({
  session: sessionInfoSchema,
  messages: sessionMessagesSchema,
  todos: sessionTodosSchema,
  status: sessionStatusSchema,
});

export type SessionInfoReadModel = z.infer<typeof sessionInfoSchema>;
export type SessionListItemReadModel = SessionInfoReadModel & { status: SessionStatusReadModel };
export type SessionMessageReadModel = z.infer<typeof sessionMessageSchema>;
export type SessionTodoReadModel = z.infer<typeof sessionTodoSchema>;
export type SessionStatusReadModel = z.infer<typeof sessionStatusSchema>;
export type SessionSnapshotReadModel = z.infer<typeof sessionSnapshotSchema>;

const IDLE_STATUS: SessionStatusReadModel = { type: "idle" };
const MAX_INLINE_READ_OUTPUT_CHARS = 128 * 1024;
const READ_OUTPUT_TAIL_CHARS = 16 * 1024;
const MAX_INLINE_READ_ATTACHMENT_CHARS = 256 * 1024;

function isOversizedInlineImageAttachment(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attachment = value as Record<string, unknown>;
  return typeof attachment.mime === "string"
    && attachment.mime.toLowerCase().startsWith("image/")
    && typeof attachment.url === "string"
    && attachment.url.toLowerCase().startsWith("data:image/")
    && attachment.url.length > MAX_INLINE_READ_ATTACHMENT_CHARS;
}

function boundReadToolPayload(messages: SessionMessageReadModel[]): SessionMessageReadModel[] {
  return messages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      const record = part as Record<string, unknown>;
      const state = record.state;
      if (
        record.type !== "tool" ||
        record.tool !== "read" ||
        !state ||
        typeof state !== "object" ||
        Array.isArray(state)
      ) return part;
      const toolState = state as Record<string, unknown>;
      const output = toolState.output;
      if (toolState.status !== "completed") return part;
      const attachments = Array.isArray(toolState.attachments) ? toolState.attachments : [];
      const visibleAttachments = attachments.filter((attachment) => !isOversizedInlineImageAttachment(attachment));
      const omittedAttachments = attachments.length - visibleAttachments.length;
      const shouldBoundOutput = typeof output === "string" && output.length > MAX_INLINE_READ_OUTPUT_CHARS;
      if (!shouldBoundOutput && omittedAttachments === 0) return part;

      changed = true;
      const boundedOutput = shouldBoundOutput
        ? (() => {
            const marker = `\n\n[JuggleWork omitted ${output.length - MAX_INLINE_READ_OUTPUT_CHARS} characters from this historical read result to keep the session responsive.]\n\n`;
            const headChars = MAX_INLINE_READ_OUTPUT_CHARS - READ_OUTPUT_TAIL_CHARS;
            return `${output.slice(0, headChars)}${marker}${output.slice(-READ_OUTPUT_TAIL_CHARS)}`;
          })()
        : output;
      const metadata = toolState.metadata && typeof toolState.metadata === "object" && !Array.isArray(toolState.metadata)
        ? toolState.metadata as Record<string, unknown>
        : {};
      return {
        ...part,
        state: {
          ...toolState,
          output: boundedOutput,
          ...(omittedAttachments > 0 ? {
            attachments: visibleAttachments,
            metadata: {
              ...metadata,
              juggleworkOmittedInlineImageAttachments: omittedAttachments,
            },
          } : {}),
        },
      };
    });
    return changed ? { ...message, parts } : message;
  });
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(502, "opencode_invalid_response", `OpenCode returned invalid ${label}`, {
    issues: result.error.issues,
  });
}

export function buildSessionList(
  value: SessionListResponse,
  statusValue: SessionStatusResponse,
): SessionListItemReadModel[] {
  const sessions = parseOrThrow(sessionListSchema, value, "session list");
  if (!statusValue || typeof statusValue !== "object" || Array.isArray(statusValue)) {
    throw new ApiError(502, "opencode_invalid_response", "OpenCode returned invalid session statuses");
  }
  return sessions.map((session) => {
    const rawStatus = Object.prototype.hasOwnProperty.call(statusValue, session.id)
      ? statusValue[session.id]
      : undefined;
    return {
      ...session,
      // OpenCode omits idle sessions from /session/status. An absent entry is
      // therefore authoritative idle, while a present malformed entry remains
      // an upstream contract error. Ignore unrelated entries so pagination is
      // not poisoned by a future status attached to an off-page session.
      status: rawStatus === undefined
        ? IDLE_STATUS
        : parseOrThrow(sessionStatusSchema, rawStatus, "session status"),
    };
  });
}

export function buildSession(value: SessionGetResponse): SessionInfoReadModel {
  return parseOrThrow(sessionInfoSchema, value, "session");
}

export function buildSessionMessages(value: SessionMessagesArrayResponse): SessionMessageReadModel[] {
  return boundReadToolPayload(parseOrThrow(sessionMessagesSchema, value, "session messages"));
}

export function buildSessionTodos(value: SessionTodoResponse): SessionTodoReadModel[] {
  return parseOrThrow(sessionTodosSchema, value, "session todos");
}

export function buildSessionStatuses(value: SessionStatusResponse): Record<string, SessionStatusReadModel> {
  return parseOrThrow(sessionStatusesSchema, value, "session statuses");
}

export function buildSessionSnapshot(input: {
  session: SessionGetResponse;
  messages: SessionMessagesArrayResponse;
  todos: SessionTodoResponse;
  statuses: SessionStatusResponse;
}): SessionSnapshotReadModel {
  const session = buildSession(input.session);
  const messages = buildSessionMessages(input.messages);
  const todos = buildSessionTodos(input.todos);
  const statuses = buildSessionStatuses(input.statuses);
  return parseOrThrow(
    sessionSnapshotSchema,
    {
      session,
      messages,
      todos,
      status: statuses[session.id] ?? IDLE_STATUS,
    },
    "session snapshot",
  );
}
