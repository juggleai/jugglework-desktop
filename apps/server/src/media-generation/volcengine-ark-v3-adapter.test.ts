import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VolcengineArkV3VideoAdapter } from "./volcengine-ark-v3-adapter.js";

const credential = async () => "ark-secret";

describe("VolcengineArkV3VideoAdapter", () => {
  function resultAdapter(options: {
    resolver: (hostname: string) => Promise<{ address: string }[]>;
    fetch?: (target: { url: URL; address: string }) => Promise<Response>;
  }) {
    return new VolcengineArkV3VideoAdapter({
      providerID: "ark", modelIDs: ["seedance"], baseURL: "https://ark.example.test/api/v3", credential,
      resultResolver: options.resolver,
      resultFetch: options.fetch ? (async (target) => options.fetch!(target)) : undefined,
    });
  }

  test("submits text-to-video and maps Ark task completion", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = new VolcengineArkV3VideoAdapter({
      providerID: "ark",
      modelIDs: ["seedance"],
      baseURL: "https://ark.example.test/api/v3",
      credential,
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
        providerID: "ark", modelIDs: ["seedance-i2v"], baseURL: "https://ark.example.test/api/v3", credential,
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
    const adapter = new VolcengineArkV3VideoAdapter({ providerID: "ark", modelIDs: ["seedance"], baseURL: "https://ark.example.test/api/v3", credential, fetch: (async () => response) as never });
    expect(await adapter.inspect("cgt-1", new AbortController().signal)).toEqual({ status: "running" });
    response = Response.json({ status: "failed", error: { message: "Bearer sk-secret-token rejected" } });
    const failed = await adapter.inspect("cgt-1", new AbortController().signal);
    expect(failed).toEqual({ status: "failed", error: { code: "video_provider_failed", message: "Bearer [REDACTED] rejected", retryable: false } });
  });

  test.each([
    ["private initial target", "https://127.0.0.1/result.mp4", "8.8.8.8"],
    ["IPv4-mapped IPv6", "https://video.example.test/result.mp4", "::ffff:127.0.0.1"],
    ["6to4", "https://video.example.test/result.mp4", "2002:0808:0808::1"],
    ["Teredo", "https://video.example.test/result.mp4", "2001:0000:4136:e378:8000:63bf:3fff:fdd2"],
    ["reserved 6bone", "https://video.example.test/result.mp4", "3ffe::1"],
  ])("rejects %s without requesting it", async (_name, url, address) => {
    let requests = 0;
    const adapter = resultAdapter({ resolver: async () => [{ address }], fetch: async () => { requests += 1; return new Response(); } });
    await expect(adapter.acquireResult(url, new AbortController().signal)).rejects.toThrow("external_media_unsafe_url");
    expect(requests).toBe(0);
  });

  test.each(["http://video.example.test/result.mp4", "https://user:secret@video.example.test/result.mp4"])("rejects insecure result URL %s", async (url) => {
    let requests = 0;
    const adapter = resultAdapter({ resolver: async () => [{ address: "8.8.8.8" }], fetch: async () => { requests += 1; return new Response(); } });
    await expect(adapter.acquireResult(url, new AbortController().signal)).rejects.toThrow("external_media_insecure_url");
    expect(requests).toBe(0);
  });

  test("rejects a public redirect to a private target before the second request", async () => {
    const requests: string[] = [];
    const adapter = resultAdapter({
      resolver: async (hostname) => [{ address: hostname === "public.example.test" ? "8.8.8.8" : "169.254.169.254" }],
      fetch: async ({ url, address }) => {
        requests.push(`${url.hostname}@${address}`);
        return new Response(null, { status: 302, headers: { location: "https://metadata.example.test/latest/meta-data" } });
      },
    });
    await expect(adapter.acquireResult("https://public.example.test/result.mp4", new AbortController().signal)).rejects.toThrow("external_media_unsafe_url");
    expect(requests).toEqual(["public.example.test@8.8.8.8"]);
  });

  test("rejects a hostname when any DNS answer is private", async () => {
    let requests = 0;
    const adapter = resultAdapter({
      resolver: async () => [{ address: "8.8.8.8" }, { address: "192.168.1.2" }],
      fetch: async () => { requests += 1; return new Response(); },
    });
    await expect(adapter.acquireResult("https://video.example.test/result.mp4", new AbortController().signal)).rejects.toThrow("external_media_unsafe_url");
    expect(requests).toBe(0);
  });

  test("downloads public HTTPS through a pinned resolved address", async () => {
    const seen: Array<{ url: string; address: string }> = [];
    const adapter = resultAdapter({
      resolver: async () => [{ address: "8.8.8.8" }, { address: "2606:4700:4700::1111" }],
      fetch: async ({ url, address }) => {
        seen.push({ url: url.toString(), address });
        return new Response("video", { status: 200, headers: { "content-type": "video/mp4" } });
      },
    });
    const response = await adapter.acquireResult("https://video.example.test/result.mp4", new AbortController().signal);
    expect(await response.text()).toBe("video");
    expect(seen).toEqual([{ url: "https://video.example.test/result.mp4", address: "8.8.8.8" }]);
  });
});
