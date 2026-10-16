import { describe, expect, test } from "bun:test";
import type { ToonCanvas, ToonEpisode, ToonWorkflowStep } from "@jugglework/types/toon-factory";

import {
  adoptWorkflowResult,
  applyUpstreamRevision,
  approveWorkflowStep,
  authorizeWorkflowCompute,
  createEpisodeWorkflowSteps,
  createNode,
  deliveryManifestIsCurrent,
  episodeDeliveryDescription,
  episodeProgress,
  skipWorkflowStep,
  updateWorkflowStep,
  validateToonConnection,
  workflowApprovalRevision,
  workflowStepAvailable,
} from "../src/react-app/domains/toon-factory/toon-factory-workflow";

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);
const NOW = "2026-10-17T10:00:00.000Z";

function episode(id: string, steps = createEpisodeWorkflowSteps(NOW, (key) => key)): ToonEpisode {
  return {
    id,
    title: id,
    ordinal: id === "episode-1" ? 1 : 2,
    canvasId: `canvas-${id}`,
    stages: [
      "content-script",
      "assets",
      "directing-storyboard",
      "images",
      "videos",
      "adoption-delivery",
    ].map((stage) => ({ stage: stage as ToonEpisode["stages"][number]["stage"], status: "draft", updatedAt: NOW })),
    steps,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function update(steps: ToonWorkflowStep[], id: string, change: (step: ToonWorkflowStep) => ToonWorkflowStep) {
  return updateWorkflowStep(steps, id, change);
}

describe("Toon Factory workflow", () => {
  test("keeps content approval, compute authorization, and result adoption as separate gates", () => {
    let steps = createEpisodeWorkflowSteps(NOW, (key) => key);
    const script = steps.find((step) => step.id === "episode-script")!;
    expect(workflowStepAvailable(steps, script)).toBe(false);

    steps = update(steps, "source-material", (step) => approveWorkflowStep(step, REVISION_A, NOW));
    expect(workflowStepAvailable(steps, steps.find((step) => step.id === "episode-script")!)).toBe(true);
    steps = update(steps, "episode-script", (step) => approveWorkflowStep(step, REVISION_B, NOW));
    const approved = steps.find((step) => step.id === "episode-script")!;
    expect(approved.contentApprovals).toHaveLength(1);
    expect(approved.computeAuthorizations).toHaveLength(0);
    expect(approved.resultAdoptions).toHaveLength(0);

    const authorized = authorizeWorkflowCompute(approved, REVISION_B, NOW);
    expect(authorized.contentApprovals).toHaveLength(1);
    expect(authorized.computeAuthorizations).toHaveLength(1);
    expect(authorized.resultAdoptions).toHaveLength(0);
    const adopted = adoptWorkflowResult(authorized, "result-1", NOW, "assets/clip-1.mp4");
    expect(adopted.resultAdoptions).toHaveLength(1);
    expect(adopted.computeAuthorizations).toHaveLength(1);
  });

  test("never substitutes a canvas revision for a step output, adoption, or manifest", () => {
    const steps = createEpisodeWorkflowSteps(NOW, (key) => key);
    expect(workflowApprovalRevision(steps.find((step) => step.id === "episode-script")!)).toBeNull();
    expect(workflowApprovalRevision({ ...steps.find((step) => step.id === "episode-script")!, outputRevision: REVISION_A })).toBe(REVISION_A);
    expect(workflowApprovalRevision({ ...steps.find((step) => step.id === "video-clips")!, outputRevision: REVISION_A })).toBeNull();
    expect(workflowApprovalRevision({ ...steps.find((step) => step.id === "delivery-manifest")!, outputRevision: REVISION_A })).toBeNull();
  });

  test("requires a skip reason and never fabricates output", () => {
    const step = createEpisodeWorkflowSteps(NOW, (key) => key)[0]!;
    expect(() => skipWorkflowStep(step, "  ", NOW)).toThrow("skip reason");
    const skipped = skipWorkflowStep(step, "No source adaptation needed", NOW);
    expect(skipped.status).toBe("skipped");
    expect(skipped.skipReason).toBe("No source adaptation needed");
    expect(skipped.outputRevision).toBeUndefined();
  });

  test("marks transitive downstream records stale while preserving versions and adoption history", () => {
    const initial = createEpisodeWorkflowSteps(NOW, (key) => key).map((step) => ({ ...step, status: "approved" as const, outputRevision: REVISION_A }));
    const withAdoption = initial.map((step) => step.id === "video-clips" ? adoptWorkflowResult(step, "clip-result", NOW, "assets/clip.mp4") : step);
    const revised = applyUpstreamRevision(episode("episode-1", withAdoption), "episode-script", REVISION_B, "2026-10-17T11:00:00.000Z");

    expect(revised.steps!.find((step) => step.id === "episode-script")!.status).toBe("pending-confirmation");
    for (const id of ["asset-plan", "direction", "storyboard", "image-candidates", "video-clips", "adopt-clips", "delivery-manifest"]) {
      expect(revised.steps!.find((step) => step.id === id)!.status).toBe("stale");
    }
    const clips = revised.steps!.find((step) => step.id === "video-clips")!;
    expect(clips.resultAdoptions).toEqual([expect.objectContaining({ resultId: "clip-result", artifactPath: "assets/clip.mp4" })]);
    expect(clips.history.length).toBeGreaterThan(0);
    expect(revised.stages.find((stage) => stage.stage === "videos")!.status).toBe("stale");
  });

  test("tracks episode progress independently", () => {
    const firstSteps = createEpisodeWorkflowSteps(NOW, (key) => key).map((step) => ({ ...step, status: "approved" as const }));
    const secondSteps = createEpisodeWorkflowSteps(NOW, (key) => key);
    expect(episodeProgress(episode("episode-1", firstSteps))).toMatchObject({ complete: true, percent: 100 });
    expect(episodeProgress(episode("episode-2", secondSteps))).toMatchObject({ complete: false, percent: 0 });
  });

  test("describes delivery as adopted clips and a manifest, never as a completed film", () => {
    const base = episode("episode-1");
    expect(episodeDeliveryDescription(base)).toBe("no-adopted-clips");
    const steps = base.steps!.map((step) => step.id === "video-clips" ? adoptWorkflowResult(step, "clip-1", NOW, "assets/clip-1.mp4") : step);
    expect(episodeDeliveryDescription({ ...base, steps })).toBe("adopted-clips-manifest");
  });

  test("marks delivery stale when the adopted candidate set changes", () => {
    const steps = episode("episode-1").steps!.map((step) => step.id === "video-clips" ? adoptWorkflowResult(step, "clip-1", NOW, "assets/clip-1.mp4") : step);
    const currentEpisode = { ...episode("episode-1"), steps };
    const adoption = steps.find((step) => step.id === "video-clips")!.resultAdoptions[0]!;
    const manifest = {
      schemaVersion: 1 as const, manifestVersion: 1 as const, id: "manifest-1", projectId: "project-1", episodeId: "episode-1", createdAt: "2026-10-17T11:00:00.000Z",
      artifacts: [{ id: adoption.id, kind: "video" as const, path: "assets/clip-1.mp4", scope: "project" as const, mimeType: "video/mp4", bytes: 12, adoptionId: adoption.id, generationRecordId: "job-1", candidateId: "clip-1", provenance: { model: { kind: "video" as const, providerID: "p", modelID: "m" }, prompt: "clip", mode: "text-to-video", referencePaths: [], referenceScope: "project" as const, parameters: {} } }],
      omissions: [], deliveryType: "adopted-media-and-manifest" as const,
      composition: { status: "not-produced" as const, excludedCapabilities: ["timeline", "composition", "subtitles", "audio-mixing"] as const },
    };
    expect(deliveryManifestIsCurrent(currentEpisode, manifest)).toBe(true);
    const changed = { ...currentEpisode, steps: currentEpisode.steps!.map((step) => step.id === "video-clips" ? adoptWorkflowResult(step, "clip-2", "2026-10-17T12:00:00.000Z", "assets/clip-2.mp4") : step) };
    expect(deliveryManifestIsCurrent(changed, manifest)).toBe(false);
  });

  test("validates typed graph handles before adding an edge", () => {
    const imageGenerator = createNode("image-generation", "image-generator", 0);
    const imageAsset = createNode("image-asset", "image-asset", 1);
    const videoAsset = createNode("video-asset", "video-asset", 2);
    const canvas: ToonCanvas = { schemaVersion: 1, id: "main", name: "Main", nodes: [imageGenerator, imageAsset, videoAsset], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    expect(validateToonConnection(canvas, { sourceNodeId: "image-generator", sourceHandleId: "image-out", targetNodeId: "image-asset", targetHandleId: "image-in" })).toEqual({ valid: true });
    expect(validateToonConnection(canvas, { sourceNodeId: "image-generator", sourceHandleId: "image-out", targetNodeId: "video-asset", targetHandleId: "video-in" })).toEqual({ valid: false, reason: "incompatible-type" });
  });
});
