# Mounted OpenCode client cleanup evidence

This document is the deprecation and release evidence for the separately
reversible cleanup that follows task 14.3 of
`add-multi-agent-runtime-claude-worker`. It covers client-facing mounted
OpenCode compatibility only. It is not an OpenCode engine removal.

## Removal decision

The 14.3 telemetry window classified mounted requests as reads, runs,
interactions, events, or other and separately counted requests carrying the
supported-client marker. The deprecation criterion was zero supported-client
requests after canonical read, run, interaction, and event rollout. The staged
rollout evidence met that criterion before this cleanup:

| Signal | Required | Accepted 14.3 evidence |
| --- | --- | --- |
| Supported-client mounted reads | `0` | `0` |
| Supported-client mounted runs | `0` | `0` |
| Supported-client mounted interactions | `0` | `0` |
| Supported-client mounted event streams | `0` | `0` |
| Canonical default-runtime acceptance | Passing | Passing |

The live counter and deprecation response headers were removed with the paths;
this file is the durable tombstone evidence used by release review.

## Removed surface

- Mounted OpenCode session create/list/read/message/todo/update/delete/fork routes.
- Mounted prompt, command, shell, compact, summarize, and abort routes.
- Mounted permission and question list/reply routes.
- Mounted workspace and global OpenCode event streams.
- Renderer mounted-session read fallback, semantic mutation monkey patches,
  event observation shim, local run-id cache, and canonical-read feature flag.
- Server proxy run reservation, mounted-path authorization, operation
  classification, deprecation headers, and mutable legacy-route telemetry.

Requests to a removed mounted path return JuggleWork `404 not_found` and are not
forwarded to the managed engine. Supported clients use
`/workspace/:id/agent/v1` for sessions, snapshots, runs, interactions, and
events.

## Retained boundary

- `OpenCodeAgentEngineAdapter` remains the Server-side implementation of the
  default `jugglework` runtime and continues to call the managed OpenCode SDK,
  including canonical create/read/run/abort/interaction/update/delete/fork
  dispatch.
- `legacy-importers/opencode-sqlite.ts` remains the documented read/import
  boundary for historical OpenCode sessions. Existing sessions are lazily
  mapped without changing backend IDs.
- Mounted OpenCode access remains only for provider/configuration and related
  engine integration families such as provider auth, MCP, agents, commands,
  tools, path/file discovery, LSP, formatter, PTY, project, and health. The
  allowlist explicitly rejects any nested session, event, permission, or
  question path.
- OpenCode provisioning, provider configuration, plugin/config watchers,
  sidecar packaging, and engine reload integration remain supported.
- Claude Agent rollout flags and rollback remain independent of this cleanup.

## Reversibility

This cleanup has no database migration and deletes no transcript or provider
configuration. Roll back by reverting the cleanup release as one unit. The
canonical database and legacy OpenCode stores remain readable by the prior
release. Do not partially restore only the mounted proxy because its Renderer
caller shims and run arbitration were removed in the same unit.

## Verification

The release gate requires:

```bash
pnpm test:acceptance:multi-runtime
pnpm --filter @jugglework/types typecheck
pnpm --filter jugglework-server typecheck
pnpm --filter @jugglework/app typecheck
pnpm --filter @jugglework/claude-agent-worker typecheck
pnpm --filter @jugglework/desktop typecheck:electron
pnpm release:review --strict
pnpm rollout:rehearse
```

`apps/server/src/opencode-mounted-cleanup.test.ts` guards the deletion boundary,
and `agent-runtime-routes.e2e.test.ts` proves the canonical default runtime still
works while removed mounted paths return 404 and mounted provider integration
continues to work.
