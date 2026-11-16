import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import { AutomationRepository } from "./automation/repository.js";
import { AUTOMATION_PERMISSION_PROFILE, type AutomationDefinition } from "@jugglework/types/automation";
import { opencodeAdmissionId } from "./opencode-admission.js";
import { runtimeDbPath } from "./runtime-db.js";
import { createSessionMutationCoordinator } from "./session-mutation-coordinator.js";
import { createSessionRunJournal } from "./session-run-journal.js";
import type { ArtifactEngineMessage } from "./artifacts/delivery.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
  hasActiveSessionRuns?: () => boolean;
};

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
  for (let attempt = 0; attempt < Math.ceil(timeoutMs / 5); attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

function startMockOpencode() {
  const prompts: Array<{ sessionId: string; body: unknown; directory: string | null }> = [];
  const v2Prompts: Array<{ sessionId: string; body: { id?: string; delivery?: string; prompt?: unknown }; directory: string | null }> = [];
  const aborts: string[] = [];
  const commands: Array<{ sessionId: string; body: unknown }> = [];
  const shells: Array<{ sessionId: string; body: unknown }> = [];
  const statusRequests: string[] = [];
  const disposes: Array<{ directory: string | null }> = [];
  const statuses = new Map<string, unknown>();
  const connected = ["connected"];
  const models: Record<string, unknown> = {
    chat: { capabilities: { output: { text: true } } },
    image: { capabilities: { output: { image: true, text: false } } },
    normalizedVideo: { modalities: { output: ["video"] } },
  };
  const messages = new Map<string, Array<Omit<ArtifactEngineMessage, "info"> & {
    info: ArtifactEngineMessage["info"] & {
      sessionID?: string;
      finish?: string;
      summary?: boolean;
      error?: unknown;
    };
  }>>();
  const sessions = new Map<string, { id: string; title: string; parentID?: string; directory?: string; time: { created: number; updated: number } }>();
  const heldPrompts = new Map<string, ReturnType<typeof deferred<void>>>();
  const heldMessageReads = new Map<string, ReturnType<typeof deferred<void>>>();
  const failedMessageReads = new Set<string>();
  const messageReads: string[] = [];
  const heldMessageIds = new Map<string, ReturnType<typeof deferred<void>>>();
  const heldAborts = new Map<string, ReturnType<typeof deferred<void>>>();
  const heldCommands = new Map<string, ReturnType<typeof deferred<void>>>();
  const heldShells = new Map<string, ReturnType<typeof deferred<void>>>();
  const failedPrompts = new Set<string>();
  const failedMessageIds = new Set<string>();
  const failedV2Ids = new Set<string>();
  const v2Admissions = new Map<string, { fingerprint: string; receipt: unknown }>();
  const v2Statuses = new Map<string, number>();
  const failedShells = new Set<string>();
  const autoPersistPrompts = { value: false };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/provider") {
        return Response.json({ all: [{ id: "connected", models }], connected });
      }
      if (request.method === "GET" && url.pathname === "/session/status") {
        statusRequests.push(request.headers.get("x-opencode-directory") ?? "");
        return Response.json(Object.fromEntries(statuses));
      }
      const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (request.method === "GET" && messageMatch) {
        const sessionId = decodeURIComponent(messageMatch[1]!);
        if (failedMessageReads.has(sessionId)) {
          messageReads.push(sessionId);
          return Response.json({ name: "MessageReadFailure" }, { status: 503 });
        }
        const snapshot = messages.get(sessionId) ?? [];
        const held = heldMessageReads.get(sessionId);
        heldMessageReads.delete(sessionId);
        messageReads.push(sessionId);
        await held?.promise;
        return Response.json(snapshot);
      }
      const directMessageMatch = url.pathname.match(/^\/session\/([^/]+)\/message\/([^/]+)$/);
      if (request.method === "GET" && directMessageMatch) {
        const sessionId = decodeURIComponent(directMessageMatch[1]!);
        const messageId = decodeURIComponent(directMessageMatch[2]!);
        const message = messages.get(sessionId)?.find((candidate) => candidate.info.id === messageId);
        return message ? Response.json(message) : Response.json({ code: "not_found" }, { status: 404 });
      }
      const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
      const messagesMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (request.method === "GET" && messagesMatch) {
        const id = decodeURIComponent(messagesMatch[1]!);
        return Response.json(messages.get(id) ?? [{
          info: { role: "assistant", finish: "stop", time: { created: Date.now(), completed: Date.now() } }, parts: [],
        }]);
      }
      if (request.method === "GET" && sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]!);
        const session = sessions.get(sessionId);
        return session ? Response.json(session) : Response.json({ code: "not_found" }, { status: 404 });
      }
      if (request.method === "DELETE" && sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]!);
        return Response.json(sessions.delete(sessionId));
      }
      if (request.method === "POST" && url.pathname === "/instance/dispose") {
        disposes.push({ directory: url.searchParams.get("directory") });
        return Response.json({ disposed: true });
      }

      const v2PromptMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/);
      if (request.method === "POST" && v2PromptMatch) {
        const sessionId = decodeURIComponent(v2PromptMatch[1]!);
        const body = await request.json() as { id?: string; delivery?: string; prompt?: unknown };
        v2Prompts.push({ sessionId, body, directory: request.headers.get("x-opencode-directory") });
        if (!body.id?.startsWith("msg_")) return Response.json({ _tag: "InvalidRequestError" }, { status: 400 });
        const forcedStatus = v2Statuses.get(sessionId);
        if (forcedStatus) return Response.json({ message: "private upstream prompt must not leak" }, { status: forcedStatus });
        if (body.id && failedV2Ids.delete(body.id)) return Response.json({ name: "PromptFailure" }, { status: 500 });
        const fingerprint = JSON.stringify([sessionId, body.prompt, body.delivery]);
        const existing = v2Admissions.get(body.id);
        if (existing) return existing.fingerprint === fingerprint
          ? Response.json(existing.receipt)
          : Response.json({ _tag: "ConflictError" }, { status: 409 });
        const receipt = {
          data: {
            admittedSeq: v2Prompts.length,
            id: body.id,
            sessionID: sessionId,
            prompt: body.prompt,
            delivery: body.delivery,
            timeCreated: Date.now(),
          },
        };
        v2Admissions.set(body.id, { fingerprint, receipt });
        return Response.json(receipt);
      }

      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (request.method === "POST" && promptMatch) {
        const sessionId = decodeURIComponent(promptMatch[1]!);
        const body = await request.json() as { messageID?: string };
        prompts.push({
          sessionId,
          body,
          directory: request.headers.get("x-opencode-directory"),
        });
        const heldPrompt = (body.messageID === undefined ? undefined : heldMessageIds.get(body.messageID)) ?? heldPrompts.get(sessionId);
        await heldPrompt?.promise;
        if (failedPrompts.delete(sessionId) || (body.messageID !== undefined && failedMessageIds.delete(body.messageID))) {
          return Response.json({ name: "PromptFailure" }, { status: 500 });
        }
        if (autoPersistPrompts.value && body.messageID) {
          const parts = Array.isArray((body as { parts?: unknown }).parts)
            ? (body as { parts: Array<Record<string, unknown>> }).parts
            : [];
          messages.set(sessionId, [
            ...(messages.get(sessionId) ?? []),
            {
              info: { id: body.messageID, role: "user" },
              parts: parts.map((part, index) => ({
                ...part,
                id: `prt_${index}`,
                messageID: body.messageID!,
                sessionID: sessionId,
              })),
            },
          ]);
        }
        return new Response(null, { status: 204 });
      }

      const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
      if (request.method === "POST" && abortMatch) {
        const sessionId = decodeURIComponent(abortMatch[1]!);
        aborts.push(sessionId);
        await heldAborts.get(sessionId)?.promise;
        return Response.json(true);
      }

      const commandMatch = url.pathname.match(/^\/session\/([^/]+)\/command$/);
      if (request.method === "POST" && commandMatch) {
        const sessionId = decodeURIComponent(commandMatch[1]!);
        commands.push({ sessionId, body: await request.json() });
        await heldCommands.get(sessionId)?.promise;
        return Response.json({ info: { id: "msg_command" }, parts: [] });
      }

      const shellMatch = url.pathname.match(/^\/session\/([^/]+)\/shell$/);
      if (request.method === "POST" && shellMatch) {
        const sessionId = decodeURIComponent(shellMatch[1]!);
        shells.push({ sessionId, body: await request.json() });
        await heldShells.get(sessionId)?.promise;
        if (failedShells.delete(sessionId)) {
          return Response.json({ name: "ShellFailure" }, { status: 500 });
        }
        return Response.json({ info: { id: "msg_shell" }, parts: [] });
      }

      return Response.json({ code: "not_found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return {
    server,
    prompts,
    v2Prompts,
    aborts,
    commands,
    shells,
    statusRequests,
    disposes,
    statuses,
    connected,
    models,
    messages,
    sessions,
    heldPrompts,
    heldMessageReads,
    failedMessageReads,
    messageReads,
    heldMessageIds,
    heldAborts,
    heldCommands,
    heldShells,
    failedPrompts,
    failedMessageIds,
    failedV2Ids,
    v2Admissions,
    v2Statuses,
    failedShells,
    autoPersistPrompts,
  };
}

async function startHarness(enginePort: number) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-session-mutation-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "jugglework-session-mutation-second-"));
  roots.push(root);
  roots.push(secondRoot);
  await mkdir(join(root, ".opencode"), { recursive: true });
  await mkdir(join(secondRoot, ".opencode"), { recursive: true });
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_collaborator",
    hostToken: "owt_host",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: root,
        preset: "starter",
        workspaceType: "local",
        baseUrl: `http://127.0.0.1:${enginePort}`,
      },
      {
        id: "ws_2",
        name: "Second Workspace",
        path: secondRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: `http://127.0.0.1:${enginePort}`,
      },
    ],
    authorizedRoots: [root, secondRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  const collaboratorHeaders = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
  const enabled = await fetch(`http://127.0.0.1:${server.port}/remote-control/pending/enable`, {
    method: "POST",
    headers: collaboratorHeaders,
    body: JSON.stringify({ enabled: true, steer: true, enqueue: true }),
  });
  if (!enabled.ok) throw new Error("Failed to enable pending-operation test fixture");
  return {
    base: `http://127.0.0.1:${server.port}`,
    root,
    collaboratorHeaders,
    hostHeaders: { "X-JuggleWork-Host-Token": config.hostToken, "Content-Type": "application/json" },
    config,
    server,
  };
}

function runPath(base: string, sessionId: string): string {
  return `${base}/workspace/ws_1/sessions/${sessionId}/runs`;
}

describe("authoritative session mutation APIs", () => {
  test("model preferences require an existing session, resolve explicit/auto prompts, and clean up on deletion", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const sessionId = "ses_preference";
    const modelPath = `${harness.base}/workspace/ws_1/sessions/${sessionId}/model-preference`;
    const startPath = `${runPath(harness.base, sessionId)}/start`;
    const requestPreference = (method: "GET" | "PUT", body?: unknown) => fetch(modelPath, {
      method,
      headers: harness.collaboratorHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    expect((await requestPreference("GET")).status).toBe(404);
    expect((await requestPreference("PUT", { mode: "auto", model: null, expectedRevision: 0 })).status).toBe(404);

    engine.sessions.set(sessionId, { id: sessionId, title: "Preference", directory: harness.config.workspaces[0]!.path, time: { created: 1, updated: 1 } });
    const explicit = { providerID: "connected", modelID: "chat" };
    const explicitResponse = await requestPreference("PUT", { mode: "explicit", model: explicit, expectedRevision: 0 });
    expect(explicitResponse.status).toBe(200);
    expect((await explicitResponse.json()).item).toMatchObject({ revision: 1, mode: "explicit", model: explicit });

    const localStart = (model: { providerID: string; modelID: string }) => fetch(startPath, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: `cmd_${engine.prompts.length}`, prompt: { parts: [{ type: "text", text: "Hello" }], model } }),
    });
    expect((await localStart({ providerID: "connected", modelID: "other-displayed-default" })).status).toBe(202);
    expect(engine.prompts.at(-1)?.body).toMatchObject({ model: explicit });
    engine.statuses.set(sessionId, { type: "idle" });
    engine.messages.set(sessionId, [{ info: { id: "msg_done", sessionID: sessionId, role: "assistant", time: { created: Date.now(), completed: Date.now() }, finish: "stop" }, parts: [] }]);

    const autoResponse = await requestPreference("PUT", { mode: "auto", model: null, expectedRevision: 1 });
    expect(autoResponse.status).toBe(200);
    const displayedDefault = { providerID: "connected", modelID: "chat" };
    expect((await localStart(displayedDefault)).status).toBe(202);
    expect(engine.prompts.at(-1)?.body).toMatchObject({ model: displayedDefault });

    const deleted = await fetch(`${harness.base}/workspace/ws_1/sessions/${sessionId}`, { method: "DELETE", headers: harness.collaboratorHeaders });
    expect(deleted.status).toBe(200);
    engine.sessions.set(sessionId, { id: sessionId, title: "Recreated", directory: harness.config.workspaces[0]!.path, time: { created: 2, updated: 2 } });
    expect((await (await requestPreference("GET")).json()).item).toMatchObject({ revision: 0, mode: "auto", model: null });
  });

  test("remote explicit model is validated and forwarded only for immediate starts", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const start = (model: unknown, whenBusy?: "reject" | "steer" | "enqueue") => fetch(`${runPath(harness.base, "ses_model")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: "cmd_model", whenBusy,
        prompt: { parts: [{ type: "text", text: "Hello" }], model } }),
    });
    const model = { providerID: "connected", modelID: "chat" };
    for (const invalid of [
      [{ providerID: "disconnected", modelID: "chat" }, "reject"],
      [{ providerID: "connected", modelID: "missing" }, "reject"],
      [{ providerID: "connected", modelID: "image" }, "reject"],
      [{ providerID: "connected", modelID: "normalizedVideo" }, "reject"],
      [model, "steer"], [model, "enqueue"],
    ] as const) {
      expect((await start(invalid[0], invalid[1])).status).toBe(400);
    }
    expect(engine.prompts).toHaveLength(0);
    // Omitted whenBusy is the normal adapter path and defaults to reject.
    expect((await start(model)).status).toBe(202);
    expect(engine.prompts[0]?.body).toMatchObject({ model });
  });
  for (const mode of ["local-queue", "local-steer", "remote-steer"] as const) {
    test(`${mode} 真实入口绑定文件交付，队列执行前不结束，生成工具可定位原轮次`, async () => {
      const engine = startMockOpencode();
      const harness = await startHarness(engine.server.port);
      const sessionId = `ses_delivery_${mode}`;
      const remote = mode.startsWith("remote-");
      engine.statuses.set(sessionId, { type: "busy" });
      const response = await fetch(mode === "local-queue"
        ? `${harness.base}/workspace/ws_1/sessions/${sessionId}/queue`
        : `${runPath(harness.base, sessionId)}/start`, {
        method: "POST", headers: harness.collaboratorHeaders,
        body: JSON.stringify(mode === "local-queue" ? { id: "file-queue", prompt: "生成文档" } : {
          origin: remote ? "remote-control" : "local-renderer", startCommandCorrelationId: "file-queue",
          whenBusy: "steer", prompt: { parts: [{ type: "text", text: "生成文档" }] },
        }),
      });
      expect(response.status).toBe(202);
      await response.json();
      await waitUntil(() => engine.v2Prompts.length === 1);
      const messageId = engine.v2Prompts[0]!.body.id!;
      const base = `${harness.base}/workspace/ws_1/sessions/${sessionId}/file-deliveries`;
      engine.statuses.set(sessionId, { type: "idle" });
      const sync = async () => {
        const result = await fetch(`${base}/sync`, { method: "POST", headers: harness.collaboratorHeaders });
        expect(result.status).toBe(200);
        return result.json();
      };
      expect(await sync()).toMatchObject({ turns: [{ turnId: messageId, status: "collecting", finishedRunIds: [], items: [] }] });
      engine.messages.set(sessionId, [{ info: { id: "msg_tool", role: "assistant", parentID: messageId }, parts: [] }]);
      const prepared = await fetch(`${base}/generations/prepare`, { method: "POST", headers: harness.collaboratorHeaders, body: JSON.stringify({ messageId: "msg_tool", outputs: [] }) });
      expect(prepared.status).toBe(200);
      const generation = await prepared.json() as { generationId: string; outputDirectory: string };
      await writeFile(join(generation.outputDirectory, "排队产物.docx"), "admitted output");
      const completed = await fetch(`${base}/generations/complete`, { method: "POST", headers: harness.collaboratorHeaders, body: JSON.stringify({ generationId: generation.generationId, exitCode: 0 }) });
      expect(completed.status).toBe(200);
      expect(await sync()).toMatchObject({ turns: [{ status: "collecting" }] });
      engine.messages.get(sessionId)![0]!.info.time = { completed: Date.now() };
      expect(await sync()).toMatchObject({ turns: [{ turnId: messageId, status: "ready", items: [expect.objectContaining({ snapshot: expect.objectContaining({ name: "排队产物.docx", sizeBytes: 15 }) })] }] });
      const runs = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
      expect(await runs.json()).toMatchObject({ items: [] });
      expect(engine.prompts).toHaveLength(0);
    });
  }

  test("local collaborator queue uses OpenCode v2 queue delivery without remote pending policy", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const response = await fetch(`${harness.base}/workspace/ws_1/sessions/ses_cli_queue/queue`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ id: "cli_queue_1", prompt: "Continue later" }),
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ disposition: "enqueued", admissionId: "cli_queue_1" });
    expect(engine.v2Prompts).toEqual([{
      sessionId: "ses_cli_queue",
      body: { id: opencodeAdmissionId({ workspaceId: "ws_1", sessionId: "ses_cli_queue", source: "local-queue", id: "cli_queue_1" }), delivery: "queue", prompt: { text: "Continue later" } },
      directory: harness.root,
    }]);
  });

  test("busy local-renderer steer is admitted through OpenCode v2 without starting a second run", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_local_steer", { type: "busy" });

    const response = await fetch(`${runPath(harness.base, "ses_local_steer")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "queued-draft-1",
        whenBusy: "steer",
        prompt: {
          parts: [
            { type: "text", text: "Change direction" },
            { type: "file", mime: "text/plain", filename: "notes.txt", url: "file:///tmp/notes.txt" },
            { type: "agent", name: "reviewer" },
          ],
        },
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ disposition: "steered", admissionId: "queued-draft-1" });
    expect(engine.v2Prompts).toEqual([{
      sessionId: "ses_local_steer",
      body: {
        id: opencodeAdmissionId({ workspaceId: "ws_1", sessionId: "ses_local_steer", source: "local-steer", id: "queued-draft-1" }),
        delivery: "steer",
        prompt: {
          text: "Change direction",
          files: [{ uri: "file:///tmp/notes.txt", name: "notes.txt" }],
          agents: [{ name: "reviewer" }],
        },
      },
      directory: harness.root,
    }]);
    const pending = await fetch(`${harness.base}/workspace/ws_1/sessions/ses_local_steer/pending`, {
      headers: harness.collaboratorHeaders,
    });
    await expect(pending.json()).resolves.toEqual({ items: [] });
  });

  test("local steer retries keep one engine admission and conflicting edits return 409", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_retry", { type: "busy" });
    const send = (text: string) => fetch(`${runPath(harness.base, "ses_retry")}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: "local-steer-retry", whenBusy: "steer", prompt: { parts: [{ type: "text", text }] } }),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await send("Change direction");
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ disposition: "steered", admissionId: "local-steer-retry" });
    }
    const conflict = await send("Different content");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "opencode_admission_conflict", details: { status: 409 } });
    expect(engine.v2Admissions.size).toBe(1);
    expect(new Set(engine.v2Prompts.map((item) => item.body.id)).size).toBe(1);
    expect(engine.prompts).toHaveLength(0);
    expect(engine.aborts).toHaveLength(0);
  });

  for (const [status, code] of [[400, "opencode_admission_invalid_request"], [404, "opencode_admission_not_found"], [500, "opencode_admission_unconfirmed"]] as const) {
    test(`local steer preserves safe upstream ${status} diagnostics`, async () => {
      const engine = startMockOpencode();
      const harness = await startHarness(engine.server.port);
      engine.statuses.set("ses_error", { type: "busy" });
      engine.v2Statuses.set("ses_error", status);
      const response = await fetch(`${runPath(harness.base, "ses_error")}/start`, {
        method: "POST", headers: harness.collaboratorHeaders,
        body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: "local-steer-error", whenBusy: "steer", prompt: { parts: [{ type: "text", text: "Private prompt" }] } }),
      });
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toMatchObject({ code, details: { status, path: "/api/session/ses_error/prompt" } });
      expect(JSON.stringify(body)).not.toContain("private upstream");
      expect(JSON.stringify(body)).not.toContain("Private prompt");
      expect(engine.prompts).toHaveLength(0);
      expect(engine.aborts).toHaveLength(0);
    });
  }

  test("busy local-renderer steer rejects unsupported prompt parts without losing the active run", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_unsupported_steer", { type: "busy" });

    const response = await fetch(`${runPath(harness.base, "ses_unsupported_steer")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "unsupported-steer-1",
        whenBusy: "steer",
        prompt: {
          parts: [{ type: "subtask", prompt: "delegate", description: "delegate", agent: "reviewer" }],
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "unsupported_steer_prompt" });
    expect(engine.v2Prompts).toHaveLength(0);
  });

  test("busy steer is durably admitted through the OpenCode v2 steer delivery", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_steer", { type: "busy" });

    const response = await fetch(`${runPath(harness.base, "ses_steer")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "cmd_steer",
        whenBusy: "steer",
        prompt: { parts: [{ type: "text", text: "Change direction" }] },
      }),
    });

    expect(response.status).toBe(202);
    const result = await response.json() as { disposition: string; pendingOperationId: string; position: number };
    expect(result).toMatchObject({ disposition: "enqueued", position: 1 });
    await waitUntil(() => engine.v2Prompts.length === 1);
    expect(engine.v2Prompts).toEqual([{
      sessionId: "ses_steer",
      body: { id: opencodeAdmissionId({ workspaceId: "ws_1", sessionId: "ses_steer", source: "remote-pending", id: result.pendingOperationId }), delivery: "steer", prompt: { text: "Change direction" } },
      directory: harness.root,
    }]);
    const db = new Database(runtimeDbPath(harness.config), { readonly: true });
    try {
      await waitUntil(() => {
        const row = db.query("SELECT state FROM session_pending_operations WHERE id = ?").get(result.pendingOperationId) as { state: string } | null;
        return row?.state === "admitted";
      });
    } finally {
      db.close();
    }
  });

  test("busy enqueue acknowledges FIFO positions and terminal observations promote one at a time", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_queue", { type: "idle" });
    engine.messages.set("ses_queue", [{ info: { id: "msg_queue_first", role: "assistant", finish: "stop", time: { created: Number.MAX_SAFE_INTEGER, completed: Number.MAX_SAFE_INTEGER } }, parts: [] }]);
    const started = await fetch(`${runPath(harness.base, "ses_queue")}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: "cmd_running", prompt: { parts: [{ type: "text", text: "Current" }] } }),
    });
    const running = (await started.json() as { run: { runId: string } }).run;
    engine.statuses.set("ses_queue", { type: "busy" });

    const queued = [];
    for (const [command, prompt] of [["cmd_first", "First"], ["cmd_second", "Second"]]) {
      const response = await fetch(`${runPath(harness.base, "ses_queue")}/start`, {
        method: "POST", headers: harness.collaboratorHeaders,
        body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: command, whenBusy: "enqueue", prompt: { parts: [{ type: "text", text: prompt }] } }),
      });
      expect(response.status).toBe(202);
      queued.push(await response.json() as { pendingOperationId: string; position: number });
    }
    expect(queued.map((item) => item.position)).toEqual([1, 2]);
    expect(engine.v2Prompts).toHaveLength(0);

    engine.statuses.set("ses_queue", { type: "idle" });
    await fetch(`${runPath(harness.base, "ses_queue")}/${running.runId}/observations`, {
      method: "POST", headers: harness.collaboratorHeaders, body: JSON.stringify({ status: "completed" }),
    });
    await waitUntil(() => engine.v2Prompts.length === 1);
    expect(engine.v2Prompts[0]?.body).toMatchObject({ id: opencodeAdmissionId({ workspaceId: "ws_1", sessionId: "ses_queue", source: "remote-pending", id: queued[0]!.pendingOperationId }), delivery: "queue", prompt: { text: "First" } });
    const deliveries = await fetch(`${harness.base}/workspace/ws_1/sessions/ses_queue/file-deliveries`, { headers: harness.collaboratorHeaders });
    const delivery = await deliveries.json() as { turns: Array<{ turnId: string; runIds: string[]; status: string }> };
    const admittedMessageId = engine.v2Prompts[0]!.body.id!;
    expect(delivery.turns.find((turn) => turn.turnId === admittedMessageId)).toMatchObject({ runIds: [`admission:${admittedMessageId}`], status: "collecting" });
    const admittedCancel = await fetch(`${harness.base}/workspace/ws_1/sessions/ses_queue/pending/${queued[0]!.pendingOperationId}/cancel`, {
      method: "POST", headers: harness.collaboratorHeaders, body: JSON.stringify({ commandCorrelationId: "cancel_admitted" }),
    });
    await expect(admittedCancel.json()).resolves.toEqual({ pendingOperationId: queued[0]!.pendingOperationId, status: "not_cancellable" });

    const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    const promotedRun = (await active.json() as { items: Array<{ runId: string }> }).items[0]!;
    engine.messages.set("ses_queue", [{ info: { id: "msg_queue_second", role: "assistant", finish: "stop", time: { created: Number.MAX_SAFE_INTEGER, completed: Number.MAX_SAFE_INTEGER } }, parts: [] }]);
    await fetch(`${runPath(harness.base, "ses_queue")}/${promotedRun.runId}/observations`, {
      method: "POST", headers: harness.collaboratorHeaders, body: JSON.stringify({ status: "completed" }),
    });
    await waitUntil(() => engine.v2Prompts.length === 2);
    expect(engine.v2Prompts[1]?.body).toMatchObject({ id: opencodeAdmissionId({ workspaceId: "ws_1", sessionId: "ses_queue", source: "remote-pending", id: queued[1]!.pendingOperationId }), delivery: "queue", prompt: { text: "Second" } });
  });

  test("preserves safe attachment parts for idle starts and rejects them while busy", async () => {
    const engine = startMockOpencode();
    engine.autoPersistPrompts.value = true;
    const harness = await startHarness(engine.server.port);
    const parts = [
      { type: "text", text: "Inspect " },
      { type: "file", mime: "application/pdf", filename: "brief.pdf", url: "data:application/pdf;base64,JVBERg==" },
      { type: "text", text: " now" },
    ];
    engine.statuses.set("ses_attachment", { type: "idle" });
    const started = await fetch(`${runPath(harness.base, "ses_attachment")}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: "cmd_attachment", prompt: { parts } }),
    });
    expect(started.status).toBe(202);
    expect((engine.prompts.at(-1)?.body as { parts?: unknown[] } | undefined)?.parts).toEqual(parts);

    engine.statuses.set("ses_attachment_busy", { type: "busy" });
    const busy = await fetch(`${runPath(harness.base, "ses_attachment_busy")}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: "cmd_attachment_busy", whenBusy: "enqueue", prompt: { parts } }),
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "session_busy" });
  });

  test("waits for the complete persisted image prompt before accepting a remote start", async () => {
    const engine = startMockOpencode();
    engine.autoPersistPrompts.value = false;
    const harness = await startHarness(engine.server.port);
    const parts = [
      { type: "text", text: "Inspect" },
      { type: "file", mime: "image/png", filename: "screen.png", url: "data:image/png;base64,iVBORw0KGgo=" },
    ];
    engine.statuses.set("ses_image_fence", { type: "idle" });

    let settled = false;
    const startedPromise = fetch(`${runPath(harness.base, "ses_image_fence")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: "cmd_image_fence", prompt: { parts } }),
    }).then((response) => {
      settled = true;
      return response;
    });
    await waitUntil(() => engine.prompts.length === 1);
    const messageID = (engine.prompts[0]!.body as { messageID: string }).messageID;
    engine.messages.set("ses_image_fence", [{
      info: { id: messageID, role: "user" },
      parts: [{ id: "prt_text", messageID, sessionID: "ses_image_fence", ...parts[0] }],
    }]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);

    engine.messages.set("ses_image_fence", [{
      info: { id: messageID, role: "user" },
      parts: [
        { id: "prt_text", messageID, sessionID: "ses_image_fence", ...parts[0] },
        { id: "prt_file", messageID, sessionID: "ses_image_fence", ...parts[1] },
      ],
    }]);
    const started = await startedPromise;
    expect(started.status).toBe(202);
  });

  test("failed queue promotion rolls back its local reservation", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_rollback_queue", { type: "busy" });
    const queuedResponse = await fetch(`${runPath(harness.base, "ses_rollback_queue")}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: "cmd_fail_queue", whenBusy: "enqueue", prompt: { parts: [{ type: "text", text: "Fail admission" }] } }),
    });
    const queued = await queuedResponse.json() as { pendingOperationId: string };
    engine.failedV2Ids.add(opencodeAdmissionId({ workspaceId: "ws_1", sessionId: "ses_rollback_queue", source: "remote-pending", id: queued.pendingOperationId }));
    engine.statuses.set("ses_rollback_queue", { type: "idle" });
    await waitUntil(() => engine.v2Prompts.length === 1);
    await waitUntil(async () => {
      const response = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
      return (await response.json() as { items: unknown[] }).items.length === 0;
    });

    const retry = await fetch(`${runPath(harness.base, "ses_rollback_queue")}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: "cmd_after_failure", prompt: { parts: [{ type: "text", text: "Starts after rollback" }] } }),
    });
    expect(retry.status).toBe(202);
  });

  test("pending cancellation is idempotent and prevents later admission", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_cancel_queue", { type: "busy" });
    const queued = await (await fetch(`${runPath(harness.base, "ses_cancel_queue")}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: "cmd_cancel_queue", whenBusy: "enqueue", prompt: { parts: [{ type: "text", text: "Cancel me" }] } }),
    })).json() as { pendingOperationId: string };
    const cancelPath = `${harness.base}/workspace/ws_1/sessions/ses_cancel_queue/pending/${queued.pendingOperationId}/cancel`;
    for (const [commandCorrelationId, expected] of [["cancel_one", "cancelled"], ["cancel_two", "already_cancelled"]]) {
      const response = await fetch(cancelPath, { method: "POST", headers: harness.collaboratorHeaders, body: JSON.stringify({ commandCorrelationId }) });
      await expect(response.json()).resolves.toEqual({ pendingOperationId: queued.pendingOperationId, status: expected });
    }
    engine.statuses.set("ses_cancel_queue", { type: "idle" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(engine.v2Prompts).toHaveLength(0);
  });

  test("Stop All cancels only not-yet-admitted remote queue rows", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_stop_all", { type: "busy" });
    for (const command of ["cmd_stop_one", "cmd_stop_two"]) {
      await fetch(`${runPath(harness.base, "ses_stop_all")}/start`, {
        method: "POST", headers: harness.collaboratorHeaders,
        body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: command, whenBusy: "enqueue", prompt: { parts: [{ type: "text", text: command }] } }),
      });
    }
    const stopped = await fetch(`${harness.base}/remote-control/pending/cancel-all`, {
      method: "POST", headers: harness.collaboratorHeaders, body: JSON.stringify({ commandCorrelationId: "stop_all_command" }),
    });
    await expect(stopped.json()).resolves.toEqual({ cancelled: 2 });
    engine.statuses.set("ses_stop_all", { type: "idle" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(engine.v2Prompts).toHaveLength(0);
  });

  test("mode policy route cancels persisted rows that stay cancelled after re-enable", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_policy_queue", { type: "busy" });
    const queued = await (await fetch(`${runPath(harness.base, "ses_policy_queue")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "cmd_policy_queue",
        whenBusy: "enqueue",
        prompt: { parts: [{ type: "text", text: "Must remain cancelled" }] },
      }),
    })).json() as { pendingOperationId: string };

    const disabled = await fetch(`${harness.base}/remote-control/pending/enable`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ enabled: true, steer: true, enqueue: false }),
    });
    await expect(disabled.json()).resolves.toEqual({ enabled: true, steer: true, enqueue: false, cancelled: 1 });
    const cancelled = await fetch(`${harness.base}/workspace/ws_1/sessions/ses_policy_queue/pending/${queued.pendingOperationId}/cancel`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ commandCorrelationId: "confirm_policy_cancel" }),
    });
    await expect(cancelled.json()).resolves.toEqual({ pendingOperationId: queued.pendingOperationId, status: "already_cancelled" });

    await fetch(`${harness.base}/remote-control/pending/enable`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ enabled: true, steer: true, enqueue: true }),
    });
    engine.statuses.set("ses_policy_queue", { type: "idle" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(engine.v2Prompts).toHaveLength(0);
  });

  test("fully disabled pending policy returns immediately for an empty queue", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const response = await fetch(`${harness.base}/remote-control/pending/enable`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ enabled: false, steer: false, enqueue: false }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: false,
      steer: false,
      enqueue: false,
      cancelled: 0,
    });
  });

  test("restart pump admits an idle persisted queue row once with its durable ID", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_restart_queue", { type: "busy" });
    const queued = await (await fetch(`${runPath(harness.base, "ses_restart_queue")}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: "cmd_restart_queue", whenBusy: "enqueue", prompt: { parts: [{ type: "text", text: "After restart" }] } }),
    })).json() as { pendingOperationId: string };

    const firstStop = stops.pop();
    await firstStop?.();
    engine.statuses.set("ses_restart_queue", { type: "idle" });
    const restarted = await startServer(harness.config) as Served;
    stops.push(() => restarted.stop(true));
    await fetch(`http://127.0.0.1:${restarted.port}/remote-control/pending/enable`, {
      method: "POST", headers: harness.collaboratorHeaders, body: JSON.stringify({ enabled: true, steer: true, enqueue: true }),
    });
    await waitUntil(() => engine.v2Prompts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(engine.v2Prompts).toHaveLength(1);
    expect(engine.v2Prompts[0]?.body).toMatchObject({ id: opencodeAdmissionId({ workspaceId: "ws_1", sessionId: "ses_restart_queue", source: "remote-pending", id: queued.pendingOperationId }), delivery: "queue", prompt: { text: "After restart" } });
  });

  test("rejects authoritative engine activity without fabricating a run id", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_busy", { type: "busy" });

    const response = await fetch(`${runPath(harness.base, "ses_busy")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "cmd_busy",
        prompt: { parts: [{ type: "text", text: "Must not dispatch" }] },
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "session_busy",
      details: { currentRunId: null },
    });
    expect(engine.prompts).toHaveLength(0);
    expect(engine.statusRequests).toEqual([harness.root]);
  });

  test("parses only the target status and starts when it is idle", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("other_session", { type: "future-invalid-status" });
    engine.statuses.set("ses_idle", { type: "idle" });

    const response = await fetch(`${runPath(harness.base, "ses_idle")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: null,
        prompt: { parts: [{ type: "text", text: "Start idle" }] },
      }),
    });

    expect(response.status).toBe(202);
    expect(engine.prompts).toHaveLength(1);
  });

  test("rejects retry and waiting engine states", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_retry", { type: "retry", attempt: 2, message: "later", next: Date.now() + 1_000 });
    engine.statuses.set("ses_waiting", { type: "waiting" });

    for (const sessionId of ["ses_retry", "ses_waiting"]) {
      const response = await fetch(`${runPath(harness.base, sessionId)}/start`, {
        method: "POST",
        headers: harness.collaboratorHeaders,
        body: JSON.stringify({
          origin: "remote-control",
          startCommandCorrelationId: null,
          prompt: { parts: [{ type: "text", text: "Must wait" }] },
        }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "session_busy",
        details: { currentRunId: null },
      });
    }
    expect(engine.prompts).toHaveLength(0);
  });

  test("local and remote starts race atomically, dispatch once, and preserve the full local prompt", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const hold = deferred<void>();
    engine.heldPrompts.set("ses_race", hold);
    const prompt = {
      messageID: "msg_local",
      model: { providerID: "connected", modelID: "chat" },
      agent: "jugglework",
      noReply: false,
      tools: { bash: false, read: true },
      format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } } }, retryCount: 2 },
      system: "System context",
      variant: "high",
      parts: [{ type: "text", text: "Local payload", metadata: { source: "composer" } }],
      reasoning_effort: "high",
    };

    const localRequest = fetch(`${runPath(harness.base, "ses_race")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_local",
        responseLanguage: { detected: "zh", fallback: "en" },
        prompt,
      }),
    });
    await waitUntil(() => engine.prompts.length === 1);
    expect(JSON.stringify(engine.prompts[0]?.body)).toContain("Use Simplified Chinese for all user-facing responses");

    const remoteResponse = await fetch(`${runPath(harness.base, "ses_race")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "cmd_remote",
        prompt: { parts: [{ type: "text", text: "Remote text" }] },
      }),
    });
    expect(remoteResponse.status).toBe(409);
    const busy = await remoteResponse.json() as { code: string; details: { currentRunId: string } };
    expect(busy.code).toBe("session_busy");
    expect(busy.details.currentRunId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(engine.prompts).toHaveLength(1);
    expect(engine.statusRequests).toEqual([harness.root, harness.root]);
    expect(engine.prompts[0]).toMatchObject({
      sessionId: "ses_race",
      body: { ...prompt, system: expect.stringContaining("Use Simplified Chinese for all user-facing responses") },
      directory: harness.root,
    });

    hold.resolve();
    const localResponse = await localRequest;
    expect(localResponse.status).toBe(202);
    const local = await localResponse.json() as { run: Record<string, unknown> };
    expect(local.run).toMatchObject({
      workspaceId: "ws_1",
      sessionId: "ses_race",
      generation: 1,
      origin: "local-renderer",
      startCommandCorrelationId: "cmd_local",
      abortCommandCorrelationId: null,
      status: "running",
      observedActive: false,
    });
    expect(local.run.runId).not.toBe(local.run.startCommandCorrelationId);
    expect(local.run).toHaveProperty("startedAt");
    expect(local.run).toHaveProperty("updatedAt");
  });

  test("prompt failure rolls back only its exact reservation", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.failedPrompts.add("ses_failure");

    const failed = await fetch(`${runPath(harness.base, "ses_failure")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "cmd_failed",
        prompt: { parts: [{ type: "text", text: "Fail once" }] },
      }),
    });
    expect(failed.status).toBe(502);

    const retry = await fetch(`${runPath(harness.base, "ses_failure")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "cmd_retry",
        prompt: { parts: [{ type: "text", text: "Retry" }] },
      }),
    });
    expect(retry.status).toBe(202);
    await expect(retry.json()).resolves.toMatchObject({
      run: { generation: 2, origin: "remote-control", startCommandCorrelationId: "cmd_retry" },
    });
    expect(engine.prompts).toHaveLength(2);
  });

  test("failed prompt admission rolls back its response-language change", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);

    const first = await fetch(`${runPath(harness.base, "ses_language_failure")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "language-zh",
        responseLanguage: { detected: "zh", fallback: "en" },
        prompt: { parts: [{ type: "text", text: "中文请求" }] },
      }),
    });
    expect(first.status).toBe(202);

    const active = (await first.json() as { run: { runId: string } }).run;
    engine.statuses.set("ses_language_failure", { type: "idle" });
    engine.messages.set("ses_language_failure", [{ info: { id: "msg_language", role: "assistant", finish: "stop", time: { created: Date.now(), completed: Date.now() } }, parts: [] }]);
    await fetch(`${runPath(harness.base, "ses_language_failure")}/${active.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "completed" }),
    });
    engine.failedPrompts.add("ses_language_failure");

    const failed = await fetch(`${runPath(harness.base, "ses_language_failure")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "language-en-failed",
        responseLanguage: { detected: "en", fallback: "en" },
        prompt: { parts: [{ type: "text", text: "English request" }] },
      }),
    });
    expect(failed.status).toBe(502);

    const db = new Database(runtimeDbPath(harness.config), { readonly: true });
    try {
      expect(db.query(
        "SELECT response_language FROM session_response_languages WHERE workspace_id = ? AND session_id = ?",
      ).get("ws_1", "ses_language_failure")).toEqual({ response_language: "zh" });
    } finally {
      db.close();
    }
  });

  test("internal language lookup inherits and persists the nearest parent language", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const now = Date.now();
    engine.sessions.set("ses_language_root", {
      id: "ses_language_root", title: "Root", directory: harness.root, time: { created: now, updated: now },
    });
    engine.sessions.set("ses_language_child", {
      id: "ses_language_child", title: "Child", parentID: "ses_language_root", directory: harness.root, time: { created: now, updated: now },
    });
    engine.sessions.set("ses_language_grandchild", {
      id: "ses_language_grandchild", title: "Grandchild", parentID: "ses_language_child", directory: harness.root, time: { created: now, updated: now },
    });

    const started = await fetch(`${runPath(harness.base, "ses_language_root")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "language-parent-zh",
        responseLanguage: { detected: "zh", fallback: "en" },
        prompt: { parts: [{ type: "text", text: "请检查这个改动" }] },
      }),
    });
    expect(started.status).toBe(202);

    const language = await fetch(
      `${harness.base}/internal/session-response-language/ses_language_grandchild?workspaceId=ws_1`,
      { headers: harness.collaboratorHeaders },
    );
    expect(language.status).toBe(200);
    expect(await language.json()).toEqual({ language: "zh" });

    const db = new Database(runtimeDbPath(harness.config), { readonly: true });
    try {
      expect(db.query(
        "SELECT response_language FROM session_response_languages WHERE workspace_id = ? AND session_id = ?",
      ).get("ws_1", "ses_language_grandchild")).toEqual({ response_language: "zh" });
    } finally {
      db.close();
    }
  });

  for (const delivery of ["start", "steer"] as const) {
    test(`${delivery} selects language only from genuine text and retains internal continuation language`, async () => {
      const engine = startMockOpencode();
      const harness = await startHarness(engine.server.port);
      const sessionId = `ses_language_${delivery}`;
      const languageUrl = `${harness.base}/internal/session-response-language/${sessionId}?workspaceId=ws_1`;
      let sequence = 0;
      async function submit(parts: unknown[], detected: "en" | "zh" | undefined, expected: "en" | "zh", fail = false) {
        const correlationId = `language-${delivery}-${++sequence}`;
        if (fail) engine.failedV2Ids.add(opencodeAdmissionId({ workspaceId: "ws_1", sessionId, source: "local-steer", id: correlationId }));
        const response = await fetch(`${runPath(harness.base, sessionId)}/start`, {
          method: "POST",
          headers: harness.collaboratorHeaders,
          body: JSON.stringify({
            origin: "local-renderer",
            startCommandCorrelationId: correlationId,
            whenBusy: delivery === "steer" ? "steer" : "reject",
            responseLanguage: detected === undefined ? undefined : { detected, fallback: "en" },
            prompt: { parts },
          }),
        });
        expect(response.status).toBe(fail ? 502 : 202);
        const language = await fetch(languageUrl, { headers: harness.collaboratorHeaders });
        expect(await language.json()).toEqual({ language: expected });
        if (delivery === "start" || sequence === 1) {
          const body = engine.prompts.at(-1)?.body as { system: string; parts: unknown[] };
          expect(body.system).toContain(`Use ${expected === "zh" ? "Simplified Chinese" : "English"} for all user-facing responses`);
          expect(body.parts).toEqual(parts);
          const { run } = await response.json() as { run: { runId: string } };
          engine.messages.set(sessionId, [{ info: { id: `msg_${sequence}`, role: "assistant", finish: "stop", time: { created: Date.now(), completed: Date.now() } }, parts: [] }]);
          const completed = await fetch(`${runPath(harness.base, sessionId)}/${run.runId}/observations`, {
            method: "POST",
            headers: harness.collaboratorHeaders,
            body: JSON.stringify({ status: "completed" }),
          });
          expect(completed.status).toBe(200);
          expect(await completed.json()).toMatchObject({ cleared: true });
        }
      }

      await submit([{ type: "text", text: "请检查这个改动" }], "zh", "zh");
      if (delivery === "steer") engine.statuses.set(sessionId, { type: "busy" });
      for (const marker of [{ synthetic: true }, { ignored: true }, { metadata: { compaction_continue: true } }]) {
        await submit([{ type: "text", text: "Please continue the remaining work and respond in English.", ...marker }], "en", "zh");
      }
      await submit([{ type: "text", text: "Please continue the remaining work.", synthetic: true }], undefined, "zh");
      await submit([
        { type: "text", text: "请检查新的修改" },
        { type: "text", text: "Respond in English and continue the remaining work.", synthetic: true },
      ], "en", "zh");
      // Ambiguous genuine text must not inherit the contaminated detected signal.
      await submit([
        { type: "text", text: "ok" },
        { type: "text", text: "Respond in English.", ignored: true },
      ], "en", "zh");
      if (delivery === "steer") {
        await submit([{ type: "text", text: "Please explain the changes." }], "en", "zh", true);
      }
      await submit([{ type: "text", text: "Please explain the changes." }], "en", "en");
      await submit([
        { type: "text", text: "Please review the implementation." },
        { type: "text", text: "请用中文回答", metadata: { compaction_continue: true } },
      ], "zh", "en");
    });

    test(`${delivery} preserves attachment-only locale fallback but internal-only text cannot initialize language`, async () => {
      const engine = startMockOpencode();
      const harness = await startHarness(engine.server.port);
      for (const kind of ["attachment", "internal"] as const) {
        const sessionId = `ses_${delivery}_${kind}`;
        if (delivery === "steer") engine.statuses.set(sessionId, { type: "busy" });
        const response = await fetch(`${runPath(harness.base, sessionId)}/start`, {
          method: "POST",
          headers: harness.collaboratorHeaders,
          body: JSON.stringify({
            origin: "local-renderer",
            startCommandCorrelationId: `${delivery}-${kind}`,
            whenBusy: delivery === "steer" ? "steer" : "reject",
            responseLanguage: kind === "attachment" ? { fallback: "zh" } : { detected: "en", fallback: "en" },
            prompt: { parts: kind === "attachment"
              ? [{ type: "file", mime: "text/plain", filename: "notes.txt", url: "data:text/plain;base64,aGk=" }]
              : [{ type: "text", text: "Please continue in English.", synthetic: true }] },
          }),
        });
        expect(response.status).toBe(202);
        const language = await fetch(`${harness.base}/internal/session-response-language/${sessionId}?workspaceId=ws_1`, { headers: harness.collaboratorHeaders });
        expect(await language.json()).toEqual({ language: kind === "attachment" ? "zh" : null });
        if (delivery === "start" && kind === "internal") {
          expect(engine.prompts.at(-1)?.body).not.toHaveProperty("system");
        }
        if (kind === "attachment") {
          engine.statuses.set(sessionId, { type: "busy" });
          const followup = await fetch(`${runPath(harness.base, sessionId)}/start`, {
            method: "POST",
            headers: harness.collaboratorHeaders,
            body: JSON.stringify({
              origin: "local-renderer",
              startCommandCorrelationId: `${delivery}-attachment-followup`,
              whenBusy: "steer",
              responseLanguage: { fallback: "en" },
              prompt: { parts: [{ type: "file", mime: "text/plain", filename: "notes.txt", url: "data:text/plain;base64,aGk=" }] },
            }),
          });
          expect(followup.status).toBe(202);
          const retained = await fetch(`${harness.base}/internal/session-response-language/${sessionId}?workspaceId=ws_1`, { headers: harness.collaboratorHeaders });
          expect(await retained.json()).toEqual({ language: "zh" });
        }
      }
    });
  }

  for (const whenBusy of ["steer", "enqueue"] as const) {
    test(`remote ${whenBusy} rejects internal provenance before pending text flattening`, async () => {
      const engine = startMockOpencode();
      const harness = await startHarness(engine.server.port);
      const sessionId = `ses_remote_internal_${whenBusy}`;
      engine.statuses.set(sessionId, { type: "busy" });
      for (const marker of [{ synthetic: true }, { ignored: true }, { metadata: { compaction_continue: true } }]) {
        for (const mixed of [false, true]) {
          const response = await fetch(`${runPath(harness.base, sessionId)}/start`, {
            method: "POST",
            headers: harness.collaboratorHeaders,
            body: JSON.stringify({
              origin: "remote-control",
              startCommandCorrelationId: "remote-internal",
              whenBusy,
              prompt: { parts: [
                ...(mixed ? [{ type: "text", text: "请检查修改" }] : []),
                { type: "text", text: "Please respond in English.", ...marker },
              ] },
            }),
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({ code: "invalid_payload" });
        }
      }
      const pending = await fetch(`${harness.base}/workspace/ws_1/sessions/${sessionId}/pending`, { headers: harness.collaboratorHeaders });
      expect(await pending.json()).toEqual({ items: [] });
      expect(engine.prompts).toHaveLength(0);
      expect(engine.v2Prompts).toHaveLength(0);
      const language = await fetch(`${harness.base}/internal/session-response-language/${sessionId}?workspaceId=ws_1`, { headers: harness.collaboratorHeaders });
      expect(await language.json()).toEqual({ language: null });
    });
  }

  test("remote user prose updates the durable language without a UI locale", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);

    const response = await fetch(`${runPath(harness.base, "ses_remote_language")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "remote-language-zh",
        prompt: { parts: [{ type: "text", text: "请帮我检查这个改动" }] },
      }),
    });
    expect(response.status).toBe(202);

    const db = new Database(runtimeDbPath(harness.config), { readonly: true });
    try {
      expect(db.query(
        "SELECT response_language FROM session_response_languages WHERE workspace_id = ? AND session_id = ?",
      ).get("ws_1", "ses_remote_language")).toEqual({ response_language: "zh" });
    } finally {
      db.close();
    }
  });

  test("proxied command activity reserves the session while preserving immediate acknowledgement", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const hold = deferred<void>();
    engine.heldCommands.set("ses_command", hold);

    const commandResponse = await fetch(`${harness.base}/workspace/ws_1/opencode/session/ses_command/command`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ command: "review", arguments: "" }),
    });
    expect(commandResponse.status).toBe(200);
    await expect(commandResponse.json()).resolves.toEqual({ ok: true, accepted: true });
    await waitUntil(() => engine.commands.length === 1);

    const remote = await fetch(`${runPath(harness.base, "ses_command")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: null,
        prompt: { parts: [{ type: "text", text: "Do not overlap command" }] },
      }),
    });
    expect(remote.status).toBe(409);
    const busy = await remote.json() as { details: { currentRunId: string | null } };
    expect(busy.details.currentRunId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(engine.prompts).toHaveLength(0);

    hold.resolve();
    await waitUntil(async () => {
      const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
      return ((await active.json()) as { items: unknown[] }).items.length === 0;
    });
  });

  test("proxied shell activity reserves the session and preserves the upstream response", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const hold = deferred<void>();
    engine.heldShells.set("ses_shell", hold);

    const shellRequest = fetch(`${harness.base}/workspace/ws_1/opencode/session/ses_shell/shell`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ agent: "build", command: "pwd" }),
    });
    await waitUntil(() => engine.shells.length === 1);

    const remote = await fetch(`${runPath(harness.base, "ses_shell")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: null,
        prompt: { parts: [{ type: "text", text: "Do not overlap shell" }] },
      }),
    });
    expect(remote.status).toBe(409);
    const busy = await remote.json() as { details: { currentRunId: string | null } };
    expect(busy.details.currentRunId).toMatch(/^[0-9a-f-]{36}$/i);

    hold.resolve();
    const shellResponse = await shellRequest;
    expect(shellResponse.status).toBe(200);
    await expect(shellResponse.json()).resolves.toEqual({ info: { id: "msg_shell" }, parts: [] });
    expect(engine.prompts).toHaveLength(0);
  });

  test("proxied execution failure releases its exact reservation", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.failedShells.add("ses_shell_failure");

    const failedShell = await fetch(`${harness.base}/workspace/ws_1/opencode/session/ses_shell_failure/shell`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ agent: "build", command: "exit 1" }),
    });
    expect(failedShell.status).toBe(500);

    const remote = await fetch(`${runPath(harness.base, "ses_shell_failure")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: null,
        prompt: { parts: [{ type: "text", text: "Retry after shell failure" }] },
      }),
    });
    expect(remote.status).toBe(202);
    expect(engine.prompts).toHaveLength(1);
  });

  test("a stale prompt failure cannot roll back a replacement run", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const hold = deferred<void>();
    engine.heldMessageIds.set("msg_first", hold);
    engine.failedMessageIds.add("msg_first");
    const firstRequest = fetch(`${runPath(harness.base, "ses_rollback")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_first",
        prompt: { messageID: "msg_first", parts: [{ type: "text", text: "First" }] },
      }),
    });
    await waitUntil(() => engine.prompts.length === 1);
    const listed = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    const firstRunId = ((await listed.json()) as { items: Array<{ runId: string }> }).items[0]!.runId;
    await fetch(`${runPath(harness.base, "ses_rollback")}/${firstRunId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "failed" }),
    });

    const replacement = await fetch(`${runPath(harness.base, "ses_rollback")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_replacement",
        prompt: { messageID: "msg_replacement", parts: [{ type: "text", text: "Replacement" }] },
      }),
    });
    hold.resolve();
    const replacementRun = (await replacement.json() as { run: { runId: string } }).run;
    expect((await firstRequest).status).toBe(502);

    const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    await expect(active.json()).resolves.toMatchObject({ items: [{ runId: replacementRun.runId }] });
  });

  test("stalled delegated recovery aborts only a verified busy child session", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.sessions.set("ses_child", {
      id: "ses_child",
      title: "Review implementation",
      parentID: "ses_parent",
      directory: harness.root,
      time: { created: Date.now(), updated: Date.now() },
    });
    engine.statuses.set("ses_parent", { type: "busy" });
    engine.statuses.set("ses_child", { type: "busy" });

    const response = await fetch(
      `${harness.base}/workspace/ws_1/sessions/ses_parent/delegated-sessions/ses_child/abort`,
      {
        method: "POST",
        headers: harness.collaboratorHeaders,
        body: JSON.stringify({ abortCommandCorrelationId: "stalled-child-task-test" }),
      },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      childSessionId: "ses_child",
      abortRequested: true,
      status: "aborting",
      abortCommandCorrelationId: "stalled-child-task-test",
    });
    expect(engine.aborts).toEqual(["ses_child"]);
  });

  test("delegated recovery refuses a child from a different parent", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.sessions.set("ses_child", {
      id: "ses_child",
      title: "Review implementation",
      parentID: "ses_other_parent",
      directory: harness.root,
      time: { created: Date.now(), updated: Date.now() },
    });
    engine.statuses.set("ses_child", { type: "busy" });

    const response = await fetch(
      `${harness.base}/workspace/ws_1/sessions/ses_parent/delegated-sessions/ses_child/abort`,
      {
        method: "POST",
        headers: harness.collaboratorHeaders,
        body: JSON.stringify({ abortCommandCorrelationId: "stalled-child-task-test" }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "delegated_session_parent_mismatch" });
    expect(engine.aborts).toEqual([]);
  });

  test("delegated recovery leaves an already-idle child untouched", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.sessions.set("ses_child", {
      id: "ses_child",
      title: "Review implementation",
      parentID: "ses_parent",
      directory: harness.root,
      time: { created: Date.now(), updated: Date.now() },
    });
    engine.statuses.set("ses_child", { type: "idle" });

    const response = await fetch(
      `${harness.base}/workspace/ws_1/sessions/ses_parent/delegated-sessions/ses_child/abort`,
      {
        method: "POST",
        headers: harness.collaboratorHeaders,
        body: JSON.stringify({ abortCommandCorrelationId: "stalled-child-task-test" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      childSessionId: "ses_child",
      abortRequested: false,
      status: "idle",
    });
    expect(engine.aborts).toEqual([]);
  });

  test("delayed abort remains active until accepted and an exact idle observation clears it", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const repository = await AutomationRepository.open(harness.config);
    stops.push(() => repository.close());
    const definition: AutomationDefinition = {
      schema: "automation-definition/v1", id: "abort-task", name: "Stop automation",
      workspace: { id: "ws_1", name: "Workspace", path: harness.root, workspaceType: "local" },
      prompt: { version: 1, parts: [{ type: "text", text: "Run" }] },
      trigger: { version: 1, kind: "calendar", frequency: "daily", localTime: "09:00", timezone: "UTC" },
      model: { mode: "auto" }, skillIds: [], connectors: [],
      permission: { profile: AUTOMATION_PERMISSION_PROFILE, acknowledgedAt: 1 },
      lifecycle: "paused", executorDeviceId: "device", revision: 1, nextRunAt: null, createdAt: 1, updatedAt: 1,
    };
    repository.createDefinition(definition, definition);
    const automationRun = repository.createManualRun(definition, "abort-automation-run", Date.now());
    repository.updateRun(automationRun.id, automationRun.revision, { state: "running", sessionId: "ses_abort", startedAt: Date.now() }, Date.now());
    const started = await fetch(`${runPath(harness.base, "ses_abort")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "command_start",
        prompt: { parts: [{ type: "text", text: "Run" }] },
      }),
    });
    const { run } = await started.json() as { run: { runId: string } };
    const hold = deferred<void>();
    engine.heldAborts.set("ses_abort", hold);
    const abortRequest = fetch(`${runPath(harness.base, "ses_abort")}/${run.runId}/abort`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ abortCommandCorrelationId: "command_abort" }),
    });
    await waitUntil(() => engine.aborts.length === 1);

    const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    await expect(active.json()).resolves.toMatchObject({
      items: [{
        runId: run.runId,
        status: "aborting",
        startCommandCorrelationId: "command_start",
        abortCommandCorrelationId: "command_abort",
      }],
    });
    const earlyIdle = await fetch(`${runPath(harness.base, "ses_abort")}/${run.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "idle" }),
    });
    await expect(earlyIdle.json()).resolves.toMatchObject({ cleared: false, run: { status: "aborting" } });
    expect(repository.getRun(automationRun.id)?.state).toBe("running");

    hold.resolve();
    expect((await abortRequest).status).toBe(202);
    expect(repository.getRun(automationRun.id)?.state).toBe("cancelled");
    const acceptedIdle = await fetch(`${runPath(harness.base, "ses_abort")}/${run.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "idle" }),
    });
    await expect(acceptedIdle.json()).resolves.toEqual({ cleared: true, run: null, terminalStatus: "aborted" });
  });

  test("aborted observations preserve accepted aborts while failed observations remain failures", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    for (const [status, requestAbort] of [
      ["aborted", true],
      ["failed", true],
      ["failed", false],
    ] as const) {
      const sessionId = `ses_error_${status}_${requestAbort}`;
      const started = await fetch(`${runPath(harness.base, sessionId)}/start`, {
        method: "POST", headers: harness.collaboratorHeaders,
        body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: sessionId,
          prompt: { parts: [{ type: "text", text: "Synthetic regression request" }] } }),
      });
      expect(started.status).toBe(202);
      const { run } = await started.json() as { run: { runId: string } };
      const observe = (status: string) => fetch(`${runPath(harness.base, sessionId)}/${run.runId}/observations`, {
        method: "POST", headers: harness.collaboratorHeaders, body: JSON.stringify({ status }),
      });
      await observe("running");
      if (requestAbort) {
        const aborted = await fetch(`${runPath(harness.base, sessionId)}/${run.runId}/abort`, {
          method: "POST", headers: harness.collaboratorHeaders,
          body: JSON.stringify({ abortCommandCorrelationId: `stop_${sessionId}` }),
        });
        expect(aborted.status).toBe(202);
      }
      const response = await observe(status);
      expect(response.status).toBe(200);
      const result = await response.json();
      const db = new Database(runtimeDbPath(harness.config), { readonly: true });
      let rows: { event: string; terminal_reason: string | null }[];
      try { rows = db.query<{ event: string; terminal_reason: string | null }, [string]>("SELECT event, terminal_reason FROM session_run_journal WHERE run_id = ? ORDER BY id").all(run.runId); }
      finally { db.close(); }
      expect(result).toEqual({ cleared: true, run: null, terminalStatus: status });
      expect(rows.filter(row => row.event === "run_terminal")).toEqual([{ event: "run_terminal", terminal_reason: status }]);
      if (requestAbort) expect(rows.map(row => row.event)).toEqual([
        "run_reserved", "run_started", "progress", "abort_requested", "abort_accepted", "run_terminal",
      ]);
    }
  });

  test("idle and stale observations are fenced, while exact terminals clear", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const start = async (command: string) => {
      const response = await fetch(`${runPath(harness.base, "ses_fence")}/start`, {
        method: "POST",
        headers: harness.collaboratorHeaders,
        body: JSON.stringify({
          origin: "local-renderer",
          startCommandCorrelationId: command,
          prompt: { parts: [{ type: "text", text: command }] },
        }),
      });
      return (await response.json() as { run: { runId: string } }).run;
    };
    const first = await start("cmd_first");
    const prematureIdle = await fetch(`${runPath(harness.base, "ses_fence")}/${first.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "idle" }),
    });
    await expect(prematureIdle.json()).resolves.toMatchObject({ cleared: false, run: { observedActive: false } });

    engine.messages.set("ses_fence", [{ info: { id: "msg_fence", role: "assistant", finish: "stop", time: { created: Date.now(), completed: Date.now() } }, parts: [] }]);
    const terminal = await fetch(`${runPath(harness.base, "ses_fence")}/${first.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "completed" }),
    });
    await expect(terminal.json()).resolves.toEqual({ cleared: true, run: null, terminalStatus: "completed" });
    const second = await start("cmd_second");

    const stale = await fetch(`${runPath(harness.base, "ses_fence")}/${first.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "failed" }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ code: "run_mismatch", details: { currentRunId: second.runId } });
    const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    await expect(active.json()).resolves.toMatchObject({ items: [{ runId: second.runId }] });
  });

  test("a new start remains fenced when an accepted run has no final assistant", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const firstResponse = await fetch(`${runPath(harness.base, "ses_self_heal")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_first",
        prompt: { parts: [{ type: "text", text: "First" }] },
      }),
    });
    expect(firstResponse.status).toBe(202);
    const first = (await firstResponse.json() as { run: { runId: string } }).run;

    const idle = await fetch(`${runPath(harness.base, "ses_self_heal")}/${first.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "idle" }),
    });
    await expect(idle.json()).resolves.toMatchObject({ cleared: false, run: { observedActive: false } });

    const secondResponse = await fetch(`${runPath(harness.base, "ses_self_heal")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_second",
        prompt: { parts: [{ type: "text", text: "Second" }] },
      }),
    });
    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toMatchObject({ code: "session_busy" });
    expect(engine.prompts.map((item) => item.sessionId)).toEqual(["ses_self_heal"]);
    expect(engine.statusRequests.length).toBeGreaterThanOrEqual(3);
  });

  test("active-run reads retain an accepted run without a final assistant", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const started = await fetch(`${runPath(harness.base, "ses_list_reconcile")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_list_reconcile",
        prompt: { parts: [{ type: "text", text: "Fast completion" }] },
      }),
    });
    expect(started.status).toBe(202);

    const first = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    await expect(first.json()).resolves.toMatchObject({ items: [{ sessionId: "ses_list_reconcile" }] });
    await new Promise((resolve) => setTimeout(resolve, 510));
    const second = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    await expect(second.json()).resolves.toMatchObject({ items: [{ sessionId: "ses_list_reconcile" }] });
  });

  test("restart fails a restored run when the replacement engine is authoritatively idle", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const sessionId = "ses_interrupted_restart";
    const started = await fetch(`${runPath(harness.base, sessionId)}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_interrupted_restart",
        prompt: { parts: [{ type: "text", text: "Interrupted by restart" }] },
      }),
    });
    expect(started.status).toBe(202);
    const { run } = await started.json() as { run: { runId: string } };
    expect(harness.server.hasActiveSessionRuns?.()).toBe(true);

    await harness.server.stop(true);
    stops.pop();
    const restarted = await startServer(harness.config);
    stops.push(() => restarted.stop());
    expect(restarted.hasActiveSessionRuns()).toBe(true);

    await waitUntil(() => !restarted.hasActiveSessionRuns(), 3_000);
    const db = new Database(runtimeDbPath(harness.config), { readonly: true });
    try {
      expect(db.query("SELECT terminal_reason FROM session_run_terminals WHERE run_id = ?").all(run.runId))
        .toEqual([{ terminal_reason: "failed" }]);
    } finally { db.close(); }
  }, 5_000);

  test("restart converges a restored starting admission when the engine is authoritatively idle", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    await harness.server.stop(true);
    stops.pop();

    const journal = await createSessionRunJournal({ config: harness.config });
    const coordinator = createSessionMutationCoordinator({
      allocateGeneration: journal.allocateGeneration,
      onLifecycleEvent: journal.record,
      randomUUID: () => "restored-starting-run",
    });
    const run = coordinator.reserveStart({
      workspaceId: "ws_1",
      sessionId: "ses_restored_starting",
      origin: "local-renderer",
      startCommandCorrelationId: "cmd_restored_starting",
    });
    journal.close();

    const restarted = await startServer(harness.config);
    stops.push(() => restarted.stop());
    expect(restarted.hasActiveSessionRuns()).toBe(true);
    await waitUntil(() => !restarted.hasActiveSessionRuns(), 3_500);

    const db = new Database(runtimeDbPath(harness.config), { readonly: true });
    try {
      expect(db.query("SELECT terminal_reason FROM session_run_terminals WHERE run_id = ?").all(run.runId))
        .toEqual([{ terminal_reason: "failed" }]);
      expect(db.query("SELECT event, terminal_reason FROM session_run_journal WHERE run_id = ? ORDER BY id").all(run.runId))
        .toEqual([
          { event: "run_reserved", terminal_reason: null },
          { event: "idle_suspected", terminal_reason: null },
          { event: "run_terminal", terminal_reason: "failed" },
        ]);
    } finally { db.close(); }
  }, 6_000);

  test("restart keeps a restored run active while terminal messages are unavailable", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const sessionId = "ses_restart_message_read_failure";
    const started = await fetch(`${runPath(harness.base, sessionId)}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_restart_message_read_failure",
        prompt: { parts: [{ type: "text", text: "Keep active until messages recover" }] },
      }),
    });
    expect(started.status).toBe(202);
    engine.failedMessageReads.add(sessionId);

    await harness.server.stop(true);
    stops.pop();
    const restarted = await startServer(harness.config);
    stops.push(() => restarted.stop());
    await waitUntil(() => engine.messageReads.includes(sessionId), 2_500);
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(restarted.hasActiveSessionRuns()).toBe(true);

    engine.failedMessageReads.delete(sessionId);
    await waitUntil(() => !restarted.hasActiveSessionRuns(), 3_500);
  }, 7_000);

  for (const terminal of ["failed", "aborted"] as const) for (const recovery of ["poll", "background", "retry", "idle-observation"] as const) test(`无主窗口上报时通过 ${recovery} 释放 ${terminal} 的本轮运行并保留终态`, async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const sessionId = `ses_error_${terminal}_${recovery}`;
    const start = (id: string) => fetch(`${runPath(harness.base, sessionId)}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: id,
        prompt: { parts: [{ type: "text", text: "Provider failure recovery" }] } }),
    });
    const response = await start("first_error_run");
    expect(response.status).toBe(202);
    const { run } = await response.json() as { run: { runId: string } };
    await waitUntil(() => engine.prompts.some((prompt) => prompt.sessionId === sessionId));
    engine.messages.set(sessionId, terminal === "failed"
      ? [{ info: { id: "msg_error", role: "assistant", time: { created: Date.now() }, error: { name: "APIError", data: { message: "Subscription unavailable" } } }, parts: [] }]
      : [{ info: { id: "msg_permission_rejected", role: "assistant", finish: "tool-calls", time: { created: Date.now(), completed: Date.now() } },
        parts: [{ type: "tool", state: { status: "error", error: "The user rejected permission to use this specific tool call.", time: { end: Date.now() } } }] }]);
    const poll = () => fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    engine.statuses.set(sessionId, { type: "busy" });
    expect((await (await poll()).json() as any).items).toHaveLength(1);
    engine.statuses.set(sessionId, { type: "idle" });
    if (recovery === "poll") {
      // Lifecycle v3 GETs are pure; only the runtime observer can settle this run.
      await waitUntil(async () => (await (await poll()).json() as any).items.length === 0, 2_500);
    } else if (recovery === "background") {
      const db = new Database(runtimeDbPath(harness.config), { readonly: true });
      try {
        // No GET/observation/retry is needed to trigger terminalization.
        await waitUntil(() => db.query("SELECT 1 FROM session_run_terminals WHERE run_id = ?").get(run.runId) !== null, 2_500);
      } finally { db.close(); }
    } else if (recovery === "retry") {
      expect((await start("second_error_run")).status).toBe(202);
    } else {
      const observed = await fetch(`${runPath(harness.base, sessionId)}/${run.runId}/observations`, {
        method: "POST", headers: harness.collaboratorHeaders, body: JSON.stringify({ status: "completed" }),
      });
      expect(await observed.json()).toMatchObject({ cleared: true, terminalStatus: terminal });
    }
    const db = new Database(runtimeDbPath(harness.config), { readonly: true });
    try {
      expect(db.query<{ terminal_reason: string }, [string]>("SELECT terminal_reason FROM session_run_journal WHERE run_id = ? AND event = 'run_terminal'").all(run.runId)).toEqual([{ terminal_reason: terminal }]);
      expect(db.query("SELECT status, revision FROM session_lifecycle_feed WHERE run_id = ? ORDER BY sequence").all(run.runId))
        .toEqual([{ status: "running", revision: 1 }, { status: terminal, revision: 2 }]);
    } finally { db.close(); }
  });

  for (const terminal of ["failed", "aborted"] as const) test(`后台 ${terminal} 恢复保留旧消息、最新工具步骤和活动子任务的运行`, async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const sessionId = `ses_background_guard_${terminal}`;
    const started = await fetch(`${runPath(harness.base, sessionId)}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: "guard_start",
        prompt: { parts: [{ type: "text", text: "Keep latest run" }] } }),
    });
    expect(started.status).toBe(202);
    const { run } = await started.json() as { run: { runId: string; startedAt: number } };
    const terminalMessage = (created: number) => terminal === "failed"
      ? { info: { id: "msg_error", role: "assistant", time: { created }, error: { name: "APIError" } }, parts: [] }
      : { info: { id: "msg_rejected", role: "assistant", finish: "tool-calls", time: { created, completed: created + 1 } },
        parts: [{ type: "tool", state: { status: "error", error: "The user rejected permission to use this specific tool call.", time: { end: created + 1 } } }] };
    const remainsActiveAfterBackgroundRead = async () => {
      const reads = engine.messageReads.length;
      await waitUntil(() => engine.messageReads.length > reads, 2_500);
      const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
      expect(await active.json()).toMatchObject({ items: [{ runId: run.runId }] });
    };
    engine.messages.set(sessionId, [terminalMessage(run.startedAt - 10)]);
    await remainsActiveAfterBackgroundRead();
    engine.messages.set(sessionId, [terminalMessage(run.startedAt), {
      info: { id: "msg_latest", role: "assistant", finish: "tool-calls", time: { created: run.startedAt + 1, completed: run.startedAt + 2 } }, parts: [],
    }]);
    await remainsActiveAfterBackgroundRead();
    // An idle root cannot settle while a delegated grandchild is active.
    engine.sessions.set("ses_child_guard", { id: "ses_child_guard", title: "Child", parentID: sessionId, time: { created: 1, updated: 1 } });
    engine.sessions.set("ses_grandchild_guard", { id: "ses_grandchild_guard", title: "Grandchild", parentID: "ses_child_guard", time: { created: 1, updated: 1 } });
    engine.statuses.set("ses_grandchild_guard", { type: "busy" });
    engine.messages.set(sessionId, [terminalMessage(run.startedAt)]);
    const reads = engine.statusRequests.length;
    await waitUntil(() => engine.statusRequests.length > reads, 2_500);
    expect(await (await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders })).json())
      .toMatchObject({ items: [{ runId: run.runId }] });
    engine.statuses.set("ses_grandchild_guard", { type: "idle" });
    await waitUntil(async () => (await (await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders })).json() as any).items.length === 0, 2_500);
    const db = new Database(runtimeDbPath(harness.config), { readonly: true });
    try {
      expect(db.query("SELECT terminal_reason FROM session_run_terminals WHERE run_id = ?").all(run.runId)).toEqual([{ terminal_reason: terminal }]);
    } finally { db.close(); }
  }, 7_000);

  test("后台不得在 prompt admission 完成前收尾 starting run", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const sessionId = "ses_background_starting";
    const held = deferred<void>();
    engine.heldPrompts.set(sessionId, held);
    const pending = fetch(`${runPath(harness.base, sessionId)}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: "starting",
        prompt: { parts: [{ type: "text", text: "Pending admission" }] } }),
    });
    try {
      await waitUntil(() => engine.prompts.length === 1);
      engine.messages.set(sessionId, [{ info: { id: "msg_error", role: "assistant", time: { created: Date.now() }, error: { name: "APIError" } }, parts: [] }]);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(await (await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders })).json())
        .toMatchObject({ items: [{ status: "starting" }] });
      const db = new Database(runtimeDbPath(harness.config), { readonly: true });
      try { expect(db.query("SELECT status FROM session_lifecycle_feed").all()).toEqual([]); }
      finally { db.close(); }
    } finally { held.resolve(); }
    expect((await pending).status).toBe(202);
  });

  test("后台旧 run 的迟到错误证据不能收尾替代 run 或打乱 activity 顺序", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const sessionId = "ses_background_replacement";
    const start = (id: string) => fetch(`${runPath(harness.base, sessionId)}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: id,
        prompt: { parts: [{ type: "text", text: id }] } }),
    });
    const first = await (await start("first")).json() as { run: { runId: string } };
    engine.messages.set(sessionId, [{ info: { id: "msg_old_error", role: "assistant", time: { created: Date.now() }, error: { name: "APIError" } }, parts: [] }]);
    const held = deferred<void>();
    engine.heldMessageReads.set(sessionId, held);
    try {
      await waitUntil(() => !engine.heldMessageReads.has(sessionId), 2_500);
      const cleared = await fetch(`${runPath(harness.base, sessionId)}/${first.run.runId}/observations`, {
        method: "POST", headers: harness.collaboratorHeaders, body: JSON.stringify({ status: "failed" }),
      });
      expect(await cleared.json()).toMatchObject({ cleared: true, terminalStatus: "failed" });
      const response = await start("replacement");
      expect(response.status).toBe(202);
      const second = await response.json() as { run: { runId: string } };
      const reads = engine.messageReads.length;
      held.resolve();
      await waitUntil(() => engine.messageReads.length > reads, 2_500);
      expect(await (await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders })).json())
        .toMatchObject({ items: [{ runId: second.run.runId }] });
      const db = new Database(runtimeDbPath(harness.config), { readonly: true });
      try {
        expect(db.query("SELECT run_id, status, revision FROM session_lifecycle_feed ORDER BY sequence").all()).toEqual([
          { run_id: first.run.runId, status: "running", revision: 1 },
          { run_id: first.run.runId, status: "failed", revision: 2 },
          { run_id: second.run.runId, status: "running", revision: 1 },
        ]);
      } finally { db.close(); }
    } finally { held.resolve(); }
  });

  test("startup idle and an old stop cannot complete a new run before its final assistant", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const sessionId = "ses_startup_race";
    engine.messages.set(sessionId, [{ info: {
      id: "msg_startup_old", role: "assistant", finish: "stop", time: { created: 1, completed: 2 },
    }, parts: [] }]);
    const started = await fetch(`${runPath(harness.base, sessionId)}/start`, {
      method: "POST", headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: "cmd_race",
        prompt: { parts: [{ type: "text", text: "Start work" }] } }),
    });
    expect(started.status).toBe(202);
    const { run } = await started.json() as { run: { runId: string } };
    const observe = (status: string) => fetch(`${runPath(harness.base, sessionId)}/${run.runId}/observations`, {
      method: "POST", headers: harness.collaboratorHeaders, body: JSON.stringify({ status }),
    });
    await observe("running");
    await expect((await observe("idle")).json()).resolves.toMatchObject({ cleared: false });
    await new Promise((resolve) => setTimeout(resolve, 510));
    await expect((await observe("completed")).json()).resolves.toMatchObject({ cleared: false });
    engine.messages.set(sessionId, [{ info: {
      id: "msg_startup_tool", role: "assistant", finish: "tool-calls", time: { created: Date.now(), completed: Date.now() },
    }, parts: [] }]);
    await expect((await observe("idle")).json()).resolves.toMatchObject({ cleared: false });
    engine.messages.set(sessionId, [{ info: {
      id: "msg_startup_final", role: "assistant", finish: "stop", time: { created: Date.now(), completed: Date.now() },
    }, parts: [] }]);
    await expect((await observe("idle")).json()).resolves.toMatchObject({ cleared: false });
    await new Promise((resolve) => setTimeout(resolve, 510));
    await expect((await observe("idle")).json()).resolves.toMatchObject({ cleared: true, terminalStatus: "completed" });
  });

  for (const terminalStatus of ["completed", "failed", "aborted"] as const) {
    test(`observe recovers journal ${terminalStatus} after clear with exact scope and authorization`, async () => {
      const engine = startMockOpencode();
      const harness = await startHarness(engine.server.port);
      const sessionId = `ses_journal_${terminalStatus}`;
      const started = await fetch(`${runPath(harness.base, sessionId)}/start`, {
        method: "POST", headers: harness.collaboratorHeaders,
        body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: "cmd_journal",
          prompt: { parts: [{ type: "text", text: "Journal recovery" }] } }),
      });
      expect(started.status).toBe(202);
      const { run } = await started.json() as { run: { runId: string } };
      const observe = (status: string, workspaceId = "ws_1", session = sessionId, runId = run.runId,
        headers: Record<string, string> = harness.collaboratorHeaders) => fetch(
        `${harness.base}/workspace/${workspaceId}/sessions/${session}/runs/${runId}/observations`, {
          method: "POST", headers, body: JSON.stringify({ status }),
        });

      if (terminalStatus === "completed") {
        engine.messages.set(sessionId, [{ info: { id: "msg_journal_final", role: "assistant", finish: "stop",
          time: { created: Date.now(), completed: Date.now() } }, parts: [] }]);
      } else if (terminalStatus === "aborted") {
        const aborted = await fetch(`${runPath(harness.base, sessionId)}/${run.runId}/abort`, {
          method: "POST", headers: harness.collaboratorHeaders,
          body: JSON.stringify({ abortCommandCorrelationId: "cmd_journal_abort" }),
        });
        expect(aborted.status).toBe(202);
      }
      const cleared = await observe(terminalStatus === "aborted" ? "idle" : terminalStatus);
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toEqual({ cleared: true, run: null, terminalStatus });
      const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
      expect(await active.json()).toEqual({ items: [] });

      // Subsequent observers have no in-memory run; persisted authority wins even over completed/idle.
      const terminalUrl = `${harness.base}/workspace/ws_1/session-run-terminals`;
      const pageResponse = await fetch(`${terminalUrl}?limit=1`, { headers: harness.collaboratorHeaders });
      expect(pageResponse.status).toBe(200);
      const page = await pageResponse.json();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ workspaceId: "ws_1", sessionId, runId: run.runId, terminalReason: terminalStatus });
      expect(page.items[0].generation).toBeGreaterThan(0);
      expect(page.items[0].occurredAt).toBeGreaterThan(0);
      expect(Object.keys(page.items[0]).sort()).toEqual(["id", "workspaceId", "sessionId", "runId", "generation", "terminalReason", "occurredAt"].sort());
      expect(await (await fetch(`${terminalUrl}?after=${page.cursor}`, { headers: harness.collaboratorHeaders })).json())
        .toEqual({ items: [], cursor: page.cursor });
      expect(await (await fetch(`${harness.base}/workspace/ws_2/session-run-terminals`, { headers: harness.collaboratorHeaders })).json())
        .toEqual({ items: [], cursor: 0 });
      for (const query of ["after=-1", "after=abc", "limit=0", "limit=101"]) {
        expect((await fetch(`${terminalUrl}?${query}`, { headers: harness.collaboratorHeaders })).status).toBe(400);
      }
      for (const status of ["idle", "completed"]) {
        const recovered = await observe(status);
        expect(recovered.status).toBe(200);
        expect(await recovered.json()).toEqual({ cleared: true, run: null, terminalStatus });
      }
      for (const [workspaceId, session, runId] of [
        ["ws_2", sessionId, run.runId],
        ["ws_1", "ses_wrong", run.runId],
        ["ws_1", sessionId, "run_wrong"],
      ]) {
        const mismatch = await observe("idle", workspaceId, session, runId);
        expect(mismatch.status).toBe(409);
        const body = await mismatch.json();
        expect(body.code).toBe("run_mismatch");
        expect(body.terminalStatus).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain(run.runId);
      }
      const issued = await fetch(`${harness.base}/tokens`, {
        method: "POST", headers: harness.hostHeaders,
        body: JSON.stringify({ scope: "viewer", label: "journal viewer" }),
      });
      expect(issued.status).toBe(201);
      const viewer = await issued.json() as { token: string };
      for (const [headers, expectedStatus] of [
        [{ Authorization: `Bearer ${viewer.token}`, "Content-Type": "application/json" }, 403],
        [{ "Content-Type": "application/json" }, 401],
      ] as const) {
        const denied = await observe("idle", "ws_1", sessionId, run.runId, headers);
        expect((await fetch(terminalUrl, { headers })).status).toBe(expectedStatus);
        expect(denied.status).toBe(expectedStatus);
        const body = await denied.json();
        expect(body.terminalStatus).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain(run.runId);
      }
    });
  }

  test("active-run reads retain an idle parent while a delegated descendant is busy", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.sessions.set("ses_child", {
      id: "ses_child",
      title: "Delegated review",
      parentID: "ses_parent",
      directory: harness.root,
      time: { created: Date.now(), updated: Date.now() },
    });
    engine.sessions.set("ses_grandchild", {
      id: "ses_grandchild",
      title: "Nested review",
      parentID: "ses_child",
      directory: harness.root,
      time: { created: Date.now(), updated: Date.now() },
    });
    const started = await fetch(`${runPath(harness.base, "ses_parent")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_delegated",
        prompt: { parts: [{ type: "text", text: "Delegate work" }] },
      }),
    });
    expect(started.status).toBe(202);
    const run = (await started.json() as { run: { runId: string } }).run;
    await fetch(`${runPath(harness.base, "ses_parent")}/${run.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "running" }),
    });

    engine.statuses.set("ses_parent", { type: "idle" });
    engine.statuses.set("ses_grandchild", { type: "busy" });
    const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    await expect(active.json()).resolves.toMatchObject({ items: [{ sessionId: "ses_parent" }] });

    engine.statuses.set("ses_grandchild", { type: "idle" });
    engine.messages.set("ses_parent", [{ info: { id: "msg_parent", role: "assistant", finish: "stop", time: { created: Date.now(), completed: Date.now() } }, parts: [] }]);
    // Active-run reads are pure in lifecycle v3. The runtime-owned observer,
    // not this GET, confirms terminal state using two separated samples.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const terminal = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    await expect(terminal.json()).resolves.toEqual({ items: [] });
  });

  test("engine reload in another workspace is blocked until the authoritative active run clears", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const started = await fetch(`${runPath(harness.base, "ses_reload_gate")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_reload_gate",
        prompt: { parts: [{ type: "text", text: "Run" }] },
      }),
    });
    const { run } = await started.json() as { run: { runId: string } };

    const blocked = await fetch(`${harness.base}/workspace/ws_2/engine/reload`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
    });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ code: "engine_reload_blocked_active_runs" });
    expect(engine.disposes).toEqual([]);

    engine.messages.set("ses_reload_gate", [{ info: { id: "msg_reload", role: "assistant", finish: "stop", time: { created: Date.now(), completed: Date.now() } }, parts: [] }]);
    const terminal = await fetch(`${runPath(harness.base, "ses_reload_gate")}/${run.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "completed" }),
    });
    expect(terminal.status).toBe(200);

    const reloaded = await fetch(`${harness.base}/workspace/ws_2/engine/reload`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
    });
    expect(reloaded.status).toBe(200);
  });

  test("workspace navigation preserves an authoritative active run without aborting or disposing", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const started = await fetch(`${runPath(harness.base, "ses_navigation")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_navigation",
        prompt: { parts: [{ type: "text", text: "Keep running" }] },
      }),
    });
    expect(started.status).toBe(202);
    const { run } = await started.json() as { run: { runId: string } };

    for (const workspaceId of ["ws_2", "ws_1"]) {
      const activated = await fetch(`${harness.base}/workspaces/${workspaceId}/activate`, {
        method: "POST",
        headers: harness.hostHeaders,
      });
      expect(activated.status).toBe(200);
    }

    expect(engine.disposes).toEqual([]);
    expect(engine.aborts).toEqual([]);
    const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, {
      headers: harness.collaboratorHeaders,
    });
    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toMatchObject({
      items: [{ runId: run.runId, sessionId: "ses_navigation" }],
    });
  });

  test("internal workspace repair defers reload and preserves an authoritative active run", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const started = await fetch(`${runPath(harness.base, "ses_repair")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_repair",
        prompt: { parts: [{ type: "text", text: "Keep running during repair" }] },
      }),
    });
    expect(started.status).toBe(202);
    const { run } = await started.json() as { run: { runId: string } };

    const commandsDir = join(harness.root, ".opencode", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "legacy.md"),
      "---\nname: legacy\nmodel:\n---\nRun the legacy command.\n",
      "utf8",
    );
    const config = await fetch(`${harness.base}/workspace/ws_1/config`, {
      headers: harness.collaboratorHeaders,
    });
    expect(config.status).toBe(200);

    expect(engine.disposes).toEqual([]);
    expect(engine.aborts).toEqual([]);
    const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, {
      headers: harness.collaboratorHeaders,
    });
    await expect(active.json()).resolves.toMatchObject({
      items: [{ runId: run.runId, sessionId: "ses_repair" }],
    });
    const events = await fetch(`${harness.base}/workspace/ws_1/events`, {
      headers: harness.collaboratorHeaders,
    });
    await expect(events.json()).resolves.toMatchObject({
      items: [{ reason: "commands" }],
    });
  });

  test("semantic mutation and active-state APIs require collaborator scope", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const issued = await fetch(`${harness.base}/tokens`, {
      method: "POST",
      headers: harness.hostHeaders,
      body: JSON.stringify({ scope: "viewer", label: "test viewer" }),
    });
    const viewer = await issued.json() as { token: string };
    const response = await fetch(`${harness.base}/workspace/ws_1/session-runs`, {
      headers: { Authorization: `Bearer ${viewer.token}` },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "forbidden" });
    const start = await fetch(`${runPath(harness.base, "ses_forbidden")}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${viewer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(start.status).toBe(403);
    expect(engine.prompts).toHaveLength(0);
  });
});
