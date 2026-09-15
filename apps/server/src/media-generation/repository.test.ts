import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { automationSqliteAdapter } from "../automation/sqlite.js";
import { MediaGenerationRepository } from "./repository.js";

const repositories: MediaGenerationRepository[] = [];
function repository() {
  const sqlite = new Database(":memory:");
  const repo = MediaGenerationRepository.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
  repositories.push(repo);
  return repo;
}
afterEach(() => { while (repositories.length) repositories.pop()?.close(); });

const create = (repo: MediaGenerationRepository, clientRequestId = "request-1") => repo.createOrGet({
  workspaceId: "workspace-1", sessionId: "session-1", clientRequestId,
  model: { providerID: "provider", modelID: "video" }, mode: "text-to-video", options: { durationSeconds: 5 }, now: 100,
});

describe("MediaGenerationRepository", () => {
  test("creates one durable job per scoped request identity", () => {
    const repo = repository();
    const first = create(repo);
    const second = create(repo);
    expect(second.id).toBe(first.id);
    expect(second.options).toEqual({ durationSeconds: 5 });
  });

  test("enforces legal optimistic transitions and terminal state", () => {
    const repo = repository();
    const queued = create(repo);
    const submitting = repo.transition(queued.id, queued.revision, "submitting");
    const submitted = repo.transition(submitting.id, submitting.revision, "submitted", { providerJobId: "external-1", nextPollAt: 200 });
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
});
