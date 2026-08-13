## Purpose

Define the independently supervised Claude Agent runtime, including secure process boundaries, resumable sessions, streaming execution, recovery, packaging, and advanced capability delivery.

## ADDED Requirements

### Requirement: Claude runs in an independent managed worker
Claude Agent execution SHALL occur in an independent worker process managed by JuggleWork Server, not in Renderer and not inside the OpenCode process. Worker failure MUST NOT terminate Server or another runtime.

#### Scenario: Worker crashes during a run
- **WHEN** the Claude worker exits unexpectedly
- **THEN** Server marks affected runs failed, preserves canonical output already received, reports runtime health, and keeps other runtimes available

#### Scenario: Application shuts down
- **WHEN** Server performs normal or rollback shutdown
- **THEN** it closes worker sessions and terminates the worker and its owned Claude process tree without leaving orphans

### Requirement: Worker transport is local and authenticated
The worker control and event transport SHALL bind only to an approved local boundary, require a per-generation high-entropy credential, validate payload and size limits, and remain inaccessible to Renderer and remote clients.

#### Scenario: Unauthenticated process calls the worker
- **WHEN** a local request omits or supplies an incorrect worker credential
- **THEN** the worker rejects it without revealing session, credential, or workspace details

### Requirement: Claude sessions are explicit and resumable
Each Claude-backed JuggleWork session SHALL map to an explicit Claude backend session identifier once initialized. Subsequent runs SHALL resume that identifier and MUST NOT select a session merely because it was the most recent in a directory.

#### Scenario: First Claude run initializes
- **WHEN** a new Claude session begins its first run
- **THEN** the reported backend session identifier is persisted before the run is considered recoverably initialized

#### Scenario: Existing Claude session resumes
- **WHEN** a later run starts for the same JuggleWork session
- **THEN** the worker resumes the exact persisted backend session in the canonical workspace directory

### Requirement: Claude output streams into canonical events
The worker SHALL map initialization, assistant output, text and reasoning deltas, tool lifecycle, subagent progress, retries, compaction, results, errors, usage, and cost estimates into canonical events while retaining enough backend identity to deduplicate final messages.

#### Scenario: Claude streams text
- **WHEN** Claude produces partial text followed by its complete assistant message
- **THEN** clients see progressive text and one final canonical assistant message

#### Scenario: Claude finishes a turn
- **WHEN** Claude emits a result
- **THEN** the run reaches a terminal canonical state with turns, model usage, duration, and estimated cost when available

### Requirement: Runs support bounded cancellation and busy behavior
Server SHALL be able to abort a Claude run, close a stuck execution, and enforce application-level turn, budget, approval, idle, and wall-clock limits. Before resident streaming sessions are enabled, a busy Claude session SHALL support reject or durable enqueue but SHALL NOT claim unsupported steering.

#### Scenario: User stops the current run
- **WHEN** an authorized user requests abort
- **THEN** the active SDK operation is cancelled, pending approvals are released, owned subprocess work is stopped, and the run becomes aborted or failed within a bounded time

#### Scenario: Client requests unsupported steer
- **WHEN** a client requests steer while the runtime descriptor does not advertise it
- **THEN** Server returns a stable unsupported-capability error without losing the request as an ordinary prompt

### Requirement: Claude credentials and state are isolated
Claude API, cloud-provider, and gateway credentials MUST remain outside Renderer, workspace files, canonical messages, routine logs, and worker responses. Claude configuration and transcripts SHALL use a JuggleWork-owned per-profile data location separate from a user's standalone Claude installation.

#### Scenario: BYOK credential is used
- **WHEN** a Claude run uses a user-provided API credential
- **THEN** the credential is obtained from the approved secret store or broker and is not persisted in the workspace or session projection

#### Scenario: Worker environment is constructed
- **WHEN** Server starts the worker or the worker starts Claude
- **THEN** only an explicit environment allowlist and required short-lived credential material are inherited

### Requirement: Worker lifecycle is recoverable
Server SHALL health-check the worker, serialize lifecycle generations, apply bounded restart policy, and distinguish unavailable, starting, healthy, degraded, and failed states. A restart SHALL not silently restart a non-idempotent user run.

#### Scenario: Worker is unavailable before run dispatch
- **WHEN** a run is requested and restart policy can recover the worker
- **THEN** Server starts one coherent worker generation and dispatches only after readiness

#### Scenario: Worker dies after a tool may have mutated state
- **WHEN** execution outcome is ambiguous after worker failure
- **THEN** Server reports the run as interrupted with an ambiguity warning and requires an explicit retry

### Requirement: Worker distribution is platform-verifiable
Desktop and supported headless distributions SHALL include or resolve a compatible Node runtime, exact supported Agent SDK version, and executable Claude platform binary outside virtual archive paths. Package checks SHALL fail when required runtime assets are absent.

#### Scenario: Desktop package is built for a target architecture
- **WHEN** release packaging completes
- **THEN** an installation-level smoke test can start the worker, locate the target Claude executable, perform initialization without exposing secrets, and cleanly stop

### Requirement: Advanced Claude capabilities are feature-gated
Prewarming, resident streaming input, mid-turn interrupt or steering, subagent projection, plan mode, file checkpointing, rewind, session fork, and additional cloud providers SHALL be advertised and enabled only after runtime capability and policy checks succeed.

#### Scenario: Installed SDK lacks an advanced capability
- **WHEN** initialization does not report the capability required by a control
- **THEN** the control remains unavailable while basic Claude sessions continue to work
