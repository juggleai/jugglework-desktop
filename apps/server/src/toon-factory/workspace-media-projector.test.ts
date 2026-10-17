import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationSqliteAdapter } from "../automation/sqlite.js";
import { createToonMediaAuthorization, toonMediaRequestHash, ToonMediaJobRepository } from "./media-job-repository.js";
import { ToonMediaJobService } from "./media-job-service.js";
import { ToonWorkspaceCoordinator } from "./workspace-coordinator.js";
import { ToonWorkspaceMediaProjector } from "./workspace-media-projector.js";
import { ToonWorkspaceRuntimeStore } from "./workspace-runtime-store.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function fixture(imageAction: () => Promise<unknown>) {
  const root = await mkdtemp(join(tmpdir(), "toon-v2-media-")); roots.push(root);
  const sqlite = new Database(":memory:");
  const adapter = automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() });
  const runtime = ToonWorkspaceRuntimeStore.fromDatabase(adapter);
  const jobs = ToonMediaJobRepository.fromDatabase(adapter);
  const coordinator = new ToonWorkspaceCoordinator("ws-1", root, runtime);
  await coordinator.initialize({ operationId: "init-media", episodeId: "episode", actor: { kind: "human" }, origin: "human-ui", name: "Media", directory: "project" });
  const canvas = await coordinator.query("toon-init-media", { kind: "canvas.read", canvasId: "main" }) as any;
  await coordinator.execute("toon-init-media", { operationId: "media-node", actor: { kind: "human" }, origin: "human-ui", expectedRevisions: { "canvases/main.json": canvas.revision }, kind: "canvas.write", canvasId: "main", body: { ...canvas.canvas, nodes: [{ id: "image-node", kind: "image-generation", position: { x: 0, y: 0 }, handles: [], config: {} }] } });
  for (const stepId of ["source-material", "episode-script", "asset-plan", "direction", "storyboard"]) {
    const project = await coordinator.query("toon-init-media", { kind: "project.read" }) as any;
    await coordinator.executeHumanInteraction("toon-init-media", { operationId: `media-skip-${stepId}`, actor: { kind: "human", id: "member" }, origin: "human-ui", expectedRevisions: { "toon-project.json": project.revision }, kind: "workflow.skip", episodeId: "episode", workflowRecordId: stepId, reason: "Media projection fixture prerequisite" }, "member");
  }
  const projector = new ToonWorkspaceMediaProjector({ runtime, coordinator: async () => coordinator });
  const service = new ToonMediaJobService({ jobs, repository: async () => ({}) as never, imageAction: async () => imageAction(), mediaGeneration: { status: async () => ({}), listModels: async () => ({ models: [] }), generate: async () => ({}), getJob: async () => ({}), cancelJob: async () => ({}) }, workspaceProjector: projector });
  return { root, sqlite, runtime, jobs, coordinator, projector, service };
}

function request(projectId: string, requestId = "stable-request") {
  const plan = { kind: "image" as const, model: { kind: "image" as const, providerID: "provider", modelID: "image" }, object: "frame", quantity: 1, prompt: "Draw", referencePaths: [], referenceScope: "project" as const, mode: "text-to-image" as const, size: "1024x1024", executionCount: 1, knownCost: null };
  const snapshot = { requestId, projectId, episodeId: "episode", canvasId: "main", nodeId: "image-node", stepId: "image-candidates", plan };
  return { ...snapshot, authorization: createToonMediaAuthorization(toonMediaRequestHash(snapshot), 1) };
}

async function prepare(fx: Awaited<ReturnType<typeof fixture>>, generationId = "generation-1", requestId = "stable-request") {
  const input = request("toon-init-media", requestId);
  const links = await fx.coordinator.observeGenerationDependencies("toon-init-media", input.episodeId, input.stepId, [{ kind: "canvas", id: "main" }, { kind: "node", id: "image-node" }]);
  await fx.coordinator.execute("toon-init-media", { operationId: `prepare-${generationId}`, actor: { kind: "assistant", id: "tool" }, origin: "assistant-tool", expectedRevisions: {}, kind: "generation.prepare", generation: { id: generationId, requestId: input.requestId, episodeId: input.episodeId, workflowRecordId: input.stepId, canvasId: input.canvasId, nodeId: input.nodeId, source: "assistant", plan: { kind: "image", model: input.plan.model, object: input.plan.object, quantity: 1, prompt: input.plan.prompt, references: [], parameters: { mode: input.plan.mode, size: input.plan.size }, executionCount: 1, knownCost: null }, requestHash: input.authorization.scopeHash }, dependencyLinks: links });
  await fx.coordinator.executeHumanInteraction("toon-init-media", { operationId: `authorize-${generationId}`, actor: { kind: "human", id: "member" }, origin: "human-ui", expectedRevisions: {}, kind: "workflow.authorize", episodeId: input.episodeId, workflowRecordId: input.stepId, generationId, authorization: input.authorization }, "member");
  const created = fx.jobs.createOrGet("ws-1", "toon-init-media", input);
  await fx.projector.link(created.job, generationId);
  return created.job;
}

async function waitFor(predicate: () => boolean) { for (let i = 0; i < 100; i += 1) { if (predicate()) return; await Bun.sleep(2); } throw new Error("condition not reached"); }

describe("v2 durable media projection", () => {
  test("one provider submission is shared by canvas, assistant, workflow, and asset views, then human adoption preserves history", async () => {
    let calls = 0;
    const fx = await fixture(async () => { calls += 1; return { ok: true, result: { artifact: { path: "artifacts/shared.png", mimeType: "image/png", bytes: 8 } } }; });
    await mkdir(join(fx.root, "artifacts"), { recursive: true });
    await writeFile(join(fx.root, "artifacts/shared.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fx.runtime.createConversation({ workspaceScope: "ws-1", projectId: "toon-init-media", conversationId: "conversation", sessionId: "session", title: "Assistant", model: { kind: "text", providerID: "provider", modelID: "text" } });
    fx.runtime.saveToolCall("ws-1", "toon-init-media", { id: "generation-tool", conversationId: "conversation", operationId: "stable-request", state: "awaiting-human-authorization", result: { turnId: "turn", requestId: "stable-request" } });
    const job = await prepare(fx);
    await expect(fx.projector.assertPrerequisites(job)).resolves.toBeUndefined();
    expect(fx.jobs.createOrGet("ws-1", "toon-init-media", request("toon-init-media")).job.id).toBe(job.id);
    fx.service.dispatch(job.id);
    await waitFor(() => fx.jobs.require(job.id).status === "awaiting-review" && fx.jobs.require(job.id).projectionPending !== true);
    expect(calls).toBe(1);
    const generation = await fx.projector.generation("ws-1", "toon-init-media", "generation-1");
    expect(generation).toMatchObject({ status: "awaiting-review", candidates: [{ status: "awaiting-review", assetId: expect.any(String) }] });
    const canvas = await fx.coordinator.query("toon-init-media", { kind: "canvas.read", canvasId: "main" }) as any;
    expect(canvas.canvas.nodes[0].config.generation).toBeUndefined();
    const progress = fx.runtime.listEvents("ws-1", "toon-init-media", "conversation").items.filter((event) => event.type === "generation.progress");
    expect(progress.at(-1)?.data).toMatchObject({ generationId: "generation-1", job: { id: job.id, status: "awaiting-review" } });
    const asset = (await fx.coordinator.query("toon-init-media", { kind: "catalogs.read" }) as any).assets.assets[0];
    expect(asset.references).toEqual(expect.arrayContaining([{ kind: "workflow", id: "image-candidates" }, expect.objectContaining({ kind: "generation", id: "generation-1" })]));
    const candidate = fx.jobs.require(job.id).candidates[0]!;
    await expect(fx.service.review(job.id, candidate.id, "adopted")).rejects.toMatchObject({ code: "toon_human_action_required" });
    await fx.service.review(job.id, candidate.id, "adopted", { operationId: "adopt-first", adoptionId: "adoption-first", principalId: "member", episodeId: "episode", workflowRecordId: "image-candidates" });
    const adopted = await fx.coordinator.query("toon-init-media", { kind: "project.read" }) as any;
    expect(adopted.project.workflow.adoptions).toEqual([expect.objectContaining({ id: "adoption-first", candidateId: candidate.id })]);
    expect((await fx.coordinator.query("toon-init-media", { kind: "canvas.read", canvasId: "main" }) as any).canvas.nodes[0].config.asset.id).toBe(asset.id);

    const secondJob = await prepare(fx, "generation-2", "stable-request-2");
    fx.service.dispatch(secondJob.id);
    await waitFor(() => fx.jobs.require(secondJob.id).status === "awaiting-review" && fx.jobs.require(secondJob.id).projectionPending !== true);
    const secondCandidate = fx.jobs.require(secondJob.id).candidates[0]!;
    await fx.service.review(secondJob.id, secondCandidate.id, "adopted", { operationId: "adopt-second", adoptionId: "adoption-second", principalId: "member", episodeId: "episode", workflowRecordId: "image-candidates" });
    const history = (await fx.coordinator.query("toon-init-media", { kind: "project.read" }) as any).project.workflow.adoptions;
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "adoption-first", supersededAt: expect.any(String) }),
      expect.objectContaining({ id: "adoption-second" }),
    ]));
    expect(history.find((item: any) => item.id === "adoption-second").supersededAt).toBeUndefined();
    expect((await fx.coordinator.query("toon-init-media", { kind: "catalogs.read" }) as any).assets.assets).toHaveLength(1);
  });

  test("lost provider response becomes submission_unknown and invalidated authorization blocks execution without retry", async () => {
    let calls = 0;
    const fx = await fixture(async () => { calls += 1; throw new Error("response lost"); });
    const job = await prepare(fx);
    await expect(fx.projector.assertPrerequisites(job)).resolves.toBeUndefined();
    fx.service.start();
    await waitFor(() => fx.jobs.require(job.id).status === "submission_unknown");
    await waitFor(() => fx.jobs.require(job.id).projectionPending !== true);
    expect(calls).toBe(1);
    expect((await fx.projector.generation("ws-1", "toon-init-media", "generation-1")).status).toBe("submission_unknown");
    await fx.service.dispose();

    const current = await fx.coordinator.query("toon-init-media", { kind: "canvas.read", canvasId: "main" }) as any;
    await fx.coordinator.execute("toon-init-media", { operationId: "change-prompt-node", actor: { kind: "human" }, origin: "human-ui", expectedRevisions: { "canvases/main.json": current.revision }, kind: "canvas.write", canvasId: "main", body: { ...current.canvas, nodes: current.canvas.nodes.map((node: any) => ({ ...node, config: { ...node.config, parameters: { prompt: "changed" } } })) } });
    const invalidated = await fx.projector.generation("ws-1", "toon-init-media", "generation-1");
    expect(invalidated.authorization?.invalidatedAt).toEqual(expect.any(String));
    await expect(fx.projector.assertPrerequisites(job)).rejects.toMatchObject({ code: "toon_compute_authorization_scope_changed" });
  });

  test("adoption retry completes SQLite review after portable truth committed before a crash", async () => {
    const fx = await fixture(async () => ({ ok: true, result: { artifact: { path: "artifacts/adoption.png", mimeType: "image/png", bytes: 8 } } }));
    await mkdir(join(fx.root, "artifacts"), { recursive: true });
    await writeFile(join(fx.root, "artifacts/adoption.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const job = await prepare(fx);
    fx.service.dispatch(job.id);
    await waitFor(() => fx.jobs.require(job.id).status === "awaiting-review" && fx.jobs.require(job.id).projectionPending !== true);
    const candidate = fx.jobs.require(job.id).candidates[0]!;
    const adopt = fx.projector.adopt.bind(fx.projector);
    let crashed = false;
    fx.projector.adopt = async (...args) => {
      await adopt(...args);
      if (!crashed) { crashed = true; throw new Error("crash after portable adoption"); }
    };
    await expect(fx.service.review(job.id, candidate.id, "adopted", { operationId: "adopt-crash", adoptionId: "adoption-crash", principalId: "member", episodeId: "episode", workflowRecordId: "image-candidates" })).rejects.toThrow("crash after portable adoption");
    expect(fx.jobs.require(job.id).candidates[0]?.status).toBe("awaiting-review");
    expect((await fx.coordinator.query("toon-init-media", { kind: "project.read" }) as any).project.workflow.adoptions).toEqual([expect.objectContaining({ id: "adoption-crash" })]);
    fx.projector.adopt = adopt;
    const retried = await fx.service.review(job.id, candidate.id, "adopted", { operationId: "adopt-crash", adoptionId: "adoption-crash", principalId: "member", episodeId: "episode", workflowRecordId: "image-candidates" });
    expect(retried.candidates[0]?.status).toBe("adopted");
    expect((await fx.coordinator.query("toon-init-media", { kind: "project.read" }) as any).project.workflow.adoptions).toHaveLength(1);
  });
});
