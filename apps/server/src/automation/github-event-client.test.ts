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
