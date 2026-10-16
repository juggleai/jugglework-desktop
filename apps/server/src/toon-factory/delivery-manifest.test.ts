import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toonDeliveryManifestSchema, type ToonMediaJob, type ToonProjectResponse } from "@jugglework/types/toon-factory";
import { ToonFactoryRepository } from "./repository.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "toon-delivery-"));
  roots.push(root);
  const repository = new ToonFactoryRepository(root);
  const created = await repository.createProject({ name: "Series", directory: "toons/series" });
  const now = "2026-10-17T10:00:00.000Z";
  const project: ToonProjectResponse["project"] = {
    ...created.project,
    episodes: [{
      id: "episode-1", title: "Episode 1", ordinal: 1, canvasId: "main",
      stages: [{ stage: "images", status: "adopted", updatedAt: now }, { stage: "videos", status: "adopted", updatedAt: now }],
      steps: [
        { id: "image-candidates", stage: "images", title: "Images", status: "adopted", dependencies: [], contentApprovals: [], computeAuthorizations: [], resultAdoptions: [{ id: "adoption-image", resultId: "candidate-image", artifactPath: "artifacts/adopted.png", artifactScope: "workspace", adoptedAt: now }], history: [], updatedAt: now },
        { id: "video-clips", stage: "videos", title: "Clips", status: "adopted", dependencies: [], contentApprovals: [], computeAuthorizations: [], resultAdoptions: [{ id: "adoption-video", resultId: "candidate-video", artifactPath: "artifacts/missing.mp4", artifactScope: "workspace", adoptedAt: now }], history: [], updatedAt: now },
      ],
      createdAt: now, updatedAt: now,
    }],
    updatedAt: now,
  };
  await repository.updateProject(created.project.id, { project, expectedRevision: created.revision });
  await mkdir(join(root, "artifacts"), { recursive: true });
  await writeFile(join(root, "artifacts/adopted.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const provenance = { model: { kind: "image" as const, providerID: "provider", modelID: "model" }, prompt: "prompt", mode: "text-to-image", referencePaths: [], referenceScope: "workspace" as const, parameters: {} };
  const base = { schemaVersion: 1 as const, workspaceId: "workspace-1", projectId: created.project.id, episodeId: "episode-1", canvasId: "main", requestHash: "a".repeat(64), authorization: { id: "authorization-1", scopeHash: "a".repeat(64), authorizedAt: now }, status: "adopted" as const, cancellation: undefined, createdAt: now, updatedAt: now };
  const imageJob = {
    ...base, id: "job-image", nodeId: "image-node", stepId: "image-candidates", kind: "image" as const,
    requestSnapshot: { requestId: "request-image", projectId: created.project.id, episodeId: "episode-1", canvasId: "main", nodeId: "image-node", stepId: "image-candidates", plan: { kind: "image" as const, model: provenance.model, object: "image", quantity: 1, prompt: "prompt", referencePaths: [], referenceScope: "workspace" as const, executionCount: 1, knownCost: null, mode: "text-to-image" as const } },
    candidates: [
      { id: "candidate-image", ordinal: 1, status: "adopted" as const, runtime: "openai-image-generation" as const, artifact: { scope: "workspace" as const, path: "artifacts/adopted.png", mimeType: "image/png", bytes: 8 }, provenance, review: { decision: "adopted" as const, reviewedAt: now }, createdAt: now, updatedAt: now },
      { id: "candidate-unadopted", ordinal: 2, status: "awaiting-review" as const, runtime: "openai-image-generation" as const, artifact: { scope: "workspace" as const, path: "artifacts/unadopted.png", mimeType: "image/png", bytes: 8 }, provenance, review: { decision: "pending" as const }, createdAt: now, updatedAt: now },
    ],
  } satisfies ToonMediaJob;
  const videoJob = {
    ...base, id: "job-video", nodeId: "video-node", stepId: "video-clips", kind: "video" as const,
    requestSnapshot: { requestId: "request-video", projectId: created.project.id, episodeId: "episode-1", canvasId: "main", nodeId: "video-node", stepId: "video-clips", plan: { kind: "video" as const, model: { kind: "video" as const, providerID: "provider", modelID: "video" }, object: "clip", quantity: 1, prompt: "clip prompt", referencePaths: [], referenceScope: "workspace" as const, executionCount: 1, knownCost: null, mode: "text-to-video" as const, durationSeconds: 5, resolution: "720p" } },
    candidates: [{ id: "candidate-video", ordinal: 1, status: "adopted" as const, runtime: "media-generation" as const, artifact: { scope: "workspace" as const, path: "artifacts/missing.mp4", mimeType: "video/mp4", bytes: 12 }, provenance: { ...provenance, model: { kind: "video" as const, providerID: "provider", modelID: "video" }, prompt: "clip prompt", mode: "text-to-video" }, review: { decision: "adopted" as const, reviewedAt: now }, createdAt: now, updatedAt: now }],
  } satisfies ToonMediaJob;
  return { root, repository, projectId: created.project.id, jobs: [imageJob, videoJob] };
}

describe("Toon Factory delivery manifests", () => {
  test("rejects non-relative paths in the shared delivery contract", () => {
    const base = {
      schemaVersion: 1, manifestVersion: 1, id: "manifest-1", projectId: "project-1", episodeId: "episode-1", createdAt: "2026-10-17T10:00:00.000Z",
      artifacts: [], omissions: [], deliveryType: "adopted-media-and-manifest",
      composition: { status: "not-produced", excludedCapabilities: ["timeline", "composition", "subtitles", "audio-mixing"] },
    };
    for (const path of ["../clip.mp4", "/tmp/clip.mp4", "C:/clip.mp4"]) {
      expect(toonDeliveryManifestSchema.safeParse({ ...base, omissions: [{ kind: "video", code: "artifact_missing", reason: "missing", path }] }).success).toBe(false);
    }
  });

  test("persists validated adopted outputs at the real export path and reports missing outputs", async () => {
    const fx = await fixture();
    const response = await fx.repository.createDeliveryManifest(fx.projectId, "episode-1", fx.jobs, { expectedRevision: null });
    expect(response.path).toBe("toons/series/exports/episodes/episode-1/delivery-manifest.json");
    expect(response.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(response.manifest?.artifacts).toEqual([expect.objectContaining({ id: "adoption-image", path: "artifacts/adopted.png", generationRecordId: "job-image", candidateId: "candidate-image", mimeType: "image/png", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    expect(response.manifest?.artifacts.some((artifact) => artifact.candidateId === "candidate-unadopted")).toBe(false);
    expect(response.manifest?.omissions).toEqual([expect.objectContaining({ kind: "video", code: "artifact_missing", path: "artifacts/missing.mp4" })]);
    expect(response.manifest?.composition).toEqual({ status: "not-produced", excludedCapabilities: ["timeline", "composition", "subtitles", "audio-mixing"] });
    expect(JSON.parse(await readFile(join(fx.root, response.path!), "utf8"))).toEqual(response.manifest);
    await expect(fx.repository.createDeliveryManifest(fx.projectId, "episode-1", fx.jobs, { expectedRevision: "b".repeat(64) })).rejects.toThrow("changed since it was loaded");
  });

  test("rejects unsafe adopted files from delivery and only resolves listed validated artifacts", async () => {
    const fx = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "toon-delivery-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "escaped.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await symlink(join(outside, "escaped.png"), join(fx.root, "artifacts/adopted.png.tmp"));
    await rm(join(fx.root, "artifacts/adopted.png"));
    await symlink(join(outside, "escaped.png"), join(fx.root, "artifacts/adopted.png"));
    const response = await fx.repository.createDeliveryManifest(fx.projectId, "episode-1", fx.jobs, { expectedRevision: null });
    expect(response.manifest?.artifacts).toEqual([]);
    expect(response.manifest?.omissions).toEqual(expect.arrayContaining([expect.objectContaining({ code: "artifact_unsafe", adoptionId: "adoption-image" })]));
    await expect(fx.repository.resolveDeliveryArtifact(fx.projectId, "episode-1", "adoption-image", fx.jobs)).rejects.toThrow("not found");
  });

  test("marks a mismatched artifact signature as an omission", async () => {
    const fx = await fixture();
    await writeFile(join(fx.root, "artifacts/adopted.png"), "not an image", "utf8");
    const response = await fx.repository.createDeliveryManifest(fx.projectId, "episode-1", fx.jobs, { expectedRevision: null });
    expect(response.manifest?.artifacts).toEqual([]);
    expect(response.manifest?.omissions).toEqual(expect.arrayContaining([expect.objectContaining({ code: "artifact_invalid_signature", adoptionId: "adoption-image" })]));
  });

  test("refuses a same-MIME artifact whose content changed after manifest creation", async () => {
    const fx = await fixture();
    const response = await fx.repository.createDeliveryManifest(fx.projectId, "episode-1", fx.jobs, { expectedRevision: null });
    expect(response.manifest?.artifacts).toHaveLength(1);
    const replacement = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]);
    await writeFile(join(fx.root, "artifacts/adopted.png"), replacement);
    await expect(fx.repository.resolveDeliveryArtifact(fx.projectId, "episode-1", "adoption-image", fx.jobs))
      .rejects.toThrow("changed after manifest validation");
  });
});
