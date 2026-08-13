import { describe, expect, test } from "bun:test";
import {
  agentRuntimeDescriptorSchema,
  canonicalAgentEventSchema,
  canonicalSessionSnapshotSchema,
  type CanonicalAgentEvent,
} from "@jugglework/types/agent-runtime";

import eventsFixture from "./fixtures/opencode-events.json" with { type: "json" };
import sessionFixture from "./fixtures/opencode-session.json" with { type: "json" };
import { verifyCommonAgentEngineContract } from "./contract-test-support.js";
import { OpenCodeAgentEngineAdapter } from "./opencode-adapter.js";

type Call = { method: string; input?: unknown };

function result(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function recordedClient(events: unknown[] = eventsFixture) {
  const calls: Call[] = [];
  const client = {
    global: { health: async () => result({ healthy: true, version: "1.18.7" }) },
    instance: { dispose: async () => { calls.push({ method: "dispose" }); return result(true); } },
    provider: {
      list: async () => result({
        all: [{
          id: "provider-a",
          models: {
            "model-a": { id: "model-a", name: "Model A", capabilities: { reasoning: true, toolcall: true } },
          },
        }],
        default: { "provider-a": "model-a" },
        connected: ["provider-a"],
      }),
    },
    session: {
      create: async (input: unknown) => { calls.push({ method: "create", input }); return result(sessionFixture.session); },
      list: async () => result([sessionFixture.session]),
      get: async (input: unknown) => { calls.push({ method: "get", input }); return result(sessionFixture.session); },
      messages: async (input: unknown) => { calls.push({ method: "messages", input }); return result(sessionFixture.messages); },
      todo: async () => result(sessionFixture.todos),
      status: async () => result({ "backend-session": { type: "retry", attempt: 2, message: "wait", next: 500 } }),
      promptAsync: async (input: unknown) => { calls.push({ method: "promptAsync", input }); return result(undefined); },
      abort: async (input: unknown) => { calls.push({ method: "abort", input }); return result(true); },
      update: async (input: unknown) => { calls.push({ method: "update", input }); return result({ ...sessionFixture.session, title: "Renamed" }); },
      fork: async (input: unknown) => { calls.push({ method: "fork", input }); return result({ ...sessionFixture.session, id: "backend-fork", title: "Fork" }); },
    },
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          for (const event of events) yield event;
        })(),
      }),
    },
    permission: {
      list: async () => result(sessionFixture.permissions),
      reply: async (input: unknown) => { calls.push({ method: "permission.reply", input }); return result(true); },
    },
    question: {
      list: async () => result(sessionFixture.questions),
      reply: async (input: unknown) => { calls.push({ method: "question.reply", input }); return result(true); },
      reject: async (input: unknown) => { calls.push({ method: "question.reject", input }); return result(true); },
    },
    v2: {
      session: {
        permission: {
          list: async () => result({ data: [] }),
          reply: async (input: unknown) => { calls.push({ method: "permission.v2.reply", input }); return result(true); },
        },
        question: {
          list: async () => result({ data: [] }),
          reply: async (input: unknown) => { calls.push({ method: "question.v2.reply", input }); return result(true); },
          reject: async (input: unknown) => { calls.push({ method: "question.v2.reject", input }); return result(true); },
        },
      },
    },
    mcp: {
      add: async (input: unknown) => { calls.push({ method: "mcp.add", input }); return result({ demo: { status: "connected" } }); },
      disconnect: async (input: unknown) => { calls.push({ method: "mcp.disconnect", input }); return result(true); },
    },
  };
  return { client, calls };
}

async function collectEvents(adapter: OpenCodeAgentEngineAdapter): Promise<CanonicalAgentEvent[]> {
  const events: CanonicalAgentEvent[] = [];
  for await (const event of adapter.subscribeEvents({ workspaceId: "workspace-a", directory: "/workspace" })) {
    events.push(event);
  }
  return events;
}

describe("OpenCodeAgentEngineAdapter contract", () => {
  test("passes the common engine contract against recorded OpenCode behavior", async () => {
    const { client } = recordedClient([]);
    await verifyCommonAgentEngineContract({
      engine: new OpenCodeAgentEngineAdapter({ createClient: () => client }),
      context: { workspaceId: "workspace-a", directory: "/workspace" },
      expectedRuntimeId: "jugglework",
      expectedBackendSessionId: "backend-session",
    });
  });

  test("wraps create, list, read, snapshot, run, abort, model, MCP, reload and dispose behavior", async () => {
    const { client, calls } = recordedClient([]);
    const adapter = new OpenCodeAgentEngineAdapter({ createClient: () => client });
    const context = { workspaceId: "workspace-a", directory: "/workspace" };

    expect(agentRuntimeDescriptorSchema.parse(await adapter.descriptor()).id).toBe("jugglework");
    expect(await adapter.listModels(context)).toEqual([
      expect.objectContaining({ id: "model-a", providerId: "provider-a", isDefault: true }),
    ]);

    const created = await adapter.createSession({
      ...context,
      sessionId: "public-session",
      title: "Recorded OpenCode session",
      configuration: {
        agentProfile: "jugglework",
        model: { providerId: "provider-a", modelId: "model-a" },
        execution: { effort: "high" },
      },
    });
    expect(created).toMatchObject({
      id: "public-session",
      backendSessionId: "backend-session",
      runtimeId: "jugglework",
      status: { type: "idle" },
    });
    expect((await adapter.listSessions(context))[0]).toMatchObject({ backendSessionId: "backend-session" });
    expect(await adapter.readSession({ ...context, sessionId: "public-session" })).toMatchObject({
      id: "public-session",
      status: { type: "retrying", attempt: 2 },
    });
    const messages = await adapter.readMessages({ ...context, sessionId: "public-session" });
    expect(messages[1]).toMatchObject({
      id: "message-assistant",
      parts: [
        { id: "part-text", type: "text", text: "Hello world", state: "complete" },
        { id: "part-tool", type: "tool", toolCallId: "call-read", state: "completed" },
      ],
    });
    const snapshot = canonicalSessionSnapshotSchema.parse(
      await adapter.readSnapshot({ ...context, sessionId: "public-session" }),
    );
    expect(snapshot.todos).toEqual([
      { id: "todo-one", content: "Verify adapter", status: "in_progress", priority: "high" },
    ]);
    expect(snapshot.interactions.map(({ kind }) => kind)).toEqual(["permission", "question"]);

    await adapter.startRun({
      ...context,
      sessionId: "public-session",
      backendSessionId: "backend-session",
      runId: "run-one",
      prompt: { parts: [{ type: "text", text: "hello" }] },
    });
    await adapter.abortRun({
      ...context,
      sessionId: "public-session",
      backendSessionId: "backend-session",
      runId: "run-one",
    });
    await adapter.resolveInteraction({
      ...context,
      sessionId: "public-session",
      backendSessionId: "backend-session",
      interactionId: "permission-one",
      resolution: { outcome: "allow" },
    });
    await adapter.resolveInteraction({
      ...context,
      sessionId: "public-session",
      backendSessionId: "backend-session",
      interactionId: "permission-persistent",
      resolution: { outcome: "allow", updatedInput: { permissionPersistence: "always" } },
    });
    await adapter.resolveInteraction({
      ...context,
      sessionId: "public-session",
      backendSessionId: "backend-session",
      interactionId: "question-one",
      resolution: { outcome: "answer", values: ["Yes"] },
    });
    await adapter.registerMcp(context, "demo", { type: "remote", url: "https://example.test/mcp" });
    await adapter.disconnectMcp(context, "demo");
    await adapter.reloadConfiguration(context);
    await adapter.dispose();

    expect(calls).toContainEqual({
      method: "promptAsync",
      input: {
        sessionID: "backend-session",
        model: { providerID: "provider-a", modelID: "model-a" },
        agent: "jugglework",
        variant: "high",
        parts: [{ type: "text", text: "hello" }],
      },
    });
    expect(calls).toContainEqual({ method: "abort", input: { sessionID: "backend-session" } });
    expect(calls).toContainEqual({
      method: "permission.reply",
      input: { requestID: "permission-one", reply: "once" },
    });
    expect(calls).toContainEqual({
      method: "permission.reply",
      input: { requestID: "permission-persistent", reply: "always" },
    });
    expect(calls).toContainEqual({
      method: "question.reply",
      input: { requestID: "question-one", answers: [["Yes"]] },
    });
    expect(calls.filter(({ method }) => method === "dispose")).toHaveLength(2);
  });

  test("maps recorded deltas, final parts, tools, status, retry, errors, todos, permissions and questions", async () => {
    const { client } = recordedClient();
    const adapter = new OpenCodeAgentEngineAdapter({ createClient: () => client, now: () => 1_000 });
    await adapter.createSession({
      workspaceId: "workspace-a",
      directory: "/workspace",
      sessionId: "public-session",
      title: "Recorded",
      configuration: {},
    });
    await adapter.startRun({
      workspaceId: "workspace-a",
      directory: "/workspace",
      sessionId: "public-session",
      backendSessionId: "backend-session",
      runId: "run-live",
      prompt: { parts: [{ type: "text", text: "go" }] },
    });

    const events = await collectEvents(adapter);
    events.forEach((event) => canonicalAgentEventSchema.parse(event));
    expect(events.every((event, index) => event.sequence === index + 1)).toBe(true);
    expect(events.every((event) => event.sessionId === "public-session" && event.runtimeId === "jugglework")).toBe(true);

    const deltas = events.filter((event) => event.data.type === "message.part.delta");
    expect(deltas.map((event) => event.data.type === "message.part.delta" ? event.data.delta : "")).toEqual(["Hello ", "world"]);
    const finalPart = events.find((event) => event.data.type === "message.part.updated" && event.data.part.id === "part-live");
    expect(finalPart?.data).toMatchObject({
      type: "message.part.updated",
      part: { type: "text", text: "Hello world", state: "complete" },
    });
    const messageUpdates = events.filter((event) => event.data.type === "message.updated" && event.data.message.id === "message-live");
    expect(new Set(messageUpdates.map((event) => event.data.type === "message.updated" ? event.data.message.id : ""))).toEqual(
      new Set(["message-live"]),
    );
    expect(messageUpdates.at(-1)?.data).toMatchObject({
      type: "message.updated",
      message: {
        id: "message-live",
        completedAt: 315,
        parts: [
          { id: "part-live", type: "text", text: "Hello world" },
          { id: "part-live-tool", type: "tool", toolCallId: "call-live" },
        ],
      },
    });
    expect(events.find((event) => event.data.type === "message.part.updated" && event.data.part.id === "part-live-tool")?.data)
      .toMatchObject({ type: "message.part.updated", part: { type: "tool", state: "running", toolCallId: "call-live" } });
    expect(events.find((event) => event.data.type === "session.status" && event.data.status.type === "retrying")?.data)
      .toMatchObject({ type: "session.status", status: { type: "retrying", attempt: 2, message: "rate limited" } });
    expect(events.find((event) => event.data.type === "session.status" && event.data.status.type === "running")).toBeDefined();
    expect(events.find((event) => event.data.type === "todo.updated")?.data)
      .toMatchObject({ type: "todo.updated", todos: [{ id: "todo-live", status: "completed" }] });
    expect(events.filter((event) => event.data.type === "interaction.requested").map((event) =>
      event.data.type === "interaction.requested" ? event.data.interaction.kind : null)).toEqual(["permission", "question"]);
    expect(events.find((event) => event.data.type === "run.failed")?.data)
      .toMatchObject({ type: "run.failed", runId: "run-live", message: "provider failed", retryable: true });
  });

  test("returns stable request and backend-session mismatch errors", async () => {
    const { client } = recordedClient([]);
    const adapter = new OpenCodeAgentEngineAdapter({ createClient: () => client });
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    await adapter.createSession({ ...context, sessionId: "public-session", title: "Recorded", configuration: {} });

    await expect(adapter.startRun({
      ...context,
      sessionId: "public-session",
      backendSessionId: "another-backend",
      runId: "run-one",
      prompt: {},
    })).rejects.toMatchObject({ code: "runtime_session_mismatch" });

    const failed = new OpenCodeAgentEngineAdapter({
      createClient: () => ({
        session: {
          list: async () => ({
            data: undefined,
            error: { message: "upstream unavailable" },
            response: new Response(null, { status: 503 }),
          }),
        },
      }),
    });
    await expect(failed.listSessions(context)).rejects.toMatchObject({
      code: "runtime_request_failed",
      details: { path: "/session", status: 503 },
    });
  });

  test("preserves v2 permission and question reply routing", async () => {
    const { client, calls } = recordedClient([]);
    client.v2.session.permission.list = async () => result({
      data: [{
        id: "permission-v2",
        sessionID: "backend-session",
        action: "read",
        resources: ["/workspace/README.md"],
        metadata: {},
      }],
    });
    client.v2.session.question.list = async () => result({
      data: [{
        id: "question-v2",
        sessionID: "backend-session",
        questions: [{
          question: "Continue?",
          header: "Continue",
          options: [{ label: "Yes", description: "Continue" }],
          multiple: false,
          custom: false,
        }],
      }],
    });
    const adapter = new OpenCodeAgentEngineAdapter({ createClient: () => client });
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    await adapter.createSession({ ...context, sessionId: "public-session", title: "Recorded", configuration: {} });
    const snapshot = await adapter.readSnapshot({ ...context, sessionId: "public-session" });
    expect(snapshot.interactions.filter(({ id }) => id.endsWith("-v2")).map(({ metadata }) => metadata?.protocol))
      .toEqual(["v2", "v2"]);

    await adapter.resolveInteraction({
      ...context,
      sessionId: "public-session",
      backendSessionId: "backend-session",
      interactionId: "permission-v2",
      resolution: { outcome: "allow" },
    });
    await adapter.resolveInteraction({
      ...context,
      sessionId: "public-session",
      backendSessionId: "backend-session",
      interactionId: "question-v2",
      resolution: { outcome: "answer", values: ["Yes"] },
    });
    expect(calls).toContainEqual({
      method: "permission.v2.reply",
      input: { sessionID: "backend-session", requestID: "permission-v2", reply: "once" },
    });
    expect(calls).toContainEqual({
      method: "question.v2.reply",
      input: {
        sessionID: "backend-session",
        requestID: "question-v2",
        questionV2Reply: { answers: [["Yes"]] },
      },
    });
  });

  test("keeps snapshot interactions available when one OpenCode protocol list fails", async () => {
    const { client } = recordedClient([]);
    (client.permission as { list: () => Promise<unknown> }).list = async () => ({
      data: undefined,
      error: { message: "legacy permission route unavailable" },
      response: new Response(null, { status: 503 }),
    });
    client.v2.session.permission.list = async () => result({
      data: [{
        id: "permission-v2-only",
        sessionID: "backend-session",
        action: "read",
        resources: ["/workspace/README.md"],
      }],
    });
    const adapter = new OpenCodeAgentEngineAdapter({ createClient: () => client });
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    await adapter.createSession({ ...context, sessionId: "public-session", title: "Recorded", configuration: {} });

    const snapshot = await adapter.readSnapshot({ ...context, sessionId: "public-session" });
    expect(snapshot.interactions).toContainEqual(expect.objectContaining({
      id: "permission-v2-only",
      kind: "permission",
      description: "/workspace/README.md",
    }));
  });
});
