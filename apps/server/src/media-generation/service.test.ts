import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationSqliteAdapter } from "../automation/sqlite.js";
import { filterVideoSubmissionEligibleModels, MediaGenerationService, videoSubmissionAllowed } from "./service.js";
import { MediaGenerationRepository } from "./repository.js";
import type { WorkspaceInfo } from "../types.js";
import type { VideoGenerationAdapter } from "./types.js";
import { VideoSubmissionError } from "./redaction.js";

const repositories: MediaGenerationRepository[] = [];
afterEach(() => { while (repositories.length) repositories.pop()?.close(); });
function repository() {
  const sqlite = new Database(":memory:");
  const repo = MediaGenerationRepository.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
  repositories.push(repo);
  return repo;
}
const binding = { adapterId: "fake", protocol: "openai", origin: "https://api.example.test", configFingerprint: "config", cloudProviderId: null, organizationId: null };
const workspace: WorkspaceInfo = { id: "ws", name: "Workspace", path: "/tmp", preset: "", workspaceType: "local" };
const model = { providerID: "provider", modelID: "video" };
const requestHash = "preexisting-request-hash";

describe("video submission eligibility", () => {
  test("allows a current organization-imported model without the local rollout flag", () => {
    expect(videoSubmissionAllowed({ explicitFlagEnabled: false, organizationImportedModel: true })).toBe(true);
  });

  test("requires the explicit flag for local and custom models", () => {
    expect(videoSubmissionAllowed({ explicitFlagEnabled: false, organizationImportedModel: false })).toBe(false);
    expect(videoSubmissionAllowed({ explicitFlagEnabled: true, organizationImportedModel: false })).toBe(true);
  });

  test("does not expose a local model merely because an organization model is eligible", async () => {
    const models = [
      { ref: { providerID: "lpr_org", modelID: "video" } },
      { ref: { providerID: "local", modelID: "video" } },
    ];
    expect(await filterVideoSubmissionEligibleModels({
      models,
      explicitFlagEnabled: false,
      isOrganizationImportedModel: async (model) => model.providerID === "lpr_org",
    })).toEqual([models[0]]);
    expect(await filterVideoSubmissionEligibleModels({
      models,
      explicitFlagEnabled: true,
      isOrganizationImportedModel: async () => false,
    })).toEqual(models);
  });
});

describe("paid video submission safety", () => {
  test("returns an existing request before enforcing the concurrency limit", async () => {
    const repo = repository();
    const input = { workspace, clientRequestId: "same", prompt: "waves", mode: "text-to-video" as const, model };
    let submissions = 0;
    const adapter: VideoGenerationAdapter = { id: "fake", binding, matches: () => true, submit: async () => { submissions += 1; return { providerJobId: "external" }; }, inspect: async () => ({ status: "running" }), acquireResult: async () => new Response() };
    const service = new MediaGenerationService({ repository: repo, adapters: [adapter], submissionEnabled: true, maxConcurrentJobs: 2 });
    const existing = await service.submit(input);
    repo.createOrGet({ workspaceId: "ws", clientRequestId: "other", requestHash, model, mode: "text-to-video" });
    expect((await service.submit(input)).id).toBe(existing.id);
    expect(submissions).toBe(1);
  });

  test("persists ambiguous transport as submission_unknown and never submits the same id twice", async () => {
    const repo = repository();
    const secret = "be459a45-01ef-47ad-8184-7e937dcb9b86.eyJhbGciOiJIUzI1NiJ9.signature";
    let submissions = 0;
    const adapter: VideoGenerationAdapter = {
      id: "fake", binding, matches: () => true,
      submit: async () => { submissions += 1; throw new VideoSubmissionError("unknown", "video_provider_transport_unknown", "socket aborted for [REDACTED]"); },
      inspect: async () => ({ status: "running" }), acquireResult: async () => new Response(),
    };
    const service = new MediaGenerationService({ repository: repo, adapters: [adapter], submissionEnabled: true });
    const input = { workspace, clientRequestId: "same", prompt: "waves", mode: "text-to-video" as const, model };
    const first = await service.submit(input);
    const second = await service.submit(input);
    expect(first.status).toBe("submission_unknown");
    expect(second.id).toBe(first.id);
    expect(submissions).toBe(1);
    expect(JSON.stringify(first)).not.toContain(secret);
  });

  test("rejects the same request id for a different prompt or duration", async () => {
    const repo = repository();
    let submissions = 0;
    const adapter: VideoGenerationAdapter = { id: "fake", binding, matches: () => true, submit: async () => { submissions += 1; return { providerJobId: "external" }; }, inspect: async () => ({ status: "running" }), acquireResult: async () => new Response() };
    const service = new MediaGenerationService({ repository: repo, adapters: [adapter], submissionEnabled: true });
    const input = { workspace, clientRequestId: "conflict", prompt: "waves", mode: "text-to-video" as const, model, options: { durationSeconds: 5 } };
    await service.submit(input);
    await expect(service.submit({ ...input, prompt: "mountains" })).rejects.toMatchObject({ status: 409, code: "video_request_conflict" });
    await expect(service.submit({ ...input, options: { durationSeconds: 8 } })).rejects.toMatchObject({ status: 409, code: "video_request_conflict" });
    expect(submissions).toBe(1);
  });

  test("hashes source image content instead of its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-request-hash-"));
    try {
      const firstPath = join(root, "first.png");
      const secondPath = join(root, "second.png");
      const firstBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
      const secondBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);
      await writeFile(firstPath, firstBytes);
      await writeFile(secondPath, firstBytes);
      let submissions = 0;
      const adapter: VideoGenerationAdapter = { id: "fake", binding, matches: () => true, submit: async () => { submissions += 1; return { providerJobId: "external" }; }, inspect: async () => ({ status: "running" }), acquireResult: async () => new Response() };
      const service = new MediaGenerationService({ repository: repository(), adapters: [adapter], submissionEnabled: true });
      const scopedWorkspace = { ...workspace, path: root };
      const input = { workspace: scopedWorkspace, clientRequestId: "source", prompt: "move", mode: "image-to-video" as const, model, sourceImagePath: "first.png" };
      const first = await service.submit(input);
      expect((await service.submit({ ...input, sourceImagePath: "second.png" })).id).toBe(first.id);
      await writeFile(secondPath, secondBytes);
      await expect(service.submit({ ...input, sourceImagePath: "second.png" })).rejects.toMatchObject({ status: 409, code: "video_request_conflict" });
      expect(submissions).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("claims concurrent identical submissions before calling the provider", async () => {
    const repo = repository();
    let submissions = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const adapter: VideoGenerationAdapter = {
      id: "fake", binding, matches: () => true,
      submit: async () => { submissions += 1; await wait; return { providerJobId: "external" }; },
      inspect: async () => ({ status: "running" }), acquireResult: async () => new Response(),
    };
    const service = new MediaGenerationService({ repository: repo, adapters: [adapter], submissionEnabled: true });
    const input = { workspace, clientRequestId: "concurrent", prompt: "waves", mode: "text-to-video" as const, model };
    const first = service.submit(input);
    await Bun.sleep(0);
    const second = await service.submit(input);
    expect(second.status).toBe("submitting");
    expect(submissions).toBe(1);
    release();
    expect((await first).status).toBe("submitted");
  });
});
