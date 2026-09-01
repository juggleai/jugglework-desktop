## Context

See `proposal.md` for motivation. Desktop remote identity consists of an Ed25519 private key and the Cloud-issued `deviceId`, plus local device-bound encryption material. The renderer currently coordinates settings and enrollment, while Electron Main owns credentials, transport fencing, and remote execution. Cloud `device.disabled` is intentionally retryable with the same identity and must remain distinct from local remote-control shutdown.

## Goals / Non-Goals

**Goals:**

- Replace the complete local remote-control identity without exposing private material to the renderer.
- Present one user action whose concurrent calls are coalesced or rejected and whose result is recoverable after partial failure.
- Stop and fence old transport/work before deleting old credential material.
- Preserve unrelated sign-in and application state.
- Project locally disabled state correctly after restart.

**Non-Goals:**

- Re-registering after ordinary network loss, WebSocket backoff, or a cloud `device.disabled` notice.
- Revoking or deleting the old Cloud inventory record automatically.
- Rotating the Cloud account login token or unrelated automation installation ID.
- Changing the server enrollment protocol.

## Decisions

### Electron Main owns one serialized replacement command

A typed IPC command will implement the compound lifecycle operation. Main first advances lifecycle fencing and stops transport/control sessions, then clears old remote credentials and device-bound encryption material, generates a fresh key pair, exchanges a newly supplied one-time enrollment grant, persists the returned identity, enables settings, and starts the normal transport. Renderer-driven sequencing was rejected because a renderer crash or double click could interleave identity deletion, enrollment, and transport restart.

### Renderer supplies a fresh enrollment grant, not key material

The signed-in renderer obtains the one-time grant through the existing authenticated Cloud API immediately before invoking Main. Main generates and retains the private key and sends only the public enrollment request through the established enrollment path. Moving account tokens into Main or returning private keys to renderer was rejected because both broaden secret exposure.

### Eligibility is local-disabled plus fresh enrollment authorization

Account settings show `Re-register and enable` only when remote control is locally disabled, the user is signed in, current policy permits enrollment, and no replacement is pending. Offline/backoff states and `device.disabled` continue their same-credential retry semantics. Revoked/invalid local credentials may use the same action once Main projects them as not enrolled and renderer has fresh authorization.

### Destructive boundary precedes enrollment and failure remains disabled

Once fencing succeeds, the old local identity is deleted before creating the new one. If grant exchange, persistence, or startup fails, Main leaves remote control disabled, closes all transport, removes any incomplete new credential, returns a stable sanitized error, and permits retry with a newly fetched one-time grant. Retaining the old key as rollback was rejected because the user explicitly requested identity replacement and accidental reuse would violate that boundary.

### Persistence ordering makes restart fail closed

Settings are not marked enabled until the new credential and device-bound key are durably stored. Startup validation treats enabled-without-valid-credential and incomplete replacement state as disabled/not enrolled and never starts transport. A process-local mutex prevents overlap; durable store ordering supplies crash safety without introducing a new database.

## Risks / Trade-offs

- [Failure after old credential deletion leaves an extra Cloud device or no local device] → Disable locally, clear incomplete credentials, surface retry, and rely on Console revocation/history for any server record created before failure.
- [One-time grant expires while queued] → Keep the critical section short, reject/coalesce concurrent work, return a stable retryable error, and fetch a new grant on retry.
- [A late old-generation callback mutates the new transport] → Advance generation fencing before stop/delete and retain generation checks across enrollment and startup.
- [Users mistake cloud suspension for identity corruption] → Do not show the action for connected/retrying cloud-disabled states; keep Restore-on-Console guidance.
- [Deleting device-bound E2EE material affects queued old work] → Cancel and clear old pending remote work before deletion; never migrate old queued commands to the new identity.

## Migration Plan

Add the IPC and Main operation first, then expose it through preload typings and Account settings. Existing credentials and settings require no migration. Rollback removes the UI and IPC entry; any newly enrolled identity remains a valid ordinary device, and previously replaced identities remain as server-side disabled/revoked inventory according to user actions.
