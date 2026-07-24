import { describe, expect, test } from "bun:test";

import {
  JUGGLEROUTER_CATALOG_URL,
  fetchJuggleRouterCatalog,
  parseJuggleRouterCatalog,
} from "./jugglerouter-catalog.js";

describe("JuggleRouter catalog", () => {
  test("keeps OpenAI chat models, normalizes tags, and deduplicates model names", () => {
    expect(
      parseJuggleRouterCatalog({
        data: [
          {
            model_name: "gpt-5.3-codex",
            tags: " chat, code, tools, reasoning ",
            supported_endpoint_types: ["openai"],
          },
          {
            model_name: "claude-opus-4-6",
            tags: "chat,vision",
            supported_endpoint_types: ["anthropic", "openai"],
          },
          {
            model_name: "claude-opus-4-6",
            tags: "chat",
            supported_endpoint_types: ["openai"],
          },
          {
            model_name: "embedding-only",
            tags: "embedding",
            supported_endpoint_types: ["openai"],
          },
          {
            model_name: "missing-tags",
            supported_endpoint_types: ["openai"],
          },
          {
            model_name: "anthropic-only",
            tags: "chat",
            supported_endpoint_types: ["anthropic"],
          },
        ],
      }),
    ).toEqual([
      {
        id: "gpt-5.3-codex",
        tags: ["chat", "code", "tools", "reasoning"],
      },
      {
        id: "claude-opus-4-6",
        tags: ["chat", "vision"],
      },
    ]);
  });

  test("fetches the public pricing endpoint", async () => {
    let requestedUrl = "";
    let requestedSignal: AbortSignal | null = null;
    const models = await fetchJuggleRouterCatalog(async (url, init) => {
      requestedUrl = url;
      requestedSignal = init?.signal ?? null;
      return Response.json({
        data: [
          {
            model_name: "chat-model",
            tags: ["chat", "thinking"],
            supported_endpoint_types: ["openai"],
          },
        ],
      });
    });

    expect(requestedUrl).toBe(JUGGLEROUTER_CATALOG_URL);
    expect(requestedSignal === null).toBe(false);
    expect(models).toEqual([{ id: "chat-model", tags: ["chat", "thinking"] }]);
  });

  test("rejects an unsuccessful catalog response", async () => {
    await expect(
      fetchJuggleRouterCatalog(async () => new Response(null, { status: 503 })),
    ).rejects.toThrow("HTTP 503");
  });
});
