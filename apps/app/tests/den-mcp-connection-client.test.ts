import { afterEach, expect, test } from "bun:test";
import { createDenClient } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("retains member-safe connection records without URLs and authorizes their ID", async () => {
  const calls: Array<{ url: string; organizationId: string | null }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, organizationId: new Headers(init?.headers).get("x-jugglework-legacy-org-id") });
    if (url.endsWith("/connect/start")) return Response.json({ status: "needs_auth", authorizeUrl: "https://github.com/login/oauth/authorize?client_id=test" });
    return Response.json({ connections: [
      { id: "github-member", name: "GitHub", status: "active", authType: "oauth", credentialMode: "per_member", connectedForMe: false },
      { id: "github-shared", name: "GitHub", status: "active", authType: "oauth", credentialMode: "shared", connectedForMe: true },
    ] });
  }) as typeof fetch;
  const client = createDenClient({ baseUrl: "https://work.test", token: "test-token" });
  const connections = await client.listMcpConnections("org-one");
  expect(connections).toHaveLength(2);
  expect(connections[0]).toMatchObject({ id: "github-member", url: "", connected: false });
  expect(connections[1]).toMatchObject({ id: "github-shared", url: "", connected: true });
  const result = await client.startMcpConnectionConnect("org-one", connections[0]!.id);
  expect(result.authorizeUrl).toStartWith("https://github.com/login/oauth/authorize");
  expect(calls).toEqual([
    { url: "https://work.test/jwork/api/v1/mcp-connections?scope=usable", organizationId: "org-one" },
    { url: "https://work.test/jwork/api/v1/mcp-connections/github-member/connect/start", organizationId: "org-one" },
  ]);
});

test("full owner responses retain endpoint and connection state", async () => {
  globalThis.fetch = (async () => Response.json({ connections: [
    { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authType: "oauth", credentialMode: "shared", connected: false, connectedForMe: true },
    { id: "invalid", name: "GitHub", url: 42, authType: "oauth", credentialMode: "per_member" },
  ] })) as typeof fetch;
  const connections = await createDenClient({ baseUrl: "https://work.test", token: "test-token" }).listMcpConnections("org-one");
  expect(connections).toHaveLength(1);
  expect(connections[0]).toMatchObject({ url: "https://api.githubcopilot.com/mcp/", connected: false });
});
