## Purpose

Define the user-facing multi-agent experience, including safe runtime selection, runtime-aware controls, migration flows, diagnostics, usage, and progressive access to advanced features.

## ADDED Requirements

### Requirement: Users can choose an enabled runtime when creating a session
The new-session experience SHALL show enabled and policy-permitted runtimes with clear names and availability. Omitting a choice SHALL use the configured default, and unavailable runtimes SHALL not silently fall back to another runtime.

#### Scenario: User selects Claude Agent
- **WHEN** the user creates a session after selecting Claude Agent
- **THEN** the created session is visibly identified as Claude-backed before the first prompt is sent

#### Scenario: Claude Agent is unavailable
- **WHEN** the runtime is disabled, unhealthy, unsupported, or missing credentials
- **THEN** the UI explains the actionable reason and does not create a session under a different runtime

### Requirement: Runtime identity remains visible
Session lists, headers, split panes, and relevant remote views SHALL identify the bound runtime and selected model without conflating runtime, agent profile, and model.

#### Scenario: Split view contains different runtimes
- **WHEN** a JuggleWork session and Claude session are displayed together
- **THEN** each pane independently shows its runtime, model, status, and applicable controls

### Requirement: Controls are capability-gated
The UI SHALL derive model selection, variant or effort, compact, shell, command, steer, enqueue, permission mode, plan, checkpoint, rewind, and subagent controls from the runtime descriptor and current policy rather than runtime-name conditionals.

#### Scenario: Runtime does not support compact
- **WHEN** a session's descriptor reports compact as unsupported
- **THEN** compact is hidden or disabled with an explanation and no incompatible request is sent

### Requirement: Cross-runtime continuation is explicit
An existing session SHALL offer “Continue with” only for eligible target runtimes and SHALL explain that a linked session is created from bounded context. The user SHALL be able to inspect or cancel the migration before the new run begins.

#### Scenario: User confirms continuation with Claude
- **WHEN** the user reviews and confirms the generated migration context
- **THEN** a new linked Claude session opens while the source session remains unchanged and navigable

### Requirement: Model and execution settings are runtime-scoped
Runtime-specific models, effort, permission mode, budget, and advanced options SHALL be validated against the selected runtime and persisted at the appropriate global, workspace, or session scope without sending incompatible options to another runtime.

#### Scenario: User returns to a Claude session
- **WHEN** the session is reopened on the same installation
- **THEN** its effective Claude model and supported execution settings are restored from authoritative session configuration

### Requirement: Tool and interaction presentation is consistent
Canonical tool progress, results, errors, permissions, questions, and subagent attribution SHALL use shared UI states while allowing runtime-specific explanatory metadata that does not expose sensitive backend payloads.

#### Scenario: Claude tool waits for permission
- **WHEN** a Claude tool call is blocked on approval
- **THEN** the transcript and interaction surface show one linked pending state and update it in place after resolution

### Requirement: Runtime diagnostics are actionable
Users and support diagnostics SHALL distinguish configuration, credential, worker startup, SDK/binary compatibility, MCP, policy, transport, crash, timeout, and provider failures. Diagnostic exports MUST redact secrets and private transcript content by default.

#### Scenario: Claude executable is missing after installation
- **WHEN** health checks cannot resolve the packaged executable
- **THEN** the runtime is unavailable with a packaging-specific diagnostic rather than a generic model failure

### Requirement: Usage and cost are correctly scoped
When a runtime reports usage, turns, duration, or estimated cost, the UI SHALL attribute it to the correct run and model and label non-authoritative cost estimates. Session totals SHALL avoid double-counting cumulative streaming values.

#### Scenario: Claude run uses subagents
- **WHEN** the runtime result provides model-level usage including subagents
- **THEN** the run displays the full available estimate and identifies its source without treating it as an invoice

### Requirement: Advanced features roll out without breaking baseline sessions
Advanced Claude features SHALL be independently feature-flagged, policy-controlled, capability-detected, and observable. Disabling an advanced feature SHALL leave session reads, basic resume, prompt, streaming, approval, and abort usable.

#### Scenario: Resident sessions are rolled back
- **WHEN** operations disables resident streaming after detecting instability
- **THEN** new Claude turns use resumable run-per-query execution and existing canonical sessions remain readable
