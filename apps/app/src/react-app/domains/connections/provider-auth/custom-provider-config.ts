import { applyEdits, modify, parse } from "jsonc-parser";
import type { ProviderConfig } from "@opencode-ai/sdk/v2/client";

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

export type CustomProviderModel = {
  id: string;
  name: string;
};

const OPENAI_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/**
 * Model metadata that the OpenCode provider catalog cannot discover from a
 * generic OpenAI-compatible `/v1/models` response. Keep this allowlist narrow:
 * an unknown relay model is safer without a non-functional thinking selector
 * than with options its upstream API may ignore.
 */
const inferCustomProviderModelMetadata = (modelId: string) => {
  const normalized = modelId.trim().toLowerCase();
  const isGpt56 = /(?:^|\/)gpt-5\.6(?:$|[-.:])/.test(normalized);
  if (!isGpt56) return {};

  return {
    reasoning: true,
    variants: Object.fromEntries(
      OPENAI_REASONING_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]),
    ),
  };
};

export type CustomProviderInput = {
  providerId: string;
  name: string;
  baseUrl: string;
  models: CustomProviderModel[];
  /**
   * Optional per-model limits applied to every model in the block. Without
   * them the engine falls back to `limit.context: 0`, which disables context
   * accounting and compaction — fine for a quick trial, painful for real use,
   * so the form offers them and this module passes them straight through.
   */
  contextLimit?: number | null;
  outputLimit?: number | null;
};

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

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
  return {
    providerId,
    name: input.name.trim() || providerId,
    baseUrl: normalizeCustomProviderBaseUrl(input.baseUrl),
    models: input.models.flatMap((model) => {
      const id = model.id.trim();
      return id ? [{ id, name: model.name.trim() || id }] : [];
    }),
    contextLimit: input.contextLimit ?? null,
    outputLimit: input.outputLimit ?? null,
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
  | "providers.custom_models_required"
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
  if (input.models.length === 0) {
    return "providers.custom_models_required";
  }

  const hasContext = typeof input.contextLimit === "number";
  const hasOutput = typeof input.outputLimit === "number";
  if (hasContext !== hasOutput) {
    return "providers.custom_limits_incomplete";
  }
  if (hasContext && !(input.contextLimit! > 0 && input.outputLimit! > 0)) {
    return "providers.custom_limits_invalid";
  }

  return null;
};

export const buildCustomProviderConfig = (
  input: CustomProviderInput,
): ProviderConfig => {
  const limit =
    typeof input.contextLimit === "number" && typeof input.outputLimit === "number"
      ? { context: input.contextLimit, output: input.outputLimit }
      : null;

  return {
    npm: CUSTOM_PROVIDER_NPM,
    name: input.name,
    options: { baseURL: input.baseUrl },
    models: Object.fromEntries(
      input.models.map((model) => [
        model.id,
        {
          name: model.name,
          ...inferCustomProviderModelMetadata(model.id),
          ...(limit ? { limit } : {}),
        },
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
    options: Record<string, unknown>;
    models: Record<string, {
      id: string;
      name: string;
      api?: { npm?: string };
      limit?: { context?: number; output?: number };
    }>;
  },
): CustomProviderInput | null => {
  const baseUrl = typeof provider.options?.baseURL === "string"
    ? provider.options.baseURL.trim()
    : "";
  const models = Object.values(provider.models ?? {});
  if (
    !baseUrl ||
    models.length === 0 ||
    models.some((model) => model.api?.npm !== CUSTOM_PROVIDER_NPM)
  ) {
    return null;
  }

  const [firstModel] = models;
  const firstContext = firstModel.limit?.context ?? 0;
  const firstOutput = firstModel.limit?.output ?? 0;
  const hasConsistentLimits = models.every(
    (model) =>
      (model.limit?.context ?? 0) === firstContext &&
      (model.limit?.output ?? 0) === firstOutput,
  );
  if (!hasConsistentLimits || (firstContext > 0) !== (firstOutput > 0)) {
    return null;
  }

  return {
    providerId: provider.id,
    name: provider.name,
    baseUrl,
    models: Object.values(provider.models).map((model) => ({
      id: model.id,
      name: model.name || model.id,
    })),
    contextLimit: firstContext > 0 ? firstContext : null,
    outputLimit: firstOutput > 0 ? firstOutput : null,
  };
};

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
