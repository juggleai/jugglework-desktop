## 1. Global Settings Contract

- [x] 1.1 Extend shared remote-control settings with the waiting wake preference and compatible legacy normalization.
- [x] 1.2 Keep the remote-control editor inside Cloud Account without adding a separate global Settings route.
- [x] 1.3 Localize remote-control status text and keep local disable/Stop All available without policy.

## 2. P0 Resume and Network Recovery

- [x] 2.1 Add a typed Main-to-renderer remote-policy recovery notification for system resume.
- [x] 2.2 Implement a coalesced fresh-policy recovery loop with bounded exponential retry for resume and renderer online events.
- [x] 2.3 Preserve post-suspend policy and token generation fencing while reconnecting only after fresh validation.

## 3. P1 Power and Transport Hardening

- [x] 3.1 Reconcile the Electron power-save blocker for authorized waiting devices and active runs, releasing it on every ineligible transition.
- [x] 3.2 Consume welcome liveness thresholds, track inbound cloud activity, and terminate silent half-open sockets before authenticated reconnect.
- [x] 3.3 Ensure transport replacement clears watchdog state and ignores stale socket-generation callbacks.

## 4. Verification

- [x] 4.1 Add settings migration, waiting blocker, suspend/resume recovery, and half-open WebSocket unit tests.
- [x] 4.2 Add renderer route, navigation, desktop-only, policy gating, recovery coalescing, and i18n coverage.
- [x] 4.3 Run focused desktop, renderer, types, and OpenSpec validation and resolve all failures.

## 5. Cloud Suspension Recovery

- [x] 5.1 Add the `device.disabled` WSS envelope to the shared protocol schema and rebuild the electron runtime contract.
- [x] 5.2 Treat cloud suspension as retryable in the agent: preserve enrollment, credentials, and settings, clear sessions and authorizations, and reconnect with bounded exponential backoff.
- [x] 5.3 Add agent coverage for suspension, restore-after-retry, and malformed notices, and rerun the focused desktop suite.
