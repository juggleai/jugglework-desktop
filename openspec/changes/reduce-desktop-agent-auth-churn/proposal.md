## Why

Desktop currently performs a fresh challenge, Ed25519 proof, and agent-token issuance on every transport reconnect even when the in-memory bearer token remains valid. Overseas production data showed thousands of short-lived challenge/token rows per device and recurring reconnects, creating avoidable database writes and authentication contention.

## What Changes

- Cache the agent token only in Electron Main memory and reuse it for ordinary reconnects while it remains valid beyond a safety margin.
- Keep proactive token refresh minting a fresh token before expiry.
- Clear the cache on identity/context changes, local disable/stop, credential deletion, confirmed revocation, and any pre-welcome transport failure that may represent bearer rejection.
- Do not persist the bearer token or expose it to Renderer/logs/status.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-remote-control-lifecycle`: Ordinary transport reconnects reuse a still-valid in-memory agent token without weakening expiry, revocation, policy, or identity fencing.

## Impact

- `apps/desktop/electron/remote-control-agent.mjs` and focused lifecycle tests.
- No server API, credential-store schema, persistent setting, or renderer contract change.
