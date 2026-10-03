import { describe, expect, test } from "bun:test";

import { mcpPost, readMcpPayload } from "./connect-cloud-mcp-rpc.js";

describe("bounded Cloud MCP transport", () => {
  test("rejects an oversized provider response", async () => {
    const response = new Response(JSON.stringify({ value: "x".repeat(128) }), { headers: { "content-type": "application/json" } });
    await expect(readMcpPayload(response, 32)).rejects.toThrow("size limit");
  });

  test("passes caller cancellation to the transport", async () => {
    const controller = new AbortController();
    const fetcher = async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    const pending = mcpPost(fetcher, "https://example.test/mcp", {}, {}, { signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
