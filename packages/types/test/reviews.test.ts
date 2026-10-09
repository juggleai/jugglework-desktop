import assert from "node:assert/strict"
import test from "node:test"

import {
  reviewConnectionStatusSchema,
  reviewErrorDetailsSchema,
  reviewListResponseSchema,
} from "../dist/reviews.js"

test("review connection status requires a bounded member action", () => {
  const parsed = reviewConnectionStatusSchema.parse({
    schemaVersion: 1,
    provider: "github",
    state: "member_authorization_required",
    action: {
      version: 1,
      kind: "connection_action",
      source: "jugglework-cloud",
      connectionId: "github",
      connectionName: "GitHub",
      authType: "oauth",
      credentialMode: "per_member",
      state: "needs_connection",
      actor: "member",
      action: { type: "connect", surface: "jugglework_your_connections", retry: "search_capabilities" },
    },
  })

  assert.equal(parsed.state, "member_authorization_required")
})

test("review pages reject oversized result sets", () => {
  assert.throws(() => reviewListResponseSchema.parse({
    schemaVersion: 1,
    items: new Array(101).fill({}),
    nextCursor: null,
    snapshotAt: new Date().toISOString(),
    source: { provider: "github", connectionId: "github", connectionName: "GitHub" },
    cache: { source: "provider", fetchedAt: new Date().toISOString(), stale: false },
  }))
})

test("review error details reject unknown credential-shaped data", () => {
  assert.throws(() => reviewErrorDetailsSchema.parse({
    retryable: false,
    authorization: "Bearer secret",
  }))
})
