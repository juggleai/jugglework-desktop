import { describe, expect, test } from "bun:test";

import { ApiError } from "../errors.js";
import { decodeReviewId, encodeReviewId } from "./review-id.js";
import { ReviewMemoryCache } from "./cache.js";

describe("Review identity and cache", () => {
  test("round-trips a bounded opaque GitHub identity", () => {
    const identity = { version: 1 as const, provider: "github" as const, connectionId: "mcpconn-1", hostname: "github.com", owner: "jugglework", repository: "desktop", number: 42 };
    expect(decodeReviewId(encodeReviewId(identity))).toEqual(identity);
    expect(() => decodeReviewId("review_bad")).toThrow(ApiError);
  });

  test("deduplicates concurrent requests and serves fresh memory hits", async () => {
    let count = 0;
    const cache = new ReviewMemoryCache(10, () => 100);
    const load = async () => { count += 1; await Promise.resolve(); return "ok"; };
    const [first, second] = await Promise.all([cache.getOrLoad("key", 1_000, load), cache.getOrLoad("key", 1_000, load)]);
    const third = await cache.getOrLoad("key", 1_000, load);
    expect(count).toBe(1);
    expect(first.value).toBe("ok");
    expect(second.value).toBe("ok");
    expect(third.cacheHit).toBe(true);
  });
});
