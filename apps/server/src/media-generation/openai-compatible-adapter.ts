import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { EnvService } from "../env-file.js";
import { externalFetch } from "../server-fetch.js";
import type { VideoAdapterSubmitInput, VideoGenerationAdapter, VideoProviderJobState } from "./types.js";
import type { VideoModelRef } from "@jugglework/types/media-generation";

type OpenAiCompatibleVideoAdapterOptions = {
  providerID: string;
  baseURL: string;
  envKeys: string[];
  env: EnvService;
  fetch?: typeof externalFetch;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function providerMessage(payload: unknown, fallback: string): string {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  const message = typeof error?.message === "string" && error.message.trim() ? error.message.trim().slice(0, 500) : fallback;
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|key|signature|sig|credential)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|jwmcp|jwgw)_[A-Za-z0-9_-]+\b/g, "[REDACTED]");
}

export class OpenAiCompatibleVideoAdapter implements VideoGenerationAdapter {
  readonly id: string;
  private readonly fetch: typeof externalFetch;
  constructor(private readonly options: OpenAiCompatibleVideoAdapterOptions) {
    this.id = `openai-compatible:${options.providerID}`;
    this.fetch = options.fetch ?? externalFetch;
  }
  matches(model: VideoModelRef) { return model.providerID === this.options.providerID; }

  private async apiKey(): Promise<string> {
    const records = await this.options.env.list();
    for (const key of this.options.envKeys) {
      const value = records.find((entry) => entry.key === key)?.value.trim() || process.env[key]?.trim();
      if (value) return value;
    }
    throw new Error("video_credential_missing");
  }

  private endpoint(path: string): string {
    return `${this.options.baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const apiKey = await this.apiKey();
    return this.fetch(this.endpoint(path), {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...init.headers },
      redirect: "follow",
    });
  }

  async submit(input: VideoAdapterSubmitInput, signal: AbortSignal): Promise<{ providerJobId: string }> {
    let body: BodyInit;
    let headers: HeadersInit | undefined = { "Content-Type": "application/json", "Idempotency-Key": input.clientRequestId };
    const seconds = input.options.durationSeconds;
    const size = input.options.resolution;
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
    const response = await this.request("videos", { method: "POST", headers, body, signal });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(providerMessage(payload, response.status === 429 ? "video_provider_rate_limited" : "video_provider_submission_failed"));
    const id = isRecord(payload) && typeof payload.id === "string" ? payload.id.trim() : "";
    if (!id) throw new Error("video_provider_invalid_response");
    return { providerJobId: id };
  }

  async inspect(providerJobId: string, signal: AbortSignal): Promise<VideoProviderJobState> {
    const response = await this.request(`videos/${encodeURIComponent(providerJobId)}`, { method: "GET", signal });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(providerMessage(payload, "video_provider_status_failed"));
    if (!isRecord(payload) || typeof payload.status !== "string") throw new Error("video_provider_invalid_response");
    const progress = typeof payload.progress === "number" ? payload.progress : undefined;
    if (payload.status === "queued") return { status: "submitted", ...(progress !== undefined ? { progress } : {}) };
    if (payload.status === "in_progress") return { status: "running", ...(progress !== undefined ? { progress } : {}) };
    if (payload.status === "completed") return { status: "completed", resultReference: providerJobId };
    if (payload.status === "failed") return { status: "failed", error: { code: "video_provider_failed", message: providerMessage(payload, "Video generation failed."), retryable: false } };
    throw new Error("video_provider_unknown_status");
  }

  acquireResult(resultReference: string, signal: AbortSignal): Promise<Response> {
    return this.request(`videos/${encodeURIComponent(resultReference)}/content`, { method: "GET", signal });
  }
}
