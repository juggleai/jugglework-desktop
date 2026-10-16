import type {
  ToonCanvas,
  ToonDeliveryManifest,
  ToonEdge,
  ToonEpisode,
  ToonHandle,
  ToonNode,
  ToonNodeKind,
  ToonWorkflowStage,
  ToonWorkflowStep,
} from "@jugglework/types/toon-factory";

export type ToonNodeDefinition = {
  kind: ToonNodeKind;
  labelKey: string;
  handles: ToonHandle[];
  externalText: boolean;
};

export const TOON_NODE_DEFINITIONS: readonly ToonNodeDefinition[] = [
  { kind: "text", labelKey: "toon_factory.node_text", externalText: true, handles: [{ id: "text-in", direction: "target", dataType: "text" }, { id: "text-out", direction: "source", dataType: "text" }] },
  { kind: "asset", labelKey: "toon_factory.node_asset", externalText: true, handles: [{ id: "asset-out", direction: "source", dataType: "asset" }] },
  { kind: "storyboard", labelKey: "toon_factory.node_storyboard", externalText: true, handles: [{ id: "text-in", direction: "target", dataType: "text" }, { id: "asset-in", direction: "target", dataType: "asset" }, { id: "storyboard-out", direction: "source", dataType: "storyboard" }] },
  { kind: "image-asset", labelKey: "toon_factory.node_image_asset", externalText: false, handles: [{ id: "image-in", direction: "target", dataType: "image" }, { id: "image-out", direction: "source", dataType: "image" }] },
  { kind: "video-asset", labelKey: "toon_factory.node_video_asset", externalText: false, handles: [{ id: "video-in", direction: "target", dataType: "video" }, { id: "video-out", direction: "source", dataType: "video" }] },
  { kind: "image-generation", labelKey: "toon_factory.node_image_generation", externalText: false, handles: [{ id: "prompt-in", direction: "target", dataType: "text" }, { id: "storyboard-in", direction: "target", dataType: "storyboard" }, { id: "asset-in", direction: "target", dataType: "asset" }, { id: "image-out", direction: "source", dataType: "image" }] },
  { kind: "video-generation", labelKey: "toon_factory.node_video_generation", externalText: false, handles: [{ id: "prompt-in", direction: "target", dataType: "text" }, { id: "storyboard-in", direction: "target", dataType: "storyboard" }, { id: "image-in", direction: "target", dataType: "image" }, { id: "video-out", direction: "source", dataType: "video" }] },
] as const;

const STAGE_STEPS: ReadonlyArray<{ id: string; stage: ToonWorkflowStage; titleKey: string; dependencies: string[] }> = [
  { id: "source-material", stage: "content-script", titleKey: "toon_factory.step_source_material", dependencies: [] },
  { id: "episode-script", stage: "content-script", titleKey: "toon_factory.step_episode_script", dependencies: ["source-material"] },
  { id: "asset-plan", stage: "assets", titleKey: "toon_factory.step_asset_plan", dependencies: ["episode-script"] },
  { id: "direction", stage: "directing-storyboard", titleKey: "toon_factory.step_direction", dependencies: ["episode-script", "asset-plan"] },
  { id: "storyboard", stage: "directing-storyboard", titleKey: "toon_factory.step_storyboard", dependencies: ["direction"] },
  { id: "image-candidates", stage: "images", titleKey: "toon_factory.step_image_candidates", dependencies: ["storyboard", "asset-plan"] },
  { id: "video-clips", stage: "videos", titleKey: "toon_factory.step_video_clips", dependencies: ["image-candidates", "storyboard"] },
  { id: "adopt-clips", stage: "adoption-delivery", titleKey: "toon_factory.step_adopt_clips", dependencies: ["video-clips"] },
  { id: "delivery-manifest", stage: "adoption-delivery", titleKey: "toon_factory.step_delivery_manifest", dependencies: ["adopt-clips"] },
];

export function createEpisodeWorkflowSteps(now: string, title: (key: string) => string): ToonWorkflowStep[] {
  return STAGE_STEPS.map((step) => ({
    id: step.id,
    stage: step.stage,
    title: title(step.titleKey),
    status: step.dependencies.length === 0 ? "pending-confirmation" : "draft",
    dependencies: [...step.dependencies],
    contentApprovals: [],
    computeAuthorizations: [],
    resultAdoptions: [],
    history: [],
    updatedAt: now,
  }));
}

export function handlesAreCompatible(source: ToonHandle, target: ToonHandle): boolean {
  return source.direction === "source"
    && target.direction === "target"
    && (source.dataType === "any" || target.dataType === "any" || source.dataType === target.dataType);
}

export function validateToonConnection(canvas: ToonCanvas, edge: Omit<ToonEdge, "id">): { valid: true } | { valid: false; reason: "missing-node" | "missing-handle" | "wrong-direction" | "incompatible-type" } {
  const sourceNode = canvas.nodes.find((node) => node.id === edge.sourceNodeId);
  const targetNode = canvas.nodes.find((node) => node.id === edge.targetNodeId);
  if (!sourceNode || !targetNode) return { valid: false, reason: "missing-node" };
  const source = sourceNode.handles.find((handle) => handle.id === edge.sourceHandleId);
  const target = targetNode.handles.find((handle) => handle.id === edge.targetHandleId);
  if (!source || !target) return { valid: false, reason: "missing-handle" };
  if (source.direction !== "source" || target.direction !== "target") return { valid: false, reason: "wrong-direction" };
  if (!handlesAreCompatible(source, target)) return { valid: false, reason: "incompatible-type" };
  return { valid: true };
}

function historyEntry(step: ToonWorkflowStep, now: string) {
  return {
    id: `version-${step.id}-${step.history.length + 1}`,
    status: step.status,
    ...(step.inputRevision ? { inputRevision: step.inputRevision } : {}),
    ...(step.outputRevision ? { outputRevision: step.outputRevision } : {}),
    recordedAt: now,
  } as const;
}

export function approveWorkflowStep(step: ToonWorkflowStep, outputRevision: string, now: string): ToonWorkflowStep {
  return {
    ...step,
    status: "approved",
    outputRevision,
    skipReason: undefined,
    staleReason: undefined,
    contentApprovals: [...step.contentApprovals, { id: `approval-${step.id}-${step.contentApprovals.length + 1}`, outputRevision, approvedAt: now }],
    history: [...step.history, historyEntry(step, now)],
    updatedAt: now,
  };
}

export function workflowApprovalRevision(step: ToonWorkflowStep, evidence?: { deliveryManifestRevision?: string | null }): string | null {
  if (step.id === "delivery-manifest") return evidence?.deliveryManifestRevision ?? null;
  if (step.id === "image-candidates" || step.id === "video-clips" || step.id === "adopt-clips") {
    return null;
  }
  return step.generatedResults?.at(-1)?.outputRevision ?? step.outputRevision ?? null;
}

export function skipWorkflowStep(step: ToonWorkflowStep, reason: string, now: string): ToonWorkflowStep {
  const normalized = reason.trim();
  if (!normalized) throw new Error("A skip reason is required");
  return {
    ...step,
    status: "skipped",
    skipReason: normalized,
    staleReason: undefined,
    history: [...step.history, historyEntry(step, now)],
    updatedAt: now,
  };
}

export function authorizeWorkflowCompute(step: ToonWorkflowStep, scopeRevision: string, now: string): ToonWorkflowStep {
  return {
    ...step,
    computeAuthorizations: [...step.computeAuthorizations, { id: `authorization-${step.id}-${step.computeAuthorizations.length + 1}`, scopeRevision, authorizedAt: now }],
    updatedAt: now,
  };
}

export function workflowStepAvailable(steps: readonly ToonWorkflowStep[], step: ToonWorkflowStep): boolean {
  return step.dependencies.every((dependencyId) => {
    const dependency = steps.find((candidate) => candidate.id === dependencyId);
    return dependency !== undefined && (dependency.status === "approved" || dependency.status === "adopted" || dependency.status === "skipped");
  });
}

export function updateWorkflowStep(
  steps: readonly ToonWorkflowStep[],
  stepId: string,
  update: (step: ToonWorkflowStep) => ToonWorkflowStep,
): ToonWorkflowStep[] {
  const updated = steps.map((step) => step.id === stepId ? update(step) : step);
  return updated.map((step) => step.status === "draft" && workflowStepAvailable(updated, step)
    ? { ...step, status: "pending-confirmation", updatedAt: updated.find((candidate) => candidate.id === stepId)?.updatedAt ?? step.updatedAt }
    : step);
}

export function synchronizeEpisodeStages(episode: ToonEpisode, now: string): ToonEpisode {
  const steps = episode.steps ?? [];
  const stages = episode.stages.map((stage) => {
    const stageSteps = steps.filter((step) => step.stage === stage.stage);
    if (stageSteps.length === 0) return stage;
    let status = stage.status;
    if (stageSteps.some((step) => step.status === "stale")) status = "stale";
    else if (stageSteps.every((step) => step.status === "skipped")) status = "skipped";
    else if (stageSteps.every((step) => step.status === "approved" || step.status === "adopted" || step.status === "skipped")) status = "approved";
    else if (stageSteps.some((step) => step.status === "pending-confirmation")) status = "pending-confirmation";
    else status = "draft";
    return status === stage.status ? stage : { ...stage, status, updatedAt: now };
  });
  return { ...episode, stages, updatedAt: now };
}

export function adoptWorkflowResult(step: ToonWorkflowStep, resultId: string, now: string, artifactPath?: string): ToonWorkflowStep {
  return {
    ...step,
    status: "adopted",
    resultAdoptions: [...step.resultAdoptions, {
      id: `adoption-${step.id}-${step.resultAdoptions.length + 1}`,
      resultId,
      ...(artifactPath ? { artifactPath, artifactScope: "project" as const } : {}),
      adoptedAt: now,
    }],
    history: [...step.history, historyEntry(step, now)],
    updatedAt: now,
  };
}

export function markDownstreamStepsStale(steps: readonly ToonWorkflowStep[], changedStepId: string, now: string): ToonWorkflowStep[] {
  const affected = new Set([changedStepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (!affected.has(step.id) && step.dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(step.id);
        changed = true;
      }
    }
  }
  affected.delete(changedStepId);

  return steps.map((step) => {
    if (!affected.has(step.id) || step.status === "draft" || step.status === "skipped" || step.status === "stale") return step;
    return {
      ...step,
      status: "stale",
      staleReason: `upstream:${changedStepId}`,
      history: [...step.history, historyEntry(step, now)],
      updatedAt: now,
    };
  });
}

export function applyUpstreamRevision(episode: ToonEpisode, stepId: string, outputRevision: string, now: string): ToonEpisode {
  const steps = episode.steps ?? [];
  const revised = steps.map((step) => step.id === stepId ? {
    ...step,
    status: "pending-confirmation" as const,
    outputRevision,
    staleReason: undefined,
    history: [...step.history, historyEntry(step, now)],
    updatedAt: now,
  } : step);
  return synchronizeEpisodeStages({ ...episode, steps: markDownstreamStepsStale(revised, stepId, now), updatedAt: now }, now);
}

export function episodeProgress(episode: ToonEpisode): { completed: number; total: number; percent: number; complete: boolean } {
  const steps = episode.steps ?? [];
  const completed = steps.filter((step) => step.status === "approved" || step.status === "adopted" || step.status === "skipped").length;
  const total = steps.length;
  return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100), complete: total > 0 && completed === total };
}

export function episodeDeliveryDescription(episode: ToonEpisode): "adopted-clips-manifest" | "no-adopted-clips" {
  const hasAdoptedClips = (episode.steps ?? []).some((step) => step.id === "video-clips" && step.resultAdoptions.some((adoption) => !adoption.supersededAt));
  return hasAdoptedClips ? "adopted-clips-manifest" : "no-adopted-clips";
}

export function deliveryManifestIsCurrent(episode: ToonEpisode, manifest: ToonDeliveryManifest | null | undefined): boolean {
  if (!manifest) return false;
  const currentAdoptions = (episode.steps ?? []).flatMap((step) => step.resultAdoptions.filter((adoption) => !adoption.supersededAt));
  const recordedAdoptionIds = new Set([
    ...manifest.artifacts.map((artifact) => artifact.adoptionId),
    ...manifest.omissions.flatMap((omission) => omission.adoptionId ? [omission.adoptionId] : []),
  ]);
  return currentAdoptions.every((adoption) => recordedAdoptionIds.has(adoption.id) && Date.parse(adoption.adoptedAt) <= Date.parse(manifest.createdAt))
    && manifest.artifacts.every((artifact) => currentAdoptions.some((adoption) => adoption.id === artifact.adoptionId));
}

export function createNode(kind: ToonNodeKind, id: string, index: number): ToonNode {
  const definition = TOON_NODE_DEFINITIONS.find((item) => item.kind === kind);
  if (!definition) throw new Error(`Unknown Toon Factory node kind: ${kind}`);
  return {
    id,
    kind,
    position: { x: 80 + (index % 3) * 260, y: 80 + Math.floor(index / 3) * 180 },
    handles: definition.handles.map((handle) => ({ ...handle })),
    data: {
      ...(definition.externalText ? { contentRef: `content/nodes/${id}.md` } : {}),
    },
  };
}
