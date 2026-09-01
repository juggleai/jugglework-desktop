## MODIFIED Requirements

### Requirement: Account remote-control settings
The desktop application SHALL expose remote-control settings inside Cloud Account. Its values SHALL be device-wide and SHALL NOT vary by workspace. When remote control is locally disabled and the signed-in account is freshly authorized to enroll, the settings SHALL offer `Re-register and enable`; ordinary offline, retry-backoff, and cloud-disabled states MUST NOT offer identity replacement as their recovery path.

#### Scenario: Open Remote Control from account
- **WHEN** a signed-in user opens Cloud Account settings
- **THEN** the application displays device enrollment, connection, background, startup, busy-session, emergency stop, sleep-policy, and eligible re-registration controls backed by the Electron Main global store

#### Scenario: Local remote control is disabled
- **WHEN** the user is signed in, remote control is locally disabled, and fresh policy permits enrollment
- **THEN** Account settings displays an enabled `Re-register and enable` action

#### Scenario: Transport is temporarily offline
- **WHEN** remote control remains locally enabled and the transport is offline, reconnecting, or suspended by cloud `device.disabled`
- **THEN** Account settings preserves the existing retry and restore guidance and does not present re-registration as required recovery

#### Scenario: Restart with locally disabled settings
- **WHEN** Desktop restarts with remote control locally disabled
- **THEN** Account settings projects the device as disabled without advertising an active or connectable transport and offers re-registration only after fresh enrollment authorization

## ADDED Requirements

### Requirement: Re-registration replaces the remote device identity
The application SHALL perform re-registration as one serialized, Main-owned operation. It MUST fence and stop old remote execution before deleting the prior remote credential and device-bound encryption material, generate a new signing identity, use a fresh one-time enrollment authorization to obtain a new Cloud `deviceId`, persist the new credential, enable remote control, and start the normal authenticated connection. Private key material MUST NOT be exposed to the renderer.

#### Scenario: User re-registers successfully
- **WHEN** an eligible user activates `Re-register and enable` and enrollment succeeds
- **THEN** the old transport and pending remote work are fenced, a distinct device identity is persisted, remote control is enabled, and the new device begins the normal connection flow

#### Scenario: Re-registration is invoked concurrently
- **WHEN** the action is activated again while identity replacement is in progress
- **THEN** the application prevents a second overlapping replacement and does not create multiple local identities

#### Scenario: Old asynchronous work completes late
- **WHEN** a callback from the old identity or transport completes after replacement begins
- **THEN** lifecycle fencing prevents it from authorizing work or mutating the new identity and transport

### Requirement: Re-registration preserves unrelated application identity
Identity replacement SHALL preserve the Cloud login token, signed-in account session, providers, workspaces, and unrelated automation installation identity. The application SHALL NOT automatically revoke or permanently delete the old Cloud device record.

#### Scenario: Re-registration completes
- **WHEN** a new remote device identity is enrolled
- **THEN** the user remains signed in with existing providers and workspaces while the prior Cloud device remains manageable through its normal Console lifecycle

### Requirement: Re-registration fails closed and remains retryable
If replacement fails after old execution has been fenced, the application SHALL leave remote control disabled, close transport and sessions, remove incomplete new credential material, return a sanitized stable error, and allow retry with a fresh one-time enrollment authorization. Startup MUST NOT connect when settings and credential state represent an incomplete replacement.

#### Scenario: Enrollment exchange fails
- **WHEN** the one-time authorization expires or the enrollment request fails after old credentials are removed
- **THEN** remote control remains disabled, no incomplete credential is used, an actionable error is displayed, and a later retry can fetch a new authorization

#### Scenario: Persistence or startup fails
- **WHEN** the new identity cannot be durably saved or its transport cannot be initialized
- **THEN** the operation fails closed without restoring the old identity or exposing secret material in the error

#### Scenario: Desktop restarts after interrupted replacement
- **WHEN** the process restarts with enabled settings but without one complete valid remote credential
- **THEN** Desktop projects remote control as disabled/not enrolled and does not start a transport until a later successful registration
