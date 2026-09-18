import type { MediaGenerationCapabilities } from "@jugglework/types/media-generation";

import type {
  ComposerDraft,
  ComposerVideoAspectRatio,
  ComposerVideoGenerationOptions,
} from "@/app/types";

export type ComposerVideoModelOption = {
  providerID: string;
  modelID: string;
  providerName: string;
  modelName: string;
  capabilities?: MediaGenerationCapabilities;
};

export const VIDEO_ASPECT_RATIO_OPTIONS: readonly ComposerVideoAspectRatio[] = [
  "auto",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
  "1:1",
  "21:9",
];

export const VIDEO_DURATION_MIN_SECONDS = 4;
export const VIDEO_DURATION_MAX_SECONDS = 15;
export const VIDEO_DURATION_DEFAULT_SECONDS = 10;

const VIDEO_SIZE_BY_ASPECT_RATIO: Record<Exclude<ComposerVideoAspectRatio, "auto">, string> = {
  "3:4": "720x960",
  "4:3": "960x720",
  "9:16": "720x1280",
  "16:9": "1280x720",
  "1:1": "720x720",
  "21:9": "1680x720",
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

export function videoModelKey(model: Pick<ComposerVideoModelOption, "providerID" | "modelID">) {
  return `${model.providerID}\u0000${model.modelID}`;
}

export function parseComposerVideoModels(payload: unknown): ComposerVideoModelOption[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return [];
  const seen = new Set<string>();
  return payload.models.flatMap((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.ref)) return [];
    const providerID = typeof candidate.ref.providerID === "string" ? candidate.ref.providerID.trim() : "";
    const modelID = typeof candidate.ref.modelID === "string" ? candidate.ref.modelID.trim() : "";
    if (!providerID || !modelID || (typeof candidate.availability === "string" && candidate.availability !== "ready")) return [];
    const option: ComposerVideoModelOption = {
      providerID,
      modelID,
      providerName: typeof candidate.providerName === "string" && candidate.providerName.trim()
        ? candidate.providerName.trim()
        : providerID,
      modelName: typeof candidate.modelName === "string" && candidate.modelName.trim()
        ? candidate.modelName.trim()
        : modelID,
      ...(isRecord(candidate.capabilities) ? { capabilities: candidate.capabilities as MediaGenerationCapabilities } : {}),
    };
    const key = videoModelKey(option);
    if (seen.has(key)) return [];
    seen.add(key);
    return [option];
  });
}

export function videoGenerationSize(aspectRatio: ComposerVideoAspectRatio) {
  return aspectRatio === "auto" ? null : VIDEO_SIZE_BY_ASPECT_RATIO[aspectRatio];
}

export function buildVideoGenerationInstruction(
  prompt: string,
  options: ComposerVideoGenerationOptions,
) {
  const size = videoGenerationSize(options.aspectRatio);
  const sizeInstruction = size
    ? `Pass resolution \`${size}\` (aspect ratio ${options.aspectRatio}).`
    : "Let the provider choose the output aspect ratio automatically; omit resolution.";

  return [
    "Generate exactly one video for the request below using the JuggleWork video-generation tools.",
    "Call `jugglework_video_generate` exactly once with mode `text-to-video`; do not substitute another model or create a handcrafted placeholder.",
    `Use model providerID \`${options.model.providerID}\` and modelID \`${options.model.modelID}\`.`,
    `Pass durationSeconds \`${options.durationSeconds}\`.`,
    sizeInstruction,
    "`jugglework_video_generate` waits for the job to reach a terminal state. Keep the turn open while it runs, then immediately summarize completion or failure and include the artifact path. Do not use shell sleep. Only use `jugglework_video_job_get` as a compatibility fallback for a non-terminal response, and never resubmit a failed job.",
    "Use the following text as the video prompt:",
    prompt,
  ].join("\n");
}

export function videoGenerationSystemInstruction(
  draft: Pick<ComposerDraft, "videoGeneration" | "resolvedText" | "text">,
) {
  if (!draft.videoGeneration) return null;
  const resolved = draft.resolvedText?.trim();
  if (resolved) return resolved;
  const prompt = draft.text.trim();
  if (!prompt) return null;
  return buildVideoGenerationInstruction(prompt, draft.videoGeneration);
}

export function mergeVideoGenerationSystemContext(
  draft: Pick<ComposerDraft, "videoGeneration" | "resolvedText" | "text">,
  baseContext?: string | null,
) {
  const base = baseContext?.trim() ?? "";
  const instruction = videoGenerationSystemInstruction(draft);
  if (!instruction) return base || undefined;
  return base ? `${base}\n\n${instruction}` : instruction;
}
