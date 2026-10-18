import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../errors.js";
import type { EnvService } from "../env-file.js";
import { ToonflowImageRuntime } from "../media-generation/image-runtime.js";
import { ImageGenerationRepository } from "../media-generation/repository.js";
import { writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import type { ServerConfig } from "../types.js";
import { matchRoute, type RequestContext, type Route } from "./registry.js";
import { registerToonflowRoutes } from "./toonflow.js";

test("Toonflow broker uses canonical credentials and durable workspace-owned video jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "toonflow-model-bridge-"));
  const previousDb = process.env.JUGGLEWORK_RUNTIME_DB;
  const originalFetch = globalThis.fetch;
  let imageRepository: ImageGenerationRepository | undefined;
  process.env.JUGGLEWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const secret = "private-model-key";
  const foreignSecret = "foreign-private-model-key";
  const bypassSecret = "raw-provider-key-must-not-work";
  const received: Array<{ url: string; auth: string | null; apiKey: string | null; anthropicVersion: string | null; anthropicBeta: string | null; body: any }> = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    const url = new URL(request.url).pathname;
    received.push({
      url, auth: request.headers.get("authorization"), apiKey: request.headers.get("x-api-key"),
      anthropicVersion: request.headers.get("anthropic-version"), anthropicBeta: request.headers.get("anthropic-beta"), body,
    });
    if (body.stream === false) return Response.json({ id: "non-stream", output: [{ type: "message", content: [] }] });
    if (url.endsWith("/responses")) return new Response([
      "event: response.reasoning_summary_text.delta", "data: {\"delta\":\"think\"}", "",
      "event: response.function_call_arguments.delta", "data: {\"delta\":\"{\\\"path\\\":\\\"a\\\"}\"}", "",
      "event: response.completed", "data: {\"type\":\"response.completed\"}", "",
    ].join("\n"), { headers: { "Content-Type": "text/event-stream" } });
    if (url.endsWith("/messages")) return new Response([
      "event: content_block_start", "data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool_1\",\"name\":\"read\",\"input\":{}}}", "",
      "event: content_block_delta", "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"think\"}}", "",
      "event: message_stop", "data: {\"type\":\"message_stop\"}", "",
    ].join("\n"), { headers: { "Content-Type": "text/event-stream" } });
    return new Response("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\",\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]}}]}\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  } });
  try {
    const workspace = { id: "toon-models", name: "Models", path: root, preset: "starter", workspaceType: "local" as const };
    const foreign = { ...workspace, id: "foreign-models" };
    const config = { workspaces: [workspace, foreign], configPath: join(root, "server.json"), readOnly: false } as ServerConfig;
    const provider = {
      npm: "@ai-sdk/openai-compatible", name: "Configured models", env: ["TOON_TEST_KEY"],
      options: { baseURL: `http://127.0.0.1:${upstream.port}/v1` },
      models: { text: { name: "Text" }, image: { imageGeneration: { textToImage: true } }, video: { mediaGeneration: { textToVideo: true, imageToVideo: true, protocol: "openai" } } },
    };
    const responsesProvider = {
      npm: "@ai-sdk/openai", name: "OpenAI responses", env: ["TOON_TEST_KEY"],
      options: { baseURL: `http://127.0.0.1:${upstream.port}/v1` }, models: { reasoning: { name: "Reasoning" } },
    };
    const anthropicProvider = {
      npm: "@ai-sdk/anthropic", name: "Anthropic messages", env: ["TOON_TEST_KEY"],
      options: { baseURL: `http://127.0.0.1:${upstream.port}/v1` }, models: { claude: { name: "Claude" } },
    };
    const bypass = {
      npm: "@ai-sdk/openai-compatible", name: "Bypass", env: [],
      options: { baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: bypassSecret }, models: { text: { name: "Bypass text" } },
    };
    await writeRuntimeOpencodeConfig(config, workspace.id, () => ({
      enabled_providers: ["configured", "responses", "anthropic", "bypass"],
      provider: { configured: provider, responses: responsesProvider, anthropic: anthropicProvider, bypass },
    }));
    await writeRuntimeOpencodeConfig(config, foreign.id, () => ({
      enabled_providers: ["configured"],
      provider: { configured: { ...provider, env: ["TOON_FOREIGN_KEY"] } },
    }));

    type Job = {
      id: string; workspaceId: string; model: { providerID: string; modelID: string }; mode: "text-to-video" | "image-to-video";
      status: "submitted" | "cancel_requested" | "completed"; options: Record<string, unknown>; pollAttempts: number;
      revision: number; createdAt: number; updatedAt: number; artifact?: { path: string; mimeType: "video/mp4"; bytes: number };
    };
    const jobs = new Map<string, Job>();
    const requests = new Map<string, string>();
    let submissions = 0;
    const mediaGenerationRuntime = {
      async listModels() {
        return { models: [{ ref: { providerID: "configured", modelID: "video" } }] };
      },
      async generate(input: any, context: Record<string, unknown>) {
        const key = `${context.workspaceId}:${input.clientRequestId}`;
        const existing = requests.get(key);
        if (existing) return { job: jobs.get(existing) };
        submissions += 1;
        const now = Date.now();
        const job: Job = { id: crypto.randomUUID(), workspaceId: String(context.workspaceId), model: input.model, mode: input.mode, status: "submitted", options: {}, pollAttempts: 0, revision: 1, createdAt: now, updatedAt: now };
        jobs.set(job.id, job); requests.set(key, job.id);
        return { job };
      },
      async getJob(jobId: string, context: Record<string, unknown>) {
        const job = jobs.get(jobId);
        if (!job || job.workspaceId !== context.workspaceId) throw new ApiError(404, "video_job_not_found", "Video job not found");
        return { job };
      },
      async cancelJob(jobId: string, context: Record<string, unknown>) {
        const job = jobs.get(jobId);
        if (!job || job.workspaceId !== context.workspaceId) throw new ApiError(404, "video_job_not_found", "Video job not found");
        job.status = "cancel_requested"; job.revision += 1;
        return { job };
      },
    };
    const env = { list: async () => [{ key: "TOON_TEST_KEY", value: secret }, { key: "TOON_FOREIGN_KEY", value: foreignSecret }] } as unknown as EnvService;
    imageRepository = await ImageGenerationRepository.open(config);
    let imageGenerationRuntime = new ToonflowImageRuntime({ config, env, repository: imageRepository });
    const registration = (routes: Route[]) => registerToonflowRoutes({ routes, config, env, mediaGenerationRuntime, imageGenerationRuntime,
      resolveWorkspace: async (_config, id) => {
        const found = config.workspaces.find(item => item.id === id);
        if (!found) throw new Error("workspace_not_found");
        return found;
      },
      jsonResponse: (value, status = 200) => Response.json(value, { status }),
    });
    const routes: Route[] = [];
    registration(routes);
    async function request(routeSet: Route[], workspaceId: string, path: string, input?: unknown, init?: { signal?: AbortSignal; headers?: HeadersInit }) {
      const url = new URL(`http://127.0.0.1/workspace/${workspaceId}/toonflow/${path}`);
      const route = matchRoute(routeSet, input === undefined ? "GET" : "POST", url.pathname)!;
      expect(route.auth).toBe("client");
      return route.handler({ request: new Request(url, input === undefined ? { signal: init?.signal } : {
        method: "POST", body: JSON.stringify(input), signal: init?.signal,
        headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(init?.headers)) },
      }), url, params: route.params, config } as RequestContext);
    }

    const catalogText = await (await request(routes, workspace.id, "models")).text();
    const catalog = JSON.parse(catalogText) as { models: Array<{ providerId: string; modelId: string }> };
    expect(catalog.models.map(model => `${model.providerId}/${model.modelId}`)).toEqual([
      "configured/text", "configured/image", "configured/video", "responses/reasoning", "anthropic/claude",
    ]);
    expect(catalogText).not.toContain(secret);
    expect(catalogText).not.toContain(bypassSecret);
    expect(catalogText).not.toContain("baseURL");

    const stream = await request(routes, workspace.id, "proxy/configured/chat", {
      modelId: "text", payload: { model: "injected", messages: [{ role: "user", content: "hello" }], stream: true },
    }, { headers: { Authorization: `Bearer ${bypassSecret}`, "x-api-key": bypassSecret } });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const chatText = await stream.text();
    expect(chatText).toContain("reasoning_content");
    expect(chatText).toContain("tool_calls");
    expect(chatText).toContain("[DONE]");
    expect(stream.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(stream.headers.get("x-accel-buffering")).toBe("no");
    expect(received[0]).toMatchObject({ url: "/v1/chat/completions", auth: `Bearer ${secret}`, apiKey: null, body: { model: "text" } });

    const responsesPayload = {
      model: "caller-cannot-select", input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }], stream: true,
      store: false, reasoning: { effort: "high", summary: "auto" }, include: ["reasoning.encrypted_content"],
      tools: [{ type: "function", name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
    };
    const responsesStream = await request(routes, workspace.id, "proxy/responses/responses", { modelId: "reasoning", payload: responsesPayload });
    const responsesText = await responsesStream.text();
    expect(responsesText).toContain("response.reasoning_summary_text.delta");
    expect(responsesText).toContain("response.function_call_arguments.delta");
    expect(received.at(-1)).toMatchObject({ url: "/v1/responses", auth: `Bearer ${secret}`, body: { ...responsesPayload, model: "reasoning" } });

    const anthropicPayload = {
      model: "caller-cannot-select", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] }],
      max_tokens: 4096, stream: true, thinking: { type: "enabled", budget_tokens: 1024 },
      betas: ["interleaved-thinking-2025-05-14"],
      tools: [{ name: "read", description: "Read", input_schema: { type: "object", properties: {} } }],
    };
    const anthropicStream = await request(routes, workspace.id, "proxy/anthropic/messages", { modelId: "claude", payload: anthropicPayload });
    const anthropicText = await anthropicStream.text();
    expect(anthropicText).toContain("thinking_delta");
    expect(anthropicText).toContain("tool_use");
    expect(received.at(-1)).toMatchObject({
      url: "/v1/messages", auth: null, apiKey: secret, anthropicVersion: "2023-06-01",
      anthropicBeta: "interleaved-thinking-2025-05-14", body: { ...Object.fromEntries(Object.entries(anthropicPayload).filter(([key]) => key !== "betas")), model: "claude" },
    });

    const nonStream = await request(routes, workspace.id, "proxy/responses/responses", {
      modelId: "reasoning", payload: { model: "ignored", input: "hello", stream: false, store: false },
    });
    expect(nonStream.headers.get("content-type")).toContain("application/json");
    expect(await nonStream.json()).toMatchObject({ id: "non-stream" });

    await expect(request(routes, workspace.id, "proxy/configured/responses", { modelId: "text", payload: responsesPayload }))
      .rejects.toMatchObject({ status: 400, code: "protocol_mismatch" });
    for (const field of ["apiKey", "baseURL", "headers"]) {
      await expect(request(routes, workspace.id, "proxy/configured/chat", {
        modelId: "text", payload: { model: "text", messages: [{ role: "user", content: "hello" }], stream: true, [field]: field === "headers" ? { Authorization: bypassSecret } : bypassSecret },
      })).rejects.toMatchObject({ status: 400 });
    }
    await expect(request(routes, workspace.id, "proxy/configured/chat", {
      modelId: "text", payload: { model: "text", messages: [{ role: "user", content: "hello" }], stream: true },
    }, { headers: { "Content-Length": String(140 * 1024 * 1024 + 1) } })).rejects.toMatchObject({ status: 413, code: "model_request_too_large" });

    await request(routes, foreign.id, "proxy/configured/chat", {
      modelId: "text", payload: { model: "ignored", messages: [{ role: "user", content: "foreign" }], stream: true },
    });
    expect(received.at(-1)?.auth).toBe(`Bearer ${foreignSecret}`);
    expect(JSON.stringify(received)).not.toContain(bypassSecret);

    const cancelController = new AbortController();
    globalThis.fetch = (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as never;
    const cancelled = request(routes, workspace.id, "proxy/configured/chat", {
      modelId: "text", payload: { model: "ignored", messages: [{ role: "user", content: "cancel" }], stream: true },
    }, { signal: cancelController.signal });
    cancelController.abort();
    await expect(cancelled).rejects.toMatchObject({ status: 499, code: "request_cancelled" });
    globalThis.fetch = (async () => { throw new Error(`transport included ${secret}`); }) as never;
    const redactedTransport = await request(routes, workspace.id, "proxy/configured/chat", {
      modelId: "text", payload: { model: "ignored", messages: [{ role: "user", content: "fail" }], stream: true },
    }).catch(error => error as ApiError);
    expect(redactedTransport).toMatchObject({ status: 502, code: "model_transport_failed" });
    expect(JSON.stringify(redactedTransport)).not.toContain(secret);
    globalThis.fetch = originalFetch;

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let imageSubmissions = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/images/generations")) {
        imageSubmissions += 1;
        expect(init.headers).toMatchObject({ Authorization: `Bearer ${secret}` });
        const body = JSON.parse(String(init.body)) as { prompt: string };
        if (body.prompt === "unknown outcome") throw new Error(`transport failed with ${secret}`);
        return Response.json({ data: [{ b64_json: png.toString("base64") }] });
      }
      return originalFetch(url, init);
    }) as never;
    const imageInput = { providerId: "configured", modelId: "image", operation: "image", payload: {
      clientRequestId: "toonflow-image-1", prompt: "a safe image", mode: "text-to-image",
      model: { providerID: "configured", modelID: "image" }, references: [],
    } };
    const firstImage = await (await request(routes, workspace.id, "proxy/configured/image", imageInput)).json() as { job: { id: string; status: string; artifact: { path: string; mimeType: string; bytes: number } } };
    const secondImage = await (await request(routes, workspace.id, "proxy/configured/image", imageInput)).json() as typeof firstImage;
    expect(firstImage.job).toMatchObject({ status: "completed", artifact: { mimeType: "image/png", bytes: png.byteLength } });
    expect(secondImage.job.id).toBe(firstImage.job.id);
    expect(imageSubmissions).toBe(1);
    expect(JSON.stringify(firstImage)).not.toContain(secret);
    expect(JSON.stringify(firstImage)).not.toContain("baseURL");
    await expect(request(routes, workspace.id, "proxy/configured/image", {
      ...imageInput, payload: { ...imageInput.payload, prompt: "a conflicting image" },
    })).rejects.toMatchObject({ status: 409, code: "image_request_conflict" });

    imageRepository.close();
    imageRepository = await ImageGenerationRepository.open(config);
    imageGenerationRuntime = new ToonflowImageRuntime({ config, env, repository: imageRepository });
    const imageRestartedRoutes: Route[] = [];
    registration(imageRestartedRoutes);
    const restartedImage = await (await request(imageRestartedRoutes, workspace.id, "proxy/configured/image", imageInput)).json() as typeof firstImage;
    expect(restartedImage.job.id).toBe(firstImage.job.id);
    expect(imageSubmissions).toBe(1);
    const imageContentInput = { providerId: "configured", modelId: "image", operation: "image", payload: {}, jobId: firstImage.job.id };
    const imageContent = await request(imageRestartedRoutes, workspace.id, "proxy/configured/image", imageContentInput);
    expect(imageContent.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await imageContent.arrayBuffer())).toEqual(png);
    await expect(request(imageRestartedRoutes, foreign.id, "proxy/configured/image", imageContentInput)).rejects.toMatchObject({ status: 404, code: "image_job_not_found" });

    const unknownInput = { ...imageInput, payload: { ...imageInput.payload, clientRequestId: "toonflow-image-unknown", prompt: "unknown outcome" } };
    const unknownFirst = await (await request(imageRestartedRoutes, workspace.id, "proxy/configured/image", unknownInput)).json() as { job: { id: string; status: string; error?: { message: string } } };
    const unknownSecond = await (await request(imageRestartedRoutes, workspace.id, "proxy/configured/image", unknownInput)).json() as typeof unknownFirst;
    expect(unknownFirst.job.status).toBe("submission_unknown");
    expect(unknownSecond.job.id).toBe(unknownFirst.job.id);
    expect(imageSubmissions).toBe(2);
    expect(JSON.stringify(unknownFirst)).not.toContain(secret);

    const videoInput = { providerId: "configured", modelId: "video", operation: "video", payload: {
      clientRequestId: "toonflow-request-1", prompt: "waves", mode: "image-to-video",
      model: { providerID: "configured", modelID: "video" }, source: { mimeType: "image/png", data: "iVBORw0KGgo=" },
    } };
    const first = (await (await request(routes, workspace.id, "proxy/configured/video", videoInput)).json()) as { job: Job };
    const second = (await (await request(routes, workspace.id, "proxy/configured/video", videoInput)).json()) as { job: Job };
    expect(second.job.id).toBe(first.job.id);
    expect(submissions).toBe(1);

    const restartedRoutes: Route[] = [];
    registration(restartedRoutes);
    const statusInput = { providerId: "configured", modelId: "video", operation: "videoStatus", payload: {}, jobId: first.job.id };
    expect(await (await request(restartedRoutes, workspace.id, "proxy/configured/videoStatus", statusInput)).json()).toMatchObject({ job: { id: first.job.id, status: "submitted" } });
    await expect(request(restartedRoutes, foreign.id, "proxy/configured/videoStatus", statusInput)).rejects.toThrow("Video job not found");

    const cancelInput = { ...statusInput, operation: "videoCancel" };
    expect(await (await request(restartedRoutes, workspace.id, "proxy/configured/videoCancel", cancelInput)).json()).toMatchObject({ job: { status: "cancel_requested" } });

    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]);
    await mkdir(join(root, "artifacts"), { recursive: true });
    await writeFile(join(root, "artifacts", `${first.job.id}.mp4`), mp4);
    Object.assign(jobs.get(first.job.id)!, { status: "completed", artifact: { path: `artifacts/${first.job.id}.mp4`, mimeType: "video/mp4", bytes: mp4.byteLength }, revision: 3 });
    const contentInput = { ...statusInput, operation: "videoContent" };
    const content = await request(restartedRoutes, workspace.id, "proxy/configured/videoContent", contentInput);
    expect(content.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await content.arrayBuffer())).toEqual(mp4);
    expect(JSON.stringify(await (await request(restartedRoutes, workspace.id, "proxy/configured/videoStatus", statusInput)).json())).not.toContain(secret);
  } finally {
    globalThis.fetch = originalFetch;
    imageRepository?.close();
    upstream.stop(true);
    if (previousDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB; else process.env.JUGGLEWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
});
