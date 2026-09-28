import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { automationSqliteAdapter } from "../automation/sqlite.js";
import { filterVideoSubmissionEligibleModels, MediaGenerationService, videoSubmissionAllowed } from "./service.js";
import { MediaGenerationRepository } from "./repository.js";
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
const workspace = { id: "ws", name: "Workspace", path: "/tmp", preset: "", workspaceType: "local" } as never;

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
    const existing = repo.createOrGet({ workspaceId: "ws", clientRequestId: "same", model: { providerID: "provider", modelID: "video" }, mode: "text-to-video" });
    repo.createOrGet({ workspaceId: "ws", clientRequestId: "other", model: { providerID: "provider", modelID: "video" }, mode: "text-to-video" });
    let submissions = 0;
    const adapter: VideoGenerationAdapter = { id: "fake", binding, matches: () => true, submit: async () => { submissions += 1; return { providerJobId: "external" }; }, inspect: async () => ({ status: "running" }), acquireResult: async () => new Response() };
    const service = new MediaGenerationService({ repository: repo, adapters: [adapter], submissionEnabled: true, maxConcurrentJobs: 1 });
    expect((await service.submit({ workspace, clientRequestId: "same", prompt: "waves", mode: "text-to-video", model: { providerID: "provider", modelID: "video" } })).id).toBe(existing.id);
    expect(submissions).toBe(0);
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
    const input = { workspace, clientRequestId: "same", prompt: "waves", mode: "text-to-video" as const, model: { providerID: "provider", modelID: "video" } };
    const first = await service.submit(input);
    const second = await service.submit(input);
    expect(first.status).toBe("submission_unknown");
    expect(second.id).toBe(first.id);
    expect(submissions).toBe(1);
    expect(JSON.stringify(first)).not.toContain(secret);
  });
});
