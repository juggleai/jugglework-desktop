import { applyEdits, modify, parse } from "jsonc-parser";
import type { ProviderConfig } from "@opencode-ai/sdk/v2/client";
import { parseImageGenerationCapabilities, parseMediaGenerationCapabilities, type ImageGenerationCapabilities, type MediaGenerationCapabilities } from "@jugglework/types/media-generation";

import { isCloudManagedProviderKey } from "./cloud-provider-config";

/**
 * Pure helpers for user-declared OpenAI-compatible providers — the "bring your
 * own gateway" case: an OpenAI-shaped relay (中转平台), a self-hosted proxy, or
 * any endpoint that speaks `/v1/chat/completions`.
 *
 * These are the same blocks the docs tell users to hand-write into
 * `opencode.jsonc` (see `packages/docs/start-here/connect-your-stack/add-a-custom-llm.mdx`),
 * so the shape stays deliberately boring: `npm` + `options.baseURL` + `models`.
 * The credential never lands here — it goes into the engine's auth store keyed
 * by the provider id, the same way cloud-managed providers do it, so a
 * global config remains free of secrets.
 */

export const CUSTOM_PROVIDER_NPM = "@ai-sdk/openai-compatible";
export const CUSTOM_PROVIDER_RESPONSES_NPM = "@ai-sdk/openai";
export type CustomProviderTextProtocol = "chat-completions" | "responses";
export type CustomProviderModelType = "text" | "image" | "video";
export const CUSTOM_REASONING_DEPTHS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CustomReasoningDepth = (typeof CUSTOM_REASONING_DEPTHS)[number];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type CustomProviderModel = {
  id: string;
  name: string;
  contextLimit?: number | null;
  outputLimit?: number | null;
  /** Defaults to true; false marks a generation-only model. */
  chat?: boolean;
  textProtocol?: CustomProviderTextProtocol;
  reasoningDepths?: CustomReasoningDepth[];
  mediaGeneration?: MediaGenerationCapabilities;
  imageGeneration?: ImageGenerationCapabilities;
};

/**
 * The structured editor presents one mutually exclusive model type. Older raw
 * configs may contain mixed capability metadata, so editing resolves those
 * deterministically instead of guessing from the model id.
 */
export const customProviderModelType = (model: Pick<CustomProviderModel, "mediaGeneration" | "imageGeneration">): CustomProviderModelType =>
  model.mediaGeneration ? "video" : model.imageGeneration ? "image" : "text";

export type CustomProviderInput = {
  providerId: string;
  name: string;
  baseUrl: string;
  /** Credential key consumed by server-side provider adapters. */
  credentialEnv?: string | null;
  models: CustomProviderModel[];
  /** Legacy group-level defaults accepted for migration and programmatic callers. */
  contextLimit?: number | null;
  outputLimit?: number | null;
};

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const customProviderCredentialEnv = (providerId: string) => {
  const suffix = normalizeCustomProviderId(providerId)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return suffix ? `CUSTOM_${suffix}_API_KEY` : "CUSTOM_PROVIDER_API_KEY";
};

/** Config-safe id: lowercase, with anything else folded into `-`. */
export const normalizeCustomProviderId = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");

export const normalizeCustomProviderBaseUrl = (value: string) =>
  value.trim().replace(/\/+$/, "");

/**
 * One model per line (or comma separated). `id` alone uses the id as the
 * display name; `id = Display Name` sets one. Ids keep their original case and
 * may contain `:` (`qwen3:8b`), so only `=` separates the two halves.
 */
export const parseCustomProviderModels = (raw: string): CustomProviderModel[] => {
  const seen = new Set<string>();
  return raw
    .split(/[\n,]/)
    .flatMap((line) => {
      const entry = line.trim();
      if (!entry) return [];
      const separator = entry.indexOf("=");
      const id = (separator === -1 ? entry : entry.slice(0, separator)).trim();
      const name = separator === -1 ? "" : entry.slice(separator + 1).trim();
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [{ id, name: name || id } satisfies CustomProviderModel];
    });
};

export const normalizeCustomProviderInput = (
  input: CustomProviderInput,
): CustomProviderInput => {
  const providerId = normalizeCustomProviderId(input.providerId);
  const models = input.models.flatMap((model) => {
    const id = model.id.trim();
    const mediaGeneration = parseMediaGenerationCapabilities(model.mediaGeneration);
    const imageGeneration = parseImageGenerationCapabilities(model.imageGeneration);
    return id ? [{
      id,
      name: model.name.trim() || id,
      ...((model.contextLimit ?? input.contextLimit) != null
        ? { contextLimit: model.contextLimit ?? input.contextLimit }
        : {}),
      ...((model.outputLimit ?? input.outputLimit) != null
        ? { outputLimit: model.outputLimit ?? input.outputLimit }
        : {}),
      ...(model.chat === false ? { chat: false } : {}),
      ...((model.textProtocol ?? "chat-completions") === "responses" ? { textProtocol: "responses" as const } : {}),
      ...(model.chat !== false && model.reasoningDepths?.length
        ? { reasoningDepths: CUSTOM_REASONING_DEPTHS.filter((depth) => model.reasoningDepths?.includes(depth)) }
        : {}),
      ...(mediaGeneration ? { mediaGeneration } : {}),
      ...(imageGeneration ? { imageGeneration } : {}),
    }] : [];
  });
  const needsAdapterCredential = models.some((model) => model.mediaGeneration || model.imageGeneration);
  return {
    providerId,
    name: input.name.trim() || providerId,
    baseUrl: normalizeCustomProviderBaseUrl(input.baseUrl),
    credentialEnv:
      input.credentialEnv?.trim() || (needsAdapterCredential ? customProviderCredentialEnv(providerId) : null),
    models,
  };
};

/**
 * Validation failures are returned as i18n keys, not sentences: this module is
 * pure and locale-agnostic, so the caller (`t(...)` at the store or the modal)
 * decides the language.
 */
export type CustomProviderValidationKey =
  | "providers.provider_id_required"
  | "providers.custom_id_invalid"
  | "providers.custom_id_reserved"
  | "providers.custom_base_url_required"
  | "providers.custom_base_url_invalid"
  | "providers.custom_credential_env_invalid"
  | "providers.custom_models_required"
  | "providers.custom_model_capability_required"
  | "providers.custom_limits_incomplete"
  | "providers.custom_limits_invalid";

/** Returns the first problem with a normalized input, or null when it is good. */
export const validateCustomProviderInput = (
  input: CustomProviderInput,
): CustomProviderValidationKey | null => {
  if (!input.providerId) {
    return "providers.provider_id_required";
  }
  if (!PROVIDER_ID_PATTERN.test(input.providerId)) {
    return "providers.custom_id_invalid";
  }
  if (isCloudManagedProviderKey(input.providerId)) {
    return "providers.custom_id_reserved";
  }
  if (!input.baseUrl) {
    return "providers.custom_base_url_required";
  }
  if (!/^https?:\/\/\S+$/i.test(input.baseUrl)) {
    return "providers.custom_base_url_invalid";
  }
  if (input.credentialEnv && !ENV_KEY_PATTERN.test(input.credentialEnv)) {
    return "providers.custom_credential_env_invalid";
  }
  if (input.models.length === 0) {
    return "providers.custom_models_required";
  }
  if (input.models.some((model) => model.chat === false && !model.mediaGeneration && !model.imageGeneration)) {
    return "providers.custom_model_capability_required";
  }

  for (const model of input.models) {
    const hasContext = typeof model.contextLimit === "number";
    const hasOutput = typeof model.outputLimit === "number";
    if (hasContext !== hasOutput) return "providers.custom_limits_incomplete";
    if (hasContext && !(model.contextLimit! > 0 && model.outputLimit! > 0)) {
      return "providers.custom_limits_invalid";
    }
  }

  return null;
};

export const buildCustomProviderConfig = (
  input: CustomProviderInput,
): ProviderConfig => {
  const credentialEnv = input.credentialEnv?.trim() ||
    (input.models.some((model) => parseMediaGenerationCapabilities(model.mediaGeneration) || parseImageGenerationCapabilities(model.imageGeneration))
      ? customProviderCredentialEnv(input.providerId)
      : null);
  return {
    npm: CUSTOM_PROVIDER_NPM,
    name: input.name,
    ...(credentialEnv ? { env: [credentialEnv] } : {}),
    options: { baseURL: input.baseUrl },
    models: Object.fromEntries(
      input.models.map((model) => [
        model.id,
        (() => {
          const limit = typeof model.contextLimit === "number" && typeof model.outputLimit === "number"
            ? { context: model.contextLimit, output: model.outputLimit }
            : null;
          return {
          name: model.name,
          ...(model.reasoningDepths?.length ? {
            reasoning: true,
            variants: Object.fromEntries(
              model.reasoningDepths.map((depth) => [
                depth,
                depth === "none" ? {} : { reasoningEffort: depth },
              ]),
            ),
          } : {}),
          ...(model.chat !== false && model.textProtocol === "responses"
            ? { provider: { npm: CUSTOM_PROVIDER_RESPONSES_NPM } }
            : {}),
          ...(model.chat === false ? {
            modalities: {
              input: (model.mediaGeneration?.imageToVideo || model.imageGeneration?.imageToImage || model.imageGeneration?.multiImageToImage ? ["text", "image"] : ["text"]) as ("text" | "image")[],
              output: [
                ...(model.mediaGeneration ? ["video"] : []),
                ...(model.imageGeneration ? ["image"] : []),
              ] as ("video" | "image")[],
            },
          } : {}),
          ...(model.mediaGeneration ? { mediaGeneration: model.mediaGeneration } : {}),
          ...(model.imageGeneration ? { imageGeneration: model.imageGeneration } : {}),
          ...(limit ? { limit } : {}),
          };
        })(),
      ]),
    ),
  };
};

/**
 * 将引擎返回的本地模型组转换为编辑表单数据。
 *
 * @param provider 引擎返回的模型组
 * @returns 可安全编辑的数据；非 OpenAI 兼容或模型限制不一致时返回 null
 */
export const customProviderInputFromProvider = (
  provider: {
    id: string;
    name: string;
    env?: string[];
    options: Record<string, unknown>;
    models: Record<string, {
      id: string;
      name: string;
      api?: { npm?: string };
      limit?: { context?: number; output?: number };
      mediaGeneration?: unknown;
      imageGeneration?: unknown;
      modalities?: { input?: string[]; output?: string[] };
      variants?: Record<string, unknown>;
    }>;
  },
): CustomProviderInput | null => {
  const baseUrl = typeof provider.options?.baseURL === "string"
    ? provider.options.baseURL.trim()
    : "";
  const models = Object.values(provider.models ?? {});
  const capabilities = models.map((model) => parseMediaGenerationCapabilities(model.mediaGeneration));
  const imageCapabilities = models.map((model) => parseImageGenerationCapabilities(model.imageGeneration));
  const chatModes = models.map((model) => !Array.isArray(model.modalities?.output) || model.modalities.output.includes("text"));
  if (
    !baseUrl ||
    models.length === 0 ||
    models.some((model) => ![CUSTOM_PROVIDER_NPM, CUSTOM_PROVIDER_RESPONSES_NPM].includes(model.api?.npm ?? ""))
  ) {
    return null;
  }

  if (models.some((model) => ((model.limit?.context ?? 0) > 0) !== ((model.limit?.output ?? 0) > 0))) {
    return null;
  }

  return {
    providerId: provider.id,
    name: provider.name,
    baseUrl,
    ...(provider.env?.find((entry) => typeof entry === "string" && entry.trim())?.trim() || capabilities[0]
      ? {
          credentialEnv:
            provider.env?.find((entry) => typeof entry === "string" && entry.trim())?.trim() ||
            customProviderCredentialEnv(provider.id),
        }
      : {}),
    models: Object.values(provider.models).map((model, index) => ({
      id: model.id,
      name: model.name || model.id,
      ...((model.limit?.context ?? 0) > 0 ? { contextLimit: model.limit!.context! } : {}),
      ...((model.limit?.output ?? 0) > 0 ? { outputLimit: model.limit!.output! } : {}),
      ...(chatModes[index] === false ? { chat: false } : {}),
      ...(chatModes[index] !== false && model.api?.npm === CUSTOM_PROVIDER_RESPONSES_NPM
        ? { textProtocol: "responses" as const }
        : {}),
      ...(chatModes[index] !== false && CUSTOM_REASONING_DEPTHS.some((depth) =>
        Object.prototype.hasOwnProperty.call(model.variants ?? {}, depth),
      )
        ? {
            reasoningDepths: CUSTOM_REASONING_DEPTHS.filter((depth) =>
              Object.prototype.hasOwnProperty.call(model.variants ?? {}, depth),
            ),
          }
        : {}),
      ...(capabilities[index] ? { mediaGeneration: capabilities[index] } : {}),
      ...(imageCapabilities[index] ? { imageGeneration: imageCapabilities[index] } : {}),
    })),
  };
};

/**
 * Build an editable provider from raw JSONC. Runtime ProviderList output is a
 * lossy projection and omits custom mediaGeneration metadata.
 */
export function customProviderInputFromConfigContent(
  content: string,
  providerId: string,
  runtimeProvider?: {
    id: string;
    name: string;
    models: Record<string, {
      id: string;
      name: string;
      api?: { npm?: string };
      limit?: { context?: number; output?: number };
      modalities?: { input?: string[]; output?: string[] };
      mediaGeneration?: unknown;
      imageGeneration?: unknown;
    }>;
  } | null,
): CustomProviderInput | null {
  const resolved = providerId.trim();
  if (!resolved) return null;
  const parsed = parse(content || "{}") as unknown;
  const root = isRecord(parsed) ? parsed : {};
  const providers = isRecord(root.provider) ? root.provider : {};
  const rawProvider = providers[resolved];
  if (!isRecord(rawProvider)) return null;
  const rawModels = isRecord(rawProvider.models) ? rawProvider.models : {};
  const models = Object.fromEntries(Object.entries(rawModels).flatMap(([modelID, modelRaw]) => {
    if (!isRecord(modelRaw)) return [];
    const runtimeModel = runtimeProvider?.models?.[modelID];
    return [[modelID, {
      ...runtimeModel,
      ...modelRaw,
      id: typeof modelRaw.id === "string" && modelRaw.id.trim() ? modelRaw.id : modelID,
      name: typeof modelRaw.name === "string" && modelRaw.name.trim() ? modelRaw.name : modelID,
      api: isRecord(modelRaw.provider)
        ? { npm: typeof modelRaw.provider.npm === "string" ? modelRaw.provider.npm : CUSTOM_PROVIDER_NPM }
        : { npm: CUSTOM_PROVIDER_NPM },
    }]];
  }));
  return customProviderInputFromProvider({
    ...runtimeProvider,
    ...rawProvider,
    id: resolved,
    name: typeof rawProvider.name === "string" && rawProvider.name.trim()
      ? rawProvider.name
      : runtimeProvider?.name ?? resolved,
    options: isRecord(rawProvider.options) ? rawProvider.options : {},
    env: Array.isArray(rawProvider.env) ? rawProvider.env.filter((item): item is string => typeof item === "string") : [],
    models,
  });
}

export function customProviderCredentialEnvEntry(
  input: Pick<CustomProviderInput, "credentialEnv">,
  apiKey: string,
): { key: string; value: string } | null {
  const key = input.credentialEnv?.trim() ?? "";
  const value = apiKey.trim();
  return key && value ? { key, value } : null;
}

/**
 * Upsert the provider block in an `opencode.jsonc`. The whole block is
 * replaced on purpose: reconnecting with a new base URL or model list is an
 * edit of the same provider, not a merge with whatever it used to be.
 */
export const formatConfigWithCustomProvider = (
  raw: string,
  providerId: string,
  config: ProviderConfig,
) => {
  const base = raw.trim()
    ? raw
    : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const edits = modify(base, ["provider", providerId], config, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const updated = applyEdits(base, edits);
  return updated.endsWith("\n") ? updated : `${updated}\n`;
};

/**
 * Permanently remove a user-declared provider from an OpenCode config. This
 * also clears a matching disabled_providers entry left by Disconnect while
 * preserving unrelated JSONC comments and settings.
 */
export const formatConfigWithoutCustomProvider = (raw: string, providerId: string) => {
  const resolvedProviderId = providerId.trim();
  if (!resolvedProviderId) return raw.endsWith("\n") ? raw : `${raw}\n`;

  let updated = raw.trim()
    ? raw
    : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';

  const initial = parse(updated) as Record<string, unknown> | undefined;
  const initialProviders = initial?.provider;
  // TIPS: jsonc-parser 删除缺失路径时会抛出 “Can not delete in empty document”。
  // 删除动作必须先确认目标字段存在，目标不存在应当是幂等 no-op。
  if (
    initialProviders &&
    typeof initialProviders === "object" &&
    !Array.isArray(initialProviders) &&
    Object.prototype.hasOwnProperty.call(initialProviders, resolvedProviderId)
  ) {
    updated = applyEdits(
      updated,
      modify(updated, ["provider", resolvedProviderId], undefined, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
  }

  const parsedAfterProvider = parse(updated) as Record<string, unknown> | undefined;
  const providers = parsedAfterProvider?.provider;
  if (
    providers &&
    typeof providers === "object" &&
    !Array.isArray(providers) &&
    Object.keys(providers).length === 0
  ) {
    updated = applyEdits(
      updated,
      modify(updated, ["provider"], undefined, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
  }

  const parsed = parse(updated) as Record<string, unknown> | undefined;
  const existingDisabledProviders = Array.isArray(parsed?.disabled_providers)
    ? parsed.disabled_providers
    : [];
  const disabledProviders = existingDisabledProviders.length
    ? existingDisabledProviders.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim() !== resolvedProviderId,
      )
    : [];
  if (existingDisabledProviders.some((entry) => typeof entry === "string" && entry.trim() === resolvedProviderId)) {
    updated = applyEdits(
      updated,
      modify(
        updated,
        ["disabled_providers"],
        disabledProviders.length ? disabledProviders : undefined,
        { formattingOptions: { insertSpaces: true, tabSize: 2 } },
      ),
    );
  }

  return updated.endsWith("\n") ? updated : `${updated}\n`;
};
