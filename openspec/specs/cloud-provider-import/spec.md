# cloud-provider-import Specification

## Purpose
Define how Desktop imports managed and ordinary cloud routing providers while preserving provider identity, compatibility, and policy boundaries across router generations.

## Requirements

### Requirement: Startup readiness does not invalidate cloud providers
Desktop SHALL NOT remove imported cloud providers or their credentials merely because the engine client, active organization, or workspace target is not yet ready. Startup cleanup SHALL run only when no authentication token is present, through the existing workspace mutation queue, and SHALL recheck session presence, workspace identity, and store disposal before execution.

#### Scenario: Sign-in fails without explicit sign-out
- **WHEN** a sign-in attempt fails without an explicit sign-out
- **THEN** A failed sign-in attempt SHALL NOT trigger sign-out cleanup; explicit sign-out and existing account/organization ownership cleanup SHALL retain their behavior.

#### Scenario: Signed-in Desktop starts before the engine is ready
- **WHEN** Desktop restores an authenticated session while the engine client or workspace context is still initializing
- **THEN** Desktop preserves the imported providers and resumes synchronization when prerequisites are ready

#### Scenario: Session or workspace changes while startup cleanup waits
- **WHEN** a signed-out startup cleanup is queued and the user signs in, switches workspace, or the store is disposed before it executes
- **THEN** Desktop skips that startup cleanup

#### Scenario: Signed-out workspace target becomes ready
- **WHEN** Desktop starts without an authentication token and workspace resolution supplies its runtime ID, or the workspace target or host becomes available later
- **THEN** Desktop cleans the resolved target using its freshly read import baseline once ready
- **AND** repeated unchanged options synchronization does not repeat successful cleanup
- **AND** Signed-out startup cleanup SHALL resolve the workspace target before choosing its queue key, and SHALL refresh that target's import baseline inside the queue before cleanup. When the workspace target or host becomes ready after startup, options synchronization SHALL schedule the pending cleanup. An unchanged, successfully cleaned target SHALL NOT be purged again on repeated options synchronization. Cleanup from a disposed store lifecycle SHALL NOT resume after that store restarts.

#### Scenario: Provider reconciliation follows a transient empty engine list
- **WHEN** cloud provider synchronization verifies engine application after an earlier empty provider-list response
- **THEN** Desktop fetches the current engine list rather than relying on the cached response
- **AND** ordinary cached provider-list reads revalidate expired entries and await the fresh result

### Requirement: Sign-out cleanup is bound to the departing session
Desktop SHALL clear the local Cloud session without waiting for workspace cleanup. When the workspace host and ID are known at sign-out, Desktop SHALL capture that target and the departing deployment and organization before clearing the session, and SHALL use the captured target rather than the active route for cleanup. Desktop SHALL remove only providers recorded in that workspace's import baseline on sign-out and SHALL retain failed provider records for recovery. Shared credentials remain subject to server-side ownership checks.

#### Scenario: The active route changes at sign-out
- **WHEN** sign-out clears the active organization and the route switches workspace or unmounts before cleanup runs
- **THEN** Desktop cleans the originally captured workspace and its scoped Cloud MCP metadata without redirecting that cleanup to the newly selected workspace
- **AND** missing organization metadata does not prevent an exact workspace Cloud MCP removal

#### Scenario: Cleanup partially fails
- **WHEN** cleanup of an identified sign-out target fails while the same sign-out is still current
- **THEN** Desktop handles the failure without an unhandled promise rejection and retries at most once for that captured target and sign-out
- **AND** provider and Cloud MCP cleanup are attempted independently, with diagnostics limited to the failure stage, applicable HTTP status, and recognized non-sensitive error codes

#### Scenario: A new session arrives before cleanup finishes
- **WHEN** a new login or a newer sign-out supersedes pending captured cleanup
- **THEN** Desktop skips pending retries and does not start subsequent cleanup mutations from the superseded sign-out

### Requirement: Cloud-managed models follow the verified workspace
Desktop SHALL keep Cloud-managed model discovery and new requests scoped to the verified signed-in session and its active organization. A previous scope's cached catalog, runtime imports, or pending drafts SHALL NOT authorize new managed requests while a switch or reconciliation is pending. Explicitly configured local providers remain independent of Cloud scope.

#### Scenario: Old runtime models remain after an organization switch
- **WHEN** Desktop switches organization and the engine still advertises models from the previous organization
- **THEN** Desktop hides those models and its local runtime rejects new use until the active scope and its imports are verified
- **AND** a pending managed media draft is not sent under a different scope, while already-admitted work keeps its original binding

#### Scenario: Background refresh for a verified workspace
- **WHEN** provider synchronization refreshes an already verified, unchanged account, organization and workspace
- **THEN** the existing verified grants remain usable during the refresh
- **AND** a confirmed authorization rejection or a changed or withdrawn existing grant is fenced before further reconciliation

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

#### Scenario: A retired organization group is still connected in the engine
- **WHEN** a successful organization catalog refresh excludes a managed group that the engine still advertises
- **THEN** both session model pickers hide that group immediately and Desktop requests a scoped reload for the difference, including when the last group was removed
- **AND** locally configured providers remain available during reconciliation

#### Scenario: Engine lacks the provider entirely
- **WHEN** the baseline records a provider the engine does not list
- **THEN** the sync re-imports the provider once

#### Scenario: Same difference is reported repeatedly
- **WHEN** repeated sync triggers observe the same workspace and the same missing provider/model signature
- **THEN** Desktop requests the reload only once, and requests it again only after the difference disappears or changes

### Requirement: Cloud provider reload requests are workspace scoped
A reload request raised by the cloud provider applied check SHALL stay pending for its workspace until a reload targeting that same workspace succeeds. A successful reload of another workspace SHALL NOT clear it. Unscoped reload requests keep their existing behavior.

#### Scenario: Another workspace reloads first
- **WHEN** workspace A has a scoped pending reload and the user reloads workspace B
- **THEN** A stays pending, and when A is selected again and idle the coordinator reloads it automatically
- **AND** When the requesting surface cannot address the workspace by the same server-side ID used to register reload controls (for example a remote workspace in Settings), Desktop SHALL fall back to an unscoped request rather than a scoped request that can never be applied.

### Requirement: Rejected gateway credentials are repaired without replaying the failed turn
Desktop SHALL treat only an explicit gateway-credential rejection as a repairable imported-provider failure. It SHALL preserve the failed turn and SHALL NOT automatically replay the message or its tool calls.

#### Scenario: Engine rejects a cached gateway credential
- **WHEN** a live session returns 401 and explicitly reports that the gateway credential is missing, revoked, or expired for an imported provider
- **THEN** Desktop rotates that provider credential once for the workspace, installs the verified replacement, and tells the user to retry the preserved message after recovery
- **AND** It SHALL read the matching device's current organization-provider connection, hash the rejected `jwgw_` credential locally with SHA-256, and send only that digest plus a fresh UUID request ID to the dedicated credential-rotation endpoint. It SHALL install the returned replacement through the existing import path, updating shared OpenCode authentication, the gateway credential record, runtime provider configuration, and requesting one engine reload.

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
A gateway credential is issued per member, provider, and signed-in device, and the OpenCode auth store holds one entry per provider ID for the whole machine. Desktop SHALL keep one gateway credential record per organization and cloud provider, shared by every workspace that imports that provider. A workspace import only authorizes reading or writing that record.

#### Scenario: Legacy workspace credential is imported again
- **WHEN** the next import encounters a credential record written per workspace by an older build
- **THEN** Records written per workspace by older builds SHALL stay readable by their own workspace and SHALL be migrated to the shared record by the next import.

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
