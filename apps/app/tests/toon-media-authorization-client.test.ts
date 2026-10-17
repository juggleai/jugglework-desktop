import { afterEach, expect, test } from "bun:test";

import { createJuggleWorkServerClient } from "../src/app/lib/jugglework-server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("v1 media client keeps the exact plan in authorize and submits or retries only by authorization ID", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path.endsWith("/authorize")) return Response.json({ requestSnapshot: { ...exact, projectId: "project" }, requestHash: "a".repeat(64), planFingerprint: "a".repeat(64), planSummary: exact.plan, authorizationId: "authorization-1", expiresAt: "2026-01-01T00:05:00.000Z" });
    return Response.json({ job: { id: "ignored-by-this-contract-test" } }, { status: 422 });
  }) as typeof fetch;
  const client = createJuggleWorkServerClient({ baseUrl: "http://127.0.0.1:8787", token: "client-token" });
  const exact = {
    requestId: "request-1", episodeId: "episode-1", canvasId: "main", nodeId: "image-node", stepId: "image-candidates",
    plan: { kind: "image" as const, model: { kind: "image" as const, providerID: "provider", modelID: "model" }, object: "frame", quantity: 1, prompt: "draw", referencePaths: [], referenceScope: "project" as const, mode: "text-to-image" as const, size: "1024x1024", executionCount: 1, knownCost: null },
  };
  const authorized = await client.authorizeToonMediaJob("ws", "project", exact);
  await expect(client.createToonMediaJob("ws", "project", { authorizationId: authorized.authorizationId, expectedPlanFingerprint: authorized.planFingerprint })).rejects.toThrow();
  await expect(client.retryToonMediaJob("ws", "project", "prior-job", { authorizationId: authorized.authorizationId, expectedPlanFingerprint: authorized.planFingerprint })).rejects.toThrow();
  expect(requests.map((request) => request.body)).toEqual([exact, { authorizationId: "authorization-1", expectedPlanFingerprint: "a".repeat(64) }, { authorizationId: "authorization-1", expectedPlanFingerprint: "a".repeat(64) }]);
});
