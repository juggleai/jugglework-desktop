import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { externalFetch } from "../server-fetch.js";
import type { VideoAdapterBinding, VideoAdapterSubmitInput, VideoGenerationAdapter, VideoProviderJobState } from "./types.js";
import type { VideoModelRef } from "@jugglework/types/media-generation";
import { redactProviderMessage, VideoSubmissionError } from "./redaction.js";

type OpenAiCompatibleVideoAdapterOptions = {
  providerID: string;
  modelIDs?: string[];
  baseURL: string;
  credential: () => Promise<string | null>;
  binding?: Omit<VideoAdapterBinding, "adapterId" | "protocol" | "origin">;
  fetch?: typeof externalFetch;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const OPENAI_VIDEO_SIZE_BY_PRESET: Record<string, string> = {
  "480p": "854x480",
  "720p": "1280x720",
  "1080p": "1920x1080",
  "4k": "3840x2160",
};

export function openAiVideoSize(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  return OPENAI_VIDEO_SIZE_BY_PRESET[normalized] ?? (/^\d{2,5}x\d{2,5}$/.test(normalized) ? normalized : undefined);
}

function providerMessage(payload: unknown, fallback: string, credential?: string): string {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  const message = typeof error?.message === "string" && error.message.trim() ? error.message.trim().slice(0, 500) : fallback;
  return redactProviderMessage(message, [credential]);
}

export class OpenAiCompatibleVideoAdapter implements VideoGenerationAdapter {
  readonly id: string;
  readonly binding: VideoAdapterBinding;
  private readonly fetch: typeof externalFetch;
  private readonly modelIDs: Set<string> | null;
  constructor(private readonly options: OpenAiCompatibleVideoAdapterOptions) {
    this.id = `openai-compatible:${options.providerID}`;
    this.binding = { adapterId: this.id, protocol: "openai", origin: new URL(options.baseURL).origin,
      configFingerprint: options.binding?.configFingerprint ?? "direct", cloudProviderId: options.binding?.cloudProviderId ?? null,
      organizationId: options.binding?.organizationId ?? null };
    this.fetch = options.fetch ?? externalFetch;
    this.modelIDs = options.modelIDs ? new Set(options.modelIDs) : null;
  }
  matches(model: VideoModelRef) { return model.providerID === this.options.providerID && (!this.modelIDs || this.modelIDs.has(model.modelID)); }

  private async apiKey(): Promise<string> {
    const value = (await this.options.credential())?.trim();
    if (value) return value;
    throw new Error("video_credential_missing");
  }

  private endpoint(path: string): string {
    return `${this.options.baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  private async request(path: string, init: RequestInit): Promise<{ response: Response; credential: string }> {
    const credential = await this.apiKey();
    try {
      const response = await this.fetch(this.endpoint(path), {
        ...init,
        headers: { Authorization: `Bearer ${credential}`, ...init.headers },
        redirect: "follow",
      });
      return { response, credential };
    } catch (error) {
      throw new VideoSubmissionError("unknown", "video_provider_transport_unknown", redactProviderMessage(error, [credential]));
    }
  }

  async submit(input: VideoAdapterSubmitInput, signal: AbortSignal): Promise<{ providerJobId: string }> {
    let body: BodyInit;
    let headers: HeadersInit | undefined = { "Content-Type": "application/json", "Idempotency-Key": input.clientRequestId };
    const seconds = input.options.durationSeconds;
    const size = openAiVideoSize(input.options.resolution);
    if (input.mode === "image-to-video") {
      if (!input.sourceImagePath) throw new Error("video_source_image_required");
      const form = new FormData();
      form.set("prompt", input.prompt);
      form.set("model", input.model.modelID);
      if (typeof seconds === "number") form.set("seconds", String(seconds));
      if (typeof size === "string") form.set("size", size);
      const bytes = await readFile(input.sourceImagePath);
      form.set("input_reference", new Blob([bytes]), basename(input.sourceImagePath));
      body = form;
      headers = { "Idempotency-Key": input.clientRequestId };
    } else {
      body = JSON.stringify({
        prompt: input.prompt,
        model: input.model.modelID,
        ...(typeof seconds === "number" ? { seconds: String(seconds) } : {}),
        ...(typeof size === "string" ? { size } : {}),
      });
    }
    const { response, credential } = await this.request("videos", { method: "POST", headers, body, signal });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new VideoSubmissionError("rejected", response.status === 429 ? "video_provider_rate_limited" : "video_provider_submission_failed", providerMessage(payload, response.status === 429 ? "video_provider_rate_limited" : "video_provider_submission_failed", credential), response.status === 429);
    const id = isRecord(payload) && typeof payload.id === "string" ? payload.id.trim() : "";
    if (!id) throw new VideoSubmissionError("unknown", "video_provider_invalid_response", "The provider submission response did not contain a job identifier.");
    return { providerJobId: id };
  }

  async inspect(providerJobId: string, signal: AbortSignal): Promise<VideoProviderJobState> {
    const { response, credential } = await this.request(`videos/${encodeURIComponent(providerJobId)}`, { method: "GET", signal });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(providerMessage(payload, "video_provider_status_failed", credential));
    if (!isRecord(payload) || typeof payload.status !== "string") throw new Error("video_provider_invalid_response");
    const progress = typeof payload.progress === "number" ? payload.progress : undefined;
    if (payload.status === "queued") return { status: "submitted", ...(progress !== undefined ? { progress } : {}) };
    if (payload.status === "in_progress") return { status: "running", ...(progress !== undefined ? { progress } : {}) };
    if (payload.status === "completed") return { status: "completed", resultReference: providerJobId };
    if (payload.status === "failed") return { status: "failed", error: { code: "video_provider_failed", message: providerMessage(payload, "Video generation failed."), retryable: false } };
    throw new Error("video_provider_unknown_status");
  }

  acquireResult(resultReference: string, signal: AbortSignal): Promise<Response> {
    return this.request(`videos/${encodeURIComponent(resultReference)}/content`, { method: "GET", signal }).then(({ response }) => response);
  }
}
