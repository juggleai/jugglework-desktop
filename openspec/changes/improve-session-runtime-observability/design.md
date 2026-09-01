## Context

See `proposal.md` for motivation. OpenCode exposes retry state through three shapes: session status, retry parts embedded in assistant messages, and `session.next.retried` events. The renderer currently presents only session-level retry status. Every part update refreshes the meaningful-progress clock before unsupported retry parts are discarded, so repeated retry parts can keep a run looking healthy. Tool calls are already retained in order and expandable, but the process header only describes one tool and does not summarize completed activity.

The renderer already maintains session-scoped activity in Zustand, transcript state in TanStack Query, and child-session task metadata. The solution should build on those stores without changing persisted messages or server APIs.

## Goals / Non-Goals

**Goals:**

- Normalize all runtime retry signals into one session-scoped activity record.
- Keep event liveness and user-meaningful progress as separate concepts.
- Render retry, stalled, and tool-only progress in the existing process presentation.
- Preserve child-session activity visibility through parent task tools.
- Keep derived summaries deterministic, local, and content-free enough for safe presentation.

**Non-Goals:**

- Automatically abort or resubmit a stalled task.
- Generate hidden chain-of-thought or infer semantic conclusions not present in runtime events.
- Persist synthesized progress as assistant messages.
- Change provider retry policy or OpenCode execution behavior.

## Decisions

### Store structured retry activity beside session activity

Extend each activity record with retry attempt, safe message, next retry time, and observation time. Session status, retry parts, and retry events update the same fields; meaningful assistant or tool progress clears them. This avoids fabricating AI SDK message parts and allows child task presentation to read the same canonical state.

Alternative considered: convert retry parts to ordinary assistant text. Rejected because it would pollute transcript copy, exports, and future model context and could duplicate session-level retry UI.

### Classify progress before updating the progress clock

Part updates update the liveness timestamp, but only assistant text/reasoning output and observable tool lifecycle advancement update `lastMeaningfulProgressAt`. Retry parts update retry state without resetting the clock. Completed or newly in-flight tools count as progress; repeated snapshots of the same state rely on the existing part upsert and do not need an independent heartbeat.

Alternative considered: keep all events as progress and increase the stalled timeout. Rejected because recurring retry events can suppress stalled detection indefinitely at any timeout.

### Pass canonical activity into the conversation renderer

`SessionSurface` passes the current activity status and retry detail to `MessageList`. The message list gives stalled state precedence, keeps structured retry detail visible alongside it, and otherwise falls back to retry or the normal live action. This makes the active conversation accurate even when transcript messages already exist and keeps the sidebar and conversation consistent.

### Derive tool progress without creating messages

The tool activity helper computes the current action, total tool count, and completed count from the current task's process messages. The process disclosure renders one compact summary while existing tool groups remain expandable. The summary is derived during rendering and never enters the `UIMessage[]` cache.

Alternative considered: ask the model to emit periodic commentary. Model guidance may be added later, but it cannot report during a blocked provider request or long-running tool, varies by model, and consumes tokens. Deterministic activity is the primary mechanism.

### Project retry through child task status

Task presentation reads the child's structured retry detail in addition to its coarse status. A retry label takes precedence over generic in-flight wording; stalled continues to take precedence over normal activity. The parent tool state remains owned by OpenCode.

## Risks / Trade-offs

- [A long-running tool with no updates can be marked stalled even though it is healthy] → Keep the wording probabilistic, retain the tool name and elapsed activity, and do not auto-abort.
- [Provider error messages can contain sensitive details] → Reuse sanitized runtime summaries and avoid rendering serialized raw error objects.
- [Retry signals can arrive through multiple event shapes] → Deduplicate by session, attempt, and observation time in the canonical activity record.
- [A tool count can include setup calls that are not semantic milestones] → Label the metric as completed steps, not percent complete, and preserve raw details.

## Migration Plan

The change is renderer-only and additive. Deploy the updated desktop application without data migration. Rollback restores the previous generic activity presentation; persisted sessions remain compatible because no new transcript part is stored.
