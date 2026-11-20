# Tasks

- [x] 1.1 Detect the pre-welcome `1008 ... unsupported_capability_gate` close and advance an ordered capability-subset ladder.
- [x] 1.2 Reconnect immediately with the enrolled credential, keep the pending welcome wait bound to the replacement socket, and do not request a new enrollment grant.
- [x] 1.3 Persist the accepted subset bound to control plane, app version, policy version, and a bounded age; clear it when the full advertisement is accepted.
- [x] 2.1 Reset the in-memory subset on identity/context changes and on agent start.
- [x] 2.2 Extend the startup welcome deadline so the bounded ladder can finish before fail-closed cleanup.
- [x] 3.1 Cover downgrade success, cached reuse, stale-cache rejection, and ladder exhaustion in `remote-control-agent.test.mjs`; cover the store in `remote-control-capability-profile.test.mjs`.
- [ ] 3.2 Verify against a control plane that rejects `session.prompt-variant` / `session.permission-mode` that registration succeeds with the reduced subset and the UI reflects a connected device.
