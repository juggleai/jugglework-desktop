import {
  parseMediaGenerationCapabilities,
  supportsVideoGenerationMode,
  type MediaGenerationCapabilities,
  type VideoGenerationMode,
  type VideoModelRef,
} from "@jugglework/types/media-generation";

export type VideoModelAvailability =
  | "ready"
  | "missing_credentials"
  | "unsupported_adapter";

export type VideoModelDescriptor = {
  ref: VideoModelRef;
  providerName: string;
  modelName: string;
  capabilities: MediaGenerationCapabilities;
  availability: VideoModelAvailability;
  diagnostic?: string;
};

export type ProviderCatalogSnapshot = {
  all: Array<{
    id: string;
    name?: string;
    models: Record<string, unknown>;
  }>;
  connected: string[];
};

export type VideoModelDiscoveryOptions = {
  catalog: ProviderCatalogSnapshot;
  mode?: VideoGenerationMode;
  supportsAdapter: (ref: VideoModelRef, capabilities: MediaGenerationCapabilities) => boolean;
  credentialReady: (ref: VideoModelRef) => boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function discoverVideoModels(options: VideoModelDiscoveryOptions): VideoModelDescriptor[] {
  const connected = new Set(options.catalog.connected);
  const discovered: VideoModelDescriptor[] = [];

  for (const provider of options.catalog.all) {
    if (!connected.has(provider.id)) continue;
    for (const [modelID, rawModel] of Object.entries(provider.models)) {
      if (!isRecord(rawModel)) continue;
      const capabilities = parseMediaGenerationCapabilities(rawModel.mediaGeneration);
      if (!capabilities || (options.mode && !supportsVideoGenerationMode(capabilities, options.mode))) continue;

      const ref = { providerID: provider.id, modelID };
      const adapterSupported = options.supportsAdapter(ref, capabilities);
      const credentialsReady = options.credentialReady(ref);
      const availability: VideoModelAvailability = !adapterSupported
        ? "unsupported_adapter"
        : !credentialsReady
          ? "missing_credentials"
          : "ready";

      discovered.push({
        ref,
        providerName: provider.name?.trim() || provider.id,
        modelName: typeof rawModel.name === "string" && rawModel.name.trim() ? rawModel.name.trim() : modelID,
        capabilities,
        availability,
        ...(availability === "unsupported_adapter"
          ? { diagnostic: "JuggleWork has no adapter for this configured video model." }
          : availability === "missing_credentials"
            ? { diagnostic: "The provider credential is not available to video generation." }
            : {}),
      });
    }
  }

  return discovered.sort((left, right) =>
    left.ref.providerID.localeCompare(right.ref.providerID) ||
    left.ref.modelID.localeCompare(right.ref.modelID));
}

export function listReadyVideoModels(options: VideoModelDiscoveryOptions): VideoModelDescriptor[] {
  return discoverVideoModels(options).filter((model) => model.availability === "ready");
}

export function noVideoModelResult(mode: VideoGenerationMode) {
  return {
    ok: false as const,
    error: "no_video_model_available" as const,
    mode,
    message: mode === "image-to-video"
      ? "No configured provider currently has a usable image-to-video model. The reference image was not ignored."
      : "No configured provider currently has a usable text-to-video model.",
  };
}
