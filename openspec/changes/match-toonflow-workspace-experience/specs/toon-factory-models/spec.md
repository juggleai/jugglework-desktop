## ADDED Requirements

### Requirement: Every project assistant turn uses a currently allowed JuggleWork text model
The server MUST resolve the assistant's explicit or project-default public model reference through the live JuggleWork catalog and workspace or organization policy immediately before each turn, and SHALL NOT execute through Toonflow provider configuration or silently substitute another model.

#### Scenario: Project default model remains allowed
- **WHEN** the user sends a turn without an explicit override and the stored default is connected, text-capable, ready, and policy-allowed
- **THEN** the dedicated assistant runtime executes that turn with the exact provider and model reference

#### Scenario: Selected assistant model becomes unavailable
- **WHEN** the stored model is disconnected, blocked, not text-capable, or no longer ready
- **THEN** the turn is blocked with `selected_model_unavailable`
- **AND** the user must explicitly select another allowed JuggleWork model

### Requirement: Node-level model overrides are explicit and capability-scoped
The workspace SHALL allow a node to reference an explicit JuggleWork model appropriate to its operation, revalidate it before execution, and otherwise inherit only the declared project category default.

#### Scenario: Image node has an override
- **WHEN** an image node executes with a stored image model override
- **THEN** the model is revalidated for the requested image mode and policy
- **AND** no project or provider default silently replaces an unavailable override

#### Scenario: Node has no override
- **WHEN** a node executes without an explicit model reference
- **THEN** it uses the visible project default for that capability after live validation
- **AND** the resolved model is included in the reviewable request snapshot

### Requirement: Toon workspace exposes no independent provider system
Toon Factory SHALL use only JuggleWork model catalogs and SHALL NOT expose Toonflow API keys, balances, marketplace providers, TF-Router, dynamic provider modules, or provider-private configuration.

#### Scenario: User opens model settings from Toon Factory
- **WHEN** a required model category is unavailable
- **THEN** the UI explains the JuggleWork availability or policy state and links to the applicable JuggleWork settings surface
- **AND** does not offer a Toonflow-specific credential form

#### Scenario: Project file contains Toonflow provider metadata
- **WHEN** an import or edit supplies provider-private or dynamic adapter fields
- **THEN** those fields are rejected or omitted by the explicit importer
- **AND** they are never executed

### Requirement: Model policy synchronization is durable and retryable
The server SHALL persist the latest valid public model-policy snapshot per workspace in runtime SQLite using monotonic revision and digest comparison, SHALL restore it before recovering active generation work, and SHALL NOT persist credentials or provider-private configuration in that snapshot.

#### Scenario: Server restarts with a valid policy snapshot
- **WHEN** queued text, image, or video work is recovered after server restart
- **THEN** the server loads the latest valid workspace policy before deciding whether new provider work may be submitted
- **AND** lifecycle cleanup does not remove that latest policy snapshot

#### Scenario: Policy is absent or requires fresh organization synchronization
- **WHEN** a job is otherwise runnable but its workspace policy is missing or stale
- **THEN** execution reports `model_policy_pending` as retryable rather than `selected_model_unavailable`
- **AND** the job remains nonterminal without being claimed, dispatched, or submitted
- **AND** a newer renderer policy synchronization automatically wakes the pending work

#### Scenario: An older permissive snapshot arrives after a restrictive snapshot
- **WHEN** the server has persisted a newer restrictive revision and receives an older policy revision
- **THEN** the older snapshot is rejected by revision comparison
- **AND** it cannot loosen the effective policy after restart

#### Scenario: A video was submitted before policy became pending
- **WHEN** a recovered video candidate already has a durable remote runtime job ID
- **THEN** the server continues polling and reconciling that exact remote job while policy synchronization is pending
- **AND** it does not submit the candidate again
