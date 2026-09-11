import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Electron Main modules are JavaScript with checked JSDoc rather than emitted declarations.
// @ts-expect-error Cross-package integration intentionally exercises the production module.
import { createManagedRuntimeSseClient } from "../../desktop/electron/managed-runtime-sse-client.mjs";
// @ts-expect-error Cross-package integration intentionally exercises the production module.
import { createRemoteSessionEventBridge } from "../../desktop/electron/remote-session-event-bridge.mjs";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const CONTROL_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function workspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "jugglework-remote-events-"));
  await mkdir(join(root, ".opencode"), { recursive: true });
  roots.push(root);
  return root;
}

function waitFor<T>(read: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for projected session event")), 2_000);
    const poll = () => {
      const value = read();
      if (value !== undefined) {
        clearTimeout(timeout);
        resolve(value);
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
}

describe("desktop remote session event integration", () => {
  test("streams the actual workspace OpenCode route through the bridge", async () => {
    let upstreamRequest: { pathname: string; directory: string | null; authorization: string | null } | undefined;
    let sendUpstreamEvent: ((event: unknown) => void) | undefined;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/event") return Response.json({ code: "not_found" }, { status: 404 });
        upstreamRequest = {
          pathname: url.pathname,
          directory: request.headers.get("x-opencode-directory"),
          authorization: request.headers.get("authorization"),
        };
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) {
            sendUpstreamEvent = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      },
    }) as Served;
    stops.push(() => upstream.stop(true));

    const root = await workspaceRoot();
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      token: "owt_collaborator_token",
      hostToken: "owt_host_token",
      opencodeUsername: "opencode",
      opencodePassword: "secret",
      approval: { mode: "auto", timeoutMs: 1_000 },
      corsOrigins: ["*"],
      workspaces: [{
        id: "ws_1",
        name: "Workspace",
        path: root,
        preset: "starter",
        workspaceType: "local",
        baseUrl: `http://127.0.0.1:${upstream.port}`,
      }],
      authorizedRoots: [root],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
    };
    const local = await startServer(config) as Served;
    stops.push(() => local.stop(true));

    const published: unknown[] = [];
    const diagnostics: Array<{ message: string; metadata: unknown }> = [];
    let subscriptionUrl: string | undefined;
    let subscriptionAttempts = 0;
    const bridge = createRemoteSessionEventBridge({
      sseClient: createManagedRuntimeSseClient({
        getAccess: () => ({ baseUrl: `http://127.0.0.1:${local.port}`, clientToken: config.token }),
        fetcher: (input: RequestInfo | URL, init?: RequestInit) => {
          subscriptionUrl = input.toString();
          subscriptionAttempts += 1;
          if (subscriptionAttempts === 1) return Promise.resolve(new Response(null, { status: 401 }));
          return fetch(input, init);
        },
      }),
      coordinator: {
        getActiveRunId: () => "run_1",
        recordServerRun: () => true,
        clearTerminalRun: () => true,
      },
      listActiveRuns: async () => ({ items: [] }),
      observeRun: async () => ({ cleared: false, run: null }),
      publish: (event: unknown) => { published.push(event); return true; },
      randomUUID: () => crypto.randomUUID(),
      now: () => Date.parse("2026-09-11T12:00:00.000Z"),
      timers: { setTimeout, clearTimeout },
      coalesceMs: 1,
      subscriptionRetryDelaysMs: [1],
      logger: {
        debug: (message: string, metadata: unknown) => diagnostics.push({ message, metadata }),
        info: (message: string, metadata: unknown) => diagnostics.push({ message, metadata }),
        warn: (message: string, metadata: unknown) => diagnostics.push({ message, metadata }),
        error: (message: string, metadata: unknown) => diagnostics.push({ message, metadata }),
      },
    });
    stops.push(() => bridge.stop());

    expect(bridge.bind({
      controlSessionId: CONTROL_SESSION_ID,
      deviceId: DEVICE_ID,
      workspaceId: "ws_1",
      sessionId: "ses_1",
      rootSessionId: "ses_1",
      payloadVersion: 1,
      connectionGeneration: 7,
    })).toBe(true);

    await waitFor(() => sendUpstreamEvent);
    expect(subscriptionAttempts).toBe(2);
    expect(subscriptionUrl).toBe(`http://127.0.0.1:${local.port}/workspace/ws_1/opencode/event`);
    expect(upstreamRequest).toEqual({
      pathname: "/event",
      directory: root,
      authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    });
    sendUpstreamEvent?.({
      type: "message.updated",
      properties: {
        info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } },
      },
    });
    sendUpstreamEvent?.({
      type: "message.part.updated",
      properties: {
        part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "reply" },
      },
    });

    const messageEvent = await waitFor(() => published.find((event: any) => event.data?.type === "message.upsert")).catch((error) => {
      throw new Error(`${error.message}: ${JSON.stringify(diagnostics)}`);
    });
    expect(messageEvent).toMatchObject({
      controlSessionId: CONTROL_SESSION_ID,
      workspaceId: "ws_1",
      sessionId: "ses_1",
      data: { type: "message.upsert", message: { id: "msg_1", parts: [{ id: "prt_1", text: "reply" }] } },
    });
  });
});
