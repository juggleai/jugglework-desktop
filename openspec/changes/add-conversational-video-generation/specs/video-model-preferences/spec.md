## Purpose

Defines independent workspace and conversation defaults for video-generation models and deterministic resolution behavior when preferences are absent, incompatible, or unavailable.

## ADDED Requirements

### Requirement: Configure a workspace default video model
The system SHALL allow an authorized user to set or clear a workspace default video model independently of the workspace's normal chat-model choice.

#### Scenario: Set workspace default
- **WHEN** an authorized user selects a ready video-generation model as the workspace default
- **THEN** subsequent compatible video requests in that workspace use the selected model unless a higher-priority choice applies

#### Scenario: Chat model changes
- **WHEN** a user changes the default chat model
- **THEN** the workspace default video model remains unchanged

### Requirement: Configure a session default video model
The system SHALL allow a user to set or clear a default video model for a specific session without changing the workspace default or another session's preference.

#### Scenario: Session override
- **WHEN** a session has a compatible default video model that differs from the workspace default
- **THEN** video requests in that session resolve to the session model while other sessions continue to use their own or the workspace preference

#### Scenario: Clear session override
- **WHEN** a user clears the session video-model preference
- **THEN** subsequent requests in that session fall back to the workspace preference and normal fallback chain

### Requirement: Resolve video model using deterministic precedence
The system SHALL resolve a model in this order: a model explicitly selected for the request, the session default, the workspace default, an optional user-wide default, then the first ready compatible model in stable catalog order.

#### Scenario: Explicit model wins
- **WHEN** a request explicitly names a ready model compatible with its generation mode
- **THEN** that model is used regardless of session or workspace defaults

#### Scenario: No defaults are configured
- **WHEN** no explicit, session, workspace, or user-wide video default exists and one or more compatible models are ready
- **THEN** the first compatible model in stable catalog order is selected

### Requirement: Validate preferences against the requested mode
The system SHALL validate every preferred model at request time and SHALL skip a preference that is disconnected, removed, unauthorized, or incompatible with the requested generation mode.

#### Scenario: Session default cannot perform image-to-video
- **WHEN** the session default supports text-to-video only and the request contains a reference image
- **THEN** the resolver skips that preference and selects the next ready image-to-video model while exposing a non-secret fallback diagnostic

#### Scenario: All preferred and fallback models are unavailable
- **WHEN** each candidate in the precedence chain is unavailable or incompatible
- **THEN** resolution returns `no_video_model_available` and no generation job is submitted

### Requirement: Scope preference storage correctly
The system SHALL persist workspace defaults in workspace-scoped configuration and session defaults under the combination of workspace and session identity, without storing provider credentials in either preference.

#### Scenario: Same session identifier appears in different workspaces
- **WHEN** two workspaces contain the same session identifier but have different video-model preferences
- **THEN** each workspace resolves its own session preference without leaking the other workspace's setting
