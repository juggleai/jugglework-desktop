import { ApiError } from "./errors.js";
import { readEffectiveWorkspaceOpencodeConfig } from "./effective-workspace-opencode-config.js";
import type { EnvService } from "./env-file.js";
import { createWorkspaceProviderCredentialResolver } from "./provider-credential-resolver.js";
import { externalFetch } from "./server-fetch.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export type TextProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";
export type TextModelRef = { providerID: string; modelID: string };
export type ResolvedTextModel = {
  protocol: TextProtocol; baseURL: string; key: string; modelId: string;
  upstreamModelId: string; headers: Record<string, string>;
  provider: Record<string, any>; model: Record<string, any>;
  beforeDispatch?: () => void;
};

const unresolvedTemplate = /\{(?:env|file):|\$\{/;
function upstreamId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim() &&
    !/[\p{Cc}]/u.test(value) && !unresolvedTemplate.test(value);
}

/** v1.19.3 resolveSDK: provider.options.headers, then resolved model.headers. */
function modelHeaders(...layers: unknown[]): Record<string, string> | null {
  const headers = new Headers();
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (!layer || typeof layer !== "object" || Array.isArray(layer)) return null;
    for (const [name, value] of Object.entries(layer)) {
      if (typeof value !== "string" || /[\r\n\0]/.test(value) || unresolvedTemplate.test(value)) return null;
      // These alter the transport/framing rather than model routing; never silently drop them.
      if (/^(?:host|connection|content-length|transfer-encoding|upgrade|trailer|te|proxy-authorization)$/i.test(name)) return null;
      if (name.toLowerCase() === "content-type" && value.toLowerCase() !== "application/json") return null;
      try { headers.set(name, value); } catch { return null; }
    }
  }
  return Object.fromEntries(headers);
}

/** Stops waiting for existing non-cancellable reads as well as cancellable I/O. */
export async function withSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(
      value => { signal.removeEventListener("abort", abort); signal.aborted ? reject(signal.reason) : resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

/** Shared with Toonflow; resolves only the requested configured model, never media discovery. */
export function describeConfiguredTextModel(effective: Record<string, unknown>, live: { all: any[] }, ref: TextModelRef) {
  const configured = record(record(effective.provider)[ref.providerID]);
  if (!Object.keys(configured).length) return null;
  if (Array.isArray(effective.disabled_providers) && effective.disabled_providers.some(id => String(id).toLowerCase() === ref.providerID.toLowerCase())) return null;
  if (Array.isArray(effective.enabled_providers) && !effective.enabled_providers.includes(ref.providerID)) return null;
  const liveProvider = record(live.all.find(item => item.id === ref.providerID));
  const configuredModel = record(record(configured.models)[ref.modelID]);
  const provider: Record<string, any> = { ...liveProvider, ...configured,
    options: { ...record(liveProvider.options), ...record(configured.options) },
    models: { ...record(liveProvider.models), ...record(configured.models) } };
  if (Array.isArray(provider.blacklist) && provider.blacklist.includes(ref.modelID)) return null;
  if (Array.isArray(provider.whitelist) && !provider.whitelist.includes(ref.modelID)) return null;
  if (!Object.prototype.hasOwnProperty.call(provider.models, ref.modelID)) return null;
  const liveModel = record(liveProvider.models?.[ref.modelID]);
  // The public model key/id is not the upstream identity. Config `id` wins, while
  // live api.id includes catalog aliases/plugin resolution. A mismatch is a stale
  // engine/config snapshot, not permission to route to a different model.
  const upstreamModelId = configuredModel.id ?? record(liveModel.api).id ?? ref.modelID;
  if (!upstreamId(upstreamModelId) || (configuredModel.id !== undefined && record(liveModel.api).id !== undefined && configuredModel.id !== liveModel.api.id)) return null;
  // Raw `api` is an engine output shape, not a supported model config field.
  if (configuredModel.api !== undefined) return null;
  const model = { ...liveModel, ...configuredModel };
  const headers = modelHeaders(record(liveProvider.options).headers, record(configured.options).headers, liveModel.headers, configuredModel.headers);
  if (!headers || configured.headers !== undefined || model.options?.headers !== undefined || provider.options.fetch !== undefined) return null;
  const rawBaseURL = provider.options.baseURL || (record(configuredModel.provider).api ?? configured.api ?? record(liveModel.api).url ?? provider.api ?? "");
  if (typeof rawBaseURL !== "string" || unresolvedTemplate.test(rawBaseURL)) return null;
  const baseURL = rawBaseURL.replace(/\/+$/, "");
  if (!URL.canParse(baseURL)) return null;
  const url = new URL(baseURL);
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return null;
  const npm = record(configuredModel.provider).npm ?? configured.npm ?? record(liveModel.api).npm ?? "@ai-sdk/openai-compatible";
  const protocol: TextProtocol | null = npm === "@ai-sdk/anthropic" ? "anthropic-messages" :
    npm === "@ai-sdk/openai-compatible" ? "openai-completions" : npm === "@ai-sdk/openai" ? "openai-responses" : null;
  return protocol ? { protocol, baseURL, provider, model, configured, upstreamModelId, headers } : null;
}

/** 只排除无法产出文本的模型。思考能力不构成拦截：请求照常发出，
 * 思考耗尽额度或输出不合格时，normalizeSuggestion 会丢弃结果，用户看不到建议。 */
export function textModelIneligibility(model: Record<string, any>) {
  if (model.imageGeneration !== undefined || model.mediaGeneration !== undefined ||
    record(record(model.capabilities).output).text === false ||
    (Array.isArray(record(model.modalities).output) && !model.modalities.output.includes("text"))) return "model_non_text";
  if (typeof record(model.limit).output === "number" && model.limit.output < 512) return "model_output_limit";
  return null;
}

export function usesCompletionTokenLimit(upstreamModelId: string) {
  return /^(?:o[1-9](?:-|$)|gpt-[56](?:[.-]|$))/i.test(upstreamModelId);
}

export function createTextModelResolver(options: { config: ServerConfig; env: EnvService }) {
  const credentials = createWorkspaceProviderCredentialResolver({ ...options, readOnly: true });
  return async (workspace: WorkspaceInfo, ref: TextModelRef, live: { all: any[]; connected: string[] }, signal: AbortSignal,
    diagnose?: (detail: string) => void): Promise<ResolvedTextModel | null> => {
    const effective = await withSignal(signal, () => readEffectiveWorkspaceOpencodeConfig(options.config, workspace, { readOnly: true, signal }));
    const selected = describeConfiguredTextModel(effective, live, ref);
    if (!selected) { diagnose?.("model_configuration_unavailable"); return null; }
    if (!live.connected.includes(ref.providerID)) { diagnose?.("provider_disconnected"); return null; }
    const model = { ...record(live.all.find(item => item.id === ref.providerID)?.models?.[ref.modelID]), ...selected.model };
    const ineligible = textModelIneligibility(model);
    if (ineligible) { diagnose?.(ineligible); return null; }
    const envKeys = Array.isArray(selected.configured.env) ? selected.configured.env.filter((key: unknown): key is string => typeof key === "string") : [];
    const beforeDispatch = credentials.beforeDispatch(workspace.id, ref.providerID, selected.configured);
    const key = await withSignal(signal, () => credentials.resolve({ workspaceId: workspace.id, ...ref, declaredEnvKeys: envKeys, providerConfig: selected.configured }, signal));
    if (!key) { diagnose?.("model_credential_unavailable"); return null; }
    return { ...selected, key, modelId: ref.modelID, beforeDispatch };
  };
}

/** Protocol/auth transport only: no retries, fallback, model discovery or session mutation. */
export async function requestTextModel(input: {
  model: Pick<ResolvedTextModel, "protocol" | "baseURL" | "key" | "upstreamModelId" | "headers" | "beforeDispatch">;
  payload: Record<string, unknown>; signal: AbortSignal; requestSignal?: AbortSignal;
}): Promise<Response> {
  const { model, signal } = input;
  const operation = { "openai-completions": "chat/completions", "openai-responses": "responses", "anthropic-messages": "messages" }[model.protocol];
  const body: Record<string, unknown> = { ...input.payload, model: model.upstreamModelId };
  const headers = new Headers({ Authorization: `Bearer ${model.key}`, "Content-Type": "application/json" });
  if (model.protocol === "anthropic-messages") {
    headers.delete("Authorization");
    headers.set("x-api-key", model.key);
    headers.set("anthropic-version", "2023-06-01");
    delete body.betas;
  }
  for (const [name, value] of Object.entries(model.headers)) headers.set(name, value);
  if (model.protocol === "anthropic-messages") {
    const betas = Array.isArray(input.payload.betas) ? [...input.payload.betas] as string[] : [];
    if (record(body.thinking).type === "enabled") betas.push("interleaved-thinking-2025-05-14");
    const merged = [...new Set([...(headers.get("anthropic-beta") ?? "").split(","), ...betas].map(value => value.trim()).filter(Boolean))];
    if (merged.length) headers.set("anthropic-beta", merged.join(","));
  }
  let response: Response;
  try {
    response = await withSignal(signal, () => externalFetch(`${model.baseURL}/${operation}`, {
      method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal,
    }, model.beforeDispatch));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (input.requestSignal?.aborted) throw new ApiError(499, "request_cancelled", "模型请求已取消");
    if (signal.aborted) throw new ApiError(504, "model_request_timeout", "模型请求超时");
    throw new ApiError(502, "model_transport_failed", "模型请求失败，请检查供应商连接");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new ApiError(response.status, "model_request_failed", `模型服务返回 HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith(input.payload.stream === true ? "text/event-stream" : "application/json")) {
    void response.body?.cancel().catch(() => undefined);
    throw new ApiError(502, "invalid_model_response", "模型服务返回了不匹配的响应协议");
  }
  return response;
}
