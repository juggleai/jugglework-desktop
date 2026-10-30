## Why

Local managed-model requests timed out before OpenCode observed visible output while overseas gateway requests continued until the client cancelled them. Role/metadata/keepalive frames already prove the stream is live, so the desktop must hand off on the first response-body byte and never replay an established request.

## What Changes

- Replace tee-based probing with a single reader and byte-preserving prefix handoff.
- Hand off immediately after the first non-empty body chunk, including role, metadata, and keepalive frames; never replay an established stream.
- Retry at most once, and only when response headers never arrive, the first byte never arrives, or the body closes with zero bytes.
- Keep desktop response-header, first-byte, and outer idle deadlines at 330 seconds, slightly behind the gateway's authoritative 300-second timeout, while retaining environment overrides.
- Abort timed-out pre-stream attempts at the fetch signal and finish reader cancellation before retrying.
- Bind the guarded fetch directly into managed provider options so SDKs that capture `fetch` early cannot bypass it.
- Keep exhausted inner retries terminal to prevent OpenCode from replaying another complete retry cycle.
- Surface managed-provider response timeouts with actionable UI guidance instead of a generic operation timeout.

## Capabilities

### New Capabilities
- `provider-stream-retry-lifecycle`: Single-owner stream probing and non-overlapping retries.

### Modified Capabilities
None.

## Impact

Embedded OpenCode context-overflow plugin, runtime timeout defaults, and tests. No remote service configuration change. Packaged desktop clients need the updated bundled plugin to use this behavior.
