import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationSqliteAdapter } from "../automation/sqlite.js";
import { MediaGenerationRepository } from "./repository.js";
import { publicVideoGenerationJob } from "./types.js";

const repositories: MediaGenerationRepository[] = [];
function repository() {
  const sqlite = new Database(":memory:");
  const repo = MediaGenerationRepository.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
  repositories.push(repo);
  return repo;
}
afterEach(() => { while (repositories.length) repositories.pop()?.close(); });

const create = (repo: MediaGenerationRepository, clientRequestId = "request-1", requestHash = "hash-1") => repo.createOrGet({
  workspaceId: "workspace-1", sessionId: "session-1", clientRequestId,
  requestHash,
  model: { providerID: "provider", modelID: "video" }, mode: "text-to-video", options: { durationSeconds: 5 }, now: 100,
});
const binding = { adapterId: "adapter", protocol: "openai", origin: "https://api.example.test", configFingerprint: "config", cloudProviderId: "lpr_provider", organizationId: "org" };

describe("MediaGenerationRepository", () => {
  test("migration fails pre-binding active jobs closed without database constraints", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`CREATE TABLE media_generation_schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);
      INSERT INTO media_generation_schema_migrations VALUES (1, 1);
      CREATE TABLE video_generation_jobs (
        id TEXT PRIMARY KEY, workspace_id TEXT, session_id TEXT, client_request_id TEXT, provider_id TEXT, model_id TEXT,
        mode TEXT, status TEXT, progress REAL, options_json TEXT, provider_job_id TEXT, next_poll_at INTEGER,
        poll_attempts INTEGER DEFAULT 0, artifact_json TEXT, error_code TEXT, error_message TEXT, error_retryable INTEGER,
        revision INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER
      );
      INSERT INTO video_generation_jobs VALUES ('old', 'ws', NULL, 'request', 'provider', 'video', 'text-to-video', 'submitted', NULL, '{}', 'external', 0, 0, NULL, NULL, NULL, NULL, 1, 1, 1);`);
    const repo = MediaGenerationRepository.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
    repositories.push(repo);
    expect(repo.get("old")?.status).toBe("failed");
    expect(repo.get("old")?.error?.code).toBe("video_adapter_binding_unavailable");
  });

  test("creates one durable job per scoped request identity", () => {
    const repo = repository();
    const first = create(repo);
    const second = create(repo);
    expect(second.id).toBe(first.id);
    expect(second.options).toEqual({ durationSeconds: 5 });
  });

  test("rejects a reused request identity with a different hash", () => {
    const repo = repository();
    create(repo);
    try {
      create(repo, "request-1", "hash-2");
      throw new Error("expected video request conflict");
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: "video_request_conflict" });
    }
  });

  test("keeps legacy jobs readable but never assumes their missing hash matches", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`CREATE TABLE media_generation_schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);
      INSERT INTO media_generation_schema_migrations VALUES (4, 1);
      CREATE TABLE video_generation_jobs (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT, client_request_id TEXT NOT NULL,
        provider_id TEXT NOT NULL, model_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, progress REAL,
        options_json TEXT NOT NULL, provider_job_id TEXT, next_poll_at INTEGER, poll_attempts INTEGER NOT NULL DEFAULT 0,
        artifact_json TEXT, error_code TEXT, error_message TEXT, error_retryable INTEGER, adapter_binding_json TEXT,
        revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (workspace_id, session_id, client_request_id)
      );
      INSERT INTO video_generation_jobs VALUES ('legacy', 'workspace-1', 'session-1', 'legacy-request', 'provider', 'video',
        'text-to-video', 'completed', NULL, '{}', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, 1, 1, 1);`);
    const repo = MediaGenerationRepository.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
    repositories.push(repo);
    expect(repo.get("legacy")).toMatchObject({ id: "legacy", status: "completed" });
    try {
      create(repo, "legacy-request");
      throw new Error("expected legacy video request conflict");
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: "video_request_conflict" });
    }
  });

  test("reads a durable job after reopening the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-generation-repository-"));
    const path = join(root, "runtime.sqlite");
    try {
      const firstSqlite = new Database(path);
      const first = MediaGenerationRepository.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite: firstSqlite, db: null as never, close: () => firstSqlite.close() }));
      const job = create(first, "persisted-request");
      first.close();

      const secondSqlite = new Database(path);
      const second = MediaGenerationRepository.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite: secondSqlite, db: null as never, close: () => secondSqlite.close() }));
      expect(second.get(job.id)).toMatchObject({ id: job.id, workspaceId: "workspace-1", clientRequestId: "persisted-request", requestHash: "hash-1", status: "queued" });
      expect(create(second, "persisted-request").id).toBe(job.id);
      second.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent creates across repository connections", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-generation-concurrent-repository-"));
    const path = join(root, "runtime.sqlite");
    try {
      const firstSqlite = new Database(path);
      const secondSqlite = new Database(path);
      firstSqlite.exec("PRAGMA busy_timeout = 1000");
      secondSqlite.exec("PRAGMA busy_timeout = 1000");
      const first = MediaGenerationRepository.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite: firstSqlite, db: null as never, close: () => firstSqlite.close() }));
      const second = MediaGenerationRepository.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite: secondSqlite, db: null as never, close: () => secondSqlite.close() }));
      const [left, right] = await Promise.all([Promise.resolve().then(() => create(first)), Promise.resolve().then(() => create(second))]);
      expect(right.id).toBe(left.id);
      first.close();
      second.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enforces legal optimistic transitions and terminal state", () => {
    const repo = repository();
    const queued = create(repo);
    const pinned = repo.setAdapterBinding(queued.id, queued.revision, binding);
    const submitting = repo.transition(pinned.id, pinned.revision, "submitting");
    const submitted = repo.transition(submitting.id, submitting.revision, "submitted", { providerJobId: "external-1", adapterBinding: binding, nextPollAt: 200 });
    expect(submitted.adapterBinding).toEqual(binding);
    expect(() => repo.transition(submitted.id, submitted.revision, "running", { adapterBinding: { ...binding, origin: "https://other.example.test" } })).toThrow("video_adapter_binding_immutable");
    const downloading = repo.transition(submitted.id, submitted.revision, "downloading");
    const completed = repo.transition(downloading.id, downloading.revision, "completed", { artifact: { path: "artifacts/a.mp4", mimeType: "video/mp4", bytes: 4 } });
    expect(completed.status).toBe("completed");
    expect(() => repo.transition(completed.id, completed.revision, "running")).toThrow();
    expect(() => repo.transition(submitted.id, submitted.revision, "running")).toThrow("video_job_conflict");
  });

  test("cancellation is idempotent and reconcilable", () => {
    const repo = repository();
    const queued = create(repo);
    const cancelled = repo.requestCancellation(queued.id, 150);
    expect(cancelled.status).toBe("cancel_requested");
    expect(repo.requestCancellation(queued.id).revision).toBe(cancelled.revision);
    expect(repo.listReconcilable(200).map((job) => job.id)).toEqual([queued.id]);
  });

  test("does not persist prompt, credentials, or result URLs in the job contract", () => {
    const repo = repository();
    const job = create(repo);
    expect(JSON.stringify(job)).not.toContain("prompt");
    expect(JSON.stringify(job)).not.toContain("apiKey");
    expect(JSON.stringify(job)).not.toContain("signedUrl");
  });

  test("public jobs omit request identity and the private adapter fingerprint", () => {
    const repo = repository();
    const queued = create(repo);
    const bound = repo.setAdapterBinding(queued.id, queued.revision, binding);
    const publicJob = publicVideoGenerationJob(bound);
    expect(JSON.stringify(publicJob)).not.toContain("clientRequestId");
    expect(JSON.stringify(publicJob)).not.toContain("requestHash");
    expect(JSON.stringify(publicJob)).not.toContain("hash-1");
    expect(JSON.stringify(publicJob)).not.toContain("adapterBinding");
    expect(JSON.stringify(publicJob)).not.toContain(binding.configFingerprint);
  });
});
