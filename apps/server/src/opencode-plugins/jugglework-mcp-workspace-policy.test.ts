import { afterEach, describe, expect, test } from "bun:test";

import { JuggleWorkMcpWorkspacePolicy } from "./jugglework-mcp-workspace-policy.js";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.JUGGLEWORK_SERVER_URL;
const originalToken = process.env.JUGGLEWORK_SERVER_TOKEN;
const originalWorkspaceId = process.env.JUGGLEWORK_WORKSPACE_ID;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.JUGGLEWORK_SERVER_URL;
  else process.env.JUGGLEWORK_SERVER_URL = originalUrl;
  if (originalToken === undefined) delete process.env.JUGGLEWORK_SERVER_TOKEN;
  else process.env.JUGGLEWORK_SERVER_TOKEN = originalToken;
  if (originalWorkspaceId === undefined) delete process.env.JUGGLEWORK_WORKSPACE_ID;
  else process.env.JUGGLEWORK_WORKSPACE_ID = originalWorkspaceId;
});

describe("JuggleWork MCP workspace policy plugin", () => {
  test("reads nested OpenCode context and blocks a disabled MCP tool", async () => {
    process.env.JUGGLEWORK_SERVER_URL = "http://jugglework.test";
    process.env.JUGGLEWORK_SERVER_TOKEN = "token";
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/workspaces")) return Response.json({ items: [{ id: "ws_1", path: "/workspace", workspaceType: "local" }] });
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(body);
      if (body.operation === "inventory") {
        return Response.json({ allowed: true, workspaceId: "ws_1", serverNames: ["notion"], revision: 1 });
      }
      return Response.json({ allowed: false, serverName: "notion", code: "mcp_disabled_in_workspace" });
    }) as typeof fetch;

    const plugin = await JuggleWorkMcpWorkspacePolicy({
      context: { directory: "/workspace/.opencode/worktrees/session-1", workspaceId: "ws_1", sessionID: "ses_1" },
    });
    await expect(plugin["tool.execute.before"]({ tool: "notion_search" }, { args: { query: "test" } }))
      .rejects.toThrow("mcp_disabled_in_workspace:notion");
    expect(requests[0]).toMatchObject({ directory: "/workspace/.opencode/worktrees/session-1", workspaceId: "ws_1", sessionId: "ses_1", operation: "inventory" });
  });

  test("does not make an ordinary tool depend on the policy service", async () => {
    process.env.JUGGLEWORK_SERVER_URL = "http://jugglework.test";
    process.env.JUGGLEWORK_SERVER_TOKEN = "token";
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const plugin = await JuggleWorkMcpWorkspacePolicy({ context: { directory: "/workspace" } });
    await expect(plugin["tool.execute.before"]({ tool: "read" }, { args: {} })).resolves.toBeUndefined();
  });

  test("resolves workspace ID from the workspace list when factory context omits it", async () => {
    process.env.JUGGLEWORK_SERVER_URL = "http://jugglework.test";
    process.env.JUGGLEWORK_SERVER_TOKEN = "token";
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/workspaces")) {
        return Response.json({ items: [{ id: "ws_devtodo", root: "/Users/test/devtodo", workspaceType: "local" }] });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(body);
      if (body.operation === "inventory") return Response.json({ allowed: true, serverNames: ["notion"], revision: 1 });
      return Response.json({ allowed: false, serverName: "notion", code: "mcp_disabled_in_workspace" });
    }) as typeof fetch;
    const plugin = await JuggleWorkMcpWorkspacePolicy({ context: { directory: "/Users/test/devtodo/.opencode/worktrees/session-1" } });
    await expect(plugin["tool.execute.before"]({ tool: "notion_search" }, { args: {} })).rejects.toThrow("mcp_disabled_in_workspace:notion");
    expect(requests[0]).toMatchObject({ workspaceId: "ws_devtodo", operation: "inventory" });
  });

  test("prefers the actual Windows worktree over conflicting stale context and environment IDs", async () => {
    process.env.JUGGLEWORK_SERVER_URL = "http://jugglework.test";
    process.env.JUGGLEWORK_SERVER_TOKEN = "token";
    process.env.JUGGLEWORK_WORKSPACE_ID = "ws_env";
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/workspaces")) {
        return Response.json({ items: [{ id: "ws_devtodo", path: "C:/Users/Test/DevTodo", workspaceType: "local" }] });
      }
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ allowed: true, serverNames: ["notion"], revision: 1 });
    }) as typeof fetch;

    await JuggleWorkMcpWorkspacePolicy({
      context: {
        directory: "C:\\Users\\Test\\Other",
        worktree: "c:\\USERS\\TEST\\DEVTODO\\.opencode\\worktrees\\session-1\\",
        workspaceId: "ws_context",
      },
    });

    expect(requests[0]).toMatchObject({
      directory: "c:\\USERS\\TEST\\DEVTODO\\.opencode\\worktrees\\session-1\\",
      workspaceId: "ws_devtodo",
      operation: "inventory",
    });
  });

  test("does not let a stale explicit context ID override an unregistered execution directory", async () => {
    process.env.JUGGLEWORK_SERVER_URL = "http://jugglework.test";
    process.env.JUGGLEWORK_SERVER_TOKEN = "token";
    process.env.JUGGLEWORK_WORKSPACE_ID = "ws_env";
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/workspaces")) return Response.json({ items: [] });
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ allowed: true, serverNames: [], revision: 1 });
    }) as typeof fetch;

    await JuggleWorkMcpWorkspacePolicy({ context: { directory: "/unregistered", workspaceId: "ws_context" } });

    expect(requests[0]).toMatchObject({ directory: "/unregistered", operation: "inventory" });
    expect(requests[0]).not.toHaveProperty("workspaceId");
  });

  test("does not send an environment workspace fallback alongside an actual directory", async () => {
    process.env.JUGGLEWORK_SERVER_URL = "http://jugglework.test";
    process.env.JUGGLEWORK_SERVER_TOKEN = "token";
    process.env.JUGGLEWORK_WORKSPACE_ID = "ws_env";
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/workspaces")) return Response.json({ items: [] });
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ allowed: true, serverNames: [], revision: 1 });
    }) as typeof fetch;

    await JuggleWorkMcpWorkspacePolicy({ context: { directory: "/actual/workspace" } });

    expect(requests[0]).toMatchObject({ directory: "/actual/workspace", operation: "inventory" });
    expect(requests[0]).not.toHaveProperty("workspaceId");
  });

  test("uses environment and session fallbacks when factory directory identity is unavailable", async () => {
    process.env.JUGGLEWORK_SERVER_URL = "http://jugglework.test";
    process.env.JUGGLEWORK_SERVER_TOKEN = "token";
    process.env.JUGGLEWORK_WORKSPACE_ID = "ws_env";
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ allowed: true, serverNames: [], revision: 1 });
    }) as typeof fetch;

    await JuggleWorkMcpWorkspacePolicy();
    delete process.env.JUGGLEWORK_WORKSPACE_ID;
    await JuggleWorkMcpWorkspacePolicy({ context: { sessionID: "ses_fallback" } });

    expect(requests[0]).toMatchObject({ workspaceId: "ws_env", operation: "inventory" });
    expect(requests[1]).toMatchObject({ sessionId: "ses_fallback", operation: "inventory" });
  });

  test("treats the packaged root cwd as unavailable and uses the managed workspace fallback", async () => {
    process.env.JUGGLEWORK_SERVER_URL = "http://jugglework.test";
    process.env.JUGGLEWORK_SERVER_TOKEN = "token";
    process.env.JUGGLEWORK_WORKSPACE_ID = "ws_managed";
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ allowed: true, serverNames: [], revision: 1 });
    }) as typeof fetch;

    await JuggleWorkMcpWorkspacePolicy({ directory: "/" });

    expect(requests[0]).toMatchObject({ workspaceId: "ws_managed", operation: "inventory" });
    expect(requests[0]).not.toHaveProperty("directory");
  });

  test("uses the tool callback session instead of the managed launch workspace", async () => {
    process.env.JUGGLEWORK_SERVER_URL = "http://jugglework.test";
    process.env.JUGGLEWORK_SERVER_TOKEN = "token";
    process.env.JUGGLEWORK_WORKSPACE_ID = "ws_A";
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(body);
      if (body.operation === "inventory") {
        return Response.json({
          allowed: true,
          workspaceId: body.sessionId === "ses_B" ? "ws_B" : "ws_A",
          serverNames: body.sessionId === "ses_B" ? ["github"] : ["notion"],
          revision: 1,
        });
      }
      return Response.json({ allowed: false, serverName: "github", code: "mcp_disabled_in_workspace" });
    }) as typeof fetch;

    const plugin = await JuggleWorkMcpWorkspacePolicy({ directory: "/" });
    await expect(plugin["tool.execute.before"](
      { tool: "github_search", sessionID: "ses_B", callID: "call_1" },
      { args: { query: "test" } },
    )).rejects.toThrow("mcp_disabled_in_workspace:github");

    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({ workspaceId: "ws_A", operation: "inventory" });
    expect(requests[1]).toMatchObject({ sessionId: "ses_B", operation: "inventory" });
    expect(requests[2]).toMatchObject({ sessionId: "ses_B", toolId: "github_search" });
    expect(requests[1]).not.toHaveProperty("workspaceId");
    expect(requests[2]).not.toHaveProperty("workspaceId");
  });

  test("prefers per-call worktree and supports callback identity aliases", async () => {
    process.env.JUGGLEWORK_SERVER_URL = "http://jugglework.test";
    process.env.JUGGLEWORK_SERVER_TOKEN = "token";
    process.env.JUGGLEWORK_WORKSPACE_ID = "ws_A";
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/workspaces")) {
        return Response.json({ items: [{ id: "ws_B", path: "/workspace-b", workspaceType: "local" }] });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(body);
      return body.operation === "inventory"
        ? Response.json({ allowed: true, workspaceId: "ws_B", serverNames: ["github"], revision: 1 })
        : Response.json({ allowed: true, serverName: "github" });
    }) as typeof fetch;

    const plugin = await JuggleWorkMcpWorkspacePolicy({ directory: "/" });
    await plugin["tool.execute.before"]({
      tool: "github_search",
      directory: "/stale-directory",
      worktree: "/workspace-b/.opencode/worktrees/ses_B",
      sessionId: "ses_B",
      workspaceID: "ws_stale",
    }, { args: {} });

    expect(requests.at(-1)).toMatchObject({
      directory: "/workspace-b/.opencode/worktrees/ses_B",
      workspaceId: "ws_B",
      sessionId: "ses_B",
      toolId: "github_search",
    });
  });
});
