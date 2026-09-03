import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../errors.js";
import { createGithubEventRelayClient, createUnconfiguredGithubEventRelayClient } from "./github-event-client.js";

function hasCode(code: string) {
  return (error: unknown) => error instanceof ApiError && error.code === code;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

const repo = { owner: "juggleai", name: "jugglework-desktop" };

test("unconfigured relay client degrades gracefully instead of throwing", async () => {
  const client = createUnconfiguredGithubEventRelayClient();
  assert.deepEqual(await client.listRepositories(), []);
  assert.equal(await client.checkReadiness(repo), "not_connected");
  assert.equal(await client.estimateFrequency({} as never), null);
  await client.requestInstall(repo);
  await client.requestBind(repo);
  assert.deepEqual(await client.listPendingDeliveries(), { items: [], nextCursor: null });
  // TIPS:写回授权/认领详情换取没有一个"合理的空结果"可以优雅降级——没有真实授权/内容就是
  // 不能继续，所以这两个方法拒绝而不是像其它方法那样返回一个安全的默认值。
  await assert.rejects(() => client.fetchWriteBackGrant("task-1", repo), hasCode("github_event_relay_unavailable"));
  await assert.rejects(() => client.claimDelivery("d1"), hasCode("github_event_relay_unavailable"));
});

test("configured relay client fetches an independent write-back grant per call with an agent token", async () => {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  let issued = 0;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    issued += 1;
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> });
    return jsonResponse(200, { token: `grant-${issued}`, expiresAt: "2026-09-02T10:00:00Z" });
  }) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok", agentToken: "agent-tok" }), fakeFetch);
  const first = await client.fetchWriteBackGrant("task-1", repo);
  const second = await client.fetchWriteBackGrant("task-1", repo);
  assert.equal(calls[0]?.url, "https://cloud.example.com/api/v1/automations/github-app-grant");
  assert.deepEqual(calls[0]?.body, { automationId: "task-1", repository: "juggleai/jugglework-desktop" });
  assert.equal(calls[0]?.headers.Authorization, "Bearer tok");
  assert.equal(calls[0]?.headers["X-JuggleWork-Desktop-Agent-Token"], "agent-tok");
  // TIPS:服务端的 expiresAt 是 RFC3339 时间字符串，不是毫秒数——这里必须转换。
  assert.equal(first.expiresAt, Date.parse("2026-09-02T10:00:00Z"));
  // TIPS:两次调用必须各自铸造，不能是同一个缓存值——这是 3c.1 明确要求的行为。
  assert.notEqual(first.token, second.token);
});

test("agent-gated calls reject without a real error before making any request when no agent token is available", async () => {
  let requests = 0;
  const fakeFetch = (async () => { requests += 1; return jsonResponse(200, {}); }) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok" }), fakeFetch);
  await assert.rejects(() => client.fetchWriteBackGrant("task-1", repo), hasCode("github_event_relay_agent_unavailable"));
  await assert.rejects(() => client.listPendingDeliveries(), hasCode("github_event_relay_agent_unavailable"));
  await assert.rejects(() => client.claimDelivery("d1"), hasCode("github_event_relay_agent_unavailable"));
  assert.equal(requests, 0);
});

test("configured relay client rejects with a stable error when auth is unavailable", async () => {
  const client = createGithubEventRelayClient(async () => null);
  await assert.rejects(() => client.listRepositories(), hasCode("github_event_relay_unavailable"));
});

test("listRepositories reads bound connector instances and derives owner/name/visibility", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse(200, {
      items: [
        { id: "conn-1", name: "juggleai/jugglework-desktop", instanceConfigJson: { private: true } },
        { id: "conn-2", name: "juggleai/public-repo", instanceConfigJson: { private: false } },
        { id: "conn-3", name: "not-a-full-name" }, // malformed — must be skipped, not crash
      ],
      nextCursor: null,
    });
  }) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok" }), fakeFetch);
  const repos = await client.listRepositories();
  assert.equal(calls[0]?.url, "https://cloud.example.com/api/v1/connector-instances?connectorType=github&status=active");
  assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer tok");
  assert.deepEqual(repos, [
    { connectorId: "conn-1", owner: "juggleai", name: "jugglework-desktop", visibility: "private" },
    { connectorId: "conn-2", owner: "juggleai", name: "public-repo", visibility: "public" },
  ]);
});

test("checkReadiness forwards the repo as a single query parameter", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => { calls.push(String(url)); return jsonResponse(200, { state: "ready" }); }) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok" }), fakeFetch);
  const state = await client.checkReadiness(repo);
  assert.equal(state, "ready");
  assert.equal(calls[0], "https://cloud.example.com/api/v1/automations/github-readiness?repo=juggleai%2Fjugglework-desktop");
});

test("requestInstall and requestBind both hit the single readiness-request endpoint with a repository string", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return jsonResponse(202, {});
  }) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok" }), fakeFetch);
  await client.requestInstall(repo);
  await client.requestBind(repo);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "https://cloud.example.com/api/v1/automations/github-install-request");
    assert.deepEqual(call.body, { repository: "juggleai/jugglework-desktop" });
  }
});

test("estimateFrequency issues a GET with flattened event types and converts eventsPerDay to a weekly count", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(String(url));
    return jsonResponse(200, { windowDays: 7, sampleSince: "2026-08-26T00:00:00Z", eventsPerDay: 3, eventsPerHour: 0.125 });
  }) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok" }), fakeFetch);
  const perWeek = await client.estimateFrequency({
    version: 1, kind: "event", provider: "github", connectorId: "conn-1", repository: repo,
    matches: [{ event: "pull_request" }, { event: "issues" }],
    concurrencyKey: "entity", deliveryMode: "auto", permissionTier: "auto",
  } as never);
  assert.equal(perWeek, 21);
  assert.equal(calls[0], "https://cloud.example.com/api/v1/automations/github-event-frequency?repo=juggleai%2Fjugglework-desktop&eventTypes=pull_request%2Cissues");
});

test("listPendingDeliveries sends the agent token and converts timestamps to epoch milliseconds", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return jsonResponse(200, {
      items: [{ id: "d1", automationId: "auto-1", eventType: "pull_request", action: "opened", entityRef: "github:pull_request:1", eventTimestamp: "2026-09-02T00:00:00Z", createdAt: "2026-09-02T00:00:01Z" }],
      nextCursor: "cursor-2",
    });
  }) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok", agentToken: "agent-tok" }), fakeFetch);
  const page = await client.listPendingDeliveries("cursor-1");
  assert.equal(calls[0]?.url, "https://cloud.example.com/api/v1/automation-event-deliveries?cursor=cursor-1");
  assert.equal(calls[0]?.headers["X-JuggleWork-Desktop-Agent-Token"], "agent-tok");
  assert.equal(page.nextCursor, "cursor-2");
  assert.equal(page.items[0]?.eventTimestampMs, Date.parse("2026-09-02T00:00:00Z"));
  assert.equal(page.items[0]?.createdAtMs, Date.parse("2026-09-02T00:00:01Z"));
});

test("claimDelivery surfaces a distinguishable expired error instead of a generic one", async () => {
  const fakeFetch = (async () => jsonResponse(410, { error: "automation_event_delivery_expired", message: "This delivery's retention window has elapsed." })) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok", agentToken: "agent-tok" }), fakeFetch);
  await assert.rejects(() => client.claimDelivery("d1"), hasCode("automation_event_delivery_expired"));
});

test("claimDelivery returns authorIsAppIdentity and a millisecond timestamp", async () => {
  const fakeFetch = (async () => jsonResponse(200, {
    id: "d1", automationId: "auto-1", eventType: "pull_request", action: "opened", entityRef: "github:pull_request:1",
    eventTimestamp: "2026-09-02T00:00:00Z", payload: { action: "opened" }, authorIsAppIdentity: true,
  })) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok", agentToken: "agent-tok" }), fakeFetch);
  const detail = await client.claimDelivery("d1");
  assert.equal(detail.authorIsAppIdentity, true);
  assert.equal(detail.eventTimestampMs, Date.parse("2026-09-02T00:00:00Z"));
  assert.deepEqual(detail.payload, { action: "opened" });
});

test("configured relay client surfaces the server's own error code on a non-2xx response", async () => {
  const fakeFetch = (async () => jsonResponse(503, { error: "github_connector_unavailable", message: "GitHub Sources is not configured on this server." })) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok" }), fakeFetch);
  await assert.rejects(() => client.listRepositories(), hasCode("github_connector_unavailable"));
});

test("configured relay client falls back to a generic error code for a non-JSON error body", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok" }), fakeFetch);
  await assert.rejects(() => client.listRepositories(), hasCode("github_event_relay_error"));
});
