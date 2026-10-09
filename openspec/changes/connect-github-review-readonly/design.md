## Context

The native Review workbench already has workspace routes, retained mounting, preview fixtures, and provider-neutral presentation components. JuggleWork Connect currently exposes member-authorized GitHub tools through the workspace's `jugglework-cloud` MCP connection, but the renderer must not discover or call those tools directly. The local server already owns workspace identity, Cloud MCP health, runtime MCP sessions, request authentication, and structured API errors.

The first implementation must work with individual-account GitHub connections, remain strictly read-only, and tolerate missing authorization, disabled workspace connections, capability drift, pagination, large diffs, rate limits, and organization or account switching.

## Goals / Non-Goals

**Goals:**

- Provide a typed local Review API backed by the current member's GitHub connection in JuggleWork Connect.
- Load a real relationship-filtered PR Inbox and lazy Summary, Changes, Checks, and Threads data.
- Keep GitHub and Cloud credentials out of renderer Review state and provider DTOs.
- Enforce a fixed read-only operation allowlist in server code.
- Validate and bound Cloud capability responses before normalization.
- Provide structured readiness and recovery actions for member, organization, provider, and workspace-policy failures.
- Stop polling and cancel work when the retained Review surface is hidden or its identity changes.

**Non-Goals:**

- GitHub comments, review submission, thread mutation, merge, or any other provider write.
- Private AI Review execution.
- Local `gh` CLI support.
- A second JuggleWork-owned GitHub OAuth application.
- Persistent storage of private PR bodies, patches, or comments in this version.
- General-purpose MCP App hosting.

## Decisions

### Use a server-owned Connect adapter

The renderer calls workspace-scoped local HTTP routes. `ReviewReadService` calls a `ConnectGithubReviewProvider`, which opens the workspace Cloud MCP session and maps fixed domain operations to discovered GitHub capabilities. The adapter never accepts a capability name from the renderer.

Direct renderer-to-MCP calls were rejected because they would expose transport details and unstable tool contracts to the UI. Model-mediated calls were rejected because native rendering must be deterministic and independent of a chat turn.

### Discover exact capability names by strict semantic suffix

Current Connect capability names include an opaque connection identifier. The adapter discovers the catalog through `search_capabilities`, accepts only results whose exact suffix is one of `search_pull_requests`, `list_pull_requests`, or `pull_request_read`, and caches the resolved names briefly per workspace Cloud endpoint. Ambiguous matches fail closed.

This is a transitional projection until the hosted service exposes versioned Review operations. It preserves Connect's live workspace policy and connection readiness while keeping dynamic names behind the local API.

### Keep the first server cache bounded and in memory

The service caches normalized results with short operation-specific TTLs and deduplicates identical in-flight requests. Keys include workspace, connection/capability identity, operation, filters, PR identity, head revision when known, and cursor. Account, organization, policy, or capability changes naturally produce a different key or readiness failure.

SQLite persistence was rejected for this version because it would establish a private-code retention policy before encryption, export, and deletion behavior are specified.

### Split list and detail subresources

Inbox, metadata, files, checks, and threads use separate GET endpoints. The renderer loads heavy data only when its tab is active. A provider or tab failure does not discard already loaded data from other tabs.

### Use opaque, reversible server review IDs

The server emits a versioned opaque base64url identifier containing only provider-neutral routing identity needed for a subsequent read: connection capability identity, host, owner, repository, and PR number. Every use is schema-validated and re-authorized through the current workspace Cloud session. It is not an authorization token and must never bypass live Connect policy.

### Enforce read-only twice

The route module registers GET routes only, and the provider adapter can execute only three GitHub read capabilities with fixed methods. Write capability names and arbitrary GitHub query/API input are not part of any public contract.

### Treat provider content as untrusted data

PR titles, bodies, diffs, comments, and check output are data. They are length-bounded and normalized, never interpreted as instructions, and are not copied into an agent prompt by the Review data layer.

### Use TanStack Query with visibility-aware polling

The renderer uses scoped query keys containing endpoint ownership, workspace ID, filters, review ID, and tab. Inbox/detail refresh only while the Review surface is visible; checks poll only while a check is non-terminal. TanStack cancellation propagates through new client `AbortSignal` support where the transport permits it.

## Risks / Trade-offs

- **Capability output shapes can drift.** → Parse defensively, require critical identity fields, preserve stable error codes, and fail with `review_contract_unsupported` rather than guessing.
- **Capability discovery adds latency.** → Cache exact names briefly and deduplicate catalog requests.
- **Search syntax for personal relationships depends on GitHub semantics.** → Build fixed queries server-side and test them; never accept arbitrary search syntax from the renderer.
- **Cloud MCP bearer is still present in existing runtime configuration.** → Reuse the current server-only MCP session path but never return raw config through Review routes; credential-reference hardening remains separate work.
- **Large diffs can exhaust memory or dominate response time.** → Bound pages, text, file counts, patches, and total response bytes; expose truncation metadata.
- **Remote workspace cancellation is imperfect through current Electron IPC fetch.** → Fence stale results in Query state and add true caller cancellation to the ordinary client path where available.
- **Individual-account identity may be missing from generic capability responses.** → Display a generic connected GitHub label when login metadata is unavailable; do not invent an account identity.

## Migration Plan

1. Add shared contracts without replacing fixtures.
2. Add server routes and adapter behind read-only GET endpoints.
3. Add client methods and renderer queries.
4. Switch the Review page to real data, keeping fixtures only in tests.
5. Verify missing connection, authorization, successful data, partial failure, rate limit, cancellation, and hidden-surface behavior.

Rollback removes the new routes and queries and restores the fixture data source. No provider credentials or durable Review data are migrated.

## Open Questions

- Whether the hosted Connect layer should later expose dedicated versioned Review projection capabilities instead of generic GitHub tools.
- Whether a future release should persist encrypted metadata-only cache for fast startup.
- Whether GitHub Enterprise hosts require additional identity fields beyond those exposed by the current capabilities.
