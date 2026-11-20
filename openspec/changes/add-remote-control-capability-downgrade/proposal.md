# Change: Negotiate a supported remote-control capability subset

## Why
A Desktop advertises every additive remote capability in `device.hello`. When the Cloud control plane is older than the installed Desktop, it validates that advertisement against its own capability enum and closes the socket with WebSocket `1008` and the reason `unsupported_capability_gate` before `connection.welcome`. Registration then reports `startup_failed`, deletes the freshly enrolled credential, and disables remote control — even though enrollment and authorization succeeded. Users cannot register the device until the control plane and Desktop versions are realigned, and every retry leaves another orphaned Cloud device record because automatic revocation is forbidden.

## What Changes
- Treat a pre-welcome `1008 ... unsupported_capability_gate` close as a deterministic capability mismatch, not as an identity or authorization failure.
- Reconnect immediately with the enrolled credential and the next smaller supported capability subset instead of using the reconnect backoff or requesting another one-time enrollment grant.
- Persist the accepted subset, bound to the control plane, app version, and policy version, with a bounded age, so later connects skip the rejected handshake.
- Clear the persisted subset when the full advertisement is accepted again, so a control-plane upgrade re-enables the newest capabilities without a reinstall.
- Keep the existing fail-closed behavior once every subset has been rejected.

## Impact
- Affected specs: `desktop-remote-control-lifecycle`
- Affected app areas: Desktop Main remote-control agent, capability advertisement, remote-control startup lifecycle, Main global store
