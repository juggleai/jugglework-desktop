import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { automationSqliteAdapter } from "../automation/sqlite.js";
import { ToonProjectAssistantService } from "./project-assistant-service.js";
import { ToonWorkspaceCoordinator } from "./workspace-coordinator.js";
import { ToonWorkspaceRuntimeStore } from "./workspace-runtime-store.js";
import { ToonModelPolicyStore } from "./model-policy-store.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "toon-assistant-")); roots.push(root);
  const sqlite = new Database(":memory:");
  const runtime = ToonWorkspaceRuntimeStore.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
  const coordinator = new ToonWorkspaceCoordinator("ws-1", root, runtime);
  await coordinator.initialize({ operationId: "init-assistant", episodeId: "episode-1", actor: { kind: "human" }, origin: "human-ui", name: "Assistant", directory: "project" });
  const initialCanvas = await coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any;
  await coordinator.execute("toon-init-assistant", { operationId: "assistant-image-node", actor: { kind: "human" }, origin: "human-ui", expectedRevisions: { "canvases/main.json": initialCanvas.revision }, kind: "canvas.write", canvasId: "main", body: { ...initialCanvas.canvas, nodes: [{ id: "image-node", kind: "image-generation", position: { x: 0, y: 0 }, handles: [], config: {} }] } });
  for (const stepId of ["source-material", "episode-script", "asset-plan", "direction", "storyboard"]) {
    const project = await coordinator.query("toon-init-assistant", { kind: "project.read" }) as any;
    await coordinator.executeHumanInteraction("toon-init-assistant", { operationId: `assistant-skip-${stepId}`, actor: { kind: "human", id: "member" }, origin: "human-ui", expectedRevisions: { "toon-project.json": project.revision }, kind: "workflow.skip", episodeId: "episode-1", workflowRecordId: stepId, reason: "Assistant generation fixture prerequisite" }, "member");
  }
  const sessions = new Map<string, any>();
  const messages = new Map<string, any[]>();
  const prompts: any[] = [];
  const statuses: Record<string, { type: string }> = {};
  const aborts: string[] = [];
  const deletes: string[] = [];
  const abortResults = new Map<string, boolean | Error>();
  const deleteResults = new Map<string, Array<{ data?: boolean; error?: unknown } | Error>>();
  const forks: Array<{ sessionID: string; messageID?: string; forkedSessionID: string }> = [];
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const client: any = {
    provider: { list: async () => ({ data: { connected: ["provider"], all: [{ id: "provider", models: { text: { id: "text", name: "Text", capabilities: { output: { text: true } } }, image: { id: "image", name: "Image", capabilities: { output: { image: true } } } } }] } }) },
    session: {
      create: async (input: any) => { const id = `session-${sessions.size + 1}`; sessions.set(id, { id, title: input.title, metadata: input.metadata, permission: input.permission }); messages.set(id, []); return { data: sessions.get(id) }; },
      fork: async ({ sessionID, messageID }: any) => {
        const id = `session-${sessions.size + 1}`;
        const source = messages.get(sessionID) ?? [];
        const boundary = messageID ? source.findIndex((message) => message.info.id === messageID) : source.length;
        sessions.set(id, { id, parentID: sessionID });
        messages.set(id, source.slice(0, boundary < 0 ? 0 : boundary));
        forks.push({ sessionID, messageID, forkedSessionID: id });
        return { data: sessions.get(id) };
      },
      list: async () => ({ data: [...sessions.values()] }),
      get: async ({ sessionID }: any) => ({ data: sessions.get(sessionID) }),
      messages: async ({ sessionID }: any) => ({ data: messages.get(sessionID) ?? [] }),
      update: async ({ sessionID, ...patch }: any) => { sessions.set(sessionID, { ...sessions.get(sessionID), ...patch }); return { data: sessions.get(sessionID) }; },
      delete: async ({ sessionID }: any) => {
        deletes.push(sessionID);
        const result = deleteResults.get(sessionID)?.shift();
        if (result instanceof Error) throw result;
        if (result?.data === true) sessions.delete(sessionID);
        if (result) return result;
        sessions.delete(sessionID);
        return { data: true };
      },
      abort: async ({ sessionID }: any) => { aborts.push(sessionID); return { data: true }; },
      status: async () => ({ data: statuses }),
    },
    permission: { list: async () => ({ data: [] }), reply: async () => ({ data: true }) },
    question: { list: async () => ({ data: [] }), reply: async () => ({ data: true }) },
    tool: { ids: async () => ({ data: ["bash", "read", "jugglework_image_generate", "jugglework_video_generate", "unknown_plugin_tool", "toon_workspace_bridge"] }) },
  };
  const workspace: any = { id: "ws-1", path: root, workspaceType: "local" };
  const serviceOptions: ConstructorParameters<typeof ToonProjectAssistantService>[0] = {
    config: { workspaces: [workspace], readOnly: false } as any,
    runtime,
    resolveWorkspace: async () => workspace,
    createWorkspaceOpencodeClient: () => client,
    dispatchPrompt: async (_config, _workspace, sessionId, prompt) => {
      prompts.push({ sessionId, prompt });
      if (prompt.noReply !== true && typeof prompt.messageID === "string") messages.get(sessionId)?.push({ info: { id: prompt.messageID, sessionID: sessionId, role: "user", time: { created: now } }, parts: prompt.parts ?? [] });
    },
    dispatchAbort: async (_config, _workspace, sessionId) => {
      aborts.push(sessionId);
      const result = abortResults.get(sessionId);
      if (result instanceof Error) throw result;
      return result ?? true;
    },
    coordinator: () => coordinator,
    now: () => now,
  };
  const makeService = (overrides: Partial<ConstructorParameters<typeof ToonProjectAssistantService>[0]> = {}) => new ToonProjectAssistantService({ ...serviceOptions, ...overrides });
  const service = makeService();
  return { root, sqlite, runtime, coordinator, service, makeService, sessions, messages, prompts, aborts, abortResults, deletes, deleteResults, statuses, client, forks, advanceNow: (milliseconds: number) => { now += milliseconds; } };
}

const model = { kind: "text" as const, providerID: "provider", modelID: "text" };

async function settleQuiet(fx: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await fx.service.reconcileAllActiveTurns();
  await fx.service.reconcileAllActiveTurns();
  fx.advanceNow(3_000);
  await fx.service.reconcileAllActiveTurns();
}

async function generationProposal(fx: Awaited<ReturnType<typeof fixture>>, conversationId: string, input: { id: string; turnId: string; requestId: string; prompt: string }) {
  const catalogs = await fx.coordinator.query("toon-init-assistant", { kind: "catalogs.read" }) as any;
  return { id: input.id, conversationId, turnId: input.turnId, state: "awaiting-human-authorization" as const, requestId: input.requestId, episodeId: "episode-1", workflowRecordId: "image-candidates", canvasId: "main", nodeId: "image-node", expectedRevisions: catalogs.revisions, plan: { kind: "image" as const, model: { kind: "image" as const, providerID: "provider", modelID: "image" }, object: "frame", quantity: 1, prompt: input.prompt, references: [], parameters: { size: "1024x1024" }, executionCount: 1, knownCost: null } };
}

describe("persistent Toon project assistant", () => {
  test("creates a hidden persistent root and restores runtime-only history", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { title: "Story", model });
    const session = [...fx.sessions.values()][0];
    expect(session.metadata).toMatchObject({ kind: "toon-factory", surface: "project-assistant", hidden: true, visibility: "toon_project_assistant", workspaceId: "ws-1", projectId: "toon-init-assistant", conversationId: conversation.id });
    expect(session.permission).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "toon_workspace_bridge", pattern: "*", action: "allow" },
    ]);
    expect(JSON.stringify(await fx.coordinator.exportProject("toon-init-assistant"))).not.toContain(conversation.id);
    expect((await fx.service.list("ws-1", "toon-init-assistant"))[0]?.id).toBe(conversation.id);
    expect((await fx.service.list("ws-1", "toon-init-assistant"))[0]?.model).toEqual(model);
    await expect(fx.service.snapshot("ws-1", "another-project", conversation.id)).rejects.toMatchObject({ code: "toon_conversation_not_found" });
    fx.runtime.close();
  });

  test("renames, archives, and safely deletes runtime conversations without deleting portable projects", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { title: "Original", model });
    expect((await fx.service.update("ws-1", "toon-init-assistant", conversation.id, { title: "Renamed" })).title).toBe("Renamed");
    await fx.service.update("ws-1", "toon-init-assistant", conversation.id, { archived: true });
    expect(await fx.service.list("ws-1", "toon-init-assistant")).toEqual([]);
    expect((await fx.service.list("ws-1", "toon-init-assistant", true))[0]?.archived).toBe(true);
    expect(await fx.service.delete("ws-1", "toon-init-assistant", conversation.id)).toEqual({ deleted: true });
    expect((await fx.coordinator.query("toon-init-assistant", { kind: "project.read" }) as any).project.metadata.name).toBe("Assistant");
    expect(await fx.service.list("ws-1", "toon-init-assistant", true)).toEqual([]);
    fx.runtime.close();
  });

  test("deletes every historical root and recursive turn child after aborting active family sessions", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { title: "Family", model });
    const oldRoot = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-old-remote", "branch-old-remote");
    fx.sessions.set("child-old", { id: "child-old", parentID: oldRoot });
    fx.sessions.set("grandchild-old", { id: "grandchild-old", parentID: "child-old" });
    fx.runtime.recordLineage("ws-1", "toon-init-assistant", "child-old", oldRoot, "toon_project_subagent");
    fx.runtime.recordLineage("ws-1", "toon-init-assistant", "grandchild-old", "child-old", "toon_project_subagent");
    fx.runtime.recordLineage("ws-1", "toon-init-assistant", "persisted-only-child", "grandchild-old", "toon_project_subagent");
    fx.runtime.finishTurn("ws-1", "toon-init-assistant", conversation.id, "turn-old-remote", "interrupted", true);
    fx.sessions.set("new-root", { id: "new-root" });
    fx.messages.set("new-root", []);
    fx.runtime.replaceConversationSession("ws-1", "toon-init-assistant", conversation.id, "new-root");
    for (const sessionId of [oldRoot, "child-old", "grandchild-old", "persisted-only-child", "new-root"]) fx.statuses[sessionId] = { type: "busy" };

    expect(await fx.service.delete("ws-1", "toon-init-assistant", conversation.id)).toEqual({ deleted: true });
    expect(new Set(fx.aborts)).toEqual(new Set([oldRoot, "child-old", "grandchild-old", "persisted-only-child", "new-root"]));
    expect(fx.deletes.slice(0, 3)).toEqual(["persisted-only-child", "grandchild-old", "child-old"]);
    expect(new Set(fx.deletes.slice(3))).toEqual(new Set([oldRoot, "new-root"]));
    expect(fx.runtime.conversationForSession("ws-1", "grandchild-old")).toBeNull();
    expect(await fx.service.list("ws-1", "toon-init-assistant", true)).toEqual([]);
    fx.runtime.close();
  });

  test("persists partial cleanup ownership, blocks send, and resumes deletion after restart", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { title: "Retry", model });
    const root = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-cleanup", "branch-cleanup");
    fx.sessions.set("cleanup-child", { id: "cleanup-child", parentID: root });
    fx.runtime.recordLineage("ws-1", "toon-init-assistant", "cleanup-child", root, "toon_project_subagent");
    fx.runtime.finishTurn("ws-1", "toon-init-assistant", conversation.id, "turn-cleanup", "interrupted", true);
    fx.deleteResults.set("cleanup-child", [
      { error: { status: 503, message: "temporary delete failure" } },
      { error: { status: 503, message: "temporary delete failure" } },
      { error: { status: 503, message: "temporary delete failure" } },
      { data: true },
    ]);

    expect(await fx.service.delete("ws-1", "toon-init-assistant", conversation.id)).toEqual({ deleted: false, cleanupPending: true });
    expect(fx.deletes).toEqual(["cleanup-child", "cleanup-child", "cleanup-child"]);
    expect(fx.runtime.conversationForSession("ws-1", "cleanup-child")).toMatchObject({ projectId: "toon-init-assistant", conversationId: conversation.id });
    expect((await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id)).conversation).toMatchObject({ state: "deleting", cleanup: { pending: true, totalSessions: 2, completedSessions: 0, lastError: "temporary delete failure" } });
    await expect(fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-rejected", messageId: "message-rejected", text: "Must not send", model })).rejects.toMatchObject({ code: "toon_assistant_cleanup_pending" });

    const restarted = fx.makeService();
    await restarted.reconcileAllActiveTurns();
    expect(fx.deletes).toEqual(["cleanup-child", "cleanup-child", "cleanup-child", "cleanup-child", root]);
    expect(await restarted.list("ws-1", "toon-init-assistant", true)).toEqual([]);
    fx.runtime.close();
  });

  test("treats session not-found as confirmed cleanup and read-only delete as side-effect free", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const root = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    const readOnly = fx.makeService({ config: { workspaces: [{ id: "ws-1", path: fx.root, workspaceType: "local" }], readOnly: true } as any });
    const before = fx.sqlite.serialize();
    await expect(readOnly.delete("ws-1", "toon-init-assistant", conversation.id)).rejects.toMatchObject({ code: "read_only" });
    expect(fx.sqlite.serialize()).toEqual(before);

    fx.deleteResults.set(root, [{ error: { status: 404, message: "not found" } }]);
    expect(await fx.service.delete("ws-1", "toon-init-assistant", conversation.id)).toEqual({ deleted: true });
    expect(await fx.service.list("ws-1", "toon-init-assistant", true)).toEqual([]);
    fx.runtime.close();
  });

  test("validates the exact live text model and never silently substitutes", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    await expect(fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-image", messageId: "message-image", text: "No fallback", model: { kind: "image", providerID: "provider", modelID: "image" } })).rejects.toMatchObject({ code: "selected_model_unavailable" });
    expect(fx.prompts).toHaveLength(0);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-1", messageId: "message-1", text: "Inspect the project", model });
    expect(fx.prompts).toHaveLength(1);
    expect(fx.prompts[0].prompt).toMatchObject({ model: { providerID: "provider", modelID: "text" }, tools: {
      bash: false,
      read: false,
      jugglework_image_generate: false,
      jugglework_video_generate: false,
      unknown_plugin_tool: false,
      toon_workspace_bridge: true,
    } });
    expect(fx.prompts[0].prompt.system).toContain("never submit it without the dedicated exact human compute authorization");
    fx.runtime.close();
  });

  test("revalidates the live organization model policy before execution", async () => {
    const fx = await fixture();
    const policy = new ToonModelPolicyStore();
    const content = { workspaceId: "ws-1", signedIn: true, policyFresh: true, organizationId: "org-1", userId: "user-1", allowedModels: ["provider/other"], validatedAt: "2026-01-01T00:00:00.000Z" };
    const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}` : JSON.stringify(value);
    policy.update({ ...content, revision: 1, digest: createHash("sha256").update(canonical(content)).digest("hex") });
    const service = new ToonProjectAssistantService({
      config: { workspaces: [{ id: "ws-1", path: fx.root, workspaceType: "local" }] } as any,
      runtime: fx.runtime,
      resolveWorkspace: async () => ({ id: "ws-1", path: fx.root, workspaceType: "local" }) as any,
      createWorkspaceOpencodeClient: () => ({
        provider: { list: async () => ({ data: { connected: ["provider"], all: [{ id: "provider", source: "api", models: { text: { id: "text", capabilities: { output: { text: true } } } } }] } }) },
      }) as any,
      dispatchPrompt: async () => undefined,
      dispatchAbort: async () => true,
      coordinator: () => fx.coordinator,
      modelPolicy: policy,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    await expect(service.create("ws-1", "toon-init-assistant", { model })).rejects.toMatchObject({ code: "selected_model_unavailable" });
    expect(fx.sessions.size).toBe(0);
    fx.runtime.close();
  });

  test("replays ordered events by cursor, suppresses duplicates, and resumes after restart", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-1", messageId: "message-1", text: "Stream", model });
    const sessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    fx.messages.get(sessionId)!.push({ info: { id: "assistant-1", sessionID: sessionId, role: "assistant", parentID: "message-1", time: { created: Date.parse("2026-01-01T00:00:00.000Z"), completed: Date.parse("2026-01-01T00:00:01.000Z") } }, parts: [{ id: "part-1", sessionID: sessionId, messageID: "assistant-1", type: "text", text: "Done" }] });
    const first = await fx.service.events("ws-1", "toon-init-assistant", conversation.id, null);
    expect(first.items.map((item) => item.sequence)).toEqual(first.items.map((_, index) => index + 1));
    const after = await fx.service.events("ws-1", "toon-init-assistant", conversation.id, first.cursor);
    expect(after.items).toEqual([]);
    await fx.service.reconcileAllActiveTurns();
    const snapshot = await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id);
    expect(snapshot.messages.filter((message) => message.id === "assistant-1")).toHaveLength(1);
    expect(snapshot.messages.find((message) => message.id === "assistant-1")?.status).toBe("completed");
    fx.runtime.close();
  });

  test("stops only the exact active turn and preserves edit-and-resend branches", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-1", messageId: "message-1", text: "Original", model });
    await expect(fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "other" })).rejects.toMatchObject({ code: "toon_assistant_turn_not_active" });
    await fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-1" });
    const pending = await fx.service.editAndResend("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-2", messageId: "message-2", sourceMessageId: "message-1", text: "Edited", model, detachActiveDescendants: false });
    expect(pending).toMatchObject({ accepted: true, pending: true, turnId: "turn-2" });
    expect(await fx.service.editAndResend("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-2", messageId: "message-2", sourceMessageId: "message-1", text: "Edited", model, detachActiveDescendants: false })).toEqual(pending);
    expect(fx.prompts).toHaveLength(1);
    await settleQuiet(fx);
    expect(fx.prompts).toHaveLength(2);
    const snapshot = await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id);
    expect(snapshot.messages.find((message) => message.id === "message-1")?.parts).toEqual([{ type: "text", text: "Original" }]);
    expect(snapshot.messages.find((message) => message.id === "message-2")?.parentMessageId).toBe("message-1");
    expect(new Set(snapshot.messages.filter((message) => message.role === "user").map((message) => message.branchId)).size).toBe(2);
    fx.runtime.close();
  });

  test("keeps a turn active until its recursive descendants are terminal", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const rootSessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-family", messageId: "message-family", text: "Delegate", model });
    fx.sessions.set("child-session", { id: "child-session", parentID: rootSessionId });
    fx.sessions.set("grandchild-session", { id: "grandchild-session", parentID: "child-session" });
    fx.statuses[rootSessionId] = { type: "idle" };
    fx.statuses["child-session"] = { type: "busy" };
    fx.statuses["grandchild-session"] = { type: "busy" };
    await settleQuiet(fx);
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)?.turnId).toBe("turn-family");
    await fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-family" });
    expect(new Set(fx.aborts)).toEqual(new Set(["child-session", "grandchild-session"]));
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)?.turnId).toBe("turn-family");
    fx.statuses["child-session"] = { type: "idle" };
    fx.statuses["grandchild-session"] = { type: "idle" };
    await settleQuiet(fx);
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)).toBeNull();
    fx.runtime.close();
  });

  test("background reconciliation settles an accepted busy stop while GET events stays observe-only", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const sessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-stop-poll", messageId: "message-stop-poll", text: "Keep working", model });
    fx.statuses[sessionId] = { type: "busy" };
    const stopping = await fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-stop-poll" });
    expect(stopping.data).toMatchObject({ status: "stopping", remoteMayContinue: true });
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)).toMatchObject({ turnId: "turn-stop-poll", status: "stopping" });

    fx.statuses[sessionId] = { type: "idle" };
    await fx.service.reconcileAllActiveTurns();
    await fx.service.reconcileAllActiveTurns();
    fx.advanceNow(3_000);
    await fx.service.reconcileAllActiveTurns();
    const polled = await fx.service.events("ws-1", "toon-init-assistant", conversation.id, String(stopping.sequence));
    expect(polled.items).toEqual([expect.objectContaining({ type: "turn.status", data: expect.objectContaining({ status: "interrupted", remoteMayContinue: false }) })]);
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)).toBeNull();
    await expect(fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-after-stop", messageId: "message-after-stop", text: "Try again", model })).resolves.toMatchObject({ accepted: true, turnId: "turn-after-stop" });
    fx.runtime.close();
  });

  test("stopping polls discover late descendants, cancel each once, and keep them on the original turn", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const rootSessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-late-family", messageId: "message-late-family", text: "Delegate later", model });
    fx.statuses[rootSessionId] = { type: "busy" };
    const stopping = await fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-late-family" });
    expect(fx.aborts).toEqual([rootSessionId]);

    fx.sessions.set("late-child", { id: "late-child", parentID: rootSessionId });
    fx.sessions.set("late-grandchild", { id: "late-grandchild", parentID: "late-child" });
    fx.statuses["late-child"] = { type: "busy" };
    fx.statuses["late-grandchild"] = { type: "busy" };
    await fx.service.reconcileAllActiveTurns();
    expect(fx.aborts).toEqual([rootSessionId, "late-child", "late-grandchild"]);
    expect(fx.runtime.listTurnSessions("ws-1", "toon-init-assistant", conversation.id, "turn-late-family")).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: rootSessionId, abortRequestedAt: expect.any(Number), abortAttempts: 1 }),
      expect.objectContaining({ sessionId: "late-child", abortRequestedAt: expect.any(Number), abortAttempts: 1 }),
      expect.objectContaining({ sessionId: "late-grandchild", abortRequestedAt: expect.any(Number), abortAttempts: 1 }),
    ]));
    expect(fx.runtime.turnForSession("ws-1", "toon-init-assistant", "late-child")).toMatchObject({ conversationId: conversation.id, turnId: "turn-late-family" });
    expect(fx.runtime.turnForSession("ws-1", "toon-init-assistant", "late-grandchild")).toMatchObject({ conversationId: conversation.id, turnId: "turn-late-family" });

    await fx.service.reconcileAllActiveTurns();
    expect(fx.aborts).toEqual([rootSessionId, "late-child", "late-grandchild"]);
    fx.statuses[rootSessionId] = { type: "idle" };
    fx.statuses["late-child"] = { type: "idle" };
    fx.statuses["late-grandchild"] = { type: "idle" };
    await fx.service.reconcileAllActiveTurns();
    await fx.service.reconcileAllActiveTurns();
    fx.advanceNow(3_000);
    await fx.service.reconcileAllActiveTurns();
    const settled = await fx.service.events("ws-1", "toon-init-assistant", conversation.id, String(stopping.sequence));
    expect(settled.items).toEqual([expect.objectContaining({ type: "turn.status", data: { status: "interrupted", remoteMayContinue: false } })]);

    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-after-late-family", messageId: "message-after-late-family", text: "New work", model });
    fx.aborts.length = 0;
    fx.statuses[rootSessionId] = { type: "busy" };
    fx.statuses["late-child"] = { type: "busy" };
    fx.statuses["late-grandchild"] = { type: "busy" };
    await fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-after-late-family" });
    expect(fx.aborts).toEqual([rootSessionId]);
    expect(fx.runtime.turnForSession("ws-1", "toon-init-assistant", "late-child")?.turnId).toBe("turn-late-family");
    fx.runtime.close();
  });

  test("a child created after the root becomes idle resets the persisted quiet window and is aborted without UI polling", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const rootSessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-idle-late-child", messageId: "message-idle-late-child", text: "Delegate after idle", model });
    fx.statuses[rootSessionId] = { type: "busy" };
    await fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-idle-late-child" });
    fx.statuses[rootSessionId] = { type: "idle" };
    await fx.service.reconcileAllActiveTurns();
    await fx.service.reconcileAllActiveTurns();

    fx.sessions.set("child-after-root-idle", { id: "child-after-root-idle", parentID: rootSessionId });
    fx.statuses["child-after-root-idle"] = { type: "busy" };
    fx.advanceNow(3_000);
    await fx.service.reconcileAllActiveTurns();
    expect(fx.aborts).toEqual([rootSessionId, "child-after-root-idle"]);
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)?.turnId).toBe("turn-idle-late-child");

    fx.statuses["child-after-root-idle"] = { type: "idle" };
    await settleQuiet(fx);
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)).toBeNull();
    fx.runtime.close();
  });

  test("restart reconciliation resumes a persisted stop and dispatches a pending edit replacement", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const rootSessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-before-restart", messageId: "message-before-restart", text: "Original", model });
    fx.statuses[rootSessionId] = { type: "busy" };
    await fx.service.editAndResend("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-after-restart", messageId: "message-after-restart", sourceMessageId: "message-before-restart", text: "Replacement", model, detachActiveDescendants: false });
    expect(fx.prompts).toHaveLength(1);

    const restarted = fx.makeService();
    fx.statuses[rootSessionId] = { type: "idle" };
    await restarted.reconcileAllActiveTurns();
    await restarted.reconcileAllActiveTurns();
    fx.advanceNow(3_000);
    await restarted.reconcileAllActiveTurns();
    expect(fx.prompts).toHaveLength(2);
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)?.turnId).toBe("turn-after-restart");
    expect(fx.runtime.pendingAssistantReplacement("ws-1", "toon-init-assistant", conversation.id)).toBeNull();
    fx.runtime.close();
  });

  test("failed aborts retry a bounded number of times and settle with remote work possibly continuing", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const sessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-abort-unsupported", messageId: "message-abort-unsupported", text: "Cannot cancel", model });
    fx.statuses[sessionId] = { type: "busy" };
    fx.abortResults.set(sessionId, false);
    const stopping = await fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-abort-unsupported" });
    expect(fx.aborts).toEqual([sessionId]);

    await fx.service.reconcileAllActiveTurns();
    await fx.service.reconcileAllActiveTurns();
    fx.advanceNow(60_000);
    await fx.service.reconcileAllActiveTurns();
    await fx.service.reconcileAllActiveTurns();
    const settled = await fx.service.events("ws-1", "toon-init-assistant", conversation.id, String(stopping.sequence));
    expect(fx.aborts).toEqual([sessionId, sessionId, sessionId]);
    expect(settled.items).toEqual([expect.objectContaining({ type: "turn.status", data: { status: "interrupted", remoteMayContinue: true } })]);
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)).toBeNull();
    expect(fx.sqlite.query("SELECT status, remote_may_continue FROM toon_workspace_assistant_turns WHERE turn_id='turn-abort-unsupported'").get()).toEqual({ status: "interrupted", remote_may_continue: 1 });
    fx.runtime.close();
  });

  test("an accepted abort that remains busy times out instead of staying stopping forever", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const sessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-abort-timeout", messageId: "message-abort-timeout", text: "Remote work", model });
    fx.statuses[sessionId] = { type: "busy" };
    const stopping = await fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-abort-timeout" });
    fx.advanceNow(60_000);

    await fx.service.reconcileAllActiveTurns();
    const settled = await fx.service.events("ws-1", "toon-init-assistant", conversation.id, String(stopping.sequence));
    expect(fx.aborts).toEqual([sessionId]);
    expect(settled.items).toEqual([expect.objectContaining({ type: "turn.status", data: { status: "interrupted", remoteMayContinue: true } })]);
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)).toBeNull();
    fx.runtime.close();
  });

  test("a timed-out edit replacement starts on an isolated root and old descendant output stays on the old turn", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const oldRootSessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-remote-old", messageId: "message-remote-old", text: "Original", model });
    fx.sessions.set("remote-old-child", { id: "remote-old-child", parentID: oldRootSessionId });
    fx.statuses[oldRootSessionId] = { type: "busy" };
    fx.statuses["remote-old-child"] = { type: "busy" };
    const pending = await fx.service.editAndResend("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-isolated-new", messageId: "message-isolated-new", sourceMessageId: "message-remote-old", text: "Replacement", model, detachActiveDescendants: false });
    expect(pending).toMatchObject({ pending: true });
    fx.advanceNow(60_000);
    await fx.service.reconcileAllActiveTurns();

    const newRootSessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    expect(newRootSessionId).not.toBe(oldRootSessionId);
    expect(fx.prompts.at(-1)).toMatchObject({ sessionId: newRootSessionId });
    expect(fx.runtime.turn("ws-1", "toon-init-assistant", conversation.id, "turn-remote-old")).toEqual({ status: "interrupted", remoteMayContinue: true });
    expect(fx.runtime.turnForSession("ws-1", "toon-init-assistant", "remote-old-child")?.turnId).toBe("turn-remote-old");
    expect(fx.runtime.listTurnSessions("ws-1", "toon-init-assistant", conversation.id, "turn-isolated-new").map((item) => item.sessionId)).toEqual([newRootSessionId]);
    fx.sessions.set("remote-post-deadline-child", { id: "remote-post-deadline-child", parentID: oldRootSessionId });
    fx.statuses["remote-post-deadline-child"] = { type: "busy" };
    await fx.service.reconcileAllActiveTurns();
    expect(fx.runtime.turnForSession("ws-1", "toon-init-assistant", "remote-post-deadline-child")?.turnId).toBe("turn-remote-old");
    expect(fx.runtime.listTurnSessions("ws-1", "toon-init-assistant", conversation.id, "turn-isolated-new").map((item) => item.sessionId)).toEqual([newRootSessionId]);
    fx.runtime.close();
  });

  test("a timed-out ordinary stop isolates the active root before another send and retains its warning until the next turn", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const oldRoot = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-ordinary-stop", messageId: "message-ordinary-stop", text: "Possibly remote", model });
    fx.statuses[oldRoot] = { type: "busy" };
    await fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-ordinary-stop" });
    fx.advanceNow(60_000);
    await fx.service.reconcileAllActiveTurns();

    const isolatedRoot = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    expect(isolatedRoot).not.toBe(oldRoot);
    expect((await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id)).remoteContinueWarnings).toEqual([
      expect.objectContaining({ turnId: "turn-ordinary-stop", status: "interrupted", remoteMayContinue: true }),
    ]);
    fx.messages.get(oldRoot)!.push({ info: { id: "assistant-late-ordinary", sessionID: oldRoot, role: "assistant", parentID: "message-ordinary-stop", time: { created: 1, completed: 2 } }, parts: [{ id: "part-late-ordinary", type: "text", text: "Late old-root output" }] });
    await fx.service.reconcileAllActiveTurns();
    expect((await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id)).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "assistant-late-ordinary", turnId: "turn-ordinary-stop", branchId: "branch-turn-ordinary-stop", parts: [{ type: "text", text: "Late old-root output" }] }),
    ]));

    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-after-ordinary-stop", messageId: "message-after-ordinary-stop", text: "Isolated continuation", model });
    expect(fx.prompts.at(-1)?.sessionId).toBe(isolatedRoot);
    expect(fx.runtime.listTurnSessions("ws-1", "toon-init-assistant", conversation.id, "turn-after-ordinary-stop").map((item) => item.sessionId)).toEqual([isolatedRoot]);
    expect((await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id)).remoteContinueWarnings).toEqual([]);
    fx.runtime.close();
  });

  test("edit-and-resend forks before the edited user message so the model sees only authoritative prior history", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const oldRoot = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-context-1", messageId: "message-context-1", text: "Keep this", model });
    fx.messages.get(oldRoot)!.push({ info: { id: "assistant-context-1", sessionID: oldRoot, role: "assistant", parentID: "message-context-1", time: { created: 1, completed: 2 } }, parts: [{ id: "part-context-1", type: "text", text: "Kept answer" }] });
    fx.statuses[oldRoot] = { type: "idle" };
    await fx.service.reconcileAllActiveTurns();
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-context-2", messageId: "message-context-2", text: "Discard this and everything after it", model });
    await fx.service.editAndResend("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-context-3", messageId: "message-context-3", sourceMessageId: "message-context-2", text: "Replacement", model, detachActiveDescendants: false });
    fx.statuses[oldRoot] = { type: "idle" };
    await settleQuiet(fx);

    expect(fx.forks.at(-1)).toMatchObject({ sessionID: oldRoot, messageID: "message-context-2" });
    const forkRoot = fx.forks.at(-1)!.forkedSessionID;
    expect(fx.messages.get(forkRoot)!.map((message) => message.info.id)).toEqual(["message-context-1", "assistant-context-1", "message-context-3"]);
    expect(fx.prompts.at(-1)).toMatchObject({ sessionId: forkRoot, prompt: { messageID: "message-context-3", parts: [{ type: "text", text: "Replacement" }] } });
    const snapshot = await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id);
    expect(snapshot.branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ active: false, turnIds: ["turn-context-1", "turn-context-2"] }),
      expect.objectContaining({ active: true, fromMessageId: "message-context-2", turnIds: ["turn-context-3"] }),
    ]));
    fx.runtime.close();
  });

  test("falls back to bounded text-only replay when SDK fork includes the edited message", async () => {
    const fx = await fixture();
    fx.client.session.fork = async ({ sessionID, messageID }: any) => {
      const id = `session-${fx.sessions.size + 1}`;
      fx.sessions.set(id, { id, parentID: sessionID });
      fx.messages.set(id, [...(fx.messages.get(sessionID) ?? [])]);
      fx.forks.push({ sessionID, messageID, forkedSessionID: id });
      return { data: fx.sessions.get(id) };
    };
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const oldRoot = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-fallback-1", messageId: "message-fallback-1", text: "Prior text", model });
    fx.messages.get(oldRoot)!.push({ info: { id: "assistant-fallback-1", sessionID: oldRoot, role: "assistant", parentID: "message-fallback-1", time: { created: 1, completed: 2 } }, parts: [{ id: "tool-fallback", type: "tool", tool: "side_effect", state: { status: "completed", output: "must not replay" } }, { id: "text-fallback", type: "text", text: "Prior answer" }] });
    fx.statuses[oldRoot] = { type: "idle" };
    await fx.service.reconcileAllActiveTurns();
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-fallback-2", messageId: "message-fallback-2", text: "Edit me", model });
    await fx.service.editAndResend("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-fallback-3", messageId: "message-fallback-3", sourceMessageId: "message-fallback-2", text: "Replacement", model, detachActiveDescendants: true });

    const newRoot = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    expect(newRoot).not.toBe(oldRoot);
    expect(fx.prompts.at(-2)).toMatchObject({ sessionId: newRoot, prompt: { noReply: true, tools: {} } });
    expect(fx.prompts.at(-2)?.prompt.parts[0].text).toContain("Prior text");
    expect(fx.prompts.at(-2)?.prompt.parts[0].text).toContain("Prior answer");
    expect(fx.prompts.at(-2)?.prompt.parts[0].text).not.toContain("must not replay");
    expect(fx.prompts.at(-2)?.prompt.parts[0].text).not.toContain("Edit me");
    expect(fx.prompts.at(-1)).toMatchObject({ sessionId: newRoot, prompt: { messageID: "message-fallback-3" } });
    expect((await fx.service.events("ws-1", "toon-init-assistant", conversation.id, null)).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "turn.status", data: { status: "detached", remoteMayContinue: true } }),
    ]));
    fx.runtime.close();
  });

  test("observe-only GET projections do not mutate SDK or SQLite while a stop and replacement are pending", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const rootSessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-read-only", messageId: "message-read-only", text: "Wait", model });
    fx.statuses[rootSessionId] = { type: "busy" };
    await fx.service.editAndResend("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-read-only-next", messageId: "message-read-only-next", sourceMessageId: "message-read-only", text: "Queued", model, detachActiveDescendants: false });
    const before = fx.sqlite.serialize();
    let sdkCalls = 0;
    const readOnly = fx.makeService({
      config: { workspaces: [{ id: "ws-1", path: fx.root, workspaceType: "local" }], readOnly: true } as any,
      createWorkspaceOpencodeClient: () => new Proxy({}, { get: () => { sdkCalls += 1; throw new Error("observe-only GET touched SDK"); } }) as any,
      reconcileIntervalMs: 1,
    });
    readOnly.start();
    await readOnly.list("ws-1", "toon-init-assistant");
    const snapshot = await readOnly.snapshot("ws-1", "toon-init-assistant", conversation.id);
    await readOnly.events("ws-1", "toon-init-assistant", conversation.id, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await readOnly.dispose();

    expect(snapshot.activeTurnId).toBe("turn-read-only");
    expect(fx.runtime.pendingAssistantReplacement("ws-1", "toon-init-assistant", conversation.id)?.replacementTurnId).toBe("turn-read-only-next");
    expect(sdkCalls).toBe(0);
    expect(fx.sqlite.serialize()).toEqual(before);
    fx.runtime.close();
  });

  test("background reconcile lifecycle is idempotent and disabled for read-only services", async () => {
    const fx = await fixture();
    fx.service.start();
    fx.service.start();
    await fx.service.dispose();
    await fx.service.dispose();
    const readOnly = fx.makeService({ config: { workspaces: [{ id: "ws-1", path: fx.root, workspaceType: "local" }], readOnly: true } as any, reconcileIntervalMs: 1 });
    readOnly.start();
    await readOnly.dispose();
    fx.runtime.close();
  });

  test("background timer cancels a late child and finishes stopping without any UI event request", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const rootSessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-background", messageId: "message-background", text: "Background stop", model });
    fx.statuses[rootSessionId] = { type: "busy" };
    await fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-background" });
    const background = fx.makeService({ reconcileIntervalMs: 1 });
    background.start();
    fx.statuses[rootSessionId] = { type: "idle" };
    fx.sessions.set("background-late-child", { id: "background-late-child", parentID: rootSessionId });
    fx.statuses["background-late-child"] = { type: "busy" };
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fx.aborts).toContain("background-late-child");
    fx.statuses["background-late-child"] = { type: "idle" };
    await new Promise((resolve) => setTimeout(resolve, 10));
    fx.advanceNow(3_000);
    for (let attempt = 0; attempt < 40 && fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)).toBeNull();
    await background.dispose();
    fx.runtime.close();
  });

  test("does not attach a historical child session to a newer turn", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const rootSessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-old", messageId: "message-old", text: "Delegate", model });
    fx.sessions.set("historical-child", { id: "historical-child", parentID: rootSessionId });
    fx.statuses[rootSessionId] = { type: "busy" };
    fx.statuses["historical-child"] = { type: "busy" };
    await fx.service.reconcileAllActiveTurns();
    expect(fx.runtime.turnForSession("ws-1", "toon-init-assistant", "historical-child")?.turnId).toBe("turn-old");

    fx.runtime.finishTurn("ws-1", "toon-init-assistant", conversation.id, "turn-old", "completed");
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-new", messageId: "message-new", text: "Continue", model });
    fx.aborts.length = 0;
    await fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-new" });

    expect(fx.aborts).toEqual([rootSessionId]);
    expect(fx.runtime.turnForSession("ws-1", "toon-init-assistant", "historical-child")?.turnId).toBe("turn-old");
    expect(fx.runtime.listTurnSessions("ws-1", "toon-init-assistant", conversation.id, "turn-new").map((item) => item.sessionId)).toEqual([rootSessionId]);
    fx.runtime.close();
  });

  test("reconciles every active-turn crash window to a terminal interrupted event", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const sessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-before-message", "branch-before-message");
    await fx.service.reconcileAllActiveTurns();
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)).toBeNull();
    expect((await fx.service.events("ws-1", "toon-init-assistant", conversation.id, null)).items).toEqual(expect.arrayContaining([expect.objectContaining({ type: "turn.status", data: expect.objectContaining({ status: "interrupted" }) })]));

    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-after-message", "branch-after-message");
    fx.runtime.saveMessage("ws-1", "toon-init-assistant", { id: "message-after", conversationId: conversation.id, turnId: "turn-after-message", branchId: "branch-after-message", role: "user", status: "completed", parts: [{ type: "text", text: "After persisted message" }], attachments: [], mentions: [], contextDiagnostics: [], createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.000Z" });
    await fx.service.reconcileAllActiveTurns();
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)).toBeNull();

    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-terminal", "branch-terminal");
    fx.runtime.saveMessage("ws-1", "toon-init-assistant", { id: "message-terminal", conversationId: conversation.id, turnId: "turn-terminal", branchId: "branch-terminal", role: "user", status: "completed", parts: [{ type: "text", text: "Terminal" }], attachments: [], mentions: [], contextDiagnostics: [], createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.000Z" });
    fx.messages.get(sessionId)!.push({ info: { id: "assistant-terminal", sessionID: sessionId, role: "assistant", parentID: "message-terminal", time: { created: 1, completed: 2 } }, parts: [{ id: "part-terminal", type: "text", text: "Done" }] });
    await fx.service.reconcileAllActiveTurns();
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)).toBeNull();
    expect((await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id)).messages.find((message) => message.id === "assistant-terminal")?.status).toBe("completed");
    fx.runtime.close();
  });

  test("idle stop observes a quiet window before delete can clear the turn", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-idle", "branch-idle");
    const stopped = await fx.service.stop("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-idle" });
    expect(stopped.data).toMatchObject({ status: "stopping", remoteMayContinue: true });
    expect(fx.aborts).toHaveLength(0);
    await settleQuiet(fx);
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-delete", "branch-delete");
    expect(await fx.service.delete("ws-1", "toon-init-assistant", conversation.id)).toEqual({ deleted: true });
    fx.runtime.close();
  });

  test("keeps an active turn when restart reconciliation cannot read engine status", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-status-unavailable", "branch-status-unavailable");
    fx.client.session.status = async () => { throw new Error("status unavailable"); };
    await fx.service.reconcileAllActiveTurns();
    expect(fx.runtime.activeTurn("ws-1", "toon-init-assistant", conversation.id)).toMatchObject({ turnId: "turn-status-unavailable", status: "running" });
    fx.runtime.close();
  });

  test("resolves stable node mentions with visible bounded diagnostics", async () => {
    const fx = await fixture();
    const read = await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any;
    await fx.coordinator.execute("toon-init-assistant", { operationId: "node-context", actor: { kind: "human" }, origin: "human-ui", expectedRevisions: { "canvases/main.json": read.revision }, kind: "canvas.write", canvasId: "main", body: { ...read.canvas, nodes: [{ id: "node-1", kind: "text", position: { x: 0, y: 0 }, handles: [], config: { label: "Scene" } }] } });
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const response = await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-context", messageId: "message-context", text: "Use @node", model, mentions: [{ kind: "node", id: "node-1", revision: "a".repeat(64) }] });
    expect(response.contextDiagnostics[0]).toMatchObject({ reference: { kind: "node", id: "node-1" }, status: "stale", label: "Scene", contentType: "application/vnd.jugglework.toon-node+json" });
    expect(fx.prompts[0].prompt.parts[0].text).toContain("untrusted=\"true\"");
    fx.runtime.close();
  });

  test("denied semantic canvas proposals do not mutate and paid plans remain prepare-only", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-tools", "branch-tools");
    const canvas = await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any;
    const catalogs = await fx.coordinator.query("toon-init-assistant", { kind: "catalogs.read" }) as any;
    const proposal = await fx.service.proposeCanvasCall("ws-1", "toon-init-assistant", conversation.id, "tool-delete", {
      id: "proposal-delete", conversationId: conversation.id, turnId: "turn-tools", toolCallId: "tool-delete", risk: "destructive-mutation", summary: "Delete main canvas", affected: [{ kind: "canvas", id: "main" }], requiresConfirmation: true,
      command: { operationId: "assistant-delete", actor: { kind: "assistant", id: "tool-delete" }, origin: "assistant-tool", expectedRevisions: catalogs.revisions, kind: "canvas.delete", canvasId: "main" },
    });
    expect(proposal.requiresConfirmation).toBe(true);
    const denied = await fx.service.executeCanvasCall("ws-1", "toon-init-assistant", conversation.id, "proposal-delete", { proposalId: "proposal-delete", decision: "deny" });
    expect(denied).toEqual({ decision: "deny", proposal });
    expect(await fx.service.executeCanvasCall("ws-1", "toon-init-assistant", conversation.id, "proposal-delete", { proposalId: "proposal-delete", decision: "deny" })).toEqual(denied);
    expect((await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any).revision).toBe(canvas.revision);
    const proposalInput = await generationProposal(fx, conversation.id, { id: "generation-plan", turnId: "turn-tools", requestId: "request-paid", prompt: "Draw" });
    const sessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    const generation = await fx.service.prepareGeneration("ws-1", "toon-init-assistant", conversation.id, proposalInput, "tool-generation", sessionId);
    expect(generation.state).toBe("awaiting-human-authorization");
    expect((await fx.coordinator.query("toon-init-assistant", { kind: "generation.read", generationId: "generation-plan" }) as any).generation).toMatchObject({ requestId: "request-paid", source: "assistant", status: "awaiting-human-authorization" });
    expect((await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any).canvas.nodes.find((node: any) => node.id === "image-node").config.generation).toBeUndefined();
    expect(fx.prompts).toHaveLength(0);
    const pending = (await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id)).interactions.find((item) => item.kind === "compute-authorization");
    expect(pending).toMatchObject({ state: "pending", payload: { proposal: { id: "generation-plan" } } });
    const deniedInteraction = await fx.service.replyInteraction("ws-1", "toon-init-assistant", conversation.id, pending!.id, { answer: { decision: "deny" } });
    expect(deniedInteraction.state).toBe("denied");
    expect((await fx.coordinator.query("toon-init-assistant", { kind: "generation.read", generationId: "generation-plan" }) as any).generation.status).toBe("awaiting-human-authorization");
    fx.runtime.close();
  });

  test("commits confirmed semantic canvas proposals and persists their audit projection", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-tools", "branch-tools");
    const canvas = await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any;
    const catalogs = await fx.coordinator.query("toon-init-assistant", { kind: "catalogs.read" }) as any;
    await fx.service.proposeCanvasCall("ws-1", "toon-init-assistant", conversation.id, "tool-write", {
      id: "proposal-write", conversationId: conversation.id, turnId: "turn-tools", toolCallId: "tool-write", risk: "reversible-mutation", summary: "Add a scene node", affected: [{ kind: "canvas", id: "main" }], requiresConfirmation: true,
      command: { operationId: "assistant-write", actor: { kind: "assistant", id: "tool-write" }, origin: "assistant-tool", expectedRevisions: catalogs.revisions, kind: "canvas.write", canvasId: "main", body: { ...canvas.canvas, nodes: [{ id: "node-added", kind: "text", position: { x: 40, y: 60 }, handles: [], config: { label: "Assistant scene" } }] } },
    });
    await expect(fx.service.executeCanvasCall("ws-1", "toon-init-assistant", conversation.id, "proposal-write", { proposalId: "proposal-write", decision: "approve" })).rejects.toMatchObject({ code: "toon_canvas_lease_invalid" });
    expect((await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id)).canvasProposals[0]?.state).toBe("proposed");
    const lease = await fx.coordinator.acquireCanvasLease("toon-init-assistant", { leaseId: "assistant-editor", canvasId: "main", holder: "test", ttlMs: 5_000 });
    const result = await fx.service.executeCanvasCall("ws-1", "toon-init-assistant", conversation.id, "proposal-write", { proposalId: "proposal-write", decision: "approve", leaseToken: lease.leaseToken, leaseGeneration: lease.generation }) as any;
    expect(result.decision).toBe("approve");
    expect(result.outcome).toMatchObject({ status: "committed", origin: "assistant-tool", actor: { kind: "assistant", id: "tool-write" }, affected: [{ kind: "canvas", id: "main" }] });
    expect((await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any).canvas.nodes[0]?.id).toBe("node-added");
    expect((await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id)).canvasProposals).toEqual([
      expect.objectContaining({ state: "committed", proposal: expect.objectContaining({ id: "proposal-write", summary: "Add a scene node" }), outcome: expect.objectContaining({ status: "committed" }) }),
    ]);
    fx.runtime.close();
  });

  test("rejects missing revisions and conflicts instead of executing an old canvas body", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-conflict", "branch-conflict");
    const canvas = await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any;
    const catalogs = await fx.coordinator.query("toon-init-assistant", { kind: "catalogs.read" }) as any;
    const base = { id: "proposal-conflict", conversationId: conversation.id, turnId: "turn-conflict", toolCallId: "tool-conflict", risk: "reversible-mutation" as const, summary: "Write old canvas", affected: [{ kind: "canvas" as const, id: "main" }], requiresConfirmation: true,
      command: { operationId: "assistant-conflict", actor: { kind: "assistant" as const, id: "tool-conflict" }, origin: "assistant-tool" as const, expectedRevisions: catalogs.revisions, kind: "canvas.write" as const, canvasId: "main", body: { ...canvas.canvas, nodes: [] } } };
    await expect(fx.service.proposeCanvasCall("ws-1", "toon-init-assistant", conversation.id, "missing-revisions", { ...base, command: { ...base.command, expectedRevisions: {} } })).rejects.toMatchObject({ code: "toon_expected_revision_required" });
    await expect(fx.service.proposeCanvasCall("ws-1", "toon-init-assistant", conversation.id, "stale-revisions", { ...base, command: { ...base.command, expectedRevisions: { ...catalogs.revisions, "canvases/main.json": "f".repeat(64) } } })).rejects.toMatchObject({ code: "toon_factory_revision_conflict" });
    const proposed = await fx.service.proposeCanvasCall("ws-1", "toon-init-assistant", conversation.id, "tool-conflict", base);
    expect(Object.keys(proposed.command.expectedRevisions)).toEqual(expect.arrayContaining(["toon-project.json", "catalogs/canvases.json", "canvases/main.json"]));
    expect(proposed.command.expectedRevisions).toEqual(base.command.expectedRevisions);
    const lease = await fx.coordinator.acquireCanvasLease("toon-init-assistant", { leaseId: "conflict-editor", canvasId: "main", holder: "test", ttlMs: 5_000 });
    await fx.coordinator.execute("toon-init-assistant", { operationId: "human-after-proposal", actor: { kind: "human" }, origin: "human-ui", expectedRevisions: { "canvases/main.json": canvas.revision }, kind: "canvas.write", canvasId: "main", body: { ...canvas.canvas, nodes: [...canvas.canvas.nodes, { id: "human-node", kind: "text", position: { x: 1, y: 1 }, handles: [], config: {} }] } });
    await expect(fx.service.executeCanvasCall("ws-1", "toon-init-assistant", conversation.id, proposed.id, { proposalId: proposed.id, decision: "approve", leaseToken: lease.leaseToken, leaseGeneration: lease.generation })).rejects.toMatchObject({ code: "toon_factory_revision_conflict" });
    expect((await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any).canvas.nodes.some((node: any) => node.id === "human-node")).toBe(true);
    fx.runtime.close();
  });

  test("executes explicit bridge reads and generation prepare instead of returning tool descriptions", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const sessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "bridge-turn", "bridge-branch");
    for (const [callID, input] of [["tool-project", { action: "project.read" }], ["tool-canvas", { action: "canvas.read", canvasId: "main" }]] as const) {
      fx.messages.get(sessionId)!.push({ info: { id: `assistant-${callID}`, sessionID: sessionId, role: "assistant", time: { created: 1 } }, parts: [{ id: `part-${callID}`, type: "tool", callID, tool: "toon_workspace_bridge", state: { input } }] });
    }
    expect(await fx.service.bridge("ws-1", sessionId, "tool-project", { action: "project.read" })).toMatchObject({ kind: "project.read", project: { metadata: { id: "toon-init-assistant" } } });
    expect(await fx.service.bridge("ws-1", sessionId, "tool-canvas", { action: "canvas.read", canvasId: "main" })).toMatchObject({ kind: "canvas.read", canvas: { id: "main" } });
    const proposal = await generationProposal(fx, conversation.id, { id: "bridge-generation", turnId: "bridge-turn", requestId: "bridge-request", prompt: "Bridge draw" });
    const call = { action: "generation.prepare", proposal };
    fx.messages.get(sessionId)!.push({ info: { id: "assistant-generation", sessionID: sessionId, role: "assistant", time: { created: 1 } }, parts: [{ id: "generation-part", type: "tool", callID: "tool-generation", tool: "toon_workspace_bridge", state: { input: call } }] });
    expect(await fx.service.bridge("ws-1", sessionId, "tool-generation", call)).toMatchObject({ id: "bridge-generation" });
    await expect(fx.service.bridge("ws-1", sessionId, "forged-generation", call)).rejects.toMatchObject({ code: "toon_assistant_tool_call_unverified" });
    expect((await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id)).interactions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "compute-authorization", state: "pending" })]));
    fx.runtime.close();
  });

  test("rejects bridge calls when OpenCode metadata does not match the persisted workspace or project conversation", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const sessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "metadata-turn", "metadata-branch");
    const call = { action: "project.read" as const };
    fx.messages.get(sessionId)!.push({ info: { id: "assistant-metadata", sessionID: sessionId, role: "assistant", time: { created: 1 } }, parts: [{ id: "part-metadata", type: "tool", callID: "metadata-call", tool: "toon_workspace_bridge", state: { input: call } }] });
    fx.sessions.get(sessionId).metadata.workspaceId = "another-workspace";
    await expect(fx.service.bridge("ws-1", sessionId, "metadata-call", call)).rejects.toMatchObject({ code: "toon_assistant_session_scope_invalid" });
    fx.sessions.get(sessionId).metadata.workspaceId = "ws-1";
    fx.sessions.get(sessionId).metadata.projectId = "another-project";
    await expect(fx.service.bridge("ws-1", sessionId, "metadata-call", call)).rejects.toMatchObject({ code: "toon_assistant_session_scope_invalid" });
    fx.runtime.close();
  });

  test("rejects generation bridge proposals without the matching active turn", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const sessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    const proposal = await generationProposal(fx, conversation.id, { id: "no-turn-generation", turnId: "turn-missing", requestId: "no-turn-request", prompt: "Draw" });
    const call = { action: "generation.prepare", proposal };
    fx.messages.get(sessionId)!.push({ info: { id: "assistant-generation", sessionID: sessionId, role: "assistant", time: { created: 1 } }, parts: [{ id: "generation-part", type: "tool", callID: "tool-generation", tool: "toon_workspace_bridge", state: { input: call } }] });
    await expect(fx.service.bridge("ws-1", sessionId, "tool-generation", call)).rejects.toMatchObject({ code: "toon_assistant_turn_not_active" });
    fx.runtime.close();
  });

  test("rejects canvas and generation bridge calls from historical or detached tool sessions", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const sessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    const canvas = await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any;
    const catalogs = await fx.coordinator.query("toon-init-assistant", { kind: "catalogs.read" }) as any;
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-old", "branch-old");
    const canvasCall = { action: "canvas.propose" as const, proposal: { id: "historical-canvas", conversationId: conversation.id, turnId: "turn-old", toolCallId: "historical-canvas-call", risk: "reversible-mutation" as const, summary: "Historical", affected: [{ kind: "canvas" as const, id: "main" }], requiresConfirmation: true, command: { operationId: "historical-write", actor: { kind: "assistant" as const, id: "historical-canvas-call" }, origin: "assistant-tool" as const, expectedRevisions: catalogs.revisions, kind: "canvas.write" as const, canvasId: "main", body: canvas.canvas } } };
    fx.messages.get(sessionId)!.push({ info: { id: "historical-message", sessionID: sessionId, role: "assistant", time: { created: 1 } }, parts: [{ id: "historical-part", type: "tool", callID: "historical-canvas-call", tool: "toon_workspace_bridge", state: { input: canvasCall } }] });
    fx.runtime.finishTurn("ws-1", "toon-init-assistant", conversation.id, "turn-old", "detached");
    await fx.service.send("ws-1", "toon-init-assistant", conversation.id, { turnId: "turn-new", messageId: "message-new", text: "New turn", model });
    await expect(fx.service.bridge("ws-1", sessionId, "historical-canvas-call", canvasCall)).rejects.toMatchObject({ code: "toon_assistant_turn_not_active" });
    const generation = await generationProposal(fx, conversation.id, { id: "historical-generation", turnId: "turn-old", requestId: "historical-request", prompt: "Draw" });
    const generationCall = { action: "generation.prepare" as const, proposal: generation };
    fx.messages.get(sessionId)!.push({ info: { id: "historical-generation-message", sessionID: sessionId, role: "assistant", time: { created: 1 } }, parts: [{ id: "historical-generation-part", type: "tool", callID: "historical-generation-call", tool: "toon_workspace_bridge", state: { input: generationCall } }] });
    await expect(fx.service.bridge("ws-1", sessionId, "historical-generation-call", generationCall)).rejects.toMatchObject({ code: "toon_assistant_turn_not_active" });
    fx.runtime.close();
  });

  test("binds canvas proposals to the exact recorded OpenCode bridge call", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const sessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-bridge", "branch-bridge");
    const canvas = await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any;
    const catalogs = await fx.coordinator.query("toon-init-assistant", { kind: "catalogs.read" }) as any;
    const proposal = {
      id: "proposal-bridge", conversationId: "forged-conversation", turnId: "forged-turn", toolCallId: "forged-tool", risk: "reversible-mutation" as const, summary: "Recorded proposal", affected: [{ kind: "canvas" as const, id: "main" }], requiresConfirmation: true,
      command: { operationId: "bridge-write", actor: { kind: "assistant" as const, id: "forged-tool" }, origin: "assistant-tool" as const, expectedRevisions: catalogs.revisions, kind: "canvas.write" as const, canvasId: "main", body: canvas.canvas },
    };
    const call = { action: "canvas.propose" as const, proposal };
    fx.messages.get(sessionId)!.push({ info: { id: "assistant-tool-message", sessionID: sessionId, role: "assistant", time: { created: 1 } }, parts: [{ id: "part-id-differs", type: "tool", callID: "real-call", tool: "toon_workspace_bridge", state: { input: call } }] });
    const stored = await fx.service.bridge("ws-1", sessionId, "real-call", call) as any;
    expect(stored).toMatchObject({ conversationId: conversation.id, turnId: "turn-bridge", toolCallId: "real-call", command: { actor: { kind: "assistant", id: "real-call" } } });
    await expect(fx.service.bridge("ws-1", sessionId, "part-id-differs", call)).rejects.toMatchObject({ code: "toon_assistant_tool_call_unverified" });
    await expect(fx.service.bridge("ws-1", sessionId, "real-call", { ...call, proposal: { ...proposal, summary: "Forged after dispatch" } })).rejects.toMatchObject({ code: "toon_assistant_tool_call_unverified" });
    fx.messages.get(sessionId)!.push({ info: { id: "assistant-tool-without-call", sessionID: sessionId, role: "assistant", time: { created: 2 } }, parts: [{ id: "forged-part-only", type: "tool", tool: "toon_workspace_bridge", state: { input: call } }] });
    await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id);
    expect(() => fx.runtime.requireToolCall("ws-1", "toon-init-assistant", conversation.id, "forged-part-only")).toThrow();
    fx.runtime.close();
  });

  test("preserves a bridge proposal when message sync updates execution state before approval", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const sessionId = fx.runtime.conversationSession("ws-1", "toon-init-assistant", conversation.id);
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-sync-proposal", "branch-sync-proposal");
    const canvas = await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any;
    const catalogs = await fx.coordinator.query("toon-init-assistant", { kind: "catalogs.read" }) as any;
    const proposal = {
      id: "proposal-sync", conversationId: conversation.id, turnId: "turn-sync-proposal", toolCallId: "call-sync", risk: "reversible-mutation" as const, summary: "Sync-safe proposal", affected: [{ kind: "canvas" as const, id: "main" }], requiresConfirmation: true,
      command: { operationId: "sync-safe-write", actor: { kind: "assistant" as const, id: "call-sync" }, origin: "assistant-tool" as const, expectedRevisions: catalogs.revisions, kind: "canvas.write" as const, canvasId: "main", body: { ...canvas.canvas, nodes: [{ id: "sync-node", kind: "text", position: { x: 5, y: 6 }, handles: [], config: {} }] } },
    };
    const call = { action: "canvas.propose" as const, proposal };
    fx.messages.get(sessionId)!.push({ info: { id: "assistant-sync-proposal", sessionID: sessionId, role: "assistant", parentID: "message-unused", time: { created: 1 } }, parts: [{ id: "part-sync", type: "tool", callID: "call-sync", tool: "toon_workspace_bridge", state: { status: "completed", input: call, output: { ok: true } } }] });
    await fx.service.bridge("ws-1", sessionId, "call-sync", call);
    const snapshot = await fx.service.snapshot("ws-1", "toon-init-assistant", conversation.id);
    expect(snapshot.canvasProposals).toEqual([expect.objectContaining({ state: "proposed", proposal: expect.objectContaining({ id: "proposal-sync", summary: "Sync-safe proposal" }) })]);
    expect(fx.runtime.requireToolCall("ws-1", "toon-init-assistant", conversation.id, "call-sync")).toMatchObject({ state: "proposed", proposal: expect.objectContaining({ id: "proposal-sync" }) });

    const lease = await fx.coordinator.acquireCanvasLease("toon-init-assistant", { leaseId: "sync-proposal-editor", canvasId: "main", holder: "test", ttlMs: 5_000 });
    await expect(fx.service.executeCanvasCall("ws-1", "toon-init-assistant", conversation.id, "proposal-sync", { proposalId: "proposal-sync", decision: "approve", leaseToken: lease.leaseToken, leaseGeneration: lease.generation })).resolves.toMatchObject({ decision: "approve", proposal: { id: "proposal-sync" } });
    expect((await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any).canvas.nodes[0]?.id).toBe("sync-node");

    const other = await fx.service.create("ws-1", "toon-init-assistant", { model });
    expect(() => fx.runtime.saveToolCallExecution("ws-1", "toon-init-assistant", { id: "call-sync", conversationId: other.id, turnId: "other-turn", sessionId: fx.runtime.conversationSession("ws-1", "toon-init-assistant", other.id), state: "running" })).toThrow(expect.objectContaining({ code: "toon_assistant_tool_call_id_conflict" }));
    fx.runtime.close();
  });

  test("rejects proposals whose audit actor or affected IDs do not match the semantic command", async () => {
    const fx = await fixture();
    const conversation = await fx.service.create("ws-1", "toon-init-assistant", { model });
    const canvas = await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any;
    const catalogs = await fx.coordinator.query("toon-init-assistant", { kind: "catalogs.read" }) as any;
    fx.runtime.beginTurn("ws-1", "toon-init-assistant", conversation.id, "turn-tools", "branch-tools");
    const base = {
      id: "proposal-invalid", conversationId: conversation.id, turnId: "turn-tools", toolCallId: "tool-write", risk: "reversible-mutation" as const, summary: "Invalid proposal", affected: [{ kind: "canvas" as const, id: "other" }], requiresConfirmation: false,
      command: { operationId: "assistant-invalid", actor: { kind: "assistant" as const, id: "wrong-tool" }, origin: "assistant-tool" as const, expectedRevisions: catalogs.revisions, kind: "canvas.write" as const, canvasId: "main", body: canvas.canvas },
    };
    await expect(fx.service.proposeCanvasCall("ws-1", "toon-init-assistant", conversation.id, "tool-write", base)).rejects.toMatchObject({ code: "toon_canvas_proposal_affected_invalid" });
    const verified = await fx.service.proposeCanvasCall("ws-1", "toon-init-assistant", conversation.id, "tool-write", { ...base, affected: [{ kind: "canvas", id: "main" }] });
    expect(verified.command).toMatchObject({ actor: { kind: "assistant", id: "tool-write" }, origin: "assistant-tool" });
    expect((await fx.coordinator.query("toon-init-assistant", { kind: "canvas.read", canvasId: "main" }) as any).revision).toBe(canvas.revision);
    fx.runtime.close();
  });
});
