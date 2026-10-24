import { describe, expect, test } from "bun:test";

import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { ConnectGithubReviewProvider } from "./connect-github-provider.js";
import { encodeReviewId } from "./review-id.js";

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
  test("unwraps organization gateway and downstream MCP search results", async () => {
    const payload = { total_count: 1, items: [{ number: 17, title: "Review workflow test", state: "open", html_url: "https://github.com/juggleai/jugglework-desktop/pull/17", repository_url: "https://api.github.com/repos/juggleai/jugglework-desktop", user: { login: "yuwnloyblog" }, updated_at: "2026-10-23T15:57:17Z" }] };
    for (const execute of [
      { content: [{ type: "text", text: JSON.stringify(payload) }] },
      { structuredContent: payload, content: [{ type: "text", text: "Search complete" }] },
      toolResult({ content: [{ type: "text", text: JSON.stringify(payload) }] }),
    ]) {
      const observed: Array<Record<string, unknown>> = [];
      const result = await provider({ execute, observed }).listInbox({ workspace, relationship: "all", limit: 30 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ number: 17, title: "Review workflow test", repository: { fullName: "juggleai/jugglework-desktop" }, author: { login: "yuwnloyblog" } });
      expect(observed).toContainEqual(expect.objectContaining({ params: expect.objectContaining({ arguments: expect.objectContaining({ body: expect.objectContaining({ query: "is:open involves:@me" }) }) }) }));
    }
  });

  test("loads recently merged pull requests with an explicit merged query", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const result = await provider({
      observed,
      execute: { items: [{ number: 18, title: "Merged change", state: "closed", merged: true, html_url: "https://github.com/juggleai/jugglework-desktop/pull/18", repository_url: "https://api.github.com/repos/juggleai/jugglework-desktop", user: { login: "yuwnloyblog" }, updated_at: "2026-10-24T01:00:00Z" }] },
    }).listInbox({ workspace, relationship: "recently_merged", limit: 30 });

    expect(result.items[0]).toMatchObject({ state: "merged", relationships: ["recently_merged"] });
    expect(observed).toContainEqual(expect.objectContaining({ params: expect.objectContaining({ arguments: expect.objectContaining({ body: expect.objectContaining({ query: "is:merged involves:@me sort:updated-desc" }) }) }) }));
  });

  test("unwraps downstream PR details, changed files, checks and discussions", async () => {
    const head = "a".repeat(40);
    const wrap = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
    const instance = provider({ executeByMethod: {
      get: wrap({ number: 17, title: "Actual title", state: "open", user: { login: "yuwnloyblog" }, head: { sha: head, ref: "test/review" }, base: { ref: "dev" }, body: "Actual description", changed_files: 1 }),
      get_files: wrap([{ filename: "docs/test.md", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+Test" }]),
      get_check_runs: wrap({ check_runs: [{ id: 1, name: "Docs", status: "completed", conclusion: "success" }] }),
      get_review_comments: wrap({ nodes: [], pageInfo: { hasNextPage: false } }),
      get_comments: wrap([{ id: 2, body: "Test comment", user: { login: "reviewer" }, created_at: "2026-10-23T16:00:00Z" }]),
      get_reviews: wrap([]),
    } });
    const detail = await instance.resolveUrl({ workspace, url: "https://github.com/juggleai/jugglework-desktop/pull/17" });
    expect(detail.item).toMatchObject({ title: "Actual title", body: "Actual description", author: { login: "yuwnloyblog" }, headRevision: head, baseBranch: "dev", headBranch: "test/review" });
    const target = { workspace, reviewId: detail.item.id, limit: 30 };
    expect((await instance.listFiles(target)).items).toHaveLength(1);
    expect((await instance.getChecks(target)).items).toHaveLength(1);
    expect((await instance.listThreads(target)).items).toHaveLength(1);
  });

  test("downstream MCP failures cannot become an empty inbox or a placeholder PR", async () => {
    for (const execute of [toolResult({ message: "GitHub denied access" }, true), toolResult(toolResult({ message: "GitHub denied access" }, true))]) {
      const instance = provider({ execute });
      await expect(instance.listInbox({ workspace, relationship: "all", limit: 30 })).rejects.toMatchObject({ code: "github_invalid_response" });
      await expect(instance.resolveUrl({ workspace, url: "https://github.com/juggleai/jugglework-desktop/pull/17" })).rejects.toMatchObject({ code: "github_invalid_response" });
    }
  });

  test("a nested GitHub publish error cannot be acknowledged as success", async () => {
    const head = "a".repeat(40);
    const instance = provider({ search: { matches: [
      { name: "mcp:mcpconn_github:search_pull_requests" }, { name: "mcp:mcpconn_github:pull_request_read" }, { name: "mcp:mcpconn_github:add_issue_comment" },
    ] }, executeByMethod: { get: toolResult({ state: "open", head: { sha: head } }) }, execute: toolResult({ message: "GitHub denied access" }, true) });
    const reviewId = encodeReviewId({ version: 1, provider: "github", connectionId: "mcpconn_github", hostname: "github.com", owner: "team", repository: "repo", number: 17 });
    await expect(instance.mutate({ workspace, reviewId, kind: "comment", body: "Test", expectedHeadRevision: head, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: "github_review_publish_unconfirmed" });
  });

  test("opens a GitHub PR URL through the current organization and rejects other hosts", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const instance = provider({ observed, executeByMethod: { get: { number: 7, state: "open", title: "Review target", head: { sha: "a".repeat(40) }, base: { ref: "main" } } } });
    const result = await instance.resolveUrl({ workspace, url: "https://github.com/team/repo/pull/7#discussion" });
    expect(result.item.repository.fullName).toBe("team/repo");
    expect(result.item.number).toBe(7);
    const count = observed.length;
    for (const url of ["https://gitlab.com/team/repo/pull/7", "https://github.com.attacker.test/team/repo/pull/7", "http://github.com/team/repo/pull/7", "https://github.com/team/repo/issues/7"]) await expect(instance.resolveUrl({ workspace, url })).rejects.toMatchObject({ code: "invalid_review_url" });
    expect(observed).toHaveLength(count);
  });
  test("publishes explicit review decisions through the same connection at the selected head", async () => {
    const head = "a".repeat(40);
    const reviewId = encodeReviewId({ version: 1, provider: "github", connectionId: "mcpconn_github", hostname: "github.com", owner: "team", repository: "repo", number: 7 });
    for (const event of ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const) {
      const observed: Array<Record<string, unknown>> = [];
      const instance = provider({ observed, search: { matches: [
        { name: "mcp:mcpconn_github:search_pull_requests" }, { name: "mcp:mcpconn_github:pull_request_read" },
        { name: "mcp:mcpconn_github:pull_request_review_write" }, { name: "mcp:unrelated:add_issue_comment" },
      ] }, executeByMethod: { get: { state: "open", head: { sha: head } } }, execute: { message: "Submitted" } });
      expect((await instance.getConnection({ workspace })).operations).toMatchObject({ comment: false, submitReview: true });
      await instance.mutate({ workspace, reviewId, kind: "review", event, body: "Reviewed", expectedHeadRevision: head, requestId: crypto.randomUUID() });
      const calls = observed.filter((entry) => (entry.params as { name?: string } | undefined)?.name === "execute_capability");
      expect(calls.at(-1)?.params).toMatchObject({ arguments: { name: "mcp:mcpconn_github:pull_request_review_write", body: { method: "create", owner: "team", repo: "repo", pullNumber: 7, event, body: "Reviewed", commitID: head } } });
      expect(JSON.stringify(calls)).not.toContain("merge_pull_request");
    }
  });

  test("changed heads and missing write grants cannot publish", async () => {
    const reviewId = encodeReviewId({ version: 1, provider: "github", connectionId: "mcpconn_github", hostname: "github.com", owner: "team", repository: "repo", number: 7 });
    for (const enabled of [true, false]) {
      const observed: Array<Record<string, unknown>> = [];
      const instance = provider({ observed, search: { matches: [
        { name: "mcp:mcpconn_github:search_pull_requests" }, { name: "mcp:mcpconn_github:pull_request_read" },
        ...(enabled ? [{ name: "mcp:mcpconn_github:add_issue_comment" }] : []),
      ] }, executeByMethod: { get: { state: "open", head: { sha: "b".repeat(40) } } } });
      await expect(instance.mutate({ workspace, reviewId, kind: "comment", body: "hello", expectedHeadRevision: "a".repeat(40), requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: enabled ? "review_revision_changed" : "github_review_write_unavailable" });
      expect(observed.filter((entry) => (entry.params as { arguments?: { name?: string } } | undefined)?.arguments?.name?.endsWith(":add_issue_comment"))).toHaveLength(0);
    }
  });

  test("maps fixed pull request actions to the current organization connection", async () => {
    const head = "a".repeat(40);
    const reviewId = encodeReviewId({ version: 1, provider: "github", connectionId: "mcpconn_github", hostname: "github.com", owner: "team", repository: "repo", number: 7 });
    const capabilities = [
      "search_pull_requests", "pull_request_read", "convert_pull_request_to_draft",
      "mark_pull_request_ready_for_review", "update_pull_request", "merge_pull_request", "enable_auto_merge",
    ].map((name) => ({ name: `mcp:mcpconn_github:${name}` }));
    const cases = [
      ["mark_draft", "convert_pull_request_to_draft", { repository_full_name: "team/repo", pr_number: 7 }],
      ["mark_ready", "mark_pull_request_ready_for_review", { repository_full_name: "team/repo", pr_number: 7 }],
      ["close", "update_pull_request", { repository_full_name: "team/repo", pr_number: 7, state: "closed" }],
      ["merge", "merge_pull_request", { repository_full_name: "team/repo", pr_number: 7, expected_head_sha: head, merge_method: "squash" }],
      ["enable_auto_merge", "enable_auto_merge", { repository_full_name: "team/repo", pr_number: 7 }],
    ] as const;
    for (const [action, capability, expectedBody] of cases) {
      const observed: Array<Record<string, unknown>> = [];
      const instance = provider({ observed, search: { matches: capabilities }, executeByMethod: { get: { state: "open", head: { sha: head } } }, execute: action === "merge" ? { merged: true } : { success: true } });
      await instance.mutatePullRequest({ workspace, reviewId, action, expectedHeadRevision: head, requestId: crypto.randomUUID(), ...(action === "merge" ? { mergeMethod: "squash" } : {}) });
      const calls = observed.filter((entry) => (entry.params as { name?: string } | undefined)?.name === "execute_capability");
      expect(calls.at(-1)?.params).toMatchObject({ arguments: { name: `mcp:mcpconn_github:${capability}`, body: expectedBody } });
    }
  });

  test("rejects stale revisions before executing a pull request action", async () => {
    const reviewId = encodeReviewId({ version: 1, provider: "github", connectionId: "mcpconn_github", hostname: "github.com", owner: "team", repository: "repo", number: 7 });
    const observed: Array<Record<string, unknown>> = [];
    const instance = provider({ observed, search: { matches: [
      { name: "mcp:mcpconn_github:search_pull_requests" }, { name: "mcp:mcpconn_github:pull_request_read" }, { name: "mcp:mcpconn_github:merge_pull_request" },
    ] }, executeByMethod: { get: { state: "open", head: { sha: "b".repeat(40) } } } });
    await expect(instance.mutatePullRequest({ workspace, reviewId, action: "merge", expectedHeadRevision: "a".repeat(40), requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: "review_revision_changed" });
    const executed = observed.filter((entry) => (entry.params as { arguments?: { name?: string } } | undefined)?.arguments?.name?.endsWith(":merge_pull_request"));
    expect(executed).toHaveLength(0);
  });
  test("an existing Connect gateway without GitHub capabilities requires organization administrator setup", async () => {
    for (const matches of [[], [{ name: "skill:review_guide", summary: "Review guidance" }]]) {
      const observed: Array<Record<string, unknown>> = [];
      const instance = provider({ observed, search: { matches } });
      expect(await instance.getConnection({ workspace })).toMatchObject({
        state: "organization_admin_action_required",
        hint: "Your organization has not configured GitHub for Code Review. Ask an organization administrator to add a GitHub connection.",
      });
      await expect(instance.listInbox({ workspace, relationship: "all", limit: 30 })).rejects.toMatchObject({ code: "github_organization_admin_action_required" });
      expect(observed.some((entry) => (entry.params as { name?: string } | undefined)?.name === "execute_capability")).toBe(false);
    }
  });

  test("partial, ambiguous, or malformed discovery remains unavailable instead of suggesting missing setup", async () => {
    for (const search of [
      { matches: [{ name: "mcp:github:pull_request_read" }] },
      { matches: [
        { name: "mcp:a:search_pull_requests" },
        { name: "mcp:b:search_pull_requests" },
        { name: "mcp:a:pull_request_read" },
      ] },
      {},
      { matches: null },
      { matches: [null] },
    ]) {
      expect(await provider({ search }).getConnection({ workspace })).toMatchObject({ state: "unavailable" });
    }
  });

  test("GitHub setup can recover immediately after empty discovery without caching the missing state", async () => {
    const scenario: FetchScenario = { search: { matches: [] } };
    const instance = provider(scenario);
    expect((await instance.getConnection({ workspace })).state).toBe("organization_admin_action_required");
    scenario.search = { matches: [
      { name: "mcp:github:search_pull_requests" },
      { name: "mcp:github:pull_request_read" },
    ] };
    expect((await instance.getConnection({ workspace })).state).toBe("ready");
  });

  test("requires both review capabilities to come from the same organization connection", async () => {
    const status = await provider({ search: { matches: [
      { name: "mcp:github-a:search_pull_requests" },
      { name: "mcp:github-b:pull_request_read" },
    ] } }).getConnection({ workspace });
    expect(status).toMatchObject({ state: "unavailable", hint: "GitHub review capabilities resolve to different organization connections." });
  });

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
