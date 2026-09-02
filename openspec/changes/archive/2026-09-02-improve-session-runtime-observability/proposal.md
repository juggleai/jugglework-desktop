## Why

Long-running sessions can appear indefinitely busy even while the model provider is repeatedly failing and retrying, because retry events are not surfaced and are currently counted as meaningful progress. Sessions that emit only tool calls also provide little user-readable feedback, making healthy work difficult to distinguish from a stuck run.

## What Changes

- Preserve provider retry events as structured session activity, including attempt, error summary, and retry timing, instead of dropping them from the renderer.
- Separate transport/event liveness from user-meaningful progress so retry heartbeats cannot indefinitely suppress stalled detection.
- Present provider retry activity inside the active conversation while keeping stalled detection internal and preserving the existing neutral in-progress presentation.
- Derive a concise, local-only progress summary from tool activity, including the current action and completed tool-step count, while keeping raw tool calls expandable.
- Propagate child-session retry activity through existing subagent task presentation without adding a speculative stuck warning.
- Keep raw compaction-boundary parts invisible so manual compaction cannot show a completed receipt before the runtime reports completion.
- Add focused synchronization, state, and presentation tests for retry, stalled, and tool-only runs.

## Capabilities

### New Capabilities

- `session-runtime-observability`: Defines reliable, user-visible runtime activity for provider retries, stalled detection, tool-only progress, and child-session activity.

### Modified Capabilities

- `session-task-progress`: Extends active task progress presentation so tool-only runs remain understandable without requiring model-authored todo updates.

## Impact

- Renderer session synchronization and activity state under `apps/app/src/react-app/domains/session`.
- Conversation process rendering and tool activity helpers under `apps/app/src/components/chat` and `apps/app/src/lib`.
- Session activity, synchronization, and task presentation tests.
- No external API or persisted transcript format changes; synthesized progress remains local presentation state.
