## Purpose

Define consistent, secure tool and human-interaction behavior across agent runtimes, including authorization, exactly-once resolution, MCP exposure, and remote collaboration.

## ADDED Requirements

### Requirement: Runtime interactions use one canonical lifecycle
Permissions, clarification questions, and runtime-defined human input SHALL be represented as canonical pending interactions with stable identifiers, session ownership, actor scope, deadlines, and allow, deny, answer, reject, timeout, or cancellation outcomes.

#### Scenario: Claude requests tool approval
- **WHEN** Claude requests a tool action that requires human approval
- **THEN** local and authorized remote clients receive a canonical pending interaction using the same product UI and resolution API as other runtimes

#### Scenario: Run is aborted during approval
- **WHEN** a run is aborted while its interaction is pending
- **THEN** the interaction is cancelled and the runtime callback is released without waiting indefinitely

### Requirement: Interaction resolution is exactly once
Concurrent local, remote, timeout, and cancellation resolutions SHALL pass through Server arbitration so at most one terminal decision is delivered to the runtime and later attempts receive a deterministic already-resolved result.

#### Scenario: Local and remote users reply concurrently
- **WHEN** two authorized actors resolve the same interaction at nearly the same time
- **THEN** one resolution wins and the other observes the persisted terminal outcome without a second runtime reply

### Requirement: Mandatory policy runs before every tool execution
Workspace authorization, canonical path and symlink checks, sensitive-path restrictions, command and network policy, actor scope, and tool-specific validation SHALL run on every relevant tool call even if the runtime would otherwise auto-approve it. Prompt instructions and approval callbacks MUST NOT be the sole enforcement boundary.

#### Scenario: Auto-approved tool attempts an unauthorized path
- **WHEN** a runtime considers a tool pre-approved but the resolved path leaves authorized workspace roots
- **THEN** JuggleWork denies the operation before execution and records a redacted policy decision

#### Scenario: Tool input can be safely narrowed
- **WHEN** policy permits an operation only after canonicalization or argument reduction
- **THEN** the runtime receives the policy-approved input and the canonical interaction records that input was modified

### Requirement: JuggleWork capabilities are exposed through controlled tools
Claude Agent SHALL be able to use JuggleWork context, side-effect-free queries, attributed commands, bounded filesystem search, skill guidance, and artifact operations through a controlled tool boundary whose handlers re-authorize every call.

#### Scenario: Claude invokes a JuggleWork command
- **WHEN** Claude calls a side-effecting JuggleWork tool
- **THEN** the handler validates workspace, actor, command schema, expected revision where applicable, and applicable approval policy before dispatch

### Requirement: Runtime MCP configuration is explicit and isolated
Each runtime SHALL receive only MCP servers allowed for the workspace, user, organization policy, and runtime. Unknown user-level or project-level MCP configuration MUST NOT be loaded by the Claude worker unless an explicit product option authorizes that source.

#### Scenario: Workspace has a configured remote MCP
- **WHEN** Claude starts with an authorized workspace MCP configuration
- **THEN** the worker receives a redacted runtime translation and exposes only the allowed server and tools

#### Scenario: MCP needs OAuth
- **WHEN** a configured MCP requires interactive OAuth
- **THEN** JuggleWork completes authorization outside the agent process and supplies only the approved runtime credential mechanism

### Requirement: Headless and remote interaction policy is deterministic
When no interactive approver is available, the runtime SHALL follow a configured deny, pre-approved, or bounded-wait policy and MUST NOT leave an approval unresolved indefinitely. Remote viewers remain read-only and only authorized collaborators can resolve interactions.

#### Scenario: Headless run reaches an unapproved destructive tool
- **WHEN** no eligible approver is available before the configured deadline
- **THEN** the tool is denied or the run fails according to policy and the terminal reason is visible in canonical state

### Requirement: Interaction decisions are auditable without secrets
The system SHALL record runtime, session, tool, requesting reason, actor, decision, timing, and redacted policy basis while excluding credentials and secret-bearing raw payloads.

#### Scenario: Administrator investigates a denied action
- **WHEN** authorized diagnostics inspect an interaction
- **THEN** they can identify which policy or actor denied it without receiving credential values or unrelated file content
