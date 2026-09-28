import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationSqliteAdapter } from "../automation/sqlite.js";
import { MediaGenerationRepository } from "./repository.js";
import { MediaGenerationWorker } from "./worker.js";
import type { VideoGenerationAdapter } from "./types.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });

function repository() {
  const sqlite = new Database(":memory:");
  const repo = MediaGenerationRepository.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
  cleanup.push(() => repo.close());
  return repo;
}

const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
const binding = { adapterId: "fake", protocol: "openai", origin: "https://api.example.test", configFingerprint: "config", cloudProviderId: null, organizationId: null };

describe("MediaGenerationWorker", () => {
  test("recovers a submitted job and publishes its completed result", async () => {
    const repo = repository();
    const root = await mkdtemp(join(tmpdir(), "jugglework-worker-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
    let job = repo.createOrGet({ workspaceId: "ws", clientRequestId: "request", model: { providerID: "provider", modelID: "video" }, mode: "text-to-video" });
    job = repo.transition(job.id, job.revision, "submitting", { adapterBinding: binding });
    job = repo.transition(job.id, job.revision, "submitted", { providerJobId: "external", adapterBinding: binding, nextPollAt: 0 });
    const adapter: VideoGenerationAdapter = {
      id: "fake", binding, matches: () => true,
      submit: async () => ({ providerJobId: "external" }),
      inspect: async () => ({ status: "completed", resultReference: "external" }),
      acquireResult: async () => new Response(mp4, { headers: { "content-type": "video/mp4" } }),
    };
    const worker = new MediaGenerationWorker({ repository: repo, resolveAdapters: async () => [adapter], workspaceRoot: () => root, pollIntervalMs: 5 });
    worker.start(); cleanup.push(() => worker.dispose());
    for (let attempt = 0; attempt < 30 && repo.get(job.id)?.status !== "completed"; attempt += 1) await Bun.sleep(5);
    expect(repo.get(job.id)?.status).toBe("completed");
    expect(repo.get(job.id)?.artifact?.path).toContain("artifacts/jugglework-video-");
  });

  test("keeps best-effort cancellation reconcilable when provider has no cancel endpoint", async () => {
    const repo = repository();
    let job = repo.createOrGet({ workspaceId: "ws", clientRequestId: "cancel", model: { providerID: "provider", modelID: "video" }, mode: "text-to-video" });
    job = repo.transition(job.id, job.revision, "submitting", { adapterBinding: binding });
    job = repo.transition(job.id, job.revision, "submitted", { providerJobId: "external", adapterBinding: binding, nextPollAt: 0 });
    job = repo.requestCancellation(job.id);
    const adapter: VideoGenerationAdapter = {
      id: "fake", binding, matches: () => true,
      submit: async () => ({ providerJobId: "external" }),
      inspect: async () => ({ status: "running", progress: 10 }),
      acquireResult: async () => new Response(),
    };
    const worker = new MediaGenerationWorker({ repository: repo, resolveAdapters: async () => [adapter], workspaceRoot: () => null, pollIntervalMs: 5 });
    worker.start(); cleanup.push(() => worker.dispose());
    await Bun.sleep(25);
    expect(repo.get(job.id)?.status).toBe("cancel_requested");
    expect(repo.get(job.id)?.pollAttempts).toBeGreaterThan(0);
  });

  test("resolves the current workspace adapters on every reconciliation pass", async () => {
    const repo = repository();
    const root = await mkdtemp(join(tmpdir(), "jugglework-worker-dynamic-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
    let job = repo.createOrGet({ workspaceId: "ws", clientRequestId: "dynamic", model: { providerID: "provider", modelID: "video" }, mode: "text-to-video" });
    const dynamicBinding = { ...binding, adapterId: "dynamic" };
    job = repo.transition(job.id, job.revision, "submitting", { adapterBinding: dynamicBinding });
    job = repo.transition(job.id, job.revision, "submitted", { providerJobId: "external", adapterBinding: dynamicBinding, nextPollAt: 0 });
    const adapter: VideoGenerationAdapter = {
      id: "dynamic", binding: dynamicBinding, matches: () => true,
      submit: async () => ({ providerJobId: "external" }),
      inspect: async () => ({ status: "completed", resultReference: "external" }),
      acquireResult: async () => new Response(mp4, { headers: { "content-type": "video/mp4" } }),
    };
    let adapters: VideoGenerationAdapter[] = [];
    let resolutions = 0;
    const worker = new MediaGenerationWorker({
      repository: repo,
      resolveAdapters: async (workspaceId) => { expect(workspaceId).toBe("ws"); resolutions += 1; return adapters; },
      workspaceRoot: () => root,
      pollIntervalMs: 5,
      missingAdapterBackoff: () => 1,
    });
    worker.start(); cleanup.push(() => worker.dispose());
    await Bun.sleep(15);
    expect(repo.get(job.id)?.status).toBe("submitted");
    adapters = [adapter];
    for (let attempt = 0; attempt < 30 && repo.get(job.id)?.status !== "completed"; attempt += 1) await Bun.sleep(5);
    expect(repo.get(job.id)?.status).toBe("completed");
    expect(resolutions).toBeGreaterThan(1);
  });

  test("bounds a missing adapter and rejects a changed origin", async () => {
    const repo = repository();
    let job = repo.createOrGet({ workspaceId: "ws", clientRequestId: "missing", model: { providerID: "provider", modelID: "video" }, mode: "text-to-video" });
    job = repo.transition(job.id, job.revision, "submitting", { adapterBinding: binding });
    job = repo.transition(job.id, job.revision, "submitted", { providerJobId: "external", adapterBinding: binding, nextPollAt: 0 });
    const changed: VideoGenerationAdapter = {
      id: "fake", binding: { ...binding, origin: "https://other.example.test" }, matches: () => true,
      submit: async () => ({ providerJobId: "external" }), inspect: async () => ({ status: "running" }), acquireResult: async () => new Response(),
    };
    const worker = new MediaGenerationWorker({ repository: repo, resolveAdapters: async () => [changed], workspaceRoot: () => null, pollIntervalMs: 1, maxMissingAdapterAttempts: 1 });
    worker.start(); cleanup.push(() => worker.dispose());
    for (let attempt = 0; attempt < 80 && repo.get(job.id)?.status !== "failed"; attempt += 1) await Bun.sleep(5);
    expect(repo.get(job.id)?.status).toBe("failed");
    expect(repo.get(job.id)?.error?.code).toBe("video_adapter_binding_unavailable");
  });

  test("recovers a persisted downloading job from its valid existing artifact", async () => {
    const repo = repository();
    const root = await mkdtemp(join(tmpdir(), "jugglework-worker-download-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
    let job = repo.createOrGet({ workspaceId: "ws", clientRequestId: "download", model: { providerID: "provider", modelID: "video" }, mode: "text-to-video" });
    job = repo.transition(job.id, job.revision, "submitting", { adapterBinding: binding });
    job = repo.transition(job.id, job.revision, "submitted", { providerJobId: "external", adapterBinding: binding, nextPollAt: 0 });
    job = repo.transition(job.id, job.revision, "downloading");
    await mkdir(join(root, "artifacts"), { recursive: true });
    await writeFile(join(root, "artifacts", `jugglework-video-${job.id}.mp4`), mp4);
    let acquisitions = 0;
    const adapter: VideoGenerationAdapter = { id: "fake", binding, matches: () => true, submit: async () => ({ providerJobId: "external" }), inspect: async () => ({ status: "completed", resultReference: "external" }), acquireResult: async () => { acquisitions += 1; return new Response(mp4); } };
    const worker = new MediaGenerationWorker({ repository: repo, resolveAdapters: async () => [adapter], workspaceRoot: () => root, pollIntervalMs: 5 });
    worker.start(); cleanup.push(() => worker.dispose());
    for (let attempt = 0; attempt < 30 && repo.get(job.id)?.status !== "completed"; attempt += 1) await Bun.sleep(5);
    expect(repo.get(job.id)?.status).toBe("completed");
    expect(acquisitions).toBe(0);
  });

  test("recovers a crash during paid submission as terminal unknown without resubmitting", async () => {
    const repo = repository();
    let job = repo.createOrGet({ workspaceId: "ws", clientRequestId: "crashed", model: { providerID: "provider", modelID: "video" }, mode: "text-to-video" });
    job = repo.transition(job.id, job.revision, "submitting", { adapterBinding: binding });
    let submissions = 0;
    const adapter: VideoGenerationAdapter = {
      id: "fake", binding, matches: () => true,
      submit: async () => { submissions += 1; return { providerJobId: "external" }; },
      inspect: async () => ({ status: "running" }), acquireResult: async () => new Response(),
    };
    const worker = new MediaGenerationWorker({ repository: repo, resolveAdapters: async () => [adapter], workspaceRoot: () => null, pollIntervalMs: 5 });
    worker.start(); cleanup.push(() => worker.dispose());
    for (let attempt = 0; attempt < 30 && repo.get(job.id)?.status !== "submission_unknown"; attempt += 1) await Bun.sleep(5);
    expect(repo.get(job.id)?.status).toBe("submission_unknown");
    expect(submissions).toBe(0);
  });
});
