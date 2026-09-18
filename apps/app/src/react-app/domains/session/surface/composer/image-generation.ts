import type {
  ComposerDraft,
  ComposerImageAspectRatio,
  ComposerImageGenerationOptions,
  ComposerImageStyle,
} from "@/app/types";

export type ComposerImageModelOption = {
  providerID: string;
  modelID: string;
  providerName: string;
  modelName: string;
};

export const IMAGE_ASPECT_RATIO_OPTIONS: ReadonlyArray<{
  value: ComposerImageAspectRatio;
  size: string | null;
}> = [
  { value: "auto", size: null },
  { value: "1:1", size: "1024x1024" },
  { value: "3:2", size: "1536x1024" },
  { value: "2:3", size: "1024x1536" },
];

export const IMAGE_STYLE_OPTIONS: readonly ComposerImageStyle[] = [
  "auto",
  "photographic",
  "illustration",
  "anime",
  "3d",
];

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

export function imageModelKey(model: Pick<ComposerImageModelOption, "providerID" | "modelID">) {
  return `${model.providerID}\u0000${model.modelID}`;
}

export function parseComposerImageModels(payload: unknown): ComposerImageModelOption[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return [];
  const seen = new Set<string>();
  return payload.models.flatMap((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.ref)) return [];
    const providerID = typeof candidate.ref.providerID === "string" ? candidate.ref.providerID.trim() : "";
    const modelID = typeof candidate.ref.modelID === "string" ? candidate.ref.modelID.trim() : "";
    if (!providerID || !modelID) return [];
    const option: ComposerImageModelOption = {
      providerID,
      modelID,
      providerName: typeof candidate.providerName === "string" && candidate.providerName.trim()
        ? candidate.providerName.trim()
        : providerID,
      modelName: typeof candidate.modelName === "string" && candidate.modelName.trim()
        ? candidate.modelName.trim()
        : modelID,
    };
    const key = imageModelKey(option);
    if (seen.has(key)) return [];
    seen.add(key);
    return [option];
  });
}

export function imageGenerationSize(aspectRatio: ComposerImageAspectRatio) {
  return IMAGE_ASPECT_RATIO_OPTIONS.find((option) => option.value === aspectRatio)?.size ?? null;
}

export function buildImageGenerationInstruction(
  prompt: string,
  options: ComposerImageGenerationOptions,
) {
  const size = imageGenerationSize(options.aspectRatio);
  const styleInstruction = options.style === "auto"
    ? "Preserve the style requested by the user; do not add a style that was not requested."
    : `Render the image in the selected ${options.style} style.`;
  const sizeInstruction = size
    ? `Pass size \`${size}\` (aspect ratio ${options.aspectRatio}).`
    : "Let the provider choose the output size automatically.";

  return [
    "Generate exactly one image for the request below using the JuggleWork image-generation tool.",
    "Call `jugglework_image_generate` with mode `text-to-image`; do not substitute another model or create a handcrafted placeholder.",
    `Use model providerID \`${options.model.providerID}\` and modelID \`${options.model.modelID}\`.`,
    sizeInstruction,
    styleInstruction,
    "Use the following text as the image prompt:",
    prompt,
  ].join("\n");
}

/**
 * Image-only models cannot be used as the session chat model. Keep the
 * member's prompt as the visible user turn and inject the model-locked image
 * tool instruction into the request system context instead.
 */
export function imageGenerationSystemInstruction(
  draft: Pick<ComposerDraft, "imageGeneration" | "resolvedText" | "text">,
) {
  if (!draft.imageGeneration) return null;
  const resolved = draft.resolvedText?.trim();
  if (resolved) return resolved;
  const prompt = draft.text.trim();
  if (!prompt) return null;
  return buildImageGenerationInstruction(prompt, draft.imageGeneration);
}

export function mergeImageGenerationSystemContext(
  draft: Pick<ComposerDraft, "imageGeneration" | "resolvedText" | "text">,
  baseContext?: string | null,
) {
  const base = baseContext?.trim() ?? "";
  const instruction = imageGenerationSystemInstruction(draft);
  if (!instruction) return base || undefined;
  return base ? `${base}\n\n${instruction}` : instruction;
}
