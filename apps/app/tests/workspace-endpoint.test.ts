import { afterEach, describe, expect, test } from "bun:test";

import { resolveWorkspaceEndpoint, workspaceServerId } from "../src/app/lib/workspace-endpoint";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("workspace endpoint resolution", () => {
  test("local workspaces use the local server and local workspace id", () => {
    const endpoint = resolveWorkspaceEndpoint({
      id: "ws_local",
      name: "Local",
      path: "/tmp/ws-local",
      preset: "minimal",
      workspaceType: "local",
    }, {
      baseUrl: "http://127.0.0.1:4096",
      token: "local-token",
      hostToken: "local-host-token",
    });

    expect(endpoint?.workspaceId).toBe("ws_local");
    expect(endpoint?.baseUrl).toBe("http://127.0.0.1:4096");
    expect(endpoint?.isRemote).toBe(false);
    expect(endpoint?.mountedBaseUrl).toBe("http://127.0.0.1:4096/workspace/ws_local");
  });

  test("local workspace clients authenticate host-scoped env writes with the host token", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ ok: true, count: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const endpoint = resolveWorkspaceEndpoint({
      id: "ws_local",
      name: "Local",
      path: "/tmp/ws-local",
      preset: "minimal",
      workspaceType: "local",
    }, {
      baseUrl: "http://127.0.0.1:4096",
      token: "local-token",
      hostToken: "local-host-token",
    });
    if (!endpoint) throw new Error("Expected a local workspace endpoint.");

    await endpoint.client.upsertUserEnv([{ key: "LPR_TEST_API_KEY", value: "secret" }]);

    expect(requestUrl).toBe("http://127.0.0.1:4096/env");
    expect(new Headers(requestInit?.headers).get("Authorization")).toBe("Bearer local-token");
    expect(new Headers(requestInit?.headers).get("X-JuggleWork-Host-Token")).toBe("local-host-token");
  });

  test("remote workspaces use the owning worker URL and server-side workspace id", () => {
    const endpoint = resolveWorkspaceEndpoint({
      id: "rem_ui-workspace-b",
      name: "Remote",
      path: "/workspace/server-workspace-b",
      preset: "minimal",
      workspaceType: "remote",
      baseUrl: "https://worker.example.test",
      juggleworkToken: "remote-token",
      juggleworkWorkspaceId: "server-workspace-b",
    }, {
      baseUrl: "http://127.0.0.1:4096",
      token: "local-token",
    });

    expect(endpoint?.workspaceId).toBe("server-workspace-b");
    expect(endpoint?.baseUrl).toBe("https://worker.example.test");
    expect(endpoint?.isRemote).toBe(true);
    expect(endpoint?.mountedBaseUrl).toBe("https://worker.example.test/workspace/server-workspace-b");
  });

  test("remote workspace clients keep bearer and host credentials in separate headers", async () => {
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const endpoint = resolveWorkspaceEndpoint({
      id: "rem_server-workspace-b",
      workspaceType: "remote",
      baseUrl: "https://worker.example.test",
      juggleworkToken: "remote-client-token",
      juggleworkHostToken: "remote-host-token",
    }, { baseUrl: null, token: null });
    if (!endpoint) throw new Error("Expected a remote workspace endpoint.");

    await endpoint.client.listUserEnv();

    const headers = new Headers(requestInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer remote-client-token");
    expect(headers.get("X-JuggleWork-Host-Token")).toBe("remote-host-token");
  });

  test("legacy host-only remote records never reuse the host token as bearer auth", async () => {
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const endpoint = resolveWorkspaceEndpoint({
      id: "rem_server-workspace-b",
      workspaceType: "remote",
      baseUrl: "https://worker.example.test",
      juggleworkHostToken: "legacy-host-token",
    }, { baseUrl: null, token: null });
    if (!endpoint) throw new Error("Expected a remote workspace endpoint.");

    await endpoint.client.listUserEnv();

    const headers = new Headers(requestInit?.headers);
    expect(endpoint.token).toBe("");
    expect(headers.get("Authorization")).toBe(null);
    expect(headers.get("X-JuggleWork-Host-Token")).toBe("legacy-host-token");
  });

  test("legacy client tokens remain bearer auth when the primary field is empty", async () => {
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ ok: true, version: "test", uptimeMs: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const endpoint = resolveWorkspaceEndpoint({
      id: "rem_server-workspace-b",
      workspaceType: "remote",
      baseUrl: "https://worker.example.test",
      juggleworkToken: " ",
      juggleworkClientToken: "legacy-client-token",
      juggleworkHostToken: "remote-host-token",
    }, { baseUrl: null, token: null });
    if (!endpoint) throw new Error("Expected a remote workspace endpoint.");

    await endpoint.client.health();

    const headers = new Headers(requestInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer legacy-client-token");
    expect(headers.get("X-JuggleWork-Host-Token")).toBe("remote-host-token");
  });

  test("remote owner bearer tokens authenticate owner-capable host routes", async () => {
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ ok: true, schemaVersion: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const endpoint = resolveWorkspaceEndpoint({
      id: "rem_server-workspace-b",
      workspaceType: "remote",
      baseUrl: "https://worker.example.test",
      juggleworkToken: "remote-owner-token",
    }, { baseUrl: null, token: null });
    if (!endpoint) throw new Error("Expected a remote workspace endpoint.");

    await endpoint.client.setConnectState(true);

    const headers = new Headers(requestInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer remote-owner-token");
    expect(headers.get("X-JuggleWork-Host-Token")).toBe(null);
  });

  test("remote workspace ids fall back to stripping rem_ when no explicit server id exists", () => {
    expect(workspaceServerId({
      id: "rem_workspace-c",
      name: "Remote fallback",
      path: "/workspace/workspace-c",
      preset: "minimal",
      workspaceType: "remote",
      baseUrl: "https://worker.example.test",
    })).toBe("workspace-c");
  });
});
