import type { EnvService } from "../env-file.js";
import type { RuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { OpenAiCompatibleVideoAdapter } from "./openai-compatible-adapter.js";
import { VolcengineArkV3VideoAdapter } from "./volcengine-ark-v3-adapter.js";
import type { VideoGenerationAdapter } from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
  : [];

/** Build adapters only for explicitly configured OpenAI-compatible providers. */
export function openAiCompatibleVideoAdapters(config: RuntimeOpencodeConfig, env: EnvService): VideoGenerationAdapter[] {
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
    if (openAiModelIDs.length > 0) adapters.push(new OpenAiCompatibleVideoAdapter({ providerID, modelIDs: openAiModelIDs, baseURL, envKeys, env }));
    if (arkModelIDs.length > 0) adapters.push(new VolcengineArkV3VideoAdapter({ providerID, modelIDs: arkModelIDs, baseURL, envKeys, env }));
  }
  return adapters;
}

export async function credentialReadiness(env: EnvService): Promise<Set<string>> {
  const records = await env.list();
  return new Set([
    ...records.filter((entry) => entry.value.trim()).map((entry) => entry.key),
    ...Object.entries(process.env).filter(([, value]) => value?.trim()).map(([key]) => key),
  ]);
}
