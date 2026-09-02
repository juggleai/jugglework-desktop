import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../errors.js";
import { createGithubEventRelayClient, createUnconfiguredGithubEventRelayClient } from "./github-event-client.js";

function hasCode(code: string) {
  return (error: unknown) => error instanceof ApiError && error.code === code;
}

test("unconfigured relay client degrades gracefully instead of throwing", async () => {
  const client = createUnconfiguredGithubEventRelayClient();
  assert.deepEqual(await client.listRepositories(), []);
  assert.equal(await client.checkReadiness({ owner: "juggleai", name: "jugglework-desktop" }), "not_connected");
  assert.equal(await client.estimateFrequency({} as never), null);
  await client.requestInstall();
  await client.requestBind({ owner: "juggleai", name: "jugglework-desktop" });
  // TIPS:写回授权换取没有一个"合理的空结果"可以优雅降级——没有真实授权就是不能写回，
  // 所以这一个方法拒绝而不是像其它方法那样返回一个安全的默认值。
  await assert.rejects(() => client.fetchWriteBackGrant("task-1", { owner: "juggleai", name: "jugglework-desktop" }), hasCode("github_event_relay_unavailable"));
});

test("configured relay client fetches an independent write-back grant per call", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let issued = 0;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    issued += 1;
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ token: `grant-${issued}`, expiresAt: 1000 + issued }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok" }), fakeFetch);
  const first = await client.fetchWriteBackGrant("task-1", { owner: "juggleai", name: "jugglework-desktop" });
  const second = await client.fetchWriteBackGrant("task-1", { owner: "juggleai", name: "jugglework-desktop" });
  assert.equal(calls[0]?.url, "https://cloud.example.com/api/v1/automations/github-app-grant");
  assert.deepEqual(calls[0]?.body, { automationId: "task-1", repo: { owner: "juggleai", name: "jugglework-desktop" } });
  // TIPS:两次调用必须各自铸造，不能是同一个缓存值——这是 3c.1 明确要求的行为。
  assert.notEqual(first.token, second.token);
});

test("configured relay client rejects with a stable error when auth is unavailable", async () => {
  const client = createGithubEventRelayClient(async () => null);
  await assert.rejects(() => client.listRepositories(), hasCode("github_event_relay_unavailable"));
});

test("configured relay client forwards to the resolved base URL with a bearer token", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ items: [{ connectorId: "c1", owner: "juggleai", name: "jugglework-desktop", visibility: "public" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok" }), fakeFetch);
  const repos = await client.listRepositories();
  assert.equal(repos.length, 1);
  assert.equal(calls[0]?.url, "https://cloud.example.com/api/v1/automations/github-repositories");
  assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer tok");
});

test("configured relay client surfaces a stable error code on a non-2xx response", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const client = createGithubEventRelayClient(async () => ({ baseUrl: "https://cloud.example.com", token: "tok" }), fakeFetch);
  await assert.rejects(() => client.listRepositories(), hasCode("github_event_relay_error"));
});
