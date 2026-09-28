import type { RuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { OpenAiCompatibleVideoAdapter } from "./openai-compatible-adapter.js";
import { VolcengineArkV3VideoAdapter } from "./volcengine-ark-v3-adapter.js";
import type { VideoGenerationAdapter } from "./types.js";
import { cloudProviderConfigFingerprint } from "@jugglework/types/provider-credentials";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
  : [];

export type ProviderCredentialResolver = (input: {
  workspaceId: string;
  providerID: string;
  modelID?: string;
  declaredEnvKeys: readonly string[];
  providerConfig?: unknown;
}) => Promise<string | null>;

export type ProviderProvenanceResolver = (input: {
  workspaceId: string; providerID: string; modelID: string; declaredEnvKeys: readonly string[]; providerConfig: unknown;
}) => Promise<{ cloudProviderId: string; organizationId: string } | null>;

/** Build adapters only for explicitly configured OpenAI-compatible providers. */
export async function openAiCompatibleVideoAdapters(
  config: RuntimeOpencodeConfig,
  workspaceId: string,
  resolveCredential: ProviderCredentialResolver,
  resolveProvenance?: ProviderProvenanceResolver,
): Promise<VideoGenerationAdapter[]> {
  const adapters: VideoGenerationAdapter[] = [];
  for (const [providerID, raw] of Object.entries(config.provider ?? {})) {
    if (!isRecord(raw)) continue;
    const options = isRecord(raw.options) ? raw.options : {};
    const npm = typeof raw.npm === "string" ? raw.npm : "";
    const baseURL = typeof options.baseURL === "string" ? options.baseURL.trim() : typeof raw.api === "string" ? raw.api.trim() : "";
    const envKeys = strings(raw.env);
    if (!baseURL || envKeys.length === 0 || !npm.includes("openai")) continue;
    const parsed = new URL(baseURL);
    if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) continue;
    const models = isRecord(raw.models) ? raw.models : {};
    const arkModelIDs: string[] = [];
    const openAiModelIDs: string[] = [];
    for (const [modelID, modelRaw] of Object.entries(models)) {
      if (!isRecord(modelRaw) || !isRecord(modelRaw.mediaGeneration)) continue;
      if (modelRaw.mediaGeneration.protocol === "volcengine-ark-v3") arkModelIDs.push(modelID);
      else openAiModelIDs.push(modelID);
    }
    for (const modelID of openAiModelIDs) {
      const provenance = await resolveProvenance?.({ workspaceId, providerID, modelID, declaredEnvKeys: envKeys, providerConfig: raw }) ?? null;
      adapters.push(new OpenAiCompatibleVideoAdapter({
      providerID,
      modelIDs: [modelID],
      baseURL,
      credential: () => resolveCredential({ workspaceId, providerID, modelID, declaredEnvKeys: envKeys, providerConfig: raw }),
      binding: { configFingerprint: cloudProviderConfigFingerprint(raw), cloudProviderId: provenance?.cloudProviderId ?? null, organizationId: provenance?.organizationId ?? null },
      }));
    }
    for (const modelID of arkModelIDs) {
      const provenance = await resolveProvenance?.({ workspaceId, providerID, modelID, declaredEnvKeys: envKeys, providerConfig: raw }) ?? null;
      adapters.push(new VolcengineArkV3VideoAdapter({
      providerID,
      modelIDs: [modelID],
      baseURL,
      credential: () => resolveCredential({ workspaceId, providerID, modelID, declaredEnvKeys: envKeys, providerConfig: raw }),
      binding: { configFingerprint: cloudProviderConfigFingerprint(raw), cloudProviderId: provenance?.cloudProviderId ?? null, organizationId: provenance?.organizationId ?? null },
      }));
    }
  }
  return adapters;
}
