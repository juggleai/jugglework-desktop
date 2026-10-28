import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({ prompt: "waves", model: "video-model", seconds: "8", size: "1280x720", metadata: { resolution: "720p" } });
  });

  test("keeps standard pixel size and sends an explicit billing resolution in JSON", async () => {
    for (const [resolution, size, tier] of [
      ["480p", "854x480", "480p"], ["480x854", "480x854", "480p"],
      ["720p", "1280x720", "720p"], ["720x1280", "720x1280", "720p"],
      ["1080p", "1920x1080", "1080p"], ["1080x1920", "1080x1920", "1080p"],
      ["4k", "3840x2160", "4k"], ["2160x3840", "2160x3840", "4k"],
    ]) {
      const adapter = new OpenAiCompatibleVideoAdapter({ providerID: "managed", baseURL: "https://api.example.test/v1", credential, fetch: (async (_url: string, init: RequestInit) => {
        // This wire shape is mirrored in TestManagedMediaDesktopVideoRequestFixtures.
        expect(JSON.parse(init.body as string)).toEqual({ prompt: "waves", model: "doubao-seedance-2-0-260128", seconds: "8", size, metadata: { resolution: tier } });
        return Response.json({ id: "video_1" });
      }) as never });
      await adapter.submit({ jobId: "job", clientRequestId: "request", model: { providerID: "managed", modelID: "doubao-seedance-2-0-260128" }, mode: "text-to-video", prompt: "waves", options: { durationSeconds: 8, resolution } }, new AbortController().signal);
    }
  });

  test("does not guess a billing tier for missing, auto, or arbitrary sizes", async () => {
    for (const resolution of [undefined, "auto", "1000x720", "1281x720"]) {
      const adapter = new OpenAiCompatibleVideoAdapter({ providerID: "openai", baseURL: "https://api.example.test/v1", credential, fetch: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        expect(body.metadata).toBeUndefined();
        expect(body.size).toBe(resolution?.includes("x") ? resolution : undefined);
        return Response.json({ id: "video_1" });
      }) as never });
      await adapter.submit({ jobId: "job", clientRequestId: "request", model: { providerID: "openai", modelID: "video-model" }, mode: "text-to-video", prompt: "waves", options: { resolution } }, new AbortController().signal);
    }
  });

  test("serializes image-to-video metadata and magic-validated MIME on the actual multipart wire", async () => {
    const root = await mkdtemp(join(tmpdir(), "openai-video-adapter-"));
    try {
      const cases = [
        { mime: "image/png", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), resolution: "720p", size: "1280x720", tier: "720p" },
        { mime: "image/jpeg", bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), resolution: "1080x1920", size: "1080x1920", tier: "1080p" },
        { mime: "image/webp", bytes: new TextEncoder().encode("RIFF0000WEBP"), resolution: "4k", size: "3840x2160", tier: "4k" },
      ];
      for (const entry of cases) {
        // Deliberately misleading extension: MIME must come from these bytes.
        const sourceImagePath = join(root, "reference.wrong");
        await writeFile(sourceImagePath, entry.bytes);
        const adapter = new OpenAiCompatibleVideoAdapter({ providerID: "managed", baseURL: "https://api.example.test/v1", credential, fetch: (async (url: string, init: RequestInit) => {
          const wire = new Request(url, init);
          expect(wire.headers.get("content-type")).toStartWith("multipart/form-data; boundary=");
          expect(wire.headers.get("idempotency-key")).toBe("request");
          // Assert the serialized part header: Bun's formData() parser can
          // discard image/webp MIME for a nonstandard filename extension.
          expect(await wire.clone().text()).toContain(`Content-Type: ${entry.mime}\r\n`);
          const form = await wire.formData();
          expect(form.get("prompt")).toBe("waves");
          expect(form.get("model")).toBe("doubao-seedance-2-0-260128");
          expect(form.get("seconds")).toBe("8");
          expect(form.get("size")).toBe(entry.size);
          expect(form.get("metadata")).toBe(JSON.stringify({ resolution: entry.tier }));
          const reference = form.get("input_reference") as File;
          expect(reference.name).toBe("reference.wrong");
          expect(new Uint8Array(await reference.arrayBuffer())).toEqual(entry.bytes);
          return Response.json({ id: "video_1" });
        }) as never });
        await adapter.submit({ jobId: "job", clientRequestId: "request", model: { providerID: "managed", modelID: "doubao-seedance-2-0-260128" }, mode: "image-to-video", sourceImagePath, prompt: "waves", options: { durationSeconds: 8, resolution: entry.resolution } }, new AbortController().signal);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects invalid reference bytes even with a trusted-looking filename before POST", async () => {
    const root = await mkdtemp(join(tmpdir(), "openai-video-adapter-"));
    let requests = 0;
    try {
      const sourceImagePath = join(root, "reference.png");
      const adapter = new OpenAiCompatibleVideoAdapter({ providerID: "openai", baseURL: "https://api.example.test/v1", credential, fetch: (async () => { requests++; return Response.json({ id: "video_1" }); }) as never });
      for (const bytes of [new TextEncoder().encode("not an image"), Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])]) {
        await writeFile(sourceImagePath, bytes);
        await expect(adapter.submit({ jobId: "job", clientRequestId: "request", model: { providerID: "openai", modelID: "video-model" }, mode: "image-to-video", sourceImagePath, prompt: "waves", options: { resolution: "720p" } }, new AbortController().signal)).rejects.toThrow("video_source_image_invalid_signature");
      }
      expect(requests).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
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
