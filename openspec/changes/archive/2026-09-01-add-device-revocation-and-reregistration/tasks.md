## 1. Typed Identity-Replacement Contract

- [x] 1.1 Add a typed `desktopRemoteControlReregisterAndEnable` command, sanitized result/error envelope, and replacement-pending/status projection to the shared desktop IPC contract.
- [x] 1.2 Export the compound command through the generic renderer desktop bridge and register its Electron Main handler.

## 2. Main-Owned Lifecycle Operation

- [x] 2.1 Add a serialized Main lifecycle manager that rejects overlapping one-time grants and owns re-registration ordering and failure cleanup.
- [x] 2.2 Add an agent identity-replacement primitive that validates fresh enrollment authorization while locally disabled, fences old generations, removes old credentials and E2EE keys, enrolls a fresh Ed25519 identity, creates fresh device-bound E2EE material, and remains disconnected until enabled.
- [x] 2.3 Wire the manager to durably disable and cancel old work before replacement, enable only after identity persistence, apply local effects, and start the normal transport afterward.
- [x] 2.4 Route conflicting enable, enroll, and credential-delete commands through replacement guards so identity mutations cannot overlap.
- [x] 2.5 Make startup fail closed for enabled settings without one complete valid credential and ensure locally disabled restarts do not project an active/connectable transport.

## 3. Account Settings Experience

- [x] 3.1 Make fresh policy refresh await Main context synchronization before requesting a one-time enrollment grant.
- [x] 3.2 Show `Re-register and enable` only for signed-in, freshly authorized, locally disabled idle state and keep offline/backoff/cloud-disabled states on existing recovery behavior.
- [x] 3.3 Replace renderer-owned enable/enroll/rollback sequencing with one compound command and render deterministic pending, success, and actionable failure states.
- [x] 3.4 Add complete locale coverage for the action and sanitized recovery messages without exposing a standalone credential-delete control.

## 4. Verification

- [x] 4.1 Add manager and agent tests for exact ordering, distinct identity, concurrency rejection, generation fencing, context changes, partial failures, cleanup, retry, and secret redaction.
- [x] 4.2 Add startup reconciliation tests for missing, pending, corrupt, retained-disabled, and interrupted-replacement credentials.
- [x] 4.3 Add Account UI tests for visibility exclusions and the single compound bridge invocation.
- [x] 4.4 Run targeted Electron, renderer, bridge, type-check, and OpenSpec strict validation commands.

## 5. Rigorous Review Remediation

- [x] 5.1 Fence and abort deferred old-generation verification and dispatch, boundedly drain unresolved operations before credential deletion, and fail before the destructive boundary when drain cannot complete.
- [x] 5.2 Add a lifecycle cancellation epoch and route IPC, tray, and direct disable through it so Emergency Stop All wins replacement races and cleans any replacement identity.
- [x] 5.3 Re-arm retained policy expiry after stop and replacement so expired policy closes transport and cannot reconnect or publish.
- [x] 5.4 Bind fresh policy, Main synchronization, grant creation, and replacement to one exact control-plane, account, and organization scope.
- [x] 5.5 Inspect startup credential completeness without renderer context and durably disable enabled missing, pending, or corrupt records before context synchronization.
- [x] 5.6 Attempt credential deletion and E2EE revocation independently with stable sanitized cleanup diagnostics, and verify each and combined failure.
- [x] 5.7 Keep issued managed-server mutation POSTs awaiting their bounded authoritative outcome despite lifecycle cancellation, while fencing late local state mutation and pre-deletion drain.
- [x] 5.8 Read re-registration scope through a stable live Cloud session getter before and after deferred grant creation so render-time closures cannot authorize mixed-scope replacement.
- [x] 5.9 Track pending disable operations as a lifecycle barrier so inverse-order Stop All and disable races reject replacement before identity mutation or enablement.
