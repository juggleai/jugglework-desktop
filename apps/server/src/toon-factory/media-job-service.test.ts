import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToonMediaCandidate, ToonMediaJob, ToonMediaJobCreateRequest, ToonMediaJobRequestSnapshot } from "@jugglework/types/toon-factory";
import { automationSqliteAdapter } from "../automation/sqlite.js";
import type { MediaGenerationExtensionRuntime } from "../extensions/media-generation.js";
import { ApiError } from "../errors.js";
import { ToonMediaJobRepository, createToonMediaAuthorization, toonMediaRequestHash } from "./media-job-repository.js";
import { ToonMediaJobService } from "./media-job-service.js";
import { ToonModelPolicyStore } from "./model-policy-store.js";
import { ToonFactoryRepository } from "./repository.js";
import { ToonWorkspaceRuntimeStore } from "./workspace-runtime-store.js";

const repositories: ToonMediaJobRepository[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (repositories.length) repositories.pop()!.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function repository(): ToonMediaJobRepository {
  const sqlite = new Database(":memory:");
  const result = ToonMediaJobRepository.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
  repositories.push(result);
  return result;
}

function request(kind: "image" | "video", overrides: Partial<ToonMediaJobCreateRequest> = {}): ToonMediaJobCreateRequest {
  const base = {
    requestId: `request-${kind}`,
    episodeId: "episode-1",
    canvasId: "canvas-1",
    nodeId: `${kind}-node`,
    stepId: kind === "image" ? "image-candidates" : "video-clips",
    plan: kind === "image" ? {
      kind: "image" as const,
      model: { kind: "image" as const, providerID: "provider", modelID: "image-model" },
      object: "hero portrait", quantity: 2, prompt: "a complete image prompt", referencePaths: [],
      referenceScope: "workspace" as const,
      mode: "text-to-image" as const, size: "1024x1024", executionCount: 2, knownCost: null,
    } : {
      kind: "video" as const,
      model: { kind: "video" as const, providerID: "provider", modelID: "video-model" },
      object: "opening shot", quantity: 1, prompt: "a complete video prompt", referencePaths: [],
      referenceScope: "workspace" as const,
      mode: "text-to-video" as const, durationSeconds: 5, resolution: "720p", executionCount: 1, knownCost: null,
    },
    ...overrides,
  };
  const snapshot = { ...base, projectId: "project-1" } as ToonMediaJobRequestSnapshot;
  return { ...base, authorization: createToonMediaAuthorization(toonMediaRequestHash(snapshot), 1) } as ToonMediaJobCreateRequest;
}

function harness(input: {
  jobs?: ToonMediaJobRepository;
  imageAction?: (action: string, args: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;
  runtime?: MediaGenerationExtensionRuntime;
  modelPolicy?: ToonModelPolicyStore;
}) {
  const manifests: string[] = [];
  const adoptions: Array<{ jobId: string; candidateId: string }> = [];
  const jobs = input.jobs ?? repository();
  const runtime: MediaGenerationExtensionRuntime = input.runtime ?? {
    status: async () => ({}), listModels: async () => ({ models: [] }),
    generate: async () => ({ job: { id: "runtime-video", status: "submitted" } }),
    getJob: async () => ({ job: { id: "runtime-video", status: "running", progress: 20 } }),
    cancelJob: async () => ({ job: { id: "runtime-video", status: "cancel_requested" } }),
  };
  const service = new ToonMediaJobService({
    jobs,
    repository: async () => ({
      getProject: async () => ({ directory: "toons/series" }),
      assertMediaJobPrerequisites: async () => undefined,
      resolveMediaReference: async (_projectId: string, reference: { path: string }) => join("/workspace", reference.path),
      writeMediaJobManifest: async (job: ToonMediaJob) => { manifests.push(`${job.id}:${job.status}`); },
      adoptMediaCandidate: async (job: ToonMediaJob, candidate: ToonMediaCandidate) => { adoptions.push({ jobId: job.id, candidateId: candidate.id }); return {} as never; },
      reconcileMediaJob: async () => ({} as never),
      ownsMediaJob: async () => true,
    }) as never,
    imageAction: input.imageAction ?? (async () => ({ ok: true, result: { artifact: { path: "artifacts/fake.png", mimeType: "image/png", bytes: 8 } } })),
    mediaGeneration: runtime,
    modelPolicy: input.modelPolicy,
    providerSource: async () => "api",
  });
  return { jobs, service, manifests, adoptions };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("condition not reached");
}

describe("Toon media generation jobs", () => {
  test("authorization is scoped to the exact model, prompt, references, parameters, and count", () => {
    const jobs = repository();
    const authorized = request("image");
    expect(jobs.create("workspace-1", "project-1", authorized).requestHash).toBe(authorized.authorization.scopeHash);
    for (const changed of [
      { plan: { ...authorized.plan, prompt: "changed prompt" } },
      { plan: { ...authorized.plan, model: { ...authorized.plan.model, modelID: "changed-model" } } },
      { plan: { ...authorized.plan, referencePaths: ["assets/reference.png"], mode: "image-to-image" as const } },
      { plan: { ...authorized.plan, executionCount: 3 } },
      { plan: { ...authorized.plan, size: "512x512" } },
    ]) {
      expect(() => jobs.create("workspace-1", "project-1", { ...authorized, requestId: `changed-${Math.random()}`, ...changed } as ToonMediaJobCreateRequest)).toThrow("generation plan changed");
    }
  });

  test("server-issued authorization is consumed atomically once and a failed create rolls back consumption", () => {
    const sqlite = new Database(":memory:");
    const adapter = automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() });
    const runtime = ToonWorkspaceRuntimeStore.fromDatabase(adapter);
    const jobs = ToonMediaJobRepository.fromDatabase(adapter);
    const input = request("video");
    const authorizationId = "authorization-ledger";
    input.authorization = { ...input.authorization, id: authorizationId };
    const { authorization: _authorization, ...authorizedInput } = input;
    runtime.issueAuthorization({ authorizationId, principalId: "member", workspaceScope: "workspace-1", projectId: "project-1", generationId: "generation-1", requestHash: input.authorization.scopeHash, requestSnapshot: { ...authorizedInput, projectId: "project-1" }, expiresAt: 10_000 }, 1);
    const first = jobs.consumeAuthorizationAndCreate({ authorizationId, principalId: "member", workspaceId: "workspace-1", projectId: "project-1", generationId: "generation-1" }, 2);
    expect(runtime.scopedGenerationAuthorization({ authorizationId, principalId: "member", workspaceScope: "workspace-1", projectId: "project-1", generationId: "generation-1", requestHash: input.authorization.scopeHash }, 2)).toMatchObject({ authorizationId, state: "consumed", consumedAt: new Date(2).toISOString() });
    const retry = jobs.consumeAuthorizationAndCreate({ authorizationId, principalId: "member", workspaceId: "workspace-1", projectId: "project-1", generationId: "generation-1" }, 3);
    expect(retry).toMatchObject({ job: { id: first.job.id }, created: false });
    expect(jobs.list("workspace-1", "project-1")).toHaveLength(1);
    expect(() => jobs.consumeAuthorizationAndCreate({ authorizationId, principalId: "other", workspaceId: "workspace-1", projectId: "project-1", generationId: "generation-1" }, 4)).toThrow("does not match this principal");
    expect(runtime.scopedGenerationAuthorization({ authorizationId, principalId: "other", workspaceScope: "workspace-1", projectId: "project-1", generationId: "generation-1", requestHash: input.authorization.scopeHash }, 4)).toBeNull();

    const rollbackInput = request("video", { requestId: "rollback-request" });
    const rollbackId = "authorization-rollback";
    const { authorization: _rollbackAuthorization, ...rollbackAuthorizedInput } = rollbackInput;
    runtime.issueAuthorization({ authorizationId: rollbackId, principalId: "member", workspaceScope: "workspace-1", projectId: "project-1", generationId: "generation-2", requestHash: "f".repeat(64), requestSnapshot: { ...rollbackAuthorizedInput, projectId: "project-1" }, expiresAt: 10_000 }, 1);
    expect(runtime.scopedGenerationAuthorization({ authorizationId: rollbackId, principalId: "member", workspaceScope: "workspace-1", projectId: "project-1", generationId: "generation-2", requestHash: "f".repeat(64) }, 10_000)).toMatchObject({ state: "expired", consumedAt: null });
    expect(() => jobs.consumeAuthorizationAndCreate({ authorizationId: rollbackId, principalId: "member", workspaceId: "workspace-1", projectId: "project-1", generationId: "generation-2" }, 5)).toThrow("does not match this principal");
    expect(runtime.requireAuthorization(rollbackId).consumedAt).toBeNull();
    sqlite.close();
  });

  test("server-owned image execution persists artifacts, provenance, review, adoption, rejection, and history", async () => {
    const calls: Record<string, unknown>[] = [];
    const fx = harness({ imageAction: async (_action, args) => {
      calls.push(args);
      const ordinal = calls.length;
      return { ok: true, result: { artifact: { path: `artifacts/fake-${ordinal}.png`, mimeType: "image/png", bytes: 8 + ordinal } } };
    } });
    const job = fx.jobs.create("workspace-1", "project-1", request("image"));
    fx.service.dispatch(job.id);
    await waitFor(() => fx.jobs.require(job.id).status === "awaiting-review");
    const completed = fx.jobs.require(job.id);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ prompt: "a complete image prompt", model: { providerID: "provider", modelID: "image-model" }, size: "1024x1024" });
    expect(completed.candidates.map((candidate) => candidate.artifact?.path)).toEqual(["artifacts/fake-1.png", "artifacts/fake-2.png"]);
    expect(completed.candidates[0]?.provenance).toMatchObject({ prompt: "a complete image prompt", model: { modelID: "image-model" }, parameters: { size: "1024x1024" } });
    const adopted = await fx.service.review(job.id, completed.candidates[0]!.id, "adopted");
    expect(adopted.candidates[0]?.review.decision).toBe("adopted");
    expect(fx.adoptions).toEqual([{ jobId: job.id, candidateId: completed.candidates[0]!.id }]);
    const reviewed = await fx.service.review(job.id, completed.candidates[1]!.id, "rejected");
    expect(reviewed.candidates.map((candidate) => candidate.review.decision)).toEqual(["adopted", "rejected"]);
    expect(fx.jobs.list("workspace-1", "project-1")).toHaveLength(1);
    expect(fx.manifests.some((entry) => entry.endsWith(":awaiting-review"))).toBe(true);
  });

  test("an interrupted synchronous image call becomes submission_unknown after restart without resubmission", async () => {
    let calls = 0;
    const jobs = repository();
    const job = jobs.create("workspace-1", "project-1", request("image"));
    jobs.update(job.id, (current, now) => ({
      ...current,
      status: "running",
      candidates: current.candidates.map((candidate, index) => index === 0 ? { ...candidate, status: "running", updatedAt: now } : candidate),
    }));
    const fx = harness({ jobs, imageAction: async () => { calls += 1; return {}; } });
    fx.service.start();
    await waitFor(() => jobs.require(job.id).status === "submission_unknown");
    expect(calls).toBe(0);
    expect(jobs.require(job.id).candidates[0]?.error?.retryable).toBe(false);
    await fx.service.dispose();
  });

  test("only an explicit provider rejection fails an image candidate; invalid success stays unknown", async () => {
    const rejected = harness({ imageAction: async () => { throw new ApiError(400, "image_generation_failed", "provider rejected"); } });
    const rejectedJob = rejected.jobs.create("workspace-1", "project-1", request("image", { plan: { ...request("image").plan, quantity: 1, executionCount: 1 } }));
    rejected.service.dispatch(rejectedJob.id);
    await waitFor(() => rejected.jobs.require(rejectedJob.id).status === "failed");
    expect(rejected.jobs.require(rejectedJob.id).candidates[0]?.error?.retryable).toBe(false);

    const invalid = harness({ imageAction: async () => ({ ok: true, result: {} }) });
    const invalidJob = invalid.jobs.create("workspace-1", "project-1", request("image", { requestId: "invalid-success", plan: { ...request("image").plan, quantity: 1, executionCount: 1 } }));
    invalid.service.dispatch(invalidJob.id);
    await waitFor(() => invalid.jobs.require(invalidJob.id).status === "submission_unknown");
    expect(invalid.jobs.require(invalidJob.id).candidates[0]?.error?.retryable).toBe(false);
  });

  test("stable video client request IDs are idempotent and restart reconciliation publishes safe runtime artifacts", async () => {
    const submissions: string[] = [];
    let status = "running";
    const runtime: MediaGenerationExtensionRuntime = {
      status: async () => ({}), listModels: async () => ({ models: [] }),
      generate: async (input) => { submissions.push(input.clientRequestId); return { job: { id: "runtime-video-1", status: "submitted" } }; },
      getJob: async () => ({ job: status === "completed"
        ? { id: "runtime-video-1", status, artifact: { path: "artifacts/jugglework-video-runtime-video-1.mp4", mimeType: "video/mp4", bytes: 12 } }
        : { id: "runtime-video-1", status, progress: 45 } }),
      cancelJob: async () => ({ job: { id: "runtime-video-1", status: "cancel_requested" } }),
    };
    const jobs = repository();
    const first = harness({ jobs, runtime });
    const input = request("video");
    const job = jobs.create("workspace-1", "project-1", input);
    expect(jobs.create("workspace-1", "project-1", input).id).toBe(job.id);
    first.service.dispatch(job.id);
    await waitFor(() => Boolean(jobs.require(job.id).candidates[0]?.runtimeJobId));
    expect(submissions).toHaveLength(1);
    await first.service.dispose();

    status = "completed";
    const restarted = harness({ jobs, runtime });
    restarted.service.start();
    await waitFor(() => jobs.require(job.id).status === "awaiting-review");
    expect(submissions).toHaveLength(1);
    expect(jobs.require(job.id).candidates[0]?.artifact).toEqual({ scope: "workspace", path: "artifacts/jugglework-video-runtime-video-1.mp4", mimeType: "video/mp4", bytes: 12 });
    await restarted.service.dispose();
  });

  test("queued image and video jobs remain nonterminal without policy and submit nothing", async () => {
    let imageSubmissions = 0;
    let videoSubmissions = 0;
    const runtime: MediaGenerationExtensionRuntime = {
      status: async () => ({}), listModels: async () => ({ models: [] }),
      generate: async () => { videoSubmissions += 1; return { job: { id: "runtime-pending", status: "submitted" } }; },
      getJob: async () => ({ job: { id: "runtime-pending", status: "running" } }),
      cancelJob: async () => ({}),
    };
    const fx = harness({
      runtime,
      modelPolicy: new ToonModelPolicyStore(),
      imageAction: async () => { imageSubmissions += 1; return {}; },
    });
    const image = fx.jobs.create("workspace-1", "project-1", request("image", { requestId: "pending-image" }));
    const video = fx.jobs.create("workspace-1", "project-1", request("video", { requestId: "pending-video" }));
    fx.service.start();
    await Bun.sleep(25);
    expect(fx.jobs.require(image.id).status).toBe("queued");
    expect(fx.jobs.require(video.id).status).toBe("queued");
    expect(imageSubmissions).toBe(0);
    expect(videoSubmissions).toBe(0);
    await fx.service.dispose();
  });

  test("persisted policy restores queued image and video submission after restart", async () => {
    const sqlite = new Database(":memory:");
    const policyRuntime = ToonWorkspaceRuntimeStore.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
    new ToonModelPolicyStore(policyRuntime).update(policySnapshot(4, ["provider/image-model", "provider/video-model"]));
    const policy = new ToonModelPolicyStore(policyRuntime);
    let imageSubmissions = 0;
    let videoSubmissions = 0;
    const fx = harness({
      modelPolicy: policy,
      imageAction: async () => { imageSubmissions += 1; return { ok: true, result: { artifact: { path: "artifacts/restarted.png", mimeType: "image/png", bytes: 8 } } }; },
      runtime: {
        status: async () => ({}), listModels: async () => ({ models: [] }),
        generate: async () => { videoSubmissions += 1; return { job: { id: "runtime-restarted", status: "submitted" } }; },
        getJob: async () => ({ job: { id: "runtime-restarted", status: "running" } }),
        cancelJob: async () => ({}),
      },
    });
    const image = fx.jobs.create("workspace-1", "project-1", request("image", { requestId: "restart-image", plan: { ...request("image").plan, quantity: 1, executionCount: 1 } }));
    const video = fx.jobs.create("workspace-1", "project-1", request("video", { requestId: "restart-video" }));
    fx.service.start();
    await waitFor(() => fx.jobs.require(image.id).status === "awaiting-review" && Boolean(fx.jobs.require(video.id).candidates[0]?.runtimeJobId));
    expect(imageSubmissions).toBe(1);
    expect(videoSubmissions).toBe(1);
    await fx.service.dispose();
    policyRuntime.close();
  });

  test("policy sync automatically continues pending media jobs", async () => {
    const policy = new ToonModelPolicyStore();
    let submissions = 0;
    const fx = harness({ modelPolicy: policy, imageAction: async () => {
      submissions += 1;
      return { ok: true, result: { artifact: { path: "artifacts/synced.png", mimeType: "image/png", bytes: 8 } } };
    } });
    const job = fx.jobs.create("workspace-1", "project-1", request("image", { requestId: "sync-image", plan: { ...request("image").plan, quantity: 1, executionCount: 1 } }));
    fx.service.start();
    await Bun.sleep(25);
    expect(fx.jobs.require(job.id).status).toBe("queued");
    policy.update(policySnapshot(1, ["provider/image-model"]));
    await waitFor(() => fx.jobs.require(job.id).status === "awaiting-review");
    expect(submissions).toBe(1);
    await fx.service.dispose();
  });

  test("an already submitted video keeps polling with missing policy and is never resubmitted", async () => {
    let submissions = 0;
    let polls = 0;
    const jobs = repository();
    const created = jobs.create("workspace-1", "project-1", request("video", { requestId: "submitted-video" }));
    jobs.update(created.id, (current, now) => ({
      ...current,
      status: "running",
      candidates: current.candidates.map((candidate) => ({ ...candidate, runtimeJobId: "runtime-existing", status: "running", updatedAt: now })),
    }));
    const fx = harness({ jobs, modelPolicy: new ToonModelPolicyStore(), runtime: {
      status: async () => ({}), listModels: async () => ({ models: [] }),
      generate: async () => { submissions += 1; return { job: { id: "runtime-duplicate", status: "submitted" } }; },
      getJob: async () => { polls += 1; return { job: { id: "runtime-existing", status: "completed", artifact: { path: "artifacts/existing.mp4", mimeType: "video/mp4", bytes: 12 } } }; },
      cancelJob: async () => ({}),
    } });
    fx.service.start();
    await waitFor(() => jobs.require(created.id).status === "awaiting-review");
    expect(polls).toBeGreaterThan(0);
    expect(submissions).toBe(0);
    expect(jobs.require(created.id).candidates[0]?.runtimeJobId).toBe("runtime-existing");
    await fx.service.dispose();
  });

  test("uses a generated workspace image as the real image-to-video source and rejects traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "toon-reference-"));
    roots.push(root);
    await mkdir(join(root, "artifacts"), { recursive: true });
    const generated = join(root, "artifacts/generated.png");
    await writeFile(generated, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const jobs = repository();
    let sourceImagePath = "";
    const runtime: MediaGenerationExtensionRuntime = {
      status: async () => ({}), listModels: async () => ({ models: [] }),
      generate: async (input) => { sourceImagePath = input.sourceImagePath ?? ""; return { job: { id: "runtime-reference", status: "submitted" } }; },
      getJob: async () => ({ job: { id: "runtime-reference", status: "running" } }),
      cancelJob: async () => ({}),
    };
    const service = new ToonMediaJobService({
      jobs,
      repository: async () => ({
        assertMediaJobPrerequisites: async () => undefined,
        resolveMediaReference: async (_projectId: string, reference: { scope: string; path: string }) => {
          if (reference.path.includes("..")) throw new ApiError(400, "path_escape", "unsafe");
          return join(root, reference.path);
        },
        writeMediaJobManifest: async () => undefined,
        reconcileMediaJob: async () => ({} as never),
        ownsMediaJob: async () => true,
      }) as never,
      imageAction: async () => ({}),
      mediaGeneration: runtime,
    });
    const base = request("video") as ToonMediaJobCreateRequest & { plan: Extract<ToonMediaJobCreateRequest["plan"], { kind: "video" }> };
    const plan = { ...base.plan, mode: "image-to-video" as const, referencePaths: ["artifacts/generated.png"], referenceScope: "workspace" as const };
    const unsigned = { ...base, requestId: "video-reference", plan };
    const { authorization: _authorization, ...snapshot } = unsigned;
    const job = jobs.create("workspace-1", "project-1", { ...unsigned, authorization: createToonMediaAuthorization(toonMediaRequestHash({ ...snapshot, projectId: "project-1" })) });
    service.dispatch(job.id);
    await waitFor(() => Boolean(jobs.require(job.id).candidates[0]?.runtimeJobId));
    expect(sourceImagePath).toBe(generated);
    const safeRepository = new ToonFactoryRepository(root);
    const project = await safeRepository.createProject({ name: "References", directory: "toons/references" });
    await expect(safeRepository.resolveMediaReference(project.project.id, { scope: "workspace", path: "../outside.png" } as never)).rejects.toThrow();
  });

  test("automatically retries a one-shot terminal projection failure in the same process", async () => {
    const jobs = repository();
    let attempts = 0;
    let terminalAttempts = 0;
    const fx = harness({ jobs });
    const originalRepository = fx.service["options"].repository;
    fx.service["options"].repository = async (workspaceId: string) => {
      const repository = await originalRepository(workspaceId) as any;
      return { ...repository, writeMediaJobManifest: async (projected: ToonMediaJob) => {
        attempts += 1;
        if (projected.status === "awaiting-review" && ++terminalAttempts === 1) throw new Error("one-shot I/O failure");
      } } as never;
    };
    const job = jobs.create("workspace-1", "project-1", request("image", { plan: { ...request("image").plan, quantity: 1, executionCount: 1 } }));
    fx.service.start();
    await waitFor(() => jobs.require(job.id).status === "awaiting-review" && jobs.require(job.id).projectionPending === true);
    for (let attempt = 0; attempt < 300 && (terminalAttempts < 2 || jobs.require(job.id).projectionPending === true); attempt += 1) await Bun.sleep(10);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(terminalAttempts).toBeGreaterThanOrEqual(2);
    expect(jobs.require(job.id).projectionPending).not.toBe(true);
    await fx.service.dispose();
  });

  test("submission_unknown is terminal and never automatically resubmitted", async () => {
    let submissions = 0;
    const runtime: MediaGenerationExtensionRuntime = {
      status: async () => ({}), listModels: async () => ({ models: [] }),
      generate: async () => { submissions += 1; throw new Error("transport closed after submission"); },
      getJob: async () => { throw new Error("must not inspect without a runtime job"); },
      cancelJob: async () => ({}),
    };
    const fx = harness({ runtime });
    const job = fx.jobs.create("workspace-1", "project-1", request("video"));
    fx.service.start();
    await waitFor(() => fx.jobs.require(job.id).status === "submission_unknown");
    await Bun.sleep(20);
    expect(submissions).toBe(1);
    expect(fx.jobs.require(job.id).candidates[0]?.error?.retryable).toBe(false);
    await fx.service.dispose();
  });

  test("recovers a crash after inner idempotent submission before the outer runtime ID write", async () => {
    let calls = 0;
    const seen = new Map<string, string>();
    const runtime: MediaGenerationExtensionRuntime = {
      status: async () => ({}), listModels: async () => ({ models: [] }),
      generate: async (input) => {
        calls += 1;
        const id = seen.get(input.clientRequestId) ?? "runtime-stable";
        seen.set(input.clientRequestId, id);
        return { job: { id, status: "submitted" } };
      },
      getJob: async () => ({ job: { id: "runtime-stable", status: "running" } }),
      cancelJob: async () => ({}),
    };
    const jobs = repository();
    const created = jobs.create("workspace-1", "project-1", request("video"));
    jobs.update(created.id, (current, now) => ({
      ...current,
      status: "submitting",
      candidates: current.candidates.map((candidate) => ({ ...candidate, status: "submitting", updatedAt: now })),
    }));
    const fx = harness({ jobs, runtime });
    fx.service.start();
    await waitFor(() => jobs.require(created.id).candidates[0]?.runtimeJobId === "runtime-stable");
    expect(calls).toBe(1);
    expect(jobs.require(created.id).status).toBe("running");
    await fx.service.dispose();
  });

  test("cancel wins before each candidate submit and an old execution cannot revive it", async () => {
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let submissions = 0;
    const runtime: MediaGenerationExtensionRuntime = {
      status: async () => ({}), listModels: async () => ({ models: [] }),
      generate: async () => {
        submissions += 1;
        if (submissions === 1) await firstStarted;
        return { job: { id: `runtime-${submissions}`, status: "submitted" } };
      },
      getJob: async () => ({ job: { id: "runtime-1", status: "running" } }),
      cancelJob: async () => ({}),
    };
    const fx = harness({ runtime });
    const input = request("video");
    input.plan = { ...input.plan, quantity: 2, executionCount: 2 };
    const snapshot = { ...input, projectId: "project-1" } as ToonMediaJobRequestSnapshot;
    delete (snapshot as Partial<ToonMediaJobCreateRequest>).authorization;
    input.authorization = createToonMediaAuthorization(toonMediaRequestHash(snapshot));
    const job = fx.jobs.create("workspace-1", "project-1", input);
    fx.service.dispatch(job.id);
    await waitFor(() => fx.jobs.require(job.id).candidates[0]?.status === "submitting");
    const cancelled = await fx.service.cancel(job.id);
    releaseFirst();
    await Bun.sleep(20);
    expect(submissions).toBe(1);
    expect(cancelled.candidates[0]?.status).toBe("submission_unknown");
    expect(fx.jobs.require(job.id).status).not.toBe("running");
    expect(fx.jobs.require(job.id).candidates[1]?.status).toBe("cancelled");
  });

  test("cancellation reports that the provider may continue", async () => {
    let cancelCalls = 0;
    const runtime: MediaGenerationExtensionRuntime = {
      status: async () => ({}), listModels: async () => ({ models: [] }),
      generate: async () => ({ job: { id: "runtime-video", status: "submitted" } }),
      getJob: async () => ({ job: { id: "runtime-video", status: "running" } }),
      cancelJob: async () => { cancelCalls += 1; return { job: { id: "runtime-video", status: "cancel_requested" } }; },
    };
    const fx = harness({ runtime });
    const job = fx.jobs.create("workspace-1", "project-1", request("video"));
    fx.service.dispatch(job.id);
    await waitFor(() => Boolean(fx.jobs.require(job.id).candidates[0]?.runtimeJobId));
    const cancelled = await fx.service.cancel(job.id);
    expect(cancelCalls).toBe(1);
    expect(cancelled.status).toBe("cancel_requested");
    expect(cancelled.cancellation).toMatchObject({ remoteMayContinue: true });
  });

  test("image cancellation is not offered when the underlying runtime cannot cancel", async () => {
    const fx = harness({});
    const job = fx.jobs.create("workspace-1", "project-1", request("image"));
    await expect(fx.service.cancel(job.id)).rejects.toThrow("does not support cancellation");
  });

  test("retry is non-destructive and changed scope requires a new authorization", () => {
    const jobs = repository();
    const originalRequest = request("video");
    const original = jobs.create("workspace-1", "project-1", originalRequest);
    const changed = {
      ...originalRequest,
      requestId: "retry-request",
      retryOf: original.id,
      plan: { ...originalRequest.plan, durationSeconds: 8, resolution: "1080p" as const },
    } as ToonMediaJobCreateRequest;
    expect(() => jobs.create("workspace-1", "project-1", changed)).toThrow("generation plan changed");
    const { authorization: _authorization, ...requestWithoutAuthorization } = changed;
    const snapshot = { ...requestWithoutAuthorization, projectId: "project-1" } as ToonMediaJobRequestSnapshot;
    const retry = jobs.create("workspace-1", "project-1", { ...changed, authorization: createToonMediaAuthorization(toonMediaRequestHash(snapshot)) });
    expect(retry.requestSnapshot.retryOf).toBe(original.id);
    expect(new Set(jobs.list("workspace-1", "project-1").map((job) => job.id))).toEqual(new Set([retry.id, original.id]));
  });

  test("concurrent createOrGet calls produce one media job", async () => {
    const jobs = repository();
    const input = request("video");
    const results = await Promise.all(Array.from({ length: 16 }, async () => jobs.createOrGet("workspace-1", "project-1", input)));
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(jobs.list("workspace-1", "project-1")).toHaveLength(1);
  });

  test("an adopted candidate cannot be rejected", async () => {
    const fx = harness({});
    const created = fx.jobs.create("workspace-1", "project-1", request("image"));
    fx.jobs.update(created.id, (job, now) => ({
      ...job,
      status: "awaiting-review",
      candidates: job.candidates.map((candidate, index) => index === 0 ? {
        ...candidate,
        status: "awaiting-review",
        artifact: { scope: "workspace", path: "artifacts/fake.png", mimeType: "image/png", bytes: 8 },
        updatedAt: now,
      } : { ...candidate, status: "rejected", review: { decision: "rejected", reviewedAt: now }, updatedAt: now }),
    }));
    const candidateId = fx.jobs.require(created.id).candidates[0]!.id;
    await fx.service.review(created.id, candidateId, "adopted");
    await expect(fx.service.review(created.id, candidateId, "rejected")).rejects.toThrow("not ready for review");
    expect(fx.jobs.require(created.id).candidates[0]?.status).toBe("adopted");
  });

  test("adoption links the candidate to node, episode, and workflow without approving content", async () => {
    const root = await mkdtemp(join(tmpdir(), "toon-media-adoption-"));
    roots.push(root);
    const projectRepository = new ToonFactoryRepository(root);
    const created = await projectRepository.createProject({ name: "Series", directory: "toons/series" });
    const now = new Date().toISOString();
    const project = {
      ...created.project,
      episodes: [{
        id: "episode-1", title: "Episode 1", ordinal: 1, canvasId: "canvas-1",
        stages: [{ stage: "images" as const, status: "awaiting-review" as const, updatedAt: now }],
        steps: [{ id: "image-candidates", stage: "images" as const, title: "Images", status: "awaiting-review" as const, dependencies: [], contentApprovals: [], computeAuthorizations: [], resultAdoptions: [], history: [], updatedAt: now }],
        createdAt: now, updatedAt: now,
      }],
      updatedAt: now,
    };
    await projectRepository.updateProject(created.project.id, { project, expectedRevision: created.revision });
    await projectRepository.writeCanvas(created.project.id, "canvas-1", { canvas: {
      schemaVersion: 1, id: "canvas-1", name: "Episode 1", edges: [], viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{ id: "image-node", kind: "image-generation", position: { x: 0, y: 0 }, handles: [], data: {} }],
    } });
    const jobs = repository();
    const jobRequest = { ...request("image"), nodeId: "image-node", canvasId: "canvas-1" };
    const { authorization: _authorization, ...jobRequestWithoutAuthorization } = jobRequest;
    const job = jobs.create("workspace-1", created.project.id, {
      ...jobRequest,
      authorization: createToonMediaAuthorization(toonMediaRequestHash({ ...jobRequestWithoutAuthorization, projectId: created.project.id })),
    });
    const queued = await projectRepository.queueMediaJob(job);
    expect(queued.project.episodes[0]!.steps![0]!.contentApprovals).toEqual([]);
    expect(queued.project.episodes[0]!.steps![0]!.computeAuthorizations).toEqual([expect.objectContaining({ id: job.authorization.id, scopeRevision: job.requestHash })]);
    const candidate = { ...job.candidates[0]!, status: "awaiting-review" as const, artifact: { scope: "workspace" as const, path: "artifacts/candidate.png", mimeType: "image/png", bytes: 8 } };
    await expect(projectRepository.adoptMediaCandidate(job, candidate)).rejects.toThrow("content not found");
    await mkdir(join(root, "artifacts"), { recursive: true });
    await writeFile(join(root, "artifacts/candidate.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const adopted = await projectRepository.adoptMediaCandidate(job, candidate);
    const step = adopted.project.episodes[0]!.steps![0]!;
    expect(step.status).toBe("adopted");
    expect(step.contentApprovals).toEqual([]);
    expect(step.resultAdoptions).toEqual([expect.objectContaining({ resultId: candidate.id, artifactPath: "artifacts/candidate.png" })]);
    expect((await projectRepository.readCanvas(created.project.id, "canvas-1")).canvas.nodes[0]?.data.generationRecordId).toBe(job.id);
  });
});

function policySnapshot(revision: number, allowedModels: string[]) {
  const content = { workspaceId: "workspace-1", signedIn: true, policyFresh: true, organizationId: "org-1", userId: "user-1", allowedModels, validatedAt: new Date().toISOString() };
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}` : JSON.stringify(value);
  return { ...content, revision, digest: createHash("sha256").update(canonical(content)).digest("hex") };
}
