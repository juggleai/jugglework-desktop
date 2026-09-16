import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { VideoModelRef } from "@jugglework/types/media-generation";
import type { EnvService } from "../env-file.js";
import { externalFetch } from "../server-fetch.js";
import type { VideoAdapterSubmitInput, VideoGenerationAdapter, VideoProviderJobState } from "./types.js";

type VolcengineArkV3VideoAdapterOptions = {
  providerID: string;
  modelIDs: string[];
  baseURL: string;
  envKeys: string[];
  env: EnvService;
  fetch?: typeof externalFetch;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function imageMimeType(path: string, bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

function providerMessage(payload: unknown, fallback: string): string {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim().slice(0, 500)
    : fallback;
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|key|signature|sig|credential)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|jwmcp|jwgw)_[A-Za-z0-9_-]+\b/g, "[REDACTED]");
}

function contentVideoUrl(payload: Record<string, unknown>): string {
  const content = isRecord(payload.content) ? payload.content : null;
  return typeof content?.video_url === "string" ? content.video_url.trim() : "";
}

function arkResolution(value: unknown): { resolution?: string; ratio?: string } {
  if (typeof value !== "string" || !value.trim()) return {};
  const normalized = value.trim().toLowerCase();
  if (["480p", "720p", "1080p", "4k"].includes(normalized)) return { resolution: normalized };
  const match = /^(\d+)x(\d+)$/.exec(normalized);
  if (!match) return { resolution: normalized };
  const width = Number(match[1]);
  const height = Number(match[2]);
  const shortEdge = Math.min(width, height);
  const resolution = shortEdge >= 1080 ? "1080p" : shortEdge >= 720 ? "720p" : "480p";
  const divisor = (a: number, b: number): number => b === 0 ? a : divisor(b, a % b);
  const common = divisor(width, height);
  return { resolution, ratio: `${width / common}:${height / common}` };
}

export class VolcengineArkV3VideoAdapter implements VideoGenerationAdapter {
  readonly id: string;
  private readonly fetch: typeof externalFetch;
  private readonly modelIDs: Set<string>;

  constructor(private readonly options: VolcengineArkV3VideoAdapterOptions) {
    this.id = `volcengine-ark-v3:${options.providerID}`;
    this.fetch = options.fetch ?? externalFetch;
    this.modelIDs = new Set(options.modelIDs);
  }

  matches(model: VideoModelRef) {
    return model.providerID === this.options.providerID && this.modelIDs.has(model.modelID);
  }

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
    const content: Record<string, unknown>[] = [{ type: "text", text: input.prompt }];
    if (input.mode === "image-to-video") {
      if (!input.sourceImagePath) throw new Error("video_source_image_required");
      const image = await readFile(input.sourceImagePath);
      const mimeType = imageMimeType(input.sourceImagePath, image);
      if (!mimeType) throw new Error("video_source_image_invalid");
      content.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` },
      });
    }
    const duration = input.options.durationSeconds;
    const output = arkResolution(input.options.resolution);
    const response = await this.request("contents/generations/tasks", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", "X-Client-Request-Id": input.clientRequestId },
      body: JSON.stringify({
        model: input.model.modelID,
        content,
        ...(typeof duration === "number" ? { duration } : {}),
        ...output,
        output_format: "mp4",
      }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(providerMessage(payload, response.status === 429 ? "video_provider_rate_limited" : "video_provider_submission_failed"));
    const id = isRecord(payload) && typeof payload.id === "string" ? payload.id.trim() : "";
    if (!id) throw new Error("video_provider_invalid_response");
    return { providerJobId: id };
  }

  async inspect(providerJobId: string, signal: AbortSignal): Promise<VideoProviderJobState> {
    const response = await this.request(`contents/generations/tasks/${encodeURIComponent(providerJobId)}`, { method: "GET", signal });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(providerMessage(payload, "video_provider_status_failed"));
    if (!isRecord(payload) || typeof payload.status !== "string") throw new Error("video_provider_invalid_response");
    if (["queued", "pending"].includes(payload.status)) return { status: "submitted" };
    if (["running", "processing"].includes(payload.status)) return { status: "running" };
    if (payload.status === "succeeded") {
      const videoUrl = contentVideoUrl(payload);
      if (!videoUrl) throw new Error("video_provider_invalid_response");
      return { status: "completed", resultReference: videoUrl };
    }
    if (["failed", "expired"].includes(payload.status)) return { status: "failed", error: { code: "video_provider_failed", message: providerMessage(payload, "Video generation failed."), retryable: false } };
    if (["cancelled", "canceled"].includes(payload.status)) return { status: "cancelled" };
    throw new Error("video_provider_unknown_status");
  }

  acquireResult(resultReference: string, signal: AbortSignal): Promise<Response> {
    const url = new URL(resultReference);
    if (url.protocol !== "https:") throw new Error("video_result_insecure_url");
    return this.fetch(url.toString(), { method: "GET", signal, redirect: "follow" });
  }
}
