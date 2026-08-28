## Context

See `proposal.md` for motivation. Todo state currently lives in manually observed TanStack Query entries, while run state is derived from SSE status, renderer activity, snapshots, and the active-run coordinator. Route workspace IDs may differ from runtime workspace IDs, split panes only receive interactions for the selected session, and snapshot todo writes have no ordering fence against live events.

## Goals / Non-Goals

**Goals:**
- Give every session surface a runtime-keyed todo subscription.
- Preserve todo state until explicit session cleanup rather than cache GC.
- Prevent stale snapshots from overwriting later live progress.
- Derive progress presentation from both todo terminality and effective run state.
- Eliminate the known fast-completion/send-acceptance resurrection race.

**Non-Goals:**
- Introduce a new server todo protocol or persisted run identifier.
- Automatically retry model requests or alter OpenCode task execution.
- Redesign the visual appearance of the progress panel.

## Decisions

### Keep todo query entries until explicit lifecycle cleanup

Set todo query GC to infinity, matching permission/question state that is also manually observed. Remove todo entries when a retained session is explicitly cleared. This is preferred to mounting a query observer because todo data is event/snapshot driven and has no standalone query function in the renderer.

### Subscribe interactions per rendered session using runtime workspace identity

Move todo lookup to a small surface-level hook keyed by `runtimeWorkspaceId + sessionId`, while route-level interaction handling continues to own permission/question replies for the selected session. This fixes remote keys and split panes without duplicating permission/question side effects.

### Record live todo update time and fence snapshot seeding

Maintain a lightweight per-workspace/session timestamp for the latest live todo event. Capture snapshot request start time and only seed snapshot todos if no newer live update exists. This follows the existing permission/question snapshot ordering strategy without changing server schemas.

### Treat progress visibility as a presentation state machine

Classify todos as empty, open, or terminal. Empty stays hidden; open stays visible through active and incomplete terminal states; terminal todos remain visible briefly after a run transitions idle, then hide. A subsequent active transition cancels terminal hiding.

Alternative considered: clear todos on every `session.idle`. Rejected because it destroys useful incomplete progress and can be immediately undone by a completion snapshot that still contains historical todos.

### Fence post-send busy writes with observed terminal evidence

Capture the activity/status state before awaiting send acceptance. After acceptance, only synthesize busy if no newer live progress or terminal transition has been observed and authoritative status/coordinator state does not show completion. This preserves the fallback for slow start events while preventing completed fast runs from being resurrected.

## Risks / Trade-offs

- [Todo entries live longer in memory] → Remove them during explicit tracked-session cleanup and workspace disposal.
- [A short final acknowledgement delays panel disappearance] → Keep the delay small and cancel it immediately if a new run starts.
- [Timestamp ordering depends on renderer receipt time] → It only compares snapshot request start with live event receipt in the same renderer clock, avoiding cross-host clock assumptions.
- [Without server run IDs, every lifecycle race cannot be eliminated] → Scope this change to the observed snapshot/todo and send-acceptance races; a future protocol change can add generation fencing.

## Migration Plan

No data migration is required. Deploy as renderer behavior changes with regression tests. Rollback is limited to reverting the renderer/query-cache changes.
