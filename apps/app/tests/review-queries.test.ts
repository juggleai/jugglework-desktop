import { describe, expect, test } from "bun:test";

import { reviewChecksPollInterval, reviewQueryKeys, reviewVisiblePollInterval } from "../src/react-app/domains/reviews/review-queries";

const localEndpoint = {
  baseUrl: "http://127.0.0.1:17831",
  token: "secret-not-in-key",
  workspaceId: "ws-1",
  isRemote: false,
  client: {} as never,
  mountedBaseUrl: "http://127.0.0.1:17831/workspace/ws-1",
  opencodeBaseUrl: "http://127.0.0.1:17831/workspace/ws-1/opencode",
};

describe("Review query identity", () => {
  test("scopes data to the owning endpoint without putting credentials in query keys", () => {
    const key = reviewQueryKeys.inbox(localEndpoint, "review_requested", "router");
    expect(key).toEqual(["reviews", "http://127.0.0.1:17831", "ws-1", "inbox", "review_requested", "router"]);
    expect(JSON.stringify(key)).not.toContain("secret-not-in-key");
  });

  test("keeps each detail subresource in an independent cache branch", () => {
    expect(reviewQueryKeys.files(localEndpoint, "review-1")).not.toEqual(reviewQueryKeys.checks(localEndpoint, "review-1"));
    expect(reviewQueryKeys.checks(localEndpoint, "review-1")).not.toEqual(reviewQueryKeys.threads(localEndpoint, "review-1"));
  });

  test("stops retained-surface polling while Reviews is hidden", () => {
    expect(reviewVisiblePollInterval(false, 60_000)).toBe(false);
    expect(reviewChecksPollInterval(false, { schemaVersion: 1, headRevision: "abc", items: [{ id: "check", name: "Build", state: "running" }], cache: { source: "provider", fetchedAt: new Date().toISOString(), stale: false } })).toBe(false);
    expect(reviewChecksPollInterval(true, { schemaVersion: 1, headRevision: "abc", items: [{ id: "check", name: "Build", state: "running" }], cache: { source: "provider", fetchedAt: new Date().toISOString(), stale: false } })).toBe(10_000);
  });
});
