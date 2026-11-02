## Why

The first Review workbench is fixture-backed, so it cannot show a member's real review queue or inspect private pull requests. JuggleWork Connect already exposes member-authorized GitHub capabilities; this change turns those capabilities into a stable, native, read-only Review data path without exposing GitHub credentials or write tools to the renderer.

## What Changes

- Add versioned shared contracts for GitHub Review connection readiness, Inbox pages, pull request details, files, checks, threads, cache metadata, and structured errors.
- Add workspace-scoped, GET-only Review routes to the local JuggleWork Server.
- Add a server-owned GitHub Review provider that executes a fixed allowlist of read-only JuggleWork Connect capabilities and validates their responses.
- Respect the active member, organization, workspace connection policy, and GitHub connection identity for every request.
- Add bounded in-memory caching, request deduplication, pagination, cancellation, timeout, response-size, and stale-response controls.
- Replace preview fixtures with real connection, Inbox, detail, Changes, Checks, and Threads query states while retaining fixtures for isolated tests.
- Add member sign-in, GitHub authorization, workspace-disabled, admin-action, rate-limit, partial-data, and retry UI states.
- Explicitly exclude comments, review decisions, thread mutations, merge operations, AI Review execution, local `gh`, and direct renderer access to Cloud capabilities.

## Capabilities

### New Capabilities
- `github-review-readonly`: Member-authorized GitHub connection readiness and normalized, read-only PR data access through JuggleWork Connect.

### Modified Capabilities
- `pr-review-workbench`: Replace preview-only workbench behavior with real connection, loading, pagination, refresh, partial-failure, and read-only GitHub data states.

## Impact

- Adds cross-process Review contracts under `packages/types`.
- Adds a new server Review domain, route module, Connect GitHub adapter, and bounded cache.
- Extends the framework-neutral JuggleWork Server client with cancellable Review reads.
- Reworks the renderer Review domain around TanStack Query while retaining the existing route and native shell.
- Depends on JuggleWork Connect readiness and an individual-account GitHub connection published to the active member and workspace.
- Does not introduce a GitHub token into renderer state, local Review storage, prompts, logs, or diagnostics.
