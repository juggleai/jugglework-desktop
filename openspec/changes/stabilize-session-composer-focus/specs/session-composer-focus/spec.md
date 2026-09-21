## ADDED Requirements

### Requirement: Background synchronization preserves composer interaction

The application SHALL keep the intended session composer editable while renderable data for that session is refreshed in the background. Initial loading without renderable target-session data and rendering data for a different session MUST remain non-interactive transitions.

#### Scenario: Existing session snapshot refreshes

- **WHEN** the selected session already has renderable data and its snapshot query refetches
- **THEN** the composer remains editable
- **AND** the current focus and caret are not reset by the refresh

#### Scenario: Target session is not ready

- **WHEN** the selected session has no renderable target-session state yet
- **THEN** the surface remains in a switching state until target-session state is available

### Requirement: Composer focus follows the latest user intent

The application SHALL scope an automatic composer focus request to one session and SHALL apply it at most once. A newer request or a newer pointer or keyboard action MUST cancel the pending request.

#### Scenario: User switches sessions rapidly

- **WHEN** focus is requested for session A and then session B before session A applies it
- **THEN** only session B remains eligible to receive automatic focus

#### Scenario: User interacts before delayed readiness

- **WHEN** a target composer is not ready and the user performs a newer pointer or keyboard action
- **THEN** the pending automatic focus request is cancelled
- **AND** readiness completion does not steal focus from the user's chosen control

#### Scenario: Multiple session surfaces are mounted

- **WHEN** primary, split, or retained session surfaces coexist
- **THEN** only the active visible composer matching the target session may complete the request
