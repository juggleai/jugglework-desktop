## ADDED Requirements

### Requirement: New workspace session for every accepted trigger
Every accepted scheduled, catch-up, or manual trigger SHALL create a new OpenCode session in the automation's selected local workspace. The session SHALL have a human-readable automation title and metadata containing automation id, run id, trigger source, scheduled instant, and definition revision. Creating the background session MUST NOT navigate or replace the user's active session.

#### Scenario: Scheduled occurrence is accepted
- **WHEN** the selected workspace resolves and the scheduler claims an occurrence
- **THEN** a new session is created under that workspace and its id is persisted on the run before prompt dispatch

#### Scenario: Workspace no longer exists
- **WHEN** a trigger is claimed but its local workspace cannot be resolved
- **THEN** no session is created, the run fails with `workspace_unavailable`, and the user is notified

### Requirement: Unattended full-access session policy
An automated session MUST use the versioned unattended full-access permission profile. The effective OpenCode rules SHALL allow tools without interactive confirmation, explicitly deny the question capability, and include an unattended instruction forbidding user prompts. Organization policy and operating-system authorization MUST remain effective and MUST NOT be bypassed.

#### Scenario: Tool would normally ask for permission
- **WHEN** the automated agent invokes an available file, Bash, network, skill, or allowed connector tool
- **THEN** the OpenCode permission handler does not wait for a renderer approval response

#### Scenario: Agent attempts to ask the user
- **WHEN** the automated agent invokes the question capability
- **THEN** the call is denied and the run must continue with a reasonable assumption or fail clearly

### Requirement: Versioned execution snapshot and preflight
Each run SHALL execute the definition revision captured when the run was created. Before prompt dispatch, the executor MUST resolve `Auto` or explicit model, agent, referenced skills/files, and selected connectors against current workspace state. Missing or unauthorized dependencies SHALL produce stable failure codes and MUST NOT silently fall back to a different explicit dependency.

#### Scenario: Auto model is configured
- **WHEN** a run starts for a definition whose model is `Auto`
- **THEN** the executor resolves the workspace's current default model and records the concrete model used

#### Scenario: Explicit model was removed
- **WHEN** the stored explicit model is no longer allowed or available
- **THEN** the run fails with `model_unavailable` and does not substitute another model

### Requirement: Hard connector allowlist
Only connectors selected in the captured automation definition SHALL be exposed to that run. Unselected local MCP tools MUST be unavailable. Unified cloud capability search and execution MUST use a short-lived run-bound scope that restricts results and calls to selected connection ids. A prompt instruction alone SHALL NOT satisfy this requirement.

#### Scenario: Agent searches unified cloud capabilities
- **WHEN** an automated run selected connector A but the user is also authorized for connector B
- **THEN** capability search returns connector A capabilities only and connector B cannot be executed

#### Scenario: Selected connector authorization expired
- **WHEN** a selected connector requires renewed authorization at preflight
- **THEN** the run fails with `connector_reauth_required`, retains its audit session, and asks for reauthorization through history/UI rather than an interactive run prompt

### Requirement: Auditable preflight failure session
After the workspace resolves, the executor SHALL create and persist the run's session before dependency preflight. A later preflight failure SHALL retain that session id and expose the failure from run history. It MUST NOT dispatch the stored prompt after a failed preflight.

#### Scenario: Skill is missing after session creation
- **WHEN** the workspace resolves, a session is created, and a referenced skill then fails preflight
- **THEN** the run fails with `skill_unavailable`, the empty audit session remains linkable, and no model request is sent

### Requirement: Event-based terminal status
Submitting through `promptAsync` SHALL move a run to running but SHALL NOT mark it succeeded. The executor SHALL derive completion from the target OpenCode session's idle/error events and persisted status. Success requires the session to become idle without a terminal error; failures SHALL retain a sanitized error code/message and timestamps.

#### Scenario: Prompt dispatch returns immediately
- **WHEN** `promptAsync` accepts the prompt while the model is still producing output
- **THEN** the run remains running until the session reaches a terminal idle or error state

#### Scenario: Session emits an error
- **WHEN** the target automated session emits a terminal error
- **THEN** the run becomes failed with end time and sanitized error details

### Requirement: Run history and session navigation
The Desktop SHALL persist queued, running, succeeded, failed, skipped, and cancelled run states with scheduled/start/end times, trigger source, workspace, session id when available, concrete execution selections, and sanitized error details. A history row with a session id SHALL navigate to that workspace session.

#### Scenario: User opens a successful run
- **WHEN** the user selects a run-history row containing a session id
- **THEN** the Desktop opens the associated workspace and session transcript

### Requirement: Permission profile drives session permissions
An automation SHALL persist one versioned permission profile. Under full access the run session SHALL be created with a blanket allow and questions denied, and SHALL be told it is unattended. Under default permissions the run SHALL inherit the workspace's own confirmation policy and MUST NOT be given the blanket allow, so a sensitive action waits for the user instead of proceeding silently.

#### Scenario: Default-permission run reaches a sensitive action
- **WHEN** an automation saved with default permissions performs an action that needs confirmation
- **THEN** the run waits for the user rather than auto-approving, and the session records the pending confirmation

#### Scenario: Full-access run reaches a sensitive action
- **WHEN** an automation saved with full access performs the same action
- **THEN** the action proceeds without prompting because unattended execution cannot answer a question

### Requirement: Manual run uses the normal execution pipeline
The scheduled-task play action SHALL create a run with trigger source `manual` and use the same validation, session creation, permissions, connector scope, event reconciliation, history, and sync pipeline as a scheduled run. It SHALL NOT change the next scheduled occurrence.

Triggering a manual run SHALL confirm to the user that a test run started and that it does not affect the scheduled times. Triggering again while that task still has a queued or running run SHALL be rejected by the one-active-run-per-task rule and reported as already running rather than silently ignored.

Because manual run is an explicit current user action, it SHALL be available for enabled, paused, and completed definitions and SHALL ignore schedule due time and active date range. It MUST still require a valid current full-access acknowledgement, reject tombstoned definitions, enforce one-active-run-per-task, and perform current workspace/model/agent/skill/file/connector preflight.

#### Scenario: User manually runs an idle automation
- **WHEN** the user clicks play and no run for that automation is nonterminal
- **THEN** a manual run is created immediately and the task's `next_run_at` remains unchanged

#### Scenario: User manually runs a busy automation
- **WHEN** the user clicks play while that automation is queued or running
- **THEN** the request is rejected as overlapping and no second session is created

#### Scenario: User manually runs a paused or completed task
- **WHEN** the user clicks play on a paused task or a consumed one-time task and all current dependencies are valid
- **THEN** one manual run is created without enabling the schedule or changing its terminal/paused state

### Requirement: Automation notifications
The Desktop SHALL issue a native notification for failed automation runs and MAY notify on success according to the user's notification preference. A notification action SHALL open the corresponding run or session when available.

#### Scenario: Background run fails while window is hidden
- **WHEN** an automated run reaches failed state while the client runtime remains active and its window is hidden
- **THEN** the operating system displays a failure notification that can return the user to the run details
