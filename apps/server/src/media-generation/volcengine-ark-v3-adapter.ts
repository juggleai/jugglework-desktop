import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { VideoModelRef } from "@jugglework/types/media-generation";
import { externalFetch } from "../server-fetch.js";
import type { VideoAdapterBinding, VideoAdapterSubmitInput, VideoGenerationAdapter, VideoProviderJobState } from "./types.js";
import { redactProviderMessage, VideoSubmissionError } from "./redaction.js";

type VolcengineArkV3VideoAdapterOptions = {
  providerID: string;
  modelIDs: string[];
  baseURL: string;
  credential: () => Promise<string | null>;
  binding?: Omit<VideoAdapterBinding, "adapterId" | "protocol" | "origin">;
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

function providerMessage(payload: unknown, fallback: string, credential?: string): string {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim().slice(0, 500)
    : fallback;
  return redactProviderMessage(message, [credential]);
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
  readonly binding: VideoAdapterBinding;
  private readonly fetch: typeof externalFetch;
  private readonly modelIDs: Set<string>;

  constructor(private readonly options: VolcengineArkV3VideoAdapterOptions) {
    this.id = `volcengine-ark-v3:${options.providerID}`;
    this.binding = { adapterId: this.id, protocol: "volcengine-ark-v3", origin: new URL(options.baseURL).origin,
      configFingerprint: options.binding?.configFingerprint ?? "direct", cloudProviderId: options.binding?.cloudProviderId ?? null,
      organizationId: options.binding?.organizationId ?? null };
    this.fetch = options.fetch ?? externalFetch;
    this.modelIDs = new Set(options.modelIDs);
  }

  matches(model: VideoModelRef) {
    return model.providerID === this.options.providerID && this.modelIDs.has(model.modelID);
  }

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
    const { response, credential } = await this.request("contents/generations/tasks", {
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
    if (!response.ok) throw new VideoSubmissionError("rejected", response.status === 429 ? "video_provider_rate_limited" : "video_provider_submission_failed", providerMessage(payload, response.status === 429 ? "video_provider_rate_limited" : "video_provider_submission_failed", credential), response.status === 429);
    const id = isRecord(payload) && typeof payload.id === "string" ? payload.id.trim() : "";
    if (!id) throw new VideoSubmissionError("unknown", "video_provider_invalid_response", "The provider submission response did not contain a job identifier.");
    return { providerJobId: id };
  }

  async inspect(providerJobId: string, signal: AbortSignal): Promise<VideoProviderJobState> {
    const { response, credential } = await this.request(`contents/generations/tasks/${encodeURIComponent(providerJobId)}`, { method: "GET", signal });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(providerMessage(payload, "video_provider_status_failed", credential));
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
