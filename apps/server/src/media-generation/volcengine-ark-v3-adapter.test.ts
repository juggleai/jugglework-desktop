import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VolcengineArkV3VideoAdapter } from "./volcengine-ark-v3-adapter.js";

const env = { list: async () => [{ key: "ARK_API_KEY", value: "ark-secret" }] } as never;

describe("VolcengineArkV3VideoAdapter", () => {
  test("submits text-to-video and maps Ark task completion", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = new VolcengineArkV3VideoAdapter({
      providerID: "ark",
      modelIDs: ["seedance"],
      baseURL: "https://ark.example.test/api/v3",
      envKeys: ["ARK_API_KEY"],
      env,
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        if (init.method === "POST") return Response.json({ id: "cgt-1" });
        return Response.json({ status: "succeeded", content: { video_url: "https://video.example.test/result.mp4" } });
      }) as never,
    });
    expect(adapter.matches({ providerID: "ark", modelID: "seedance" })).toBe(true);
    expect(adapter.matches({ providerID: "ark", modelID: "other" })).toBe(false);
    expect(await adapter.submit({ jobId: "job", clientRequestId: "request", model: { providerID: "ark", modelID: "seedance" }, mode: "text-to-video", prompt: "waves", options: { durationSeconds: 8, resolution: "720p" } }, new AbortController().signal)).toEqual({ providerJobId: "cgt-1" });
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      model: "seedance",
      content: [{ type: "text", text: "waves" }],
      duration: 8,
      resolution: "720p",
      output_format: "mp4",
    });
    expect(await adapter.inspect("cgt-1", new AbortController().signal)).toEqual({ status: "completed", resultReference: "https://video.example.test/result.mp4" });
    expect(requests.map((request) => request.url)).toEqual([
      "https://ark.example.test/api/v3/contents/generations/tasks",
      "https://ark.example.test/api/v3/contents/generations/tasks/cgt-1",
    ]);
  });

  test("submits image-to-video as a validated base64 data URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jugglework-ark-video-"));
    const image = join(directory, "reference.png");
    await writeFile(image, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    try {
      let body: Record<string, unknown> | null = null;
      const adapter = new VolcengineArkV3VideoAdapter({
        providerID: "ark", modelIDs: ["seedance-i2v"], baseURL: "https://ark.example.test/api/v3", envKeys: ["ARK_API_KEY"], env,
        fetch: (async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return Response.json({ id: "cgt-2" }); }) as never,
      });
      await adapter.submit({ jobId: "job", clientRequestId: "request", model: { providerID: "ark", modelID: "seedance-i2v" }, mode: "image-to-video", prompt: "move", sourceImagePath: image, options: {} }, new AbortController().signal);
      expect(body).not.toBeNull();
      const content = (body as unknown as Record<string, unknown>).content as Array<Record<string, unknown>>;
      expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("maps running and sanitized failed states", async () => {
    let response = Response.json({ status: "running" });
    const adapter = new VolcengineArkV3VideoAdapter({ providerID: "ark", modelIDs: ["seedance"], baseURL: "https://ark.example.test/api/v3", envKeys: ["ARK_API_KEY"], env, fetch: (async () => response) as never });
    expect(await adapter.inspect("cgt-1", new AbortController().signal)).toEqual({ status: "running" });
    response = Response.json({ status: "failed", error: { message: "Bearer sk-secret-token rejected" } });
    const failed = await adapter.inspect("cgt-1", new AbortController().signal);
    expect(failed).toEqual({ status: "failed", error: { code: "video_provider_failed", message: "Bearer [REDACTED] rejected", retryable: false } });
  });
});
