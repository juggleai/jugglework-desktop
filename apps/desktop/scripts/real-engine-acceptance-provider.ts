// Shared loopback-only provider/configuration, never an OpenCode protocol mock.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

export function syntheticProvider() {
  const requests: any[] = [], unexpected: string[] = [];
  let mode = "complete", cancelled = 0;
  const encoder = new TextEncoder(), answer = "REAL_ENGINE_SYNTHETIC_OK";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
      unexpected.push(`${req.method} ${url.pathname}`);
      return Response.json({ error: "unexpected synthetic provider route" }, { status: 404 });
    }
    const body = await req.json() as any, currentMode = mode;
    requests.push({ path: url.pathname, body, mode: currentMode });
    assert.equal(body.model, "synthetic"); assert.equal(body.stream, true);
    const chunk = (delta: object, finish_reason: string | null = null) => encoder.encode(`data: ${JSON.stringify({
      id: "chatcmpl-synthetic", object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(chunk({ role: "assistant", content: "" }));
      if (currentMode === "stall") return;
      // Fixed text only; no tool calls/executable output.
      c.enqueue(chunk({ content: answer }));
      c.enqueue(chunk({}, "stop")); c.enqueue(encoder.encode("data: [DONE]\n\n")); c.close();
    }, cancel() { if (currentMode === "stall") cancelled++; } }), { headers: { "content-type": "text/event-stream" } });
  } });
  return { server, requests, unexpected, answer, setMode(value: string) {
    assert.ok(["complete", "stall"].includes(value)); mode = value;
  }, get cancelled() { return cancelled; } };
}

export async function configureSyntheticProvider(port: number) {
  const configuration = { model: "fixture/synthetic", small_model: "fixture/synthetic", share: "disabled", autoupdate: false,
    enabled_providers: ["fixture"], plugin: [], mcp: {}, permission: { "*": "deny" },
    agent: { title: { disable: true }, summary: { disable: true } },
    provider: { fixture: { name: "Loopback synthetic", npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "synthetic-only", timeout: 30000, maxRetries: 0 },
      models: { synthetic: { name: "Synthetic", family: "synthetic", release_date: "2026-01-01",
        attachment: false, reasoning: false, toolcall: false, temperature: false,
        modalities: { input: ["text"], output: ["text"] }, cost: { input: 0, output: 0 },
        limit: { context: 64000, output: 1024 } } } } } };
  await writeFile(process.env.OPENCODE_CONFIG!, JSON.stringify(configuration));
}
