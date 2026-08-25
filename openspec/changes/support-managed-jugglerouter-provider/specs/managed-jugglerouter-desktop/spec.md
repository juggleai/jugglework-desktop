## Purpose

Allow signed-in desktop members to consume organization-managed JuggleRouter model providers through the existing secure Cloud provider synchronization and gateway path.

## ADDED Requirements

### Requirement: Desktop accepts canonical managed JuggleRouter providers
The desktop SHALL accept organization provider list and connection payloads whose source is `juggle_router`, preserve their managed kind, organization access scope, enabled state, opaque cloud row ID, provider identity, timestamps, and canonical models, and SHALL continue to distinguish them from the legacy hosted provider whose source or provider identity is `jugglework`.

#### Scenario: Enabled JuggleRouter is listed
- **WHEN** an active organization member receives an enabled provider with source `juggle_router`, provider identity `JuggleRouter`, and an opaque `lpr_*` row ID
- **THEN** the desktop retains the provider for Cloud synchronization instead of rejecting or filtering it as hosted inference

#### Scenario: Legacy hosted provider is listed
- **WHEN** the provider source or provider identity is the reserved legacy value `jugglework`
- **THEN** existing hosted-provider filtering remains unchanged and the row is not treated as managed JuggleRouter

### Requirement: Managed JuggleRouter imports through the Cloud gateway
The desktop SHALL connect and install an enabled JuggleRouter provider using the opaque `lpr_*` row ID as its local runtime provider key, the server-projected gateway URL and token as its connection material, and the canonical model IDs and metadata from the connection payload. It SHALL NOT require or infer an upstream JuggleRouter API key or direct upstream Base URL.

#### Scenario: JuggleRouter connection is imported
- **WHEN** the Cloud connection response contains a gateway URL, opaque gateway token, `providerId: "JuggleRouter"`, and the organization's published models
- **THEN** the desktop stores authentication and runtime configuration under the `lpr_*` key and exposes those models through the existing model selection path

#### Scenario: Catalog provider key differs only by case
- **WHEN** the response identity is `JuggleRouter` and deployment catalog metadata is keyed by `jugglerouter`
- **THEN** model metadata lookup succeeds case-insensitively while response model metadata retains precedence

### Requirement: Managed provider lifecycle reconciles from current Cloud state
The desktop SHALL treat a disabled or absent managed JuggleRouter provider as unavailable and remove its local runtime provider, Cloud gateway credential, mirrored credential, and import baseline through the existing full-state reconciliation. When the organization re-enables and republishes it, the desktop SHALL reconnect and import it again.

#### Scenario: Organization disables JuggleRouter
- **WHEN** a previously imported JuggleRouter is disabled or absent from the organization's importable provider list
- **THEN** the next synchronization removes its local provider material and it no longer appears as an available model source

#### Scenario: Organization re-enables JuggleRouter
- **WHEN** JuggleRouter becomes enabled and visible again with a current timestamp and models
- **THEN** the next synchronization reconnects it, imports it under the same opaque cloud row ID, and restores its model choices
