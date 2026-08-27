# desktop-remote-control-lifecycle Specification

## Purpose

Keep unattended remote-control devices reachable and correctly powered across cloud suspension, system sleep, network loss, and half-open transport, while preserving local emergency controls.

## Requirements

### Requirement: Account remote-control settings
The desktop application SHALL expose remote-control settings inside Cloud Account. Its values SHALL be device-wide and SHALL NOT vary by workspace.

#### Scenario: Open Remote Control from account
- **WHEN** a signed-in user opens Cloud Account settings
- **THEN** the application displays device enrollment, connection, background, startup, busy-session, emergency stop, and sleep-policy controls backed by the Electron Main global store

### Requirement: Waiting device stays awake by default
An enabled remote-control device SHALL default to preventing application/system idle suspension while it waits for remote tasks. The assertion SHALL allow display sleep and SHALL be released when remote control is disabled, signed out, revoked, stopped, or no longer freshly authorized.

#### Scenario: Enabled and authorized device waits for work
- **WHEN** remote control is enabled, cloud policy is freshly authorized, and no run is active
- **THEN** Electron holds one `prevent-app-suspension` assertion and does not prevent display sleep

#### Scenario: Authorization is removed
- **WHEN** a waiting device loses fresh policy, is revoked, signs out, or is locally disabled
- **THEN** Electron releases the waiting assertion before the device can accept another remote command

#### Scenario: User opts out
- **WHEN** the user disables `Prevent sleep while waiting for remote tasks`
- **THEN** an idle remote-control device does not hold a power assertion while active authorized runs remain protected

### Requirement: Compatible settings migration
The global settings store SHALL accept the exact legacy remote-control schema and migrate its effective values without weakening fail-closed validation. Existing enabled devices SHALL receive the new waiting wake default; disabled or malformed settings SHALL remain fully disabled.

#### Scenario: Read enabled legacy settings
- **WHEN** the settings store reads a valid legacy record with remote control enabled
- **THEN** it preserves the existing options and returns `preventSleepWhileWaiting=true`

#### Scenario: Read malformed settings
- **WHEN** a settings file has an unknown field, invalid type, or unsupported schema
- **THEN** the store returns the fully disabled defaults and does not acquire a power assertion

### Requirement: Resume requires fresh authorization
System suspend SHALL immediately fence remote execution, invalidate pre-sleep policy, clear transport timers, and close the WebSocket. System resume SHALL request fresh organization policy and SHALL establish a new authenticated WebSocket only after post-resume policy validation succeeds.

#### Scenario: Resume with network available
- **WHEN** macOS resumes and a fresh policy request succeeds
- **THEN** the renderer synchronizes a post-resume validation context and Main obtains a new agent token and WebSocket

#### Scenario: Resume before network is ready
- **WHEN** macOS resumes but fresh policy cannot initially be fetched
- **THEN** the application retries with bounded exponential delays up to thirty seconds until validation succeeds or remote control is no longer eligible

#### Scenario: Pre-sleep response completes late
- **WHEN** an asynchronous policy, token, or socket result started before suspend completes after resume
- **THEN** lifecycle generation fencing prevents it from authorizing or replacing the post-resume transport

### Requirement: Network restoration triggers recovery
The renderer SHALL request a fresh remote-control policy after an online transition and SHALL coalesce concurrent resume and online requests into one recovery loop.

#### Scenario: Wi-Fi returns after resume
- **WHEN** an initial resume refresh fails and the renderer later receives an online event
- **THEN** the existing recovery loop retries immediately without creating competing policy refresh loops

### Requirement: Half-open transport detection
After `connection.welcome`, the agent SHALL use the negotiated liveness thresholds and last valid inbound cloud activity to bound socket silence. A silent socket that reaches the client deadline SHALL be terminated and replaced through the normal authenticated reconnect path.

#### Scenario: Cloud traffic remains healthy
- **WHEN** valid cloud frames arrive before the negotiated silence deadline
- **THEN** the watchdog is refreshed and the current connection remains active

#### Scenario: Socket becomes half-open
- **WHEN** the client receives no cloud frame through the negotiated silence deadline
- **THEN** it marks the transport failed, terminates the old socket, and schedules a newly authenticated connection

#### Scenario: Old watchdog fires after replacement
- **WHEN** a timer from an older socket generation fires after a newer socket is active
- **THEN** generation and socket identity checks prevent the old timer from affecting the current connection

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

### Requirement: Local shutdown remains available
Cloud policy SHALL gate enabling and remote execution, but it MUST NOT prevent the local user from disabling remote control, stopping all control sessions, or deleting local device credentials.

#### Scenario: Policy is unavailable while enabled
- **WHEN** remote control is locally enabled but current cloud policy is unavailable
- **THEN** the Settings page still permits Disable and Stop All while refusing any new Enable or enrollment action
