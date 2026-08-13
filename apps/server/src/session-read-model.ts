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
import type { RuntimeEvent } from "@jugglework/types/agent-runtime";
import type { RuntimeSessionRecord } from "@jugglework/types/runtime-session";

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
export type SessionMessageReadModel = z.infer<typeof sessionMessageSchema>;
export type SessionTodoReadModel = z.infer<typeof sessionTodoSchema>;
export type SessionStatusReadModel = z.infer<typeof sessionStatusSchema>;
export type SessionSnapshotReadModel = z.infer<typeof sessionSnapshotSchema>;

const IDLE_STATUS: SessionStatusReadModel = { type: "idle" };

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(502, "opencode_invalid_response", `OpenCode returned invalid ${label}`, {
    issues: result.error.issues,
  });
}

export function buildSessionList(value: SessionListResponse): SessionInfoReadModel[] {
  return parseOrThrow(sessionListSchema, value, "session list");
}

export function buildSession(value: SessionGetResponse): SessionInfoReadModel {
  return parseOrThrow(sessionInfoSchema, value, "session");
}

export function buildSessionMessages(value: SessionMessagesArrayResponse): SessionMessageReadModel[] {
  return parseOrThrow(sessionMessagesSchema, value, "session messages");
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

/** Projects the JuggleWork-authoritative runtime ledger into the existing UI wire shape. */
export function buildRuntimeSessionSnapshot(input: {
  record: RuntimeSessionRecord;
  events: RuntimeEvent[];
}): SessionSnapshotReadModel {
  const { record } = input;
  const messages = new Map<string, SessionMessageReadModel>();
  let status: SessionStatusReadModel = IDLE_STATUS;

  function message(id: string, role: string, created: number): SessionMessageReadModel {
    const current = messages.get(id);
    if (current) return current;
    const next = { info: { id, sessionID: record.id, role, time: { created } }, parts: [] } as SessionMessageReadModel;
    messages.set(id, next);
    return next;
  }

  for (const event of input.events) {
    if (!("turnId" in event)) continue;
    if (event.type === "turn.started") status = { type: "busy" };
    if (event.type === "turn.completed" || event.type === "turn.interrupted" || event.type === "turn.failed") status = IDLE_STATUS;
    if (event.type === "user.message") {
      const target = message(`user:${event.turnId}`, "user", event.occurredAt);
      target.parts = event.content.map((part, index) => part.type === "text"
        ? { id: `${event.eventId}:${index}`, messageID: target.info.id, sessionID: record.id, type: "text", text: part.text }
        : { id: `${event.eventId}:${index}`, messageID: target.info.id, sessionID: record.id, type: "file",
          mime: part.attachment.mimeType, filename: part.attachment.name, url: part.attachment.objectRef });
    }
    if (event.type === "assistant.delta" || event.type === "reasoning.delta") {
      const target = message(`assistant:${event.turnId}`, "assistant", event.occurredAt);
      const partType = event.type === "assistant.delta" ? "text" : "reasoning";
      const partId = `${partType}:${event.turnId}`;
      const existing = target.parts.find((part) => part.id === partId) as ({ text?: string } & SessionMessageReadModel["parts"][number]) | undefined;
      if (existing) existing.text = `${existing.text ?? ""}${event.text}`;
      else target.parts.push({ id: partId, messageID: target.info.id, sessionID: record.id, type: partType, text: event.text });
    }
    if (event.type === "tool.started") {
      const target = message(`assistant:${event.turnId}`, "assistant", event.occurredAt);
      target.parts.push({ id: event.toolCallId, messageID: target.info.id, sessionID: record.id, type: "tool",
        tool: event.name, callID: event.toolCallId, state: { status: "running", input: event.arguments } });
    }
    if (event.type === "tool.completed") {
      const target = message(`assistant:${event.turnId}`, "assistant", event.occurredAt);
      const existing = target.parts.find((part) => part.id === event.toolCallId) as ({ state?: unknown } & SessionMessageReadModel["parts"][number]) | undefined;
      if (existing) existing.state = { status: event.success ? "completed" : "error", output: event.output };
    }
  }

  return parseOrThrow(sessionSnapshotSchema, {
    session: {
      id: record.id, title: record.title, directory: record.cwd,
      time: { created: record.createdAt, updated: record.updatedAt, ...(record.archivedAt === null ? {} : { archived: record.archivedAt }) },
      runtimeKind: record.runtimeKind, backendThreadId: record.backendThreadId,
    },
    messages: [...messages.values()], todos: [], status,
  }, "runtime session snapshot");
}
