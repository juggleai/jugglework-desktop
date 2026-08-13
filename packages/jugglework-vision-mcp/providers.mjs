/**
 * Vision MCP — provider registry
 *
 * TIPS: Practically every major vision vendor ships an OpenAI-compatible
 * /chat/completions endpoint with an identical request/response shape
 * (messages.content accepts text + image_url). So a provider is fully described
 * by the triple "baseURL + apiKey + default model", and one call path serves all.
 *
 * Presets:
 *   jugglework — JuggleWork model gateway (keys stay on the server)
 *   dashscope  — Alibaba Qwen-VL (strongest Chinese OCR / scene understanding)
 *   openai     — GPT-4o / GPT-4o-mini
 *   gemini     — Google Gemini 2.0 Flash / 1.5 Pro
 *   anthropic  — Claude (via the OpenAI-compatible endpoint)
 *   openrouter — aggregator, reaches any model
 *   ollama     — local models (llava / qwen2-vl), no api key
 *   custom     — any OpenAI-compatible endpoint
 */

// ── Provider presets ──

/**
 * Default configuration per provider.
 *
 * @property label        Display name.
 * @property baseURL      Root address of the OpenAI-compatible API.
 * @property defaultModel Default vision model.
 * @property envKey       Environment variable holding the API key.
 * @property needsKey     Whether an API key is mandatory (local models are not).
 */
export const PROVIDER_PRESETS = {
  /**
   * JuggleWork model gateway — the third-party key never reaches this process.
   *
   * TIPS: Must stay first. autoDetectProvider() returns the first preset whose
   * envKey is present, and this preset shares VISION_API_KEY with `custom`;
   * leading the list is what makes a server-managed credential win over a
   * hand-rolled one. baseURL and model are left empty on purpose — the desktop
   * injects them from GET /api/v1/llm-providers/:id/connect.
   */
  jugglework: {
    label: "JuggleWork Gateway",
    baseURL: "",
    defaultModel: "",
    envKey: "VISION_API_KEY",
    needsKey: true,
  },

  /** Alibaba Qwen-VL — best pick for Chinese content; DashScope is OpenAI-compatible. */
  dashscope: {
    label: "Qwen-VL (DashScope)",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-vl-max",
    envKey: "DASHSCOPE_API_KEY",
    needsKey: true,
  },

  /** OpenAI — GPT-4o family, strong general-purpose vision. */
  openai: {
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    envKey: "OPENAI_API_KEY",
    needsKey: true,
  },

  /** Google Gemini — through the official OpenAI-compatible endpoint. */
  gemini: {
    label: "Google Gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    envKey: "GEMINI_API_KEY",
    needsKey: true,
  },

  /** Anthropic Claude — through the official OpenAI-compatible endpoint. */
  anthropic: {
    label: "Anthropic Claude",
    baseURL: "https://api.anthropic.com/v1",
    defaultModel: "claude-3.5-sonnet",
    envKey: "ANTHROPIC_API_KEY",
    needsKey: true,
  },

  /** OpenRouter — one key, every model. */
  openrouter: {
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "google/gemini-2.0-flash-001",
    envKey: "OPENROUTER_API_KEY",
    needsKey: true,
  },

  /** Ollama — local models, no API key; pull a vision model first. */
  ollama: {
    label: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    defaultModel: "llava",
    envKey: "OLLAMA_API_KEY",
    needsKey: false,
  },

  /** Custom — any OpenAI-compatible endpoint. */
  custom: {
    label: "Custom",
    baseURL: "",
    defaultModel: "",
    envKey: "VISION_API_KEY",
    needsKey: false,
  },
};

/**
 * Largest image this server will send upstream, in bytes.
 *
 * TIPS: base64 inflates a payload by 4/3, and the JuggleWork gateway rejects
 * request bodies over 10 MB by default. 7 MB of raw image lands near 9.4 MB
 * encoded, leaving room for the JSON envelope. Override with
 * VISION_MAX_IMAGE_BYTES when a deployment raises its own limit.
 */
export function maxImageBytes() {
  const configured = Number(process.env.VISION_MAX_IMAGE_BYTES?.trim());
  return Number.isFinite(configured) && configured > 0 ? configured : 7 * 1024 * 1024;
}

/**
 * Read the key through the VISION_API_KEY_ENV indirection.
 *
 * TIPS: The JuggleWork gateway names its credential after the provider record
 * (JUGGLEWORK_GATEWAY_KEY_LPR_XXX), so the variable holding the token is only
 * known once an administrator has created that provider. VISION_API_KEY_ENV
 * carries the *name*, never the value — it is safe to ship in a plugin
 * component, while the token itself stays in the desktop's user env store.
 *
 * @returns {string} The resolved key, or an empty string.
 */
function resolveIndirectKey() {
  const name = process.env.VISION_API_KEY_ENV?.trim();
  if (!name) return "";
  return process.env[name]?.trim() || "";
}

/**
 * Resolve the provider configuration currently in effect.
 *
 * Precedence, highest first:
 *   1. VISION_BASE_URL / VISION_MODEL / VISION_API_KEY — override everything
 *   2. VISION_API_KEY_ENV — read the key from the named variable
 *   3. VISION_PROVIDER — take the named preset's defaults
 *   4. Auto-detection — pick the first preset whose key variable is set
 *
 * @returns {{ provider: string, label: string, baseURL: string, model: string, apiKey: string }}
 */
export function resolveProvider() {
  const explicit = process.env.VISION_PROVIDER?.trim().toLowerCase();
  const presetKey = explicit && PROVIDER_PRESETS[explicit] ? explicit : autoDetectProvider();

  const preset = PROVIDER_PRESETS[presetKey] ?? PROVIDER_PRESETS.custom;

  // TIPS: Environment overrides beat preset defaults so users switch models
  // without touching code.
  const baseURL = process.env.VISION_BASE_URL?.trim() || preset.baseURL;
  const model = process.env.VISION_MODEL?.trim() || preset.defaultModel;
  const apiKey = process.env.VISION_API_KEY?.trim()
    || resolveIndirectKey()
    || (preset.envKey ? process.env[preset.envKey]?.trim() : "")
    || "";

  return { provider: presetKey, label: preset.label, baseURL, model, apiKey };
}

/**
 * Detect a provider from the environment.
 *
 * A resolvable VISION_API_KEY_ENV means an administrator wired up the gateway,
 * so it outranks any vendor key that happens to sit in the same environment.
 *
 * @returns {string} Provider key.
 */
function autoDetectProvider() {
  if (resolveIndirectKey()) return "jugglework";
  for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (preset.envKey && process.env[preset.envKey]?.trim()) return key;
  }
  return "custom";
}

/**
 * Report whether the resolved configuration is usable.
 *
 * @param config Return value of resolveProvider().
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateProvider(config) {
  if (!config.baseURL) {
    return { ok: false, error: "No baseURL configured. Set VISION_BASE_URL or VISION_PROVIDER." };
  }
  if (!config.model) {
    return { ok: false, error: "No model configured. Set VISION_MODEL or VISION_PROVIDER." };
  }
  const preset = PROVIDER_PRESETS[config.provider];
  if (preset?.needsKey && !config.apiKey) {
    const named = process.env.VISION_API_KEY_ENV?.trim();
    // Naming the empty variable is the difference between "the admin forgot to
    // wire this up" and "the user has not imported the provider yet".
    const hint = named
      ? `${named} (named by VISION_API_KEY_ENV) is empty — import the organization LLM provider in JuggleWork first`
      : `set ${preset.envKey}, VISION_API_KEY, or VISION_API_KEY_ENV`;
    return { ok: false, error: `${config.label} requires an API key: ${hint}.` };
  }
  return { ok: true };
}

// ── Unified vision call ──

/**
 * Send one image to the vision model (OpenAI-compatible, works for every provider).
 *
 * @param {{ baseURL: string, model: string, apiKey: string }} config Provider configuration.
 * @param {string} prompt Recognition instruction.
 * @param {string} base64 Base64 image payload, without the data: prefix.
 * @param {string} mime MIME type, e.g. image/png.
 * @param {number} timeoutMs Request timeout in milliseconds.
 * @returns {Promise<string>} Text returned by the model.
 */
export async function callVision(config, prompt, base64, mime, timeoutMs = 60_000) {
  const url = `${config.baseURL.replace(/\/+$/, "")}/chat/completions`;

  const body = {
    model: config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
    // TIPS: Most compatible endpoints honour max_tokens; a ceiling keeps a
    // runaway response from stalling the tool call.
    max_tokens: 4096,
  };

  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`Vision API returned ${resp.status}: ${detail.slice(0, 500)}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Vision API returned empty content");

    // TIPS: Some models answer with an array-shaped content; flatten to a string.
    return Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : String(content);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Vision API timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
