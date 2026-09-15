import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
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

describe("MediaGenerationWorker", () => {
  test("recovers a submitted job and publishes its completed result", async () => {
    const repo = repository();
    const root = await mkdtemp(join(tmpdir(), "jugglework-worker-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
    let job = repo.createOrGet({ workspaceId: "ws", clientRequestId: "request", model: { providerID: "provider", modelID: "video" }, mode: "text-to-video" });
    job = repo.transition(job.id, job.revision, "submitting");
    job = repo.transition(job.id, job.revision, "submitted", { providerJobId: "external", nextPollAt: 0 });
    const adapter: VideoGenerationAdapter = {
      id: "fake", matches: () => true,
      submit: async () => ({ providerJobId: "external" }),
      inspect: async () => ({ status: "completed", resultReference: "external" }),
      acquireResult: async () => new Response(mp4, { headers: { "content-type": "video/mp4" } }),
    };
    const worker = new MediaGenerationWorker({ repository: repo, adapters: [adapter], workspaceRoot: () => root, pollIntervalMs: 5 });
    worker.start(); cleanup.push(() => worker.dispose());
    for (let attempt = 0; attempt < 30 && repo.get(job.id)?.status !== "completed"; attempt += 1) await Bun.sleep(5);
    expect(repo.get(job.id)?.status).toBe("completed");
    expect(repo.get(job.id)?.artifact?.path).toContain("artifacts/jugglework-video-");
  });

  test("keeps best-effort cancellation reconcilable when provider has no cancel endpoint", async () => {
    const repo = repository();
    let job = repo.createOrGet({ workspaceId: "ws", clientRequestId: "cancel", model: { providerID: "provider", modelID: "video" }, mode: "text-to-video" });
    job = repo.transition(job.id, job.revision, "submitting");
    job = repo.transition(job.id, job.revision, "submitted", { providerJobId: "external", nextPollAt: 0 });
    job = repo.requestCancellation(job.id);
    const adapter: VideoGenerationAdapter = {
      id: "fake", matches: () => true,
      submit: async () => ({ providerJobId: "external" }),
      inspect: async () => ({ status: "running", progress: 10 }),
      acquireResult: async () => new Response(),
    };
    const worker = new MediaGenerationWorker({ repository: repo, adapters: [adapter], workspaceRoot: () => null, pollIntervalMs: 5 });
    worker.start(); cleanup.push(() => worker.dispose());
    await Bun.sleep(25);
    expect(repo.get(job.id)?.status).toBe("cancel_requested");
    expect(repo.get(job.id)?.pollAttempts).toBeGreaterThan(0);
  });
});
