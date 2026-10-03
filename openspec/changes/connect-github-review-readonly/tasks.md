## 1. Shared Contracts and Client

- [x] 1.1 Add versioned Review connection, list, detail, file, check, thread, pagination, cache, and error contracts with runtime schemas
- [x] 1.2 Export Review contracts from `@jugglework/types` and add focused schema tests
- [x] 1.3 Add caller cancellation support and typed read-only Review methods to the framework-neutral JuggleWork Server client

## 2. Server Review Domain

- [x] 2.1 Add the provider-neutral Review read interface, opaque review ID codec, and strict input bounds
- [x] 2.2 Add a JuggleWork Connect GitHub adapter with bounded capability discovery and a fixed read-only operation allowlist
- [x] 2.3 Normalize GitHub Inbox, PR metadata, files/diff, checks/status, reviews, comments, and review threads into shared contracts
- [x] 2.4 Add bounded in-memory caching, request deduplication, operation deadlines, cancellation, and safe error classification

## 3. Review HTTP API

- [x] 3.1 Register workspace-scoped GET-only connection, Inbox, detail, files, checks, and threads routes
- [x] 3.2 Enforce inspection-only workspace resolution and prevent raw MCP configuration or credentials from entering responses and diagnostics
- [x] 3.3 Add route/provider tests for ready, authorization-required, workspace-disabled, paginated, rate-limited, malformed, oversized, and cancelled requests

## 4. Renderer Integration

- [x] 4.1 Add endpoint-scoped TanStack Query keys and hooks for connection, infinite Inbox, detail, files, checks, and threads
- [x] 4.2 Pass retained-surface visibility and workspace endpoint ownership into the Review page so hidden polling stops and remote ownership remains correct
- [x] 4.3 Replace preview data with live connection and Inbox states, server-side search/filtering, pagination, refresh, and cached-data indicators
- [x] 4.4 Load Summary, Changes, Checks, and Threads lazily with independent empty, truncated, error, retry, and stale-revision states
- [x] 4.5 Add Settings > Connect recovery actions while keeping all external write and AI Review controls unavailable

## 5. Verification

- [x] 5.1 Add focused renderer tests for connection states, live Inbox, lazy tabs, partial failures, pagination, and hidden-surface polling
- [x] 5.2 Run focused tests, app/server/types type checks, production build, OpenSpec validation, and diff checks; document unrelated baseline failures
