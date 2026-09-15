## Purpose

Defines the observable workflow for creating text-to-video and image-to-video jobs from a JuggleWork conversation and publishing secure, playable artifacts in the active workspace.

## ADDED Requirements

### Requirement: Create video generation from conversation input
The system SHALL allow a conversation request to create a text-to-video job from a prompt or an image-to-video job from a prompt and one supported reference image.

#### Scenario: Text-to-video request
- **WHEN** a user supplies a non-empty prompt and a compatible text-to-video model can be resolved
- **THEN** the system creates a generation job using the prompt and validated generation options

#### Scenario: Image-to-video request
- **WHEN** a user supplies a non-empty prompt, one valid reference image, and a compatible image-to-video model can be resolved
- **THEN** the system creates a generation job that preserves the image as an explicit generation input

#### Scenario: Invalid reference image
- **WHEN** an image-to-video request references a file outside the authorized workspace or violates the selected model's MIME or size constraints
- **THEN** the system rejects the request before provider submission with an actionable validation error

### Requirement: Manage generation as an asynchronous job
The system SHALL return a durable job identifier after accepting a generation request and SHALL expose its current status, progress when available, terminal error, and cancellation capability.

#### Scenario: Accepted long-running request
- **WHEN** a provider accepts a video-generation request that cannot complete within the initiating call
- **THEN** the system returns the job identifier without waiting for the final video and reports subsequent status changes

#### Scenario: Cancel active job
- **WHEN** the user cancels a queued, submitted, or running job
- **THEN** the system records the cancellation request, attempts provider cancellation when supported, and eventually exposes a terminal cancelled or provider-completed state without submitting a duplicate job

#### Scenario: Recover job after restart
- **WHEN** JuggleWork restarts while a submitted provider job is incomplete
- **THEN** the system resumes status reconciliation from the persisted provider job identifier without charging for a replacement submission

### Requirement: Prevent duplicate paid submissions
The system SHALL use an idempotent request identity to prevent retries of the same accepted generation request from creating duplicate provider jobs.

#### Scenario: Client retries accepted request
- **WHEN** the client retries a request with the same idempotency identity after the original request was accepted
- **THEN** the system returns or reconciles the existing job instead of submitting another paid generation

### Requirement: Publish completed video as a workspace artifact
The system SHALL download a successful provider result into the active authorized workspace under `artifacts/`, SHALL avoid exposing a partially downloaded final file, and SHALL return a workspace-relative artifact descriptor.

#### Scenario: Successful video download
- **WHEN** a provider reports a valid completed result
- **THEN** the system validates the response, writes the complete video artifact under `artifacts/`, and publishes its relative path, MIME type, byte count, provider, model, and available media metadata

#### Scenario: Invalid provider payload
- **WHEN** a provider completion points to content that exceeds configured limits or fails MIME or video-content validation
- **THEN** the job fails without publishing the invalid content as a completed artifact

### Requirement: Present job progress and playable output in the conversation
The system SHALL render queued, running, failed, cancelled, and completed generation states in the conversation and SHALL provide playback and download/open controls for a supported completed video artifact.

#### Scenario: Generation completes
- **WHEN** an associated video job transitions to completed
- **THEN** the conversation displays a video player and identifies the artifact path and model used

#### Scenario: Generation fails
- **WHEN** an associated video job reaches a failed state
- **THEN** the conversation displays a non-secret, actionable error and a retry option when the failure is classified as retryable

### Requirement: Protect credentials, paths, and temporary media
The system MUST NOT persist or expose provider credentials, authorization headers, signed result URLs, or complete base64 media in conversation messages, workspace preference files, job diagnostics, or normal logs. The system SHALL confine input and output file operations to authorized workspace locations and SHALL clean temporary media according to the configured retention policy.

#### Scenario: Job diagnostics are inspected
- **WHEN** a user or operator views a failed job or its logs
- **THEN** diagnostics contain no API key, authorization header, signed download URL, or complete encoded media payload

#### Scenario: Output path attempts traversal
- **WHEN** a requested filename or provider result attempts to resolve outside the active workspace
- **THEN** the system rejects the path and writes no file outside the workspace

### Requirement: Keep video generation separate from video understanding
The system SHALL NOT treat generated or uploaded `video/*` files as readable chat-model attachments solely because conversational video generation is enabled.

#### Scenario: User attaches a video for analysis
- **WHEN** the configured chat model does not explicitly support validated video input
- **THEN** the attachment remains unsupported for model analysis even if video generation models are configured
