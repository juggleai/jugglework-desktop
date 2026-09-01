## ADDED Requirements

### Requirement: Tool-only runs have readable progress
The system SHALL derive a concise task-progress summary from observable tool activity when a running task has not produced model-authored progress text. The derived summary MUST remain presentation-only and MUST NOT be added to transcript copy, export, or model context.

#### Scenario: Consecutive tool calls without commentary
- **WHEN** an active task performs consecutive tool calls without assistant progress text
- **THEN** the process presentation shows the current tool action and the number of completed tool steps

#### Scenario: Raw tool details remain available
- **WHEN** tool activity is summarized into a readable progress line
- **THEN** the user can still expand the process to inspect the individual tool calls

#### Scenario: Progress summary is not transcript content
- **WHEN** the user copies or exports the conversation or the next model request is built
- **THEN** the locally derived progress summary is excluded

