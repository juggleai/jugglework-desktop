import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchJuggleWorkConnectCapabilities } from "./connect-capability-search.js";
import { writeConnectCloudMcp } from "./connect-state.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const previousRuntimeDb = process.env.JUGGLEWORK_RUNTIME_DB;

afterEach(async () => {
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
  else process.env.JUGGLEWORK_RUNTIME_DB = previousRuntimeDb;
});

async function serverConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "jugglework-capability-search-"));
  roots.push(root);
  process.env.JUGGLEWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test",
    hostToken: "host",
    configPath: join(root, "jugglework.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

type SearchCall = { query: string; limit?: number };

/**
 * Fake jugglework-cloud MCP endpoint. `respond` receives the search arguments
 * and returns either a tools/call result or null to answer with a JSON-RPC error.
 */
function cloudFetcher(
  respond: (args: SearchCall) => Record<string, unknown> | null,
  calls: SearchCall[] = [],
) {
  return async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const params = body.params as { name: string; arguments: SearchCall };
    expect(params.name).toBe("search_capabilities");
    calls.push(params.arguments);
    const result = respond(params.arguments);
    if (!result) return Response.json({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "unknown argument" } });
    return Response.json({ jsonrpc: "2.0", id: 2, result });
  };
}

function textResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

describe("JuggleWork Connect capability search", () => {
  test("returns matches parsed from the tool's text content", async () => {
    const config = await serverConfig();
    await writeConnectCloudMcp(config, { type: "remote", url: "https://work.example/api/mcp/agent", enabled: true });

    const result = await searchJuggleWorkConnectCapabilities(
      config,
      { query: "GitHub" },
      cloudFetcher(() => textResult({ matches: [{ name: "getGithubRepo", description: "Read a repo" }, "postGithubIssue"] })),
    );

    expect(result.ok).toBe(true);
    expect(result.matches.map((match) => match.name)).toEqual(["getGithubRepo", "postGithubIssue"]);
  });

  test("sends only the arguments the live tool schema allows", async () => {
    const config = await serverConfig();
    await writeConnectCloudMcp(config, { type: "remote", url: "https://work.example/api/mcp/agent", enabled: true });
    const calls: SearchCall[] = [];

    await searchJuggleWorkConnectCapabilities(
      config,
      { query: "GitHub", limit: 10 },
      cloudFetcher(() => textResult({ matches: [] }), calls),
    );

    // search_capabilities declares additionalProperties:false over {query, limit};
    // any extra field turns a valid search into invalid_capability_arguments.
    expect(calls).toEqual([{ query: "GitHub", limit: 10 }]);
  });

  test("reads matches from structuredContent when present", async () => {
    const config = await serverConfig();
    await writeConnectCloudMcp(config, { type: "remote", url: "https://work.example/api/mcp/agent", enabled: true });

    const result = await searchJuggleWorkConnectCapabilities(
      config,
      { query: "GitHub" },
      cloudFetcher(() => ({ structuredContent: { matches: [{ name: "getGithubRepo" }] } })),
    );

    expect(result.matches.map((match) => match.name)).toEqual(["getGithubRepo"]);
  });

  test("reports an empty catalog as a successful search, not a failed one", async () => {
    const config = await serverConfig();
    await writeConnectCloudMcp(config, { type: "remote", url: "https://work.example/api/mcp/agent", enabled: true });

    const result = await searchJuggleWorkConnectCapabilities(
      config,
      { query: "GitHub" },
      cloudFetcher(() => textResult({ matches: [] })),
    );

    // The caller must be able to tell "exposed nothing" from "could not ask".
    expect(result).toEqual({ ok: true, matches: [] });
  });

  test("reports failure when the tool rejects the arguments", async () => {
    const config = await serverConfig();
    await writeConnectCloudMcp(config, { type: "remote", url: "https://work.example/api/mcp/agent", enabled: true });

    const result = await searchJuggleWorkConnectCapabilities(
      config,
      { query: "GitHub" },
      // invalid_capability_arguments comes back as an isError tool result, not an HTTP error.
      cloudFetcher(() => ({ isError: true, structuredContent: { error: "invalid_capability_arguments" } })),
    );

    expect(result).toEqual({ ok: false, matches: [] });
  });

  test("reports failure when no jugglework-cloud config is available", async () => {
    const config = await serverConfig();

    const result = await searchJuggleWorkConnectCapabilities(
      config,
      { query: "GitHub" },
      cloudFetcher(() => textResult({ matches: [{ name: "getGithubRepo" }] })),
    );

    expect(result).toEqual({ ok: false, matches: [] });
  });

  test("reports failure when the handshake is rejected", async () => {
    const config = await serverConfig();
    await writeConnectCloudMcp(config, { type: "remote", url: "https://work.example/api/mcp/agent", enabled: true });

    const result = await searchJuggleWorkConnectCapabilities(
      config,
      { query: "GitHub" },
      async () => new Response("unauthorized", { status: 401 }),
    );

    expect(result).toEqual({ ok: false, matches: [] });
  });

  test("skips the round trip for an empty query", async () => {
    const config = await serverConfig();
    await writeConnectCloudMcp(config, { type: "remote", url: "https://work.example/api/mcp/agent", enabled: true });

    const result = await searchJuggleWorkConnectCapabilities(config, { query: "  " }, async () => {
      throw new Error("should not be called");
    });

    expect(result).toEqual({ ok: true, matches: [] });
  });
});
