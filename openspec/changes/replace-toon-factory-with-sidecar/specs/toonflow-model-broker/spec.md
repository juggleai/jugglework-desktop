## ADDED Requirements

### Requirement: Model discovery follows workspace policy
The broker SHALL expose only public descriptors for text, image, and video models that are configured, ready, and permitted for the target workspace according to canonical JuggleWork credential provenance and policy checks.

#### Scenario: Another workspace owns a credential
- **WHEN** a model credential is available to workspace A but not workspace B
- **THEN** the workspace B Toonflow catalog neither lists nor permits execution of that model

### Requirement: Provider secrets remain inside JuggleWork
The broker MUST NOT expose API keys, provider base URLs, OpenCode auth files, JuggleWork host tokens, organization gateway credentials, or credential-bearing errors to the sidecar or Web page.

#### Scenario: Sidecar lists models
- **WHEN** the managed sidecar requests its model catalog
- **THEN** the response contains public model references and capabilities but no secret or raw provider configuration

### Requirement: Text execution uses JuggleWork providers
Managed Toonflow text and agent requests SHALL execute through JuggleWork’s workspace-aware model runtime with explicit model references, bounded inputs, cancellation propagation, and normalized streaming events required by the Toonflow client.

#### Scenario: User cancels an agent request
- **WHEN** the user cancels an active Toonflow text request
- **THEN** cancellation propagates to the JuggleWork model runtime and the sidecar receives a terminal cancellation event

### Requirement: Paid media execution is durable and idempotent
Image and video requests MUST use JuggleWork’s media runtime, MUST include a stable client request ID, and SHALL create or reuse a durable job rather than call a provider directly from a Toonflow-specific route.

#### Scenario: Submission response is lost
- **WHEN** a media submission succeeds but its response is not delivered and the sidecar retries with the same request ID
- **THEN** JuggleWork returns the existing job and does not submit a second paid provider request

#### Scenario: Server restarts during video generation
- **WHEN** JuggleWork Server restarts after a video job is submitted
- **THEN** Toonflow can continue querying the durable job without losing workspace ownership

### Requirement: Media outputs are validated artifacts
JuggleWork SHALL download or receive provider output through its protected media path, validate the resulting artifact, and provide a bounded import/copy operation into the Toonflow project. The sidecar MUST NOT fetch arbitrary provider result URLs.

#### Scenario: Provider returns a private-network URL
- **WHEN** a provider result resolves to loopback, link-local, metadata, or private network space
- **THEN** JuggleWork rejects the artifact and the sidecar performs no direct fetch

### Requirement: Unknown outcomes are not implicitly resubmitted
The broker and sidecar MUST represent unknown, failed, cancelled, and completed submission states explicitly and MUST NOT automatically resubmit an unknown or failed paid operation.

#### Scenario: Video submission times out ambiguously
- **WHEN** the broker cannot determine whether the upstream accepted a video request
- **THEN** the job records an unknown outcome and requires reconciliation or an explicit new user-authorized request

### Requirement: Unsupported managed model types are explicit
Managed mode SHALL hide or disable AI node types for which JuggleWork has no ready model runtime and SHALL explain how availability is determined without falling back to Toonflow provider settings.

#### Scenario: No audio runtime is available
- **WHEN** a project contains an audio generation node and JuggleWork exposes no audio-generation model
- **THEN** the node is disabled with a managed-mode availability message and does not prompt for a Toonflow API key
