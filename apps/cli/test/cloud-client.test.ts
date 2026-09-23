import assert from "node:assert/strict";
import test from "node:test";
import { CloudClient, CloudHttpError } from "../src/cloud-client.js";
import { normalizeCloudUrl } from "../src/cloud-url.js";

test("public catalog omits authorization and organization headers", async () => {
  let headers: Headers | null = null;
  const client = new CloudClient(normalizeCloudUrl("https://cloud.example"), (async (_input, init) => {
    headers = new Headers(init?.headers);
    return Response.json({ provider: { models: {} } });
  }) as typeof fetch);
  await client.catalog();
  assert.equal(headers!.get("authorization"), null);
  assert.equal(headers!.get("x-jugglework-org-id"), null);
  assert.equal(headers!.get("x-jugglework-legacy-org-id"), null);
});

test("organization inventory sends bearer and both organization headers", async () => {
  let headers: Headers | null = null;
  const client = new CloudClient(normalizeCloudUrl("https://cloud.example"), (async (_input, init) => {
    headers = new Headers(init?.headers);
    return Response.json({ llmProviders: [] });
  }) as typeof fetch);
  await client.providers("session-secret", "org_123");
  assert.equal(headers!.get("authorization"), "Bearer session-secret");
  assert.equal(headers!.get("x-jugglework-org-id"), "org_123");
  assert.equal(headers!.get("x-jugglework-legacy-org-id"), "org_123");
});

test("organization state preserves the Cloud active choice and switching uses the Desktop endpoint", async () => {
  const requests: Array<{ url: string; method: string; authorization: string | null; body: string | null }> = [];
  const client = new CloudClient(normalizeCloudUrl("https://cloud.example"), (async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? init.body : null });
    return Response.json(requests.length === 1
      ? { orgs: [{ id: "org-a", slug: "a", name: "A" }], activeOrgId: "org-a", activeOrgSlug: "a" }
      : { ok: true });
  }) as typeof fetch);
  const state = await client.organizationState("session-secret");
  assert.equal(state.activeOrgId, "org-a");
  assert.equal(state.items[0]?.id, "org-a");
  await client.setActiveOrganization("session-secret", "org-a");
  assert.deepEqual(requests[1], {
    url: "https://cloud.example/jwork/api/v1/me/active-organization",
    method: "POST",
    authorization: "Bearer session-secret",
    body: '{"organizationId":"org-a"}',
  });
});

test("Cloud errors are normalized without reflecting response secrets", async () => {
  const client = new CloudClient(normalizeCloudUrl("https://cloud.example"), (async () => Response.json({
    error: "grant_expired",
    message: "grant raw-secret-grant and token raw-secret-token were rejected",
    referenceId: "ref_123",
  }, { status: 401 })) as typeof fetch);
  await assert.rejects(client.exchangeHandoff("raw-secret-grant"), (error: unknown) => {
    assert.ok(error instanceof CloudHttpError);
    assert.equal(error.code, "grant_expired");
    assert.equal(error.referenceId, "ref_123");
    assert.doesNotMatch(error.message, /raw-secret/);
    return true;
  });
});

test("handoff rejects malformed successful responses", async () => {
  const client = new CloudClient(normalizeCloudUrl("https://cloud.example"), (async () => Response.json({ user: { id: "user_1" } })) as typeof fetch);
  await assert.rejects(client.exchangeHandoff("valid_grant_12345"), /did not include a session token/);
});

test("provider fixtures handle empty and unknown provider types without exposing credentials", async () => {
  const fixtures = [
    { llmProviders: [] },
    { llmProviders: [{ id: "pub_unknown", providerId: "future-provider-type", name: "Future", apiKey: "must-not-return", models: [{ id: "future-model", name: "Future Model" }] }] },
  ];
  for (const fixture of fixtures) {
    const client = new CloudClient(normalizeCloudUrl("https://cloud.example"), (async () => Response.json(fixture)) as typeof fetch);
    const providers = await client.providers("session", "org");
    assert.doesNotMatch(JSON.stringify(providers), /must-not-return/);
    if (fixture.llmProviders.length) assert.equal(providers[0]?.providerId, "future-provider-type");
    else assert.deepEqual(providers, []);
  }
});
