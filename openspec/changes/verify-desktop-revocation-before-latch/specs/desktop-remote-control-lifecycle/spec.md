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
An authenticated `device.revoked` envelope received on the current WebSocket SHALL be authoritative and immediately latch durable revocation. A `device_revoked` protocol error or token/challenge HTTP rejection SHALL be verified through the device challenge/token flow before durable cleanup. An explicit `403 device_revoked` from a challenge that matched stored `(deviceId, keyId)`, or from token exchange after a valid signed proof, SHALL confirm durable revocation. The same exact status rule applies to retryable `403 device_disabled`. Bare/generic HTTP 401/404, status/code mismatches, `not_found`, and `device_deleted` SHALL remain non-authoritative. Only authoritative revocation SHALL delete device credentials and E2EE keys and surface revoked status.

#### Scenario: Spurious revocation signal with a healthy device
- **WHEN** the agent receives a `device_revoked` protocol error or HTTP hint, and verification shows the device still enrolled and enabled
- **THEN** credentials, settings, and enrollment are preserved, in-flight control sessions are cleared, and the agent reconnects with bounded backoff
- **AND** no revoked status is latched or shown to the user

#### Scenario: Confirmed genuine revocation
- **WHEN** the current authenticated WebSocket receives `device.revoked`, or verification returns an explicit matching-credential `device_revoked` result
- **THEN** the agent latches the revoked state, deletes device credentials and E2EE key material, disables remote-control settings, and notifies the user
- **AND** no further reconnect attempts or verification probes are scheduled for the revoked device

#### Scenario: Verification is temporarily unavailable
- **WHEN** the verification call fails with a transport error, server-side error, bare/generic 401 or 404, or any other response that does not authoritatively distinguish device state
- **THEN** the agent treats the signal as unconfirmed and keeps credentials; non-404 failures retry with bounded backoff, while repeated 404 follows the bounded re-registration-required scenario below
- **AND** the status surface shows an indeterminate "verifying" state instead of revoked

#### Scenario: Verification while control access is disabled
- **WHEN** verification shows the device enrolled but control access disabled
- **THEN** the agent follows the retryable suspension semantics and does not latch revocation

#### Scenario: Rate-limited probing for a dead device
- **WHEN** the device no longer exists, the environment/route is wrong, or repeated generic 404 verification attempts would otherwise be issued
- **THEN** the agent performs at most the configured bounded number of 404 probes, preserves credentials, disables local reconnect, and surfaces that re-registration is required
- **AND** it does not claim confirmed revocation or deletion

#### Scenario: Legacy or ambiguous API returns an authentication rejection
- **WHEN** challenge creation or token issuance returns a generic `unauthorized` response that does not distinguish a revoked, disabled, invalid, or otherwise unavailable identity
- **THEN** the agent fences transport and control authorization but preserves credentials and settings in the verifying state
- **AND** it does not claim that revocation or deletion was confirmed
