# Spec Delta

## Purpose

Defines permission-filtered, read-only calendar projections of task deadlines and automation run forecasts without turning source records into calendar events or transferring write authority to Calendar.

## ADDED Requirements

### Requirement: Task time projection
The calendar SHALL be able to project accessible task time information as read-only source entries. A task due time SHALL be projected at its due instant, and a due date without a time SHALL be projected as an all-day entry on that date in the task's governing timezone.

#### Scenario: Task has a due instant
- **WHEN** an authorized user enables task overlays for a range containing an accessible task due instant
- **THEN** the calendar shows one read-only task entry at that instant with stable task source identity

#### Scenario: Task has only a due date
- **WHEN** an accessible task has a due date but no due time
- **THEN** the calendar shows it in the all-day region for that source date without inventing a clock time

#### Scenario: Task has no due value
- **WHEN** an accessible task has neither a due date nor a due instant in the requested range
- **THEN** the task produces no calendar projection

### Requirement: Automation next-run projection
The calendar SHALL be able to project the currently forecast next run of each accessible automation as a read-only source entry. A projection SHALL represent a forecast, not an execution guarantee, and SHALL use the automation's authoritative next-run value rather than independently recalculating its schedule in Calendar.

#### Scenario: Enabled automation has a next run
- **WHEN** an authorized user enables automation overlays for a range containing an automation's authoritative next-run instant
- **THEN** the calendar shows one read-only forecast entry at that instant with stable automation source identity

#### Scenario: Automation is paused or ended
- **WHEN** an accessible automation has no authoritative next-run instant
- **THEN** it produces no forecast entry even if an older projection was cached

#### Scenario: Forecast changes
- **WHEN** the Automation domain publishes a different next-run value
- **THEN** the calendar replaces the old projection with the new forecast and does not retain both as calendar events

### Requirement: Source authority and read-only behavior
Task and automation projections SHALL retain source type and source ID and MUST NOT be stored as CalendarEvent records. Calendar move, resize, duplicate, delete, recurrence, reminder, and calendar assignment operations SHALL be unavailable for source projections.

#### Scenario: User attempts to drag a task projection
- **WHEN** a user points to or focuses a task projection in week or day view
- **THEN** calendar move and resize affordances are unavailable and no task or calendar write can be initiated by dragging it

#### Scenario: User attempts calendar deletion
- **WHEN** a user opens a source projection's actions
- **THEN** no calendar delete or recurrence action is offered and the projection identifies its authoritative source

#### Scenario: Calendar data is exported or synchronized
- **WHEN** CalendarEvent records are queried independently of overlays
- **THEN** task and automation projections are absent because they were not copied into Calendar storage

### Requirement: Source distinction and overlay controls
The Desktop SHALL visually and accessibly distinguish calendar events, task projections, and automation projections without relying on color alone. Users SHALL be able to enable or disable each overlay source independently, and those display choices MUST NOT mutate source records.

#### Scenario: Sources share a time slot
- **WHEN** a calendar event, task projection, and automation projection occupy the same visible interval
- **THEN** each entry has a non-color-only source label and participates in layout without being merged

#### Scenario: User hides task overlays
- **WHEN** a user disables the task overlay
- **THEN** task projections disappear while calendar events and enabled automation projections remain unchanged

#### Scenario: Source query fails
- **WHEN** one enabled overlay source fails to load
- **THEN** the Desktop identifies that source as unavailable while retaining successfully loaded calendar data and other source projections

### Requirement: Permission-filtered overlay queries
Every overlay query and direct source resolution SHALL be authorized by the source domain for the current deployment, organization, and member. Calendar caches and search MUST NOT reveal source entries that the current member cannot read.

#### Scenario: User cannot read a task
- **WHEN** a task falls in the requested time range but the current member lacks source-domain read permission
- **THEN** the task is absent from overlay results and no title, time, or existence metadata is disclosed

#### Scenario: Source permission is revoked
- **WHEN** a previously projected source record becomes inaccessible
- **THEN** refresh removes its projection and direct resolution returns a non-disclosing unavailable result

#### Scenario: Organization changes
- **WHEN** the active organization changes
- **THEN** overlay queries and caches use only the new organization/member scope and never display entries retained from the prior scope

### Requirement: Source navigation and mutation handoff
Opening a source projection SHALL provide a source-domain detail action, and every edit action SHALL navigate to or invoke the source domain rather than editing through Calendar. Calendar SHALL pass only stable source identity and return location; the source domain SHALL reauthorize and load current data.

#### Scenario: Open a task projection
- **WHEN** a user activates a task projection
- **THEN** the Desktop opens the authoritative task detail identified by its source ID and preserves a way to return to the calendar range

#### Scenario: Open an automation projection
- **WHEN** a user activates an automation projection
- **THEN** the Desktop opens the authoritative automation detail identified by its source ID and preserves a way to return to the calendar range

#### Scenario: Source changed after projection loaded
- **WHEN** a user follows a projection whose source version is stale
- **THEN** the source domain loads and authorizes its current record rather than treating projected fields as an editable snapshot

#### Scenario: Source no longer exists
- **WHEN** a user follows a projection whose source has been deleted or is no longer accessible
- **THEN** the Desktop shows a non-disclosing unavailable state, removes the stale projection on refresh, and performs no calendar mutation

### Requirement: Overlay search behavior
Calendar search MAY include enabled task and automation projections but SHALL label their source and apply source authorization. Selecting a source search result SHALL follow the same source-domain navigation and read-only rules as selecting its overlay entry.

#### Scenario: Search finds mixed sources
- **WHEN** an authorized search matches a calendar event, a task, and an automation forecast
- **THEN** results identify each source and source results do not expose calendar mutation actions

#### Scenario: Overlay is disabled
- **WHEN** a source overlay is disabled and the user searches within the calendar surface
- **THEN** that source is excluded unless the search explicitly offers and the user selects an authorized all-source scope
