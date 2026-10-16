## ADDED Requirements

### Requirement: Text generation uses the selected JuggleWork model
The server SHALL execute Toon Factory text jobs through a server-owned OpenCode session using the selected provider and model and SHALL persist the request snapshot and authoritative result in the project workflow.

#### Scenario: Structured script job succeeds
- **WHEN** the user authorizes a script-generation request with a valid text model and output schema
- **THEN** the server creates a Toon Factory-tagged temporary session, executes with the selected model, validates the structured result, and stores the result
- **AND** the temporary session is removed after collection so it does not remain in the normal conversation list

#### Scenario: Text generation fails
- **WHEN** OpenCode reports a model or session error
- **THEN** the Toon Factory job becomes failed with a sanitized diagnostic
- **AND** partial output is not presented as an approved stage result

### Requirement: Image generation reuses safe JuggleWork publication
The server SHALL submit image jobs through the existing image-generation extension and SHALL record the exact request, selected model, returned artifact, and review state.

#### Scenario: Image generation succeeds
- **WHEN** an authorized image request completes with a valid image signature
- **THEN** the artifact is published within the authorized workspace
- **AND** a Toon Factory candidate enters awaiting-review state with its prompt and model provenance

### Requirement: Video generation reuses persistent idempotent jobs
The server SHALL submit video jobs through the existing persistent media-generation service using a stable client request ID and SHALL expose progress, terminal state, and cancellation through the Toon Factory job record.

#### Scenario: Same video request is submitted twice
- **WHEN** the client repeats a request with the same workspace, session scope, and client request ID
- **THEN** the server returns the existing job instead of creating a second paid submission

#### Scenario: Application restarts during video generation
- **WHEN** a video job is running and the desktop or local server restarts
- **THEN** the persisted job is reconciled after restart
- **AND** the workbench can recover its current status and eventual artifact

#### Scenario: Submission outcome is uncertain
- **WHEN** transport fails after the provider may have accepted the request
- **THEN** the job enters `submission_unknown`
- **AND** the system does not automatically resubmit the paid request

### Requirement: Jobs outlive the mounted workbench
Generation execution SHALL be owned by the server or persistent job service rather than by the lifecycle of a React component.

#### Scenario: User leaves Toon Factory during generation
- **WHEN** the user navigates to another JuggleWork surface while a job is running
- **THEN** the job continues or cancels only according to its explicit job command
- **AND** returning to Toon Factory restores its latest status

### Requirement: Cancellation and retry are explicit and safe
The workbench SHALL expose cancellation only where the underlying runtime supports it and SHALL create a new attempt for a retry unless the prior submission requires reconciliation.

#### Scenario: User cancels a cancellable video job
- **WHEN** the user confirms cancellation and the provider job supports cancellation
- **THEN** the system requests cancellation and reports the eventual terminal state

#### Scenario: Provider cannot guarantee remote cancellation
- **WHEN** local waiting is cancelled but the provider may continue processing
- **THEN** the workbench states that the remote job may continue and does not report a guaranteed cancellation

### Requirement: Adoption is versioned and non-destructive
The system SHALL let users review multiple candidates and adopt a specific output version without deleting rejected or superseded generation history.

#### Scenario: User adopts a generated image or clip
- **WHEN** the user selects a candidate after review
- **THEN** the adoption record references that candidate, its request, model, and artifact version
- **AND** other candidates remain available as history

### Requirement: Delivery manifests reference validated artifacts
The system SHALL create delivery manifests from adopted outputs and SHALL verify that referenced artifacts exist within the authorized workspace.

#### Scenario: User creates an episode delivery manifest
- **WHEN** the episode has adopted outputs and the user requests delivery
- **THEN** the manifest lists validated relative paths, provenance, and outstanding omissions
- **AND** invalid or missing paths are reported instead of included as successful delivery files
