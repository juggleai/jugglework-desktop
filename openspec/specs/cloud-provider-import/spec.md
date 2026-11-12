# cloud-provider-import Specification

## Purpose
Define how Desktop imports managed and ordinary cloud routing providers while preserving provider identity, compatibility, and policy boundaries across router generations.

## Requirements

### Requirement: Desktop recognizes both managed router generations
Desktop SHALL recognize `managedIdentity=jwork_router` as the canonical managed routing identity and SHALL recognize the legacy `juggle_router` managed discriminator when the canonical field is absent.

#### Scenario: New Desktop connects to old Server
- **WHEN** the provider payload has the legacy managed discriminator and omits canonical managed identity
- **THEN** Desktop continues treating it as the managed router provider

### Requirement: Provider rename preserves workspace identity
Desktop SHALL keep the Cloud provider row ID as the local provider key when the managed provider display identity changes from JuggleRouter to JWorkRouter.

#### Scenario: Imported provider is renamed
- **WHEN** a previously imported managed provider is returned with the same Cloud row ID and the JWorkRouter display identity
- **THEN** Desktop updates the provider in place and preserves fully-qualified model references

### Requirement: Ordinary JuggleRouter remains independent
Desktop SHALL NOT classify a provider as managed based only on the name or public provider ID `JuggleRouter`.

#### Scenario: Both providers are available
- **WHEN** a workspace receives managed JWorkRouter and an ordinary JuggleRouter provider
- **THEN** it imports them under separate provider keys and does not apply managed-points policy to the ordinary provider

### Requirement: Engine application is verified per imported model
Desktop SHALL treat an imported cloud provider as applied only when the engine provider list contains that provider and every model ID recorded in the import baseline. A provider that uses a gateway credential SHALL also need to appear in the engine's connected list, when that list is readable. Models the engine lists beyond the baseline SHALL NOT count as a difference.

#### Scenario: Re-imported credential is not yet read by the engine
- **WHEN** a re-import reinstalled a gateway credential but the reload was deferred (for example 409 while a task was running), so the engine lists the provider and its models but not as connected
- **THEN** Desktop requests one engine reload for that workspace, which runs once the workspace is idle

#### Scenario: Existing provider gains a model while reload is deferred
- **WHEN** the baseline already records the new model list but the engine still lists the provider with the previous models (for example because the reload returned 409)
- **THEN** the next sync does not re-import the provider and instead requests one engine reload for that workspace

#### Scenario: Engine lacks the provider entirely
- **WHEN** the baseline records a provider the engine does not list
- **THEN** the sync re-imports the provider once

#### Scenario: Same difference is reported repeatedly
- **WHEN** repeated sync triggers observe the same workspace and the same missing provider/model signature
- **THEN** Desktop requests the reload only once, and requests it again only after the difference disappears or changes

### Requirement: Cloud provider reload requests are workspace scoped
A reload request raised by the cloud provider applied check SHALL stay pending for its workspace until a reload targeting that same workspace succeeds. A successful reload of another workspace SHALL NOT clear it. Unscoped reload requests keep their existing behavior. When the requesting surface cannot address the workspace by the same server-side ID used to register reload controls (for example a remote workspace in Settings), Desktop SHALL fall back to an unscoped request rather than a scoped request that can never be applied.

#### Scenario: Another workspace reloads first
- **WHEN** workspace A has a scoped pending reload and the user reloads workspace B
- **THEN** A stays pending, and when A is selected again and idle the coordinator reloads it automatically

### Requirement: Rejected gateway credentials are repaired without replaying the failed turn
Desktop SHALL treat only an explicit gateway-credential rejection as a repairable imported-provider failure. It SHALL read the matching device's current organization-provider connection, hash the rejected `jwgw_` credential locally with SHA-256, and send only that digest plus a fresh UUID request ID to the dedicated credential-rotation endpoint. It SHALL install the returned replacement through the existing import path, updating shared OpenCode authentication, the gateway credential record, runtime provider configuration, and requesting one engine reload. It SHALL preserve the failed turn and SHALL NOT automatically replay the message or its tool calls.

#### Scenario: Engine rejects a cached gateway credential
- **WHEN** a live session returns 401 and explicitly reports that the gateway credential is missing, revoked, or expired for an imported provider
- **THEN** Desktop rotates that provider credential once for the workspace, installs the verified replacement, and tells the user to retry the preserved message after recovery

#### Scenario: Normal connection still returns the rejected credential
- **WHEN** Desktop prepares a repair and the ordinary connection endpoint returns the device's current rejected credential
- **THEN** Desktop uses its digest only as rotation input and does not mistake the idempotent connection response for a successful repair

#### Scenario: Provider returns an ordinary authentication failure
- **WHEN** a provider returns 401 without the explicit gateway-credential rejection
- **THEN** Desktop keeps the provider's normal authentication error flow and does not refresh an organization gateway credential

#### Scenario: Rejection omits the provider identity
- **WHEN** the gateway rejection omits a provider ID and the workspace has exactly one imported organization provider
- **THEN** Desktop may repair that sole provider
- **WHEN** the workspace has more than one imported organization provider
- **THEN** Desktop does not guess a repair target

### Requirement: Gateway credentials are shared across workspaces
A gateway credential is issued per member, provider, and signed-in device, and the OpenCode auth store holds one entry per provider ID for the whole machine. Desktop SHALL keep one gateway credential record per organization and cloud provider, shared by every workspace that imports that provider. A workspace import only authorizes reading or writing that record. Records written per workspace by older builds SHALL stay readable by their own workspace and SHALL be migrated to the shared record by the next import.

#### Scenario: One workspace removes a provider others still import
- **WHEN** a workspace removes an imported organization provider, through user action, sync, or account or organization cleanup, and another workspace still imports the same provider
- **THEN** the server keeps the shared gateway credential record and the OpenCode auth entry, and reports them as retained

#### Scenario: The last importing workspace removes the provider
- **WHEN** no other workspace imports the provider
- **THEN** the server deletes the shared gateway credential record and the OpenCode auth entry

#### Scenario: Engine has lost an imported provider's credential
- **WHEN** sync finds an imported gateway provider that the engine lists but does not report as connected, while its import baseline still looks current
- **THEN** Desktop re-imports that provider to reinstall the credential instead of skipping it
- **WHEN** the engine's connected list cannot be read
- **THEN** Desktop does not treat the credential as lost
