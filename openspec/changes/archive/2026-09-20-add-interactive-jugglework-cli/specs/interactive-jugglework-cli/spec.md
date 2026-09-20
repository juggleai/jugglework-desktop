## Purpose

Provide a safe and scriptable Codex-style terminal interface for running, observing, controlling, and resuming JuggleWork tasks in a local directory or through an existing JuggleWork Server.

## ADDED Requirements

### Requirement: The jugglework command starts a terminal task

The system SHALL provide an executable named `jugglework`. A prompt supplied as arguments SHALL run once and exit, while invocation without a prompt in a terminal SHALL enter an interactive session.

#### Scenario: One-shot prompt
- **WHEN** the user runs `jugglework "inspect this project"`
- **THEN** the command creates a session in the selected workspace, streams the assistant response, and exits with a result-appropriate status

#### Scenario: Interactive invocation
- **WHEN** the user runs `jugglework` with an interactive terminal
- **THEN** the command presents a reusable input prompt and keeps the selected session available for follow-up turns

### Requirement: Local mode owns a bounded runtime

Without an explicit Server URL, the CLI SHALL start a loopback JuggleWork Server and managed OpenCode for the selected local workspace, SHALL keep CLI runtime state separate from Desktop runtime state, and SHALL stop owned processes on exit.

#### Scenario: Current directory local run
- **WHEN** no workspace or Server is specified
- **THEN** the resolved current directory becomes the workspace
- **AND** the CLI starts and later stops its owned runtime

#### Scenario: OpenCode cannot be located
- **WHEN** local mode cannot resolve an executable OpenCode binary
- **THEN** startup fails before creating a session
- **AND** the error explains the supported configuration options

### Requirement: Existing Server connections are explicit

The CLI SHALL support an explicit Server URL, bearer token, optional host token, and workspace selection without assuming ownership of that Server.

#### Scenario: Connected mode exits
- **WHEN** a command connected with `--server` finishes
- **THEN** it leaves the external Server and its OpenCode runtime running

#### Scenario: Workspace is ambiguous
- **WHEN** multiple Server workspaces exist and neither ID nor requested path selects one
- **THEN** the CLI requests a choice in interactive mode or fails clearly in non-interactive mode

### Requirement: Terminal output follows authoritative run state

The CLI SHALL render appended assistant text while a run is active, report retry or waiting state concisely, and finish only after authoritative idle or terminal evidence. It SHALL feed observed active and idle state into the Server run coordinator.

#### Scenario: Assistant streams text
- **WHEN** assistant text grows across successive snapshots
- **THEN** the CLI prints only the new text without duplicating the existing prefix

#### Scenario: Fast run completes before first busy poll
- **WHEN** a task finishes before the CLI observes a busy snapshot
- **THEN** the CLI still returns the final assistant output and terminalizes its accepted run without hanging

### Requirement: Interactive commands manage sessions

Interactive mode SHALL provide help, new session, recent sessions, resume, status, stop, and exit commands while ordinary input remains a task prompt.

#### Scenario: Resume a session
- **WHEN** the user resumes a recent session and sends another prompt
- **THEN** the prompt continues that exact session and its existing transcript

#### Scenario: Stop active run
- **WHEN** the user invokes stop or presses Ctrl-C during an active run
- **THEN** the CLI requests abort for the accepted run ID and preserves the session for later resumption

### Requirement: Pending interactions are actionable

Interactive mode SHALL display pending permissions and questions for the root session tree and SHALL submit the user's reply through existing Server interaction APIs. Non-interactive mode SHALL not silently approve an interaction.

#### Scenario: Permission is requested
- **WHEN** a run requests permission in interactive mode
- **THEN** the CLI offers allow once, session grant when supported, and reject choices
- **AND** submits exactly one selected response

#### Scenario: One-shot task requires input
- **WHEN** a non-interactive run requires a question or permission that was not pre-authorized
- **THEN** the command stops waiting with an actionable error and non-zero status

### Requirement: Full access is explicit

The CLI SHALL default to request-approval and SHALL enable Full access only when the user explicitly requests it and the Server accepts the current versioned acknowledgement.

#### Scenario: User requests Full access
- **WHEN** `--full-access` is supplied with sufficient local host or owner authority
- **THEN** the new root session is configured for Full access before its first run

#### Scenario: Server rejects Full access
- **WHEN** policy or authority prevents Full access
- **THEN** the CLI reports the refusal and does not misrepresent the session as Full access

### Requirement: Script mode is deterministic

The CLI SHALL support machine-readable JSON output, shall not emit ANSI control sequences when output is not a TTY or color is disabled, and SHALL use non-zero exit codes for configuration, connection, interaction, or execution failures.

#### Scenario: JSON one-shot execution
- **WHEN** the user supplies `--json` with a one-shot prompt
- **THEN** stdout contains machine-readable lifecycle and final-result records
- **AND** human status text is excluded from stdout

### Requirement: User configuration does not expose secrets

The CLI SHALL accept connection defaults from a user config file and environment variables, SHALL restrict newly written credential-bearing config to the current user, and SHALL redact tokens from logs and errors.

#### Scenario: Connection fails
- **WHEN** a request using a configured token fails
- **THEN** the error may identify the Server and HTTP status
- **AND** does not print the bearer or host token
