import type {
  ToonImageGenerationMode,
  ToonImageModelDescriptor,
  ToonModelReference,
  ToonVideoGenerationMode,
  ToonVideoModelDescriptor,
} from "@jugglework/types/toon-factory";
import type { ConnectedTextModelOption } from "@/react-app/infra/provider-list-query";

export type ToonModelBlockingReason =
  | "no_text_model_available"
  | "no_image_model_available"
  | "no_video_model_available"
  | "video_submission_disabled"
  | "selected_model_unavailable";

export type ToonModelAvailability = {
  available: boolean;
  reason: ToonModelBlockingReason | null;
};

function matches(reference: ToonModelReference, candidate: { providerID: string; modelID: string }): boolean {
  return reference.providerID === candidate.providerID && reference.modelID === candidate.modelID;
}

export function revalidateToonModelSelection(input: {
  kind: "text" | "image" | "video";
  selected?: ToonModelReference;
  textModels?: ConnectedTextModelOption[];
  imageModels?: ToonImageModelDescriptor[];
  videoModels?: ToonVideoModelDescriptor[];
  videoSubmissionEnabled?: boolean;
  videoBlockingReason?: "no_video_model_available" | "video_submission_disabled" | null;
}): ToonModelAvailability {
  const candidates = input.kind === "text"
    ? input.textModels ?? []
    : input.kind === "image"
      ? (input.imageModels ?? []).map((model) => model.ref)
      : (input.videoModels ?? []).map((model) => model.ref);

  if (input.kind === "video" && input.videoBlockingReason === "video_submission_disabled") {
    return { available: false, reason: "video_submission_disabled" };
  }
  if (input.selected && !candidates.some((candidate) => matches(input.selected!, candidate))) {
    return { available: false, reason: "selected_model_unavailable" };
  }
  if (input.kind === "video" && input.videoBlockingReason) {
    return { available: false, reason: input.videoBlockingReason };
  }
  if (input.kind === "video" && input.videoSubmissionEnabled === false) {
    return { available: false, reason: "video_submission_disabled" };
  }
  if (candidates.length === 0) {
    return {
      available: false,
      reason: input.kind === "text"
        ? "no_text_model_available"
        : input.kind === "image"
          ? "no_image_model_available"
          : "no_video_model_available",
    };
  }
  return { available: Boolean(input.selected), reason: null };
}

export function revalidateToonProjectModels(input: {
  selectedModels?: { text?: ToonModelReference; image?: ToonModelReference; video?: ToonModelReference };
  textModels: ConnectedTextModelOption[];
  imageModels: ToonImageModelDescriptor[];
  videoModels: ToonVideoModelDescriptor[];
  imageMode: ToonImageGenerationMode;
  videoMode: ToonVideoGenerationMode;
  videoSubmissionEnabled: boolean;
  videoBlockingReason: "no_video_model_available" | "video_submission_disabled" | null;
}) {
  return {
    text: revalidateToonModelSelection({ kind: "text", selected: input.selectedModels?.text, textModels: input.textModels }),
    image: revalidateToonModelSelection({ kind: "image", selected: input.selectedModels?.image, imageModels: input.imageModels }),
    video: revalidateToonModelSelection({
      kind: "video",
      selected: input.selectedModels?.video,
      videoModels: input.videoModels,
      videoSubmissionEnabled: input.videoSubmissionEnabled,
      videoBlockingReason: input.videoBlockingReason,
    }),
  };
}
