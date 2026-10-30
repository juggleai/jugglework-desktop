## Why

Local managed-model requests timed out before OpenCode observed output while overseas gateway requests continued until the final retry was cancelled. Stream probing must own and abort its transport explicitly and allow longer initial reasoning without replaying output.

## What Changes

- Replace tee-based probing with a single reader and byte-preserving prefix replay.
- Abort timed-out attempts at the fetch signal and finish reader cancellation before retrying.
- Allow 60 seconds for headers/first byte and 120 seconds after first byte for initial meaningful output; retain environment overrides and finite heartbeat-only waits.
- Preserve immediate text/reasoning/tool-call handoff and include the exhausted timeout phase in errors.
- Bind the guarded fetch directly into managed provider options so SDKs that capture `fetch` early cannot bypass it.
- Keep exhausted inner retries terminal to prevent OpenCode from replaying another complete retry cycle.
- Surface managed-provider response timeouts with actionable UI guidance instead of a generic operation timeout.

## Capabilities

### New Capabilities
- `provider-stream-retry-lifecycle`: Single-owner stream probing and non-overlapping retries.

### Modified Capabilities
None.

## Impact

Embedded OpenCode context-overflow plugin and tests. No remote service configuration change. Packaged desktop clients need the updated bundled plugin to use this behavior.
