## Why

After a user locally turns off remote control, the Account settings can only re-enable the retained device identity. Users need an explicit recovery action that discards the old local remote-device credential, creates a new cloud device identity, and reconnects without signing out or resetting unrelated application data.

## What Changes

- Show a `Re-register and enable` action in Account settings when remote control is locally disabled and the signed-in account is eligible to enroll.
- Execute re-registration as one Main-owned, serialized operation that fences old remote work, removes the old local device credential and device-bound encryption key, enrolls a fresh Ed25519 identity, enables remote control, and reconnects.
- Preserve the Cloud login, account session, providers, workspaces, and unrelated automation installation identity.
- Keep ordinary offline/backoff and cloud-disabled states on their existing retry-and-restore path; they do not imply re-registration.
- Provide deterministic pending, success, failure, restart, and retry behavior without exposing private key material to the renderer.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-remote-control-lifecycle`: Add an Account settings recovery flow that replaces a locally disabled device identity and re-enables remote control atomically from the renderer's perspective.

## Impact

- Account settings UI and state projection.
- Preload/API typings and Electron Main IPC registration.
- Remote agent lifecycle manager, credential store, enrollment orchestration, and device-bound E2EE key cleanup.
- Targeted unit/integration tests for identity replacement, eligibility, serialization, failure recovery, and restart behavior.
- No server schema or endpoint change is required; enrollment continues to obtain the new `deviceId` from the Cloud exchange.
