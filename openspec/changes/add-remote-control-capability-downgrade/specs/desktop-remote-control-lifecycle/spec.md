## ADDED Requirements

### Requirement: Rejected capability advertisements downgrade locally

While a replacement identity is awaiting `connection.welcome`, a control-plane close with WebSocket `1008` and the stable reason `unsupported_capability_gate` SHALL be treated as a capability-version mismatch rather than an identity, authorization, or transport failure. Desktop SHALL keep the enrolled credential and the pending welcome wait, SHALL advance through an ordered ladder of smaller capability subsets (newest additive capability first), and SHALL reconnect immediately with the same identity instead of consuming another one-time enrollment grant or waiting for reconnect backoff. Desktop SHALL declare startup failure only after every subset has been rejected.

#### Scenario: Control plane predates an additive capability

- **WHEN** the enrolled device advertises a capability the control plane does not support and receives `1008 unsupported_capability_gate` before welcome
- **WHEN** a smaller subset remains in the ladder
- **THEN** Desktop keeps the credential and the pending welcome wait, reconnects with the next subset, and does not create another Cloud device record
- **AND** a matching welcome on the replacement socket completes the replacement as connected

#### Scenario: Every subset is rejected

- **WHEN** each capability subset in the ladder is closed with `1008 unsupported_capability_gate`
- **THEN** the pending welcome wait fails with the sanitized close code and the existing fail-closed replacement cleanup runs
- **AND** no additional enrollment grant is requested

#### Scenario: Rejected handshake after a welcomed transport

- **WHEN** an already welcomed transport later closes with `1008 unsupported_capability_gate`
- **THEN** Desktop does not reinterpret it as a capability-evolution handshake and follows the ordinary transport-failure path

### Requirement: Accepted capability subset is reusable and self-healing

Desktop SHALL persist the capability subset that reached a matching welcome, bound to the control-plane base URL, app version, and policy version, with a bounded maximum age. A stored subset SHALL be reused on later connects for the identical binding only. Desktop SHALL clear the stored subset once the full advertisement is accepted again, so a control-plane upgrade re-enables the newest capabilities without reinstalling the application. Read, parse, or write failures MUST degrade to the full advertisement and MUST NOT block connection.

#### Scenario: Reconnect after a downgraded connection

- **WHEN** a device connected with a reduced subset and the transport reconnects for the same control plane, app version, and policy version
- **THEN** the first `device.hello` already advertises that reduced subset instead of replaying the rejected handshake
- **AND** no additional record is written for the unchanged subset

#### Scenario: Binding or age no longer matches

- **WHEN** the stored subset belongs to another control plane, another app version, another policy version, or is older than the bounded age
- **THEN** Desktop ignores it and advertises the full capability set

#### Scenario: Control plane catches up

- **WHEN** the full capability advertisement receives a matching welcome after a control plane upgrade
- **THEN** Desktop clears the stored reduced subset so subsequent connects advertise the full capabilities

#### Scenario: Persisted subset is unreadable

- **WHEN** the stored subset cannot be read or parsed
- **THEN** Desktop advertises the full capability set and connection proceeds normally
