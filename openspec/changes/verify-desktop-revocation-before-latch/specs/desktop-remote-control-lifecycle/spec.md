## MODIFIED Requirements

### Requirement: Cloud suspension is retryable
Receiving `device.disabled` SHALL close the current transport, clear in-flight control sessions and sleep authorizations, and schedule an authenticated reconnect with bounded exponential backoff. It SHALL NOT delete device credentials, disable local settings, or mark the device revoked, and a subsequent successful handshake SHALL restore the connected state without re-enrollment.

#### Scenario: Device is disabled from the Console
- **WHEN** the cloud sends `device.disabled` before closing the socket with a policy-violation close
- **THEN** the agent keeps its enrollment, credentials, and settings, and retries token issuance and connection with bounded backoff while access stays disabled

#### Scenario: Device is restored from the Console
- **WHEN** control access is re-enabled while the agent is retrying
- **THEN** the next retry completes the challenge/token handshake and the device returns online without re-enrollment

#### Scenario: Malformed suspension notice
- **WHEN** a `device.disabled` message does not match the enrolled device or schema
- **THEN** the agent fails the transport with a stable invalid-notice code and the normal retry path stays armed without deleting credentials

## ADDED Requirements

### Requirement: Cloud revocation is verified before durable local revocation
The current authenticated WebSocket's `device.revoked` SHALL immediately latch revocation. Protocol errors and token/challenge rejections SHALL require device challenge/token verification before durable cleanup. Only matching-credential `403 device_revoked` SHALL confirm revocation; only authoritative revocation SHALL delete credentials and E2EE keys or surface revoked status. Ambiguous failures SHALL preserve credentials.

#### Scenario: Spurious revocation signal with a healthy device
- **WHEN** the agent receives a `device_revoked` protocol error or HTTP hint, and verification shows the device still enrolled and enabled
- **THEN** credentials, settings, and enrollment are preserved, in-flight control sessions are cleared, and the agent reconnects with bounded backoff
- **AND** no revoked status is latched or shown to the user

#### Scenario: Confirmed genuine revocation
- **WHEN** the current authenticated WebSocket receives `device.revoked`, or verification returns an explicit matching-credential `device_revoked` result
- **THEN** the agent latches the revoked state, deletes device credentials and E2EE key material, disables remote-control settings, and notifies the user
- **AND** no further reconnect attempts or verification probes are scheduled for the revoked device
- **AND** an HTTP confirmation requires exact `403 device_revoked` from a challenge matching stored `(deviceId, keyId)` or token exchange after a valid signed proof

#### Scenario: Verification is temporarily unavailable
- **WHEN** the verification call fails with a transport error, server-side error, bare/generic 401 or 404, or any other response that does not authoritatively distinguish device state
- **THEN** the agent treats the signal as unconfirmed and keeps credentials; non-404 failures retry with bounded backoff, while repeated 404 follows the bounded re-registration-required scenario below
- **AND** the status surface shows an indeterminate "verifying" state instead of revoked
- **AND** bare/generic HTTP 401/404, status/code mismatches, `not_found`, and `device_deleted` remain non-authoritative

#### Scenario: Verification while control access is disabled
- **WHEN** verification shows the device enrolled but control access disabled
- **THEN** the agent follows the retryable suspension semantics and does not latch revocation
- **AND** an HTTP disabled result requires exact `403 device_disabled` under the same matching-credential or valid-signed-proof rule

#### Scenario: Rate-limited probing for a dead device
- **WHEN** the device no longer exists, the environment/route is wrong, or repeated generic 404 verification attempts would otherwise be issued
- **THEN** the agent performs at most the configured bounded number of 404 probes, preserves credentials, disables local reconnect, and surfaces that re-registration is required
- **AND** it does not claim confirmed revocation or deletion

#### Scenario: Explicit recovery with preserved credentials
- **WHEN** local remote control is disabled, fresh Cloud policy authorizes enrollment, and status reports `device_reregistration_required` with `enrolled: true` because credentials were preserved
- **THEN** Settings SHALL offer explicit re-registration through the existing fresh-policy, scoped one-time-grant compound command rather than ordinary reconnect
- **AND** no identity replacement occurs automatically; signed-out, policy-denied, locally enabled, unauthorized, and replacement-pending states SHALL NOT expose re-registration

#### Scenario: Ordinary reconnect preserves an authenticated identity
- **WHEN** an enrolled identity is offline without `device_reregistration_required`, including a local pending-policy synchronization failure after an authenticated welcome
- **THEN** Settings SHALL offer non-destructive reconnect, not identity replacement
- **AND** post-welcome pending-policy failure SHALL keep credentials while disabling and fencing remote control

#### Scenario: Legacy or ambiguous API returns an authentication rejection
- **WHEN** challenge creation or token issuance returns a generic `unauthorized` response that does not distinguish a revoked, disabled, invalid, or otherwise unavailable identity
- **THEN** the agent fences transport and control authorization but preserves credentials and settings in the verifying state
- **AND** it does not claim that revocation or deletion was confirmed
