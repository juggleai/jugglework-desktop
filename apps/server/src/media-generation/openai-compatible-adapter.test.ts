import { describe, expect, test } from "bun:test";
import { OpenAiCompatibleVideoAdapter, openAiVideoSize } from "./openai-compatible-adapter.js";

const credential = async () => "secret-value";

describe("OpenAiCompatibleVideoAdapter", () => {
  test("maps canonical video presets to OpenAI-style pixel dimensions", () => {
    expect(openAiVideoSize("480p")).toBe("854x480");
    expect(openAiVideoSize("720p")).toBe("1280x720");
    expect(openAiVideoSize("1080p")).toBe("1920x1080");
    expect(openAiVideoSize("4k")).toBe("3840x2160");
    expect(openAiVideoSize("720x1280")).toBe("720x1280");
    expect(openAiVideoSize("other")).toBeUndefined();
  });
  test("submits and polls the official asynchronous videos shape", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = new OpenAiCompatibleVideoAdapter({ providerID: "openai", baseURL: "https://api.example.test/v1", credential, fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (init.method === "POST") return Response.json({ id: "video_1", status: "queued" });
      return Response.json({ id: "video_1", status: "in_progress", progress: 42 });
    }) as never });
    const submitted = await adapter.submit({ jobId: "job", clientRequestId: "request", model: { providerID: "openai", modelID: "video-model" }, mode: "text-to-video", prompt: "waves", options: { durationSeconds: 8, resolution: "1280x720" } }, new AbortController().signal);
    expect(submitted).toEqual({ providerJobId: "video_1" });
    expect(await adapter.inspect("video_1", new AbortController().signal)).toEqual({ status: "running", progress: 42 });
    expect(requests.map((request) => request.url)).toEqual(["https://api.example.test/v1/videos", "https://api.example.test/v1/videos/video_1"]);
    expect(JSON.stringify(submitted)).not.toContain("secret-value");
  });

  test("normalizes failed asynchronous status", async () => {
    const adapter = new OpenAiCompatibleVideoAdapter({ providerID: "openai", baseURL: "https://api.example.test/v1", credential, fetch: (async () => Response.json({ status: "failed", error: { code: "policy", message: "Rejected" } })) as never });
    expect(await adapter.inspect("video_1", new AbortController().signal)).toEqual({ status: "failed", error: { code: "video_provider_failed", message: "Rejected", retryable: false } });
  });

  test("redacts secrets echoed by provider errors", async () => {
    const adapter = new OpenAiCompatibleVideoAdapter({ providerID: "openai", baseURL: "https://api.example.test/v1", credential, fetch: (async () => Response.json({ error: { message: "Bearer sk-secret-token https://example.test/result?signature=private" } }, { status: 400 })) as never });
    await expect(adapter.submit({ jobId: "job", clientRequestId: "request", model: { providerID: "openai", modelID: "video-model" }, mode: "text-to-video", prompt: "waves", options: {} }, new AbortController().signal)).rejects.toThrow("Bearer [REDACTED]");
    try {
      await adapter.submit({ jobId: "job", clientRequestId: "request", model: { providerID: "openai", modelID: "video-model" }, mode: "text-to-video", prompt: "waves", options: {} }, new AbortController().signal);
    } catch (error) {
      expect(String(error)).not.toContain("sk-secret-token");
      expect(String(error)).not.toContain("signature=private");
    }
  });

  test("redacts the exact arbitrary UUID and JWT-like credential", async () => {
    const secret = "be459a45-01ef-47ad-8184-7e937dcb9b86.eyJhbGciOiJIUzI1NiJ9.signature";
    const adapter = new OpenAiCompatibleVideoAdapter({ providerID: "openai", baseURL: "https://api.example.test/v1", credential: async () => secret, fetch: (async () => Response.json({ error: { message: `credential ${secret} rejected` } }, { status: 401 })) as never });
    try {
      await adapter.submit({ jobId: "job", clientRequestId: "request", model: { providerID: "openai", modelID: "video-model" }, mode: "text-to-video", prompt: "waves", options: {} }, new AbortController().signal);
    } catch (error) {
      expect(String(error)).toContain("[REDACTED]");
      expect(String(error)).not.toContain(secret);
    }
  });
});
