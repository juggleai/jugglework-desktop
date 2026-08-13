const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function normalizeBaseUrl(value) {
  const text = requiredText(value, "provider base URL");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("provider base URL must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("provider base URL must use HTTP(S).");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function providerApi(providerConfig) {
  const config = record(providerConfig);
  const options = record(config.options);
  return config.api ?? options.baseURL ?? options.baseUrl;
}

function modelIds(connection) {
  return Array.isArray(connection?.models)
    ? connection.models
      .map((model) => String(model?.id ?? "").trim())
      .filter(Boolean)
    : [];
}

/**
 * Translate the same organization-provider connection payload used by the
 * OpenCode import flow into Codex's provider-neutral inputs. Credentials are
 * deliberately omitted: Desktop Main injects the short-lived token only into
 * the isolated Codex child environment.
 */
export function codexProviderInputFromOpenCodeConnection(connection, options = {}) {
  const providerConfig = record(connection?.providerConfig);
  const availableModels = modelIds(connection);
  const preferredModel = String(options.preferredModel ?? "").trim();
  const model = preferredModel && availableModels.includes(preferredModel)
    ? preferredModel
    : availableModels[0];
  if (!model) throw new Error("organization provider does not expose a model.");

  const providerId = String(options.providerId ?? "jugglework").trim().toLowerCase();
  const tokenEnv = String(options.tokenEnv ?? "JUGGLEWORK_CODEX_GATEWAY_TOKEN").trim();
  if (!PROVIDER_ID_PATTERN.test(providerId)) throw new Error("Codex provider id is invalid.");
  if (!ENV_NAME_PATTERN.test(tokenEnv)) throw new Error("Codex token environment name is invalid.");

  return {
    providerId,
    providerName: String(connection?.name ?? "JuggleWork").trim() || "JuggleWork",
    baseUrl: normalizeBaseUrl(providerApi(providerConfig)),
    tokenEnv,
    model,
    availableModels,
  };
}

export function serializeCodexProviderConfig(input) {
  const providerId = requiredText(input?.providerId, "provider id");
  const providerName = requiredText(input?.providerName, "provider name");
  const baseUrl = normalizeBaseUrl(input?.baseUrl);
  const tokenEnv = requiredText(input?.tokenEnv, "token environment name");
  const model = requiredText(input?.model, "model");
  const reasoningEffort = String(input?.reasoningEffort ?? "medium").trim();
  if (!PROVIDER_ID_PATTERN.test(providerId)) throw new Error("Codex provider id is invalid.");
  if (!ENV_NAME_PATTERN.test(tokenEnv)) throw new Error("Codex token environment name is invalid.");
  if (!REASONING_EFFORTS.has(reasoningEffort)) throw new Error("Codex reasoning effort is invalid.");

  return [
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(providerId)}`,
    `model_reasoning_effort = ${tomlString(reasoningEffort)}`,
    "",
    `[model_providers.${providerId}]`,
    `name = ${tomlString(providerName)}`,
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    `env_key = ${tomlString(tokenEnv)}`,
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "",
  ].join("\n");
}

export function buildCodexGatewayEnvironment(baseEnv, input) {
  const tokenEnv = requiredText(input?.tokenEnv, "token environment name");
  const token = requiredText(input?.token, "gateway token");
  if (!ENV_NAME_PATTERN.test(tokenEnv)) throw new Error("Codex token environment name is invalid.");
  return { ...baseEnv, [tokenEnv]: token };
}
