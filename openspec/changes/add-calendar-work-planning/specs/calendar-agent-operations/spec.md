# Spec Delta

## Purpose

Defines page-independent Agent calendar affordances that query and mutate the same authorized cloud calendar domain as the Desktop while preventing ambiguous or high-impact writes from executing without informed confirmation.

## ADDED Requirements

### Requirement: Page-independent Agent availability
Authenticated Agent calendar operations SHALL be exposed by a runtime service independent of Calendar React page mounting, selected route, window visibility, and cached view state. Availability SHALL depend on calendar service readiness and member authorization, not on whether the calendar UI has been opened.

#### Scenario: Calendar page was never opened
- **WHEN** an Agent queries an authorized member's calendar before any Calendar page has mounted
- **THEN** the runtime executes the query against the calendar service without opening or mounting the page

#### Scenario: User navigates away during an operation
- **WHEN** the selected route changes while an Agent calendar operation is in progress
- **THEN** the operation completes or fails according to its service contract rather than being canceled because the page unmounted

#### Scenario: Calendar service is unavailable
- **WHEN** the calendar service or authenticated member context is not ready
- **THEN** the affordance returns an explicit unavailable result and MUST NOT infer success from cached UI data

### Requirement: Permission-consistent Agent queries
Agent list, range, detail, and search queries SHALL use the same deployment, organization, member identity, calendar filters, and server authorization as direct Calendar clients. Agent responses MUST NOT expose inaccessible event fields, hidden calendars, or unauthorized source projections.

#### Scenario: Query an authorized range
- **WHEN** an Agent requests a bounded date range and timezone for an authenticated member
- **THEN** the result contains only events and explicitly requested source projections that the member can read, with stable IDs and versions

#### Scenario: Query an inaccessible event ID
- **WHEN** an Agent requests an event that does not exist or the member cannot read
- **THEN** the result does not distinguish absence from lack of permission and discloses no event fields

#### Scenario: Query is unbounded
- **WHEN** an Agent omits required range bounds or requests a range above the supported limit
- **THEN** the operation is rejected with guidance to provide a bounded query and no broad data scan occurs

### Requirement: Shared Agent write contract
Agent create, update, move, resize, recurrence-scope, reminder, and delete writes SHALL call the same cloud calendar mutation boundary used by first-party clients. Updates and deletes MUST include the latest expected version, every retryable write MUST include an idempotency key, and all writes SHALL be reauthorized at execution time.

#### Scenario: Agent creates an event
- **WHEN** an authorized Agent submits a valid event and a unique idempotency key
- **THEN** the cloud creates one event and returns the same stable ID, version, and canonical time fields available to the Desktop

#### Scenario: Agent retries a mutation
- **WHEN** an Agent retries the same mutation with the same idempotency key
- **THEN** the original result is returned and the calendar change is applied at most once

#### Scenario: Agent writes with a stale version
- **WHEN** an Agent mutation supplies an expected version older than the authoritative event
- **THEN** the operation returns a conflict with the current authorized representation and does not overwrite it

#### Scenario: Authorization changes before execution
- **WHEN** the member loses write access after an Agent prepared a mutation but before it executes
- **THEN** the server denies the write even if an earlier query or preview was authorized

### Requirement: Structured time and recurrence inputs
Agent writes SHALL use explicit structured dates, local times, IANA timezones, all-day semantics, and supported recurrence fields. The runtime MUST NOT silently guess an omitted timezone, convert an unsupported recurrence request into a different rule, or treat a date-only value as a timed instant.

#### Scenario: Timed event lacks timezone
- **WHEN** an Agent write specifies local timed boundaries without an explicit IANA timezone or an authorized user-default timezone reference
- **THEN** the operation requests clarification and performs no write

#### Scenario: User requests unsupported recurrence
- **WHEN** natural-language intent requires yearly or arbitrary RRULE behavior
- **THEN** the Agent explains the supported daily, weekly, and monthly boundary and performs no approximating write

#### Scenario: User requests only this occurrence
- **WHEN** an Agent mutation targets a recurring occurrence with explicit `this occurrence` scope
- **THEN** the write uses that occurrence's immutable original key and does not change the entire series

### Requirement: Ambiguity resolution before mutation
An Agent MUST NOT mutate when the target, calendar, date, timezone, recurrence scope, or intended new value is materially ambiguous. It SHALL return a bounded set of authorized candidates or a focused clarification request and SHALL preserve stable candidate IDs for the follow-up.

#### Scenario: Several events match a title
- **WHEN** a mutation request matches more than one authorized event in the relevant range
- **THEN** the Agent presents distinguishing date, time, calendar, and stable candidate reference information and performs no write

#### Scenario: Recurring occurrence scope is omitted
- **WHEN** a requested edit or deletion targets a recurring occurrence but does not specify `this occurrence` or `entire series`
- **THEN** the Agent asks the user to choose between those two scopes and performs no write

#### Scenario: Follow-up selects a candidate
- **WHEN** the user selects one still-authorized candidate from the clarification response
- **THEN** the Agent reloads its current version before preparing or executing the mutation

#### Scenario: No event matches
- **WHEN** no authorized event matches a mutation request
- **THEN** the Agent reports no match and MUST NOT create a replacement event unless the user separately requests creation

### Requirement: Confirmation for high-impact operations
An Agent SHALL require explicit confirmation of a fresh preview before deleting an entire recurring series, changing an entire series in a way that affects multiple occurrences or exceptions, or performing a bounded bulk mutation. The preview SHALL identify scope, affected calendar, effective changes, affected-occurrence count within a disclosed horizon, exception consequences, and current versions. Confirmation SHALL be single-use and bound to that preview.

#### Scenario: Delete an entire recurring series
- **WHEN** an Agent prepares deletion with scope `entire series`
- **THEN** it returns a confirmation preview and performs no deletion until the user explicitly confirms that preview

#### Scenario: Series change orphans exceptions
- **WHEN** an Agent prepares a whole-series change that would remove matching original occurrences for exceptions
- **THEN** the preview discloses the number and consequence of those exceptions before confirmation

#### Scenario: Preview becomes stale
- **WHEN** any target version or authorization changes after preview generation and before confirmation
- **THEN** confirmation is rejected, no mutation occurs, and a new authorized preview is required

#### Scenario: User confirms once
- **WHEN** the user explicitly confirms a valid high-impact preview
- **THEN** the bound mutation executes once with its idempotency key and the confirmation token cannot authorize a different or repeated mutation

### Requirement: Ordinary single-write confirmation boundary
A clear request for one non-recurring create or one low-impact update MAY execute without an extra confirmation when all required fields and target identity are unambiguous. The Agent SHALL still summarize the committed result. A destructive single-event delete SHALL require explicit confirmation unless the user's current instruction unambiguously and immediately requests that exact deletion.

#### Scenario: Create request is complete
- **WHEN** a user clearly requests one event with complete date, time, timezone, calendar, and duration
- **THEN** the Agent may create it directly and returns the committed canonical event and version

#### Scenario: Delete wording is indirect
- **WHEN** the user asks about removing an event but does not unambiguously instruct deletion of the exact target
- **THEN** the Agent previews the event and asks for confirmation before deleting it

#### Scenario: Exact deletion is explicitly requested
- **WHEN** the current instruction explicitly requests deletion of one uniquely identified non-recurring event
- **THEN** the Agent may execute the versioned, idempotent deletion and reports the committed result

### Requirement: Agent result truthfulness and auditability
Agent operation results SHALL distinguish previewed, committed, conflicted, denied, and unavailable outcomes. A preview or local affordance response MUST NOT be described as a saved calendar change. Committed writes SHALL record the authenticated member and Agent operation origin without treating the model as an independent calendar principal.

#### Scenario: Write fails after preview
- **WHEN** a confirmed write fails authorization, validation, or concurrency checks
- **THEN** the Agent reports the failure category and does not claim that the calendar changed

#### Scenario: Agent write commits
- **WHEN** a calendar write succeeds
- **THEN** the response includes the stable target ID, new version, canonical affected time or deletion state, and an auditable Agent-origin marker

#### Scenario: Model identity differs from member identity
- **WHEN** an Agent performs an operation for a signed-in member
- **THEN** authorization and ownership use the member identity while audit metadata records that the member invoked the write through an Agent
