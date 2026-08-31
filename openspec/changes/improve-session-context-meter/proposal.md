## Why

The session context meter currently stays empty until a model call completes and then presents the latest provider bill as if it were the conversation's current context. This makes the meter late, misleading during streaming and model changes, and difficult to interpret after context compaction.

## What Changes

- Show an estimated current context as soon as session history is available.
- Update the estimate while the current turn streams, then calibrate it from the provider-reported token usage when the call completes.
- Re-estimate the active context from the latest compaction boundary instead of treating all loaded history as active context.
- Distinguish estimated, streaming, provider-reported, and post-compaction states in the context details.
- Separate the current-context estimate from the latest model call and loaded-history diagnostics.
- Hide or mark provider-specific token fields as unavailable when the provider did not report them instead of presenting unsupported data as an exact zero.

## Capabilities

### New Capabilities
- `session-context-meter`: Defines how the composer estimates, updates, calibrates, and explains the active session context.

### Modified Capabilities

None.

## Impact

- Affects the Desktop session composer context indicator and details dialog.
- Uses the existing session snapshot and live transcript stream; no server API change is required.
- Adds unit coverage for estimation, streaming, model changes, provider calibration, and compaction boundaries.
