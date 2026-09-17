# Change: Improve task submission startup feedback and latency

## Why

Starting a task can appear unresponsive because the composer waits for resume maintenance, Cloud MCP readiness, attachment preparation, environment context, and server acceptance before it presents an in-flight state. A full Cloud MCP probe is also repeated for closely spaced submissions even after an equivalent provider/model scope was just proven ready.

## What Changes

- Show an immediate, session-scoped preparation state as soon as an idle composer submission begins, before asynchronous preflight work finishes.
- Preserve the exact draft and attachments when preparation is blocked, cancelled, or fails.
- Send ordinary coding and chat tasks through the existing non-Connect fast path; retain the strict readiness gate for drafts that explicitly select Cloud skills, extensions, or Cloud MCP capabilities.
- Reuse a recent successful Cloud MCP readiness result for the same account, organization, workspace, provider, and model.
- Revalidate older cached readiness in the background while allowing the current submission to proceed, and invalidate the cache when revalidation or account context changes make the evidence stale.
- Keep first-time, expired, failed, and changed-scope submissions on the existing blocking check-and-repair path.
- Record cache and submission phase evidence so click-to-acceptance latency can be diagnosed.

## Impact

- Affected spec: `session-task-progress`
- Affected app areas: session composer, session route, Cloud MCP pre-send readiness coordinator, localized composer labels, and focused tests.
- No server API or persistent-data migration is required.
