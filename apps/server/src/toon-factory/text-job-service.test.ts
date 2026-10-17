import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOON_TEXT_OUTPUT_SCHEMAS,
  type ToonCanvas,
  type ToonProjectResponse,
  type ToonTextJob,
  type ToonTextJobCreateRequest,
} from "@jugglework/types/toon-factory";
import { openRuntimeSqliteDatabase } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { automationSqliteAdapter } from "../automation/sqlite.js";
import { ToonFactoryRepository } from "./repository.js";
import { ToonModelPolicyStore } from "./model-policy-store.js";
import { ToonTextJobRepository } from "./text-job-repository.js";
import { ToonTextJobService } from "./text-job-service.js";
import { ToonWorkspaceRuntimeStore } from "./workspace-runtime-store.js";
import {
  clearWorkspaceSessionRegistry,
  isRegisteredToonFactoryTransientSession,
} from "./transient-session-registry.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

type FakeOptions = {
  structured?: unknown;
  assistantError?: unknown;
  promptError?: unknown;
  sessions?: Array<Record<string, any>>;
  stayBusy?: boolean;
  modelPolicy?: ToonModelPolicyStore;
};

async function fixture(options: FakeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "toon-text-job-"));
  roots.push(root);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "client", hostToken: "host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
    workspaces: [{ id: "ws-1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false,
  };
  const projectRepository = new ToonFactoryRepository(root);
  const created = await projectRepository.createProject({ name: "Demo", directory: "toons/demo" });
  const project = await addEpisodeAndSelection(projectRepository, created);
  const database = automationSqliteAdapter(await openRuntimeSqliteDatabase(join(root, "runtime.sqlite")));
  const jobs = ToonTextJobRepository.fromDatabase(database);
  const deleted: string[] = [];
  const aborted: string[] = [];
  const createdInputs: Array<Record<string, unknown>> = [];
  const promptInputs: Array<Record<string, unknown>> = [];
  let statusReads = 0;
  const opencode = {
    session: {
      create: async (input: Record<string, unknown>) => { createdInputs.push(input); return { data: { id: "transient-1" }, error: undefined }; },
      promptAsync: async (input: Record<string, unknown>) => { promptInputs.push(input); return options.promptError ? { error: options.promptError } : { data: undefined, error: undefined }; },
      status: async () => ({ data: options.stayBusy && aborted.length === 0 ? { "transient-1": { type: "busy" } } : { "transient-1": statusReads++ === 0 ? { type: "busy" } : { type: "idle" } } }),
      messages: async () => ({ data: [{ info: {
        id: "assistant-1", sessionID: "transient-1", role: "assistant", parentID: "toon-text-job-placeholder",
        providerID: "provider", modelID: "model", mode: "assistant", agent: "jugglework",
        path: { cwd: root, root }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now(), completed: Date.now() },
        ...(options.assistantError ? { error: options.assistantError } : {}),
        ...(options.structured === undefined ? {} : { structured: options.structured }),
      }, parts: [] }] }),
      delete: async ({ sessionID }: { sessionID: string }) => { deleted.push(sessionID); return { data: true, error: undefined }; },
      abort: async ({ sessionID }: { sessionID: string }) => { aborted.push(sessionID); return { data: true, error: undefined }; },
      list: async () => ({ data: options.sessions ?? [], error: undefined }),
      get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID }, error: undefined }),
    },
    event: { subscribe: async () => { throw new Error("poll"); } },
    provider: { list: async () => ({ data: { connected: ["provider"], all: [{ id: "provider", source: "custom", models: { model: { id: "model", name: "Model" } } }] } }) },
  };
  const service = new ToonTextJobService({
    config, jobs,
    resolveWorkspace: async () => config.workspaces[0]!,
    createWorkspaceOpencodeClient: () => opencode as never,
    wait: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); },
    modelPolicy: options.modelPolicy,
  });
  opencode.session.messages = async () => ({ data: [{ info: {
    id: "assistant-1", sessionID: "transient-1", role: "assistant", parentID: `toon-${jobs.listAll()[0]?.id ?? "missing"}`,
    providerID: "provider", modelID: "model", mode: "assistant", agent: "jugglework",
    path: { cwd: root, root }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), completed: Date.now() },
    ...(options.assistantError ? { error: options.assistantError } : {}),
    ...(options.structured === undefined ? {} : { structured: options.structured }),
  }, parts: [] }] });
  return { root, config, jobs, service, projectRepository, project, deleted, aborted, createdInputs, promptInputs };
}

describe("Toon Factory text jobs", () => {
  test("remains queryable after reopening the runtime SQLite repository", async () => {
    const fx = await fixture();
    const job = fx.jobs.create("ws-1", fx.project.project.id, request());
    fx.jobs.close();
    const reopened = ToonTextJobRepository.fromDatabase(
      automationSqliteAdapter(await openRuntimeSqliteDatabase(join(fx.root, "runtime.sqlite"))),
    );
    try {
      expect(reopened.require(job.id).requestSnapshot.prompt).toBe("Write a pilot");
      expect(reopened.require(job.id).status).toBe("queued");
    } finally { reopened.close(); }
  });

  test("persists a successful structured result, leaves it awaiting review, and deletes the transient session", async () => {
    const output = { title: "Pilot", logline: "A hero wakes.", scenes: [{ id: "scene-1", heading: "INT. ROOM", summary: "Morning.", dialogue: [{ speaker: "Hero", line: "Hello." }] }] };
    const fx = await fixture({ structured: output });
    try {
      const job = fx.jobs.create("ws-1", fx.project.project.id, request());
      await fx.projectRepository.queueTextJob(job);
      fx.service.dispatch(job.id);
      await waitFor(() => ["completed", "failed", "cancelled"].includes(fx.jobs.require(job.id).status));

      const completed = fx.jobs.require(job.id);
      expect(completed.status, JSON.stringify(completed.error)).toBe("completed");
      expect(completed.result?.output).toEqual(output);
      expect(completed.transientSessionId).toBeUndefined();
      expect(fx.deleted).toEqual(["transient-1"]);
      expect(fx.createdInputs[0]).toMatchObject({
        model: { id: "model", providerID: "provider" },
        metadata: { kind: "toon-factory", transient: true, jobId: job.id },
      });
      expect(fx.promptInputs[0]).toMatchObject({
        model: { providerID: "provider", modelID: "model" },
        format: { type: "json_schema", schema: TOON_TEXT_OUTPUT_SCHEMAS.script },
      });
      const reopened = await fx.projectRepository.getProject(fx.project.project.id);
      const step = reopened.project.episodes[0]!.steps!.find((candidate) => candidate.id === "episode-script")!;
      expect(step.status).toBe("awaiting-review");
      expect(step.contentApprovals).toEqual([]);
      expect(step.generatedResults).toHaveLength(1);
      expect(await readFile(join(fx.root, "toons/demo", completed.result!.contentRef), "utf8")).toContain("# Pilot");
    } finally { fx.jobs.close(); }
  });

  test("records a sanitized model failure and still deletes the transient session", async () => {
    const fx = await fixture({ assistantError: { data: { message: "token=private provider failed" } } });
    try {
      const job = fx.jobs.create("ws-1", fx.project.project.id, request());
      await fx.projectRepository.queueTextJob(job);
      fx.service.dispatch(job.id);
      await waitFor(() => fx.jobs.require(job.id).status === "failed");
      expect(fx.jobs.require(job.id).error?.message).toContain("token=[redacted]");
      expect(fx.jobs.require(job.id).error?.message).not.toContain("private");
      expect(fx.deleted).toEqual(["transient-1"]);
    } finally { fx.jobs.close(); }
  });

  test.each([
    ["malformed", { title: "Missing scenes" }, "toon_text_result_malformed"],
    ["partial", undefined, "toon_text_partial_result"],
    ["empty partial", { title: "Pilot", logline: "Empty", scenes: [] }, "toon_text_result_malformed"],
  ])("does not succeed for %s structured output", async (_label, structured, code) => {
    const fx = await fixture({ structured });
    try {
      const job = fx.jobs.create("ws-1", fx.project.project.id, request());
      await fx.projectRepository.queueTextJob(job);
      fx.service.dispatch(job.id);
      await waitFor(() => fx.jobs.require(job.id).status === "failed");
      expect(fx.jobs.require(job.id).error?.code).toBe(code);
      expect(fx.jobs.require(job.id).result).toBeUndefined();
      expect(fx.deleted).toEqual(["transient-1"]);
    } finally { fx.jobs.close(); }
  });

  test("cancels through OpenCode and cleans up the transient session", async () => {
    const fx = await fixture({ stayBusy: true });
    try {
      const job = fx.jobs.create("ws-1", fx.project.project.id, request());
      await fx.projectRepository.queueTextJob(job);
      fx.service.dispatch(job.id);
      await waitFor(() => fx.jobs.require(job.id).status === "running");
      await fx.service.cancel(job.id);
      await waitFor(() => fx.jobs.require(job.id).status === "cancelled");
      expect(fx.aborted).toContain("transient-1");
      expect(fx.deleted).toEqual(["transient-1"]);
    } finally { fx.jobs.close(); }
  });

  test("bounded stale cleanup removes only old Toon Factory transient sessions", async () => {
    const old = Date.now() - 24 * 60 * 60 * 1_000;
    const fx = await fixture({ sessions: [
      { id: "old-toon", title: "[Transient Toon Factory] old", metadata: { kind: "toon-factory", transient: true, jobId: "missing" }, time: { created: old } },
      { id: "normal", title: "Normal", metadata: {}, time: { created: old } },
    ] });
    try {
      expect(await fx.service.cleanupStaleSessions()).toBe(1);
      expect(fx.deleted).toEqual(["old-toon"]);
    } finally { fx.jobs.close(); }
  });

  test("recovers accepted prompt output before the dispatched marker without resending", async () => {
    const output = { title: "Recovered", logline: "Already generated.", scenes: [{ id: "scene-1", heading: "INT.", summary: "Done.", dialogue: [] }] };
    const fx = await fixture({ structured: output });
    try {
      const job = fx.jobs.create("ws-1", fx.project.project.id, request());
      await fx.projectRepository.queueTextJob(job);
      fx.jobs.start(job.id, "transient-1");
      fx.service.dispatch(job.id);
      await waitFor(() => fx.jobs.require(job.id).status === "completed");
      expect(fx.promptInputs).toEqual([]);
      expect(fx.jobs.require(job.id).result?.output).toEqual(output);
    } finally { await fx.service.dispose(); fx.jobs.close(); }
  });

  test("registers persisted active transient sessions before restart cleanup or dispatch", async () => {
    const fx = await fixture();
    clearWorkspaceSessionRegistry("ws-1");
    try {
      const created = fx.jobs.create("ws-1", fx.project.project.id, request());
      await fx.projectRepository.queueTextJob(created);
      fx.jobs.start(created.id, "persisted-transient");
      fx.service.start();
      expect(isRegisteredToonFactoryTransientSession("ws-1", "persisted-transient")).toBe(true);
    } finally {
      await fx.service.dispose();
      fx.jobs.close();
      clearWorkspaceSessionRegistry("ws-1");
    }
  });

  test("dispose aborts and bounds an in-flight startup cleanup", async () => {
    const fx = await fixture();
    let markListed: (() => void) | undefined;
    const listed = new Promise<void>((resolve) => { markListed = resolve; });
    const service = new ToonTextJobService({
      config: fx.config,
      jobs: fx.jobs,
      resolveWorkspace: async () => fx.config.workspaces[0]!,
      createWorkspaceOpencodeClient: () => ({
        session: {
          list: async (_input: unknown, request?: { signal?: AbortSignal }) => {
            markListed?.();
            await new Promise<void>((_resolve, reject) => {
              request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
            });
            return { data: [] };
          },
        },
      }) as never,
      maintenanceTimeoutMs: 30_000,
      shutdownDrainMs: 25,
    });
    try {
      void service.start();
      await listed;
      const stoppedAt = Date.now();
      await service.dispose();
      expect(Date.now() - stoppedAt).toBeLessThan(500);
    } finally {
      fx.jobs.close();
    }
  });

  test("keeps a queued job nonterminal without policy and continues automatically after renderer sync", async () => {
    const policy = new ToonModelPolicyStore();
    const output = { title: "Synced", logline: "Policy arrived.", scenes: [{ id: "scene-1", heading: "INT.", summary: "Continue.", dialogue: [] }] };
    const fx = await fixture({ structured: output, modelPolicy: policy });
    try {
      const job = fx.jobs.create("ws-1", fx.project.project.id, request());
      await fx.projectRepository.queueTextJob(job);
      fx.service.start();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(fx.jobs.require(job.id).status).toBe("queued");
      expect(fx.createdInputs).toHaveLength(0);
      expect(fx.promptInputs).toHaveLength(0);

      policy.update(policySnapshot(1));
      await waitFor(() => fx.jobs.require(job.id).status === "completed");
      expect(fx.promptInputs).toHaveLength(1);
    } finally { await fx.service.dispose(); fx.jobs.close(); }
  });

  test("restart loads persisted policy before recovering queued text work", async () => {
    const sqlite = new Database(":memory:");
    const runtime = ToonWorkspaceRuntimeStore.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
    new ToonModelPolicyStore(runtime).update(policySnapshot(3));
    const restartedPolicy = new ToonModelPolicyStore(runtime);
    const output = { title: "Restarted", logline: "Loaded first.", scenes: [{ id: "scene-1", heading: "EXT.", summary: "Continue.", dialogue: [] }] };
    const fx = await fixture({ structured: output, modelPolicy: restartedPolicy });
    try {
      const job = fx.jobs.create("ws-1", fx.project.project.id, request());
      await fx.projectRepository.queueTextJob(job);
      fx.service.start();
      await waitFor(() => fx.jobs.require(job.id).status === "completed");
      expect(fx.promptInputs).toHaveLength(1);
    } finally { await fx.service.dispose(); fx.jobs.close(); runtime.close(); }
  });

  test("a running text session reconciles while policy is pending", async () => {
    const output = { title: "Recovered", logline: "No new dispatch.", scenes: [{ id: "scene-1", heading: "INT.", summary: "Done.", dialogue: [] }] };
    const fx = await fixture({ structured: output, modelPolicy: new ToonModelPolicyStore() });
    try {
      const job = fx.jobs.create("ws-1", fx.project.project.id, request());
      await fx.projectRepository.queueTextJob(job);
      fx.jobs.start(job.id, "transient-1");
      fx.jobs.markDispatched(job.id);
      fx.service.dispatch(job.id);
      await waitFor(() => ["completed", "failed"].includes(fx.jobs.require(job.id).status));
      expect(fx.jobs.require(job.id).status, JSON.stringify(fx.jobs.require(job.id).error)).toBe("completed");
      expect(fx.promptInputs).toHaveLength(0);
    } finally { await fx.service.dispose(); fx.jobs.close(); }
  });

  test("recovers a committed project result before the job completion write without resending", async () => {
    const output = { title: "Committed", logline: "Persisted first.", scenes: [{ id: "scene-1", heading: "EXT.", summary: "Done.", dialogue: [] }] };
    const fx = await fixture({ structured: undefined });
    try {
      const created = fx.jobs.create("ws-1", fx.project.project.id, request());
      await fx.projectRepository.queueTextJob(created);
      const running = fx.jobs.start(created.id, "transient-1");
      fx.jobs.markDispatched(created.id);
      await fx.projectRepository.commitTextJobResult(running, output);
      fx.service.dispatch(created.id);
      await waitFor(() => fx.jobs.require(created.id).status === "completed");
      expect(fx.promptInputs).toEqual([]);
      expect(fx.jobs.require(created.id).result?.output).toEqual(output);
      const project = await fx.projectRepository.getProject(fx.project.project.id);
      expect(project.project.episodes[0]!.steps![0]!.generatedResults).toHaveLength(1);
    } finally { await fx.service.dispose(); fx.jobs.close(); }
  });

  test("automatically retries a one-shot terminal projection failure without restart", async () => {
    const fx = await fixture();
    let attempts = 0;
    const service = new ToonTextJobService({
      config: fx.config,
      jobs: fx.jobs,
      resolveWorkspace: async () => fx.config.workspaces[0]!,
      createWorkspaceOpencodeClient: () => ({ session: { list: async () => ({ data: [] }) } }) as never,
      projectionRepository: () => ({
        reconcileTextJob: async (job: ToonTextJob) => {
          attempts += 1;
          if (attempts === 1) throw new Error("one-shot revision failure");
          return fx.projectRepository.reconcileTextJob(job);
        },
      }) as never,
    });
    try {
      const job = fx.jobs.create("ws-1", fx.project.project.id, request());
      await fx.projectRepository.queueTextJob(job);
      fx.jobs.fail(job.id, { code: "test_failure", message: "terminal" });
      fx.jobs.markProjectionClean(job.id);
      fx.jobs.markProjectionFailed(job.id, Date.now() - 1_000);
      service.start();
      for (let attempt = 0; attempt < 300 && (attempts < 2 || fx.jobs.require(job.id).projectionPending === true); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(fx.jobs.require(job.id).projectionPending).not.toBe(true);
    } finally {
      await service.dispose();
      fx.jobs.close();
    }
  });
});

function request(): ToonTextJobCreateRequest {
  return {
    action: "script", prompt: "Write a pilot", episodeId: "episode-1", canvasId: "canvas-1",
    nodeId: "script-node", stage: "content-script",
    selectedModel: { kind: "text", providerID: "provider", modelID: "model" },
    outputSchema: TOON_TEXT_OUTPUT_SCHEMAS.script, contentApproved: true,
  };
}

function policySnapshot(revision: number) {
  const content = { workspaceId: "ws-1", signedIn: true, policyFresh: true, organizationId: "org-1", userId: "user-1", allowedModels: ["provider/model"], validatedAt: new Date().toISOString() };
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}` : JSON.stringify(value);
  return { ...content, revision, digest: createHash("sha256").update(canonical(content)).digest("hex") };
}

async function addEpisodeAndSelection(repository: ToonFactoryRepository, created: ToonProjectResponse): Promise<ToonProjectResponse> {
  const now = new Date().toISOString();
  const canvas: ToonCanvas = {
    schemaVersion: 1, id: "canvas-1", name: "Episode", edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{ id: "script-node", kind: "text", position: { x: 0, y: 0 }, handles: [], data: { contentRef: "content/nodes/script-node.md" } }],
  };
  await repository.writeCanvas(created.project.id, canvas.id, { canvas });
  return repository.updateProject(created.project.id, {
    expectedRevision: created.revision,
    project: {
      ...created.project,
      selectedModels: { text: { kind: "text", providerID: "provider", modelID: "model" } },
      episodes: [{
        id: "episode-1", title: "Episode 1", ordinal: 1, canvasId: canvas.id,
        stages: [{ stage: "content-script", status: "pending-confirmation", updatedAt: now }],
        steps: [{ id: "episode-script", stage: "content-script", title: "Script", status: "pending-confirmation", dependencies: [], contentApprovals: [], computeAuthorizations: [], resultAdoptions: [], history: [], updatedAt: now }],
        createdAt: now, updatedAt: now,
      }],
      updatedAt: now,
    },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Toon Factory text job");
}
