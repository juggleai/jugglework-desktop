import { describe, expect, test } from "bun:test";

import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { ConnectGithubReviewProvider } from "./connect-github-provider.js";

const workspace: WorkspaceInfo = { id: "ws-review", name: "Review", path: "/tmp/review", preset: "default", workspaceType: "local" };
const config = { workspaces: [workspace] } as ServerConfig;
const cloudConfig = { type: "remote", url: "https://work.example.test/mcp/agent", headers: { Authorization: "Bearer cloud-secret" } };

type FetchScenario = {
  search?: unknown;
  execute?: unknown;
  executeByMethod?: Record<string, unknown>;
  executeStatus?: number;
  observed?: Array<Record<string, unknown>>;
};

function jsonRpc(id: unknown, result: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

function toolResult(value: unknown, isError = false) {
  return { isError, content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function fetcher(scenario: FetchScenario) {
  return async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    scenario.observed?.push(body);
    if (body.method === "initialize") return jsonRpc(body.id, { protocolVersion: "2025-06-18", capabilities: {} }, { headers: { "mcp-session-id": "review-session" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const params = body.params as { name?: string; arguments?: Record<string, unknown> };
    if (params.name === "search_capabilities") return jsonRpc(body.id, toolResult(scenario.search ?? {
      matches: [
        { name: "mcp:mcpconn_github:search_pull_requests", summary: "GitHub search" },
        { name: "mcp:mcpconn_github:pull_request_read", summary: "GitHub read" },
        { name: "mcp:mcpconn_github:merge_pull_request", summary: "GitHub write" },
      ],
    }));
    if (params.name === "execute_capability") {
      if (scenario.executeStatus) return new Response("rate limited", { status: scenario.executeStatus });
      const args = params.arguments ?? {};
      const capabilityBody = args.body as Record<string, unknown> | undefined;
      const selected = capabilityBody && typeof capabilityBody.method === "string"
        ? scenario.executeByMethod?.[capabilityBody.method]
        : undefined;
      return jsonRpc(body.id, toolResult(selected ?? scenario.execute ?? { items: [] }));
    }
    return new Response("unknown", { status: 500 });
  };
}

function provider(scenario: FetchScenario) {
  return new ConnectGithubReviewProvider({
    config,
    fetcher: fetcher(scenario),
    now: () => new Date("2026-10-03T00:00:00.000Z"),
    resolveCloudConfig: async () => cloudConfig,
  });
}

describe("Connect GitHub Review provider", () => {
  test("discovers only the fixed read capabilities and normalizes a paginated Inbox", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const result = await provider({ observed, execute: {
      items: [{ number: 42, title: "Review me", state: "open", draft: false, html_url: "https://github.com/jugglework/desktop/pull/42", repository_url: "https://api.github.com/repos/jugglework/desktop", user: { login: "maya" }, labels: [{ name: "desktop", color: "abcdef" }], comments: 2, updated_at: "2026-10-02T23:00:00.000Z" }],
      nextPage: 2,
    } }).listInbox({ workspace, relationship: "review_requested", query: "router", limit: 30 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ number: 42, repository: { owner: "jugglework", name: "desktop" }, author: { login: "maya" } });
    expect(result.nextCursor).toBeTruthy();
    const calls = observed.filter((entry) => entry.method === "tools/call").map((entry) => (entry.params as { name: string; arguments: Record<string, unknown> }));
    const execute = calls.find((call) => call.name === "execute_capability")!;
    expect(execute.arguments.name).toBe("mcp:mcpconn_github:search_pull_requests");
    expect(execute.arguments).toMatchObject({ body: { query: "is:open review-requested:@me router", page: 1, perPage: 30 } });
    expect(JSON.stringify(execute)).not.toContain("merge_pull_request");
    expect(JSON.stringify(result)).not.toContain("cloud-secret");
  });

  test("maps workspace-disabled capability discovery without retrying an execute call", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const status = await provider({ observed, search: { matches: [{ status: "disabled_in_workspace", hint: "Enable GitHub in Settings > Connect." }] } }).getConnection({ workspace });
    expect(status).toMatchObject({ state: "disabled_in_workspace", hint: "Enable GitHub in Settings > Connect." });
    expect(observed.filter((entry) => (entry.params as { name?: string } | undefined)?.name === "execute_capability")).toHaveLength(0);
  });

  test("maps a member connection action from capability discovery", async () => {
    const action = {
      version: 1,
      kind: "connection_action",
      source: "jugglework-cloud",
      connectionId: "github",
      connectionName: "GitHub",
      authType: "oauth",
      credentialMode: "per_member",
      state: "needs_connection",
      actor: "member",
      action: { type: "connect", surface: "jugglework_your_connections", retry: "search_capabilities" },
    };
    const status = await provider({ search: { matches: [{ kind: "connection_status", connectionStatus: action }] } }).getConnection({ workspace });
    expect(status).toMatchObject({ state: "member_authorization_required", connectionId: "github", action });
  });

  test("classifies malformed and rate-limited provider responses safely", async () => {
    await expect(provider({ execute: "not-an-object" }).listInbox({ workspace, relationship: "authored", limit: 30 })).rejects.toMatchObject({ code: "github_invalid_response" });
    await expect(provider({ executeStatus: 429 }).listInbox({ workspace, relationship: "authored", limit: 30 })).rejects.toMatchObject({ code: "github_rate_limited" });
  });

  test("partitions cached Inbox data when the member execution credential changes", async () => {
    let credential = "first-member";
    let executeCount = 0;
    const observed: Array<Record<string, unknown>> = [];
    const instance = new ConnectGithubReviewProvider({
      config,
      fetcher: async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const params = body.params as { name?: string } | undefined;
        if (params?.name === "execute_capability") executeCount += 1;
        return fetcher({ observed, execute: { items: [] } })(url, init);
      },
      resolveCloudConfig: async () => ({ ...cloudConfig, headers: { Authorization: `Bearer ${credential}` } }),
    });
    await instance.listInbox({ workspace, relationship: "authored", limit: 30 });
    credential = "second-member";
    await instance.listInbox({ workspace, relationship: "authored", limit: 30 });
    expect(executeCount).toBe(2);
    expect(JSON.stringify(await instance.getConnection({ workspace }))).not.toContain("member");
  });

  test("normalizes the live GitHub detail and file response shapes", async () => {
    const instance = provider({
      execute: { items: [{ number: 42, title: "Review me", state: "open", html_url: "https://github.com/jugglework/desktop/pull/42", repository_url: "https://api.github.com/repos/jugglework/desktop", user: { login: "maya" }, updated_at: "2026-10-03T00:00:00Z" }] },
      executeByMethod: {
        get: { number: 42, title: "Review me", state: "open", html_url: "https://github.com/jugglework/desktop/pull/42", user: { login: "maya" }, head: { ref: "feature", sha: "abc123" }, base: { ref: "main", repo: { full_name: "jugglework/desktop" } }, additions: 2, deletions: 1, changed_files: 1, updated_at: "2026-10-03T00:00:00Z" },
        get_files: [{ filename: "README.md", status: "modified", additions: 2, deletions: 1, changes: 3, patch: "@@ -1 +1,2 @@\n-old\n+new\n+line" }],
      },
    });
    const inbox = await instance.listInbox({ workspace, relationship: "review_requested", limit: 30 });
    const detail = await instance.getDetail({ workspace, reviewId: inbox.items[0].id });
    const files = await instance.listFiles({ workspace, reviewId: inbox.items[0].id, limit: 30 });
    expect(detail.item).toMatchObject({ repository: { fullName: "jugglework/desktop" }, headRevision: "abc123", baseBranch: "main", headBranch: "feature" });
    expect(files.items[0]).toMatchObject({ path: "README.md", status: "modified", additions: 2, deletions: 1 });
    expect(files.items[0].patch?.map((line) => line.kind)).toEqual(["meta", "deletion", "addition", "addition"]);
  });

  test("honors caller cancellation during MCP setup", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(provider({}).getConnection({ workspace, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
