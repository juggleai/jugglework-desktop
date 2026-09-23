## ADDED Requirements

### Requirement: Ordinary reconnects reuse a valid in-memory agent token
The Desktop agent SHALL reuse its current agent token for an ordinary transport reconnect only when the token is bound to the current device identity and remains valid beyond a handshake safety margin. The token MUST stay in Electron Main memory, MUST NOT be persisted, exposed to Renderer, logged, or projected in status, and MUST NOT be reused across account, organization, control-plane, or device-identity changes.

#### Scenario: Connected transport drops within token lifetime
- **WHEN** a welcomed transport closes and the cached token remains valid beyond the safety margin
- **THEN** the reconnect authenticates with that token without requesting a new challenge or agent token

#### Scenario: Token is near expiry
- **WHEN** a reconnect begins with no token or with a token inside the safety margin
- **THEN** Desktop performs the existing challenge, proof-of-possession, and fresh token issuance flow

### Requirement: Token reuse preserves authorization fencing
Proactive refresh SHALL always mint a fresh token. Desktop SHALL clear cached tokens on identity/context or authorization-policy changes, credential deletion/replacement, local or cloud disable/stop, confirmed revocation, and pre-welcome transport failure. Revocation verification SHALL remain a fresh proof probe.

#### Scenario: Cached bearer is rejected before welcome
- **WHEN** a reconnect using a cached token fails before `connection.welcome`
- **THEN** Desktop clears that token and the next retry performs fresh proof-of-possession authentication

#### Scenario: Account or device identity changes
- **WHEN** the signed-in identity, organization, control-plane origin, or enrolled device changes
- **THEN** the previous token is cleared before any new transport starts

#### Scenario: Proactive refresh fires
- **WHEN** the refresh timer reaches the pre-expiry margin on a connected socket
- **THEN** Desktop replaces the transport with a newly issued token rather than reusing the cached one
