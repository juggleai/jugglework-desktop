# Change: Recover deferred engine reloads without blocking tasks

## Why
The server correctly fences a shared-engine reload while any task is active, but the desktop currently stores that temporary `409 engine_reload_blocked_active_runs` response as a permanent reload error. The error prevents future automatic reload attempts and disables the composer even though the existing engine remains usable.

## What Changes
- Classify the active-run reload fence as a deferred reload rather than a reload failure.
- Keep the reload request pending and automatically retry after task activity settles or the reload cooldown expires.
- Keep genuine reload failures visible without making the existing engine unavailable for task submission.
- Preserve the server-side active-run fence and prohibit direct engine disposal from bypassing it.

## Impact
- Affected spec: `server-owned-runtime`
- Affected app areas: reload state, reload coordinator, session readiness, provider reload fallback
