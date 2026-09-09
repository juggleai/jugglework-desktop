## ADDED Requirements

### Requirement: Remember model and reasoning selection
The desktop SHALL remember the model and reasoning strength most recently selected by the user and SHALL use that pair as the default for subsequently created workspace sessions.

#### Scenario: New session after model and reasoning selection
- **WHEN** the user selects a model and reasoning strength in one session and then creates another session
- **THEN** the new session initially uses the selected model and reasoning strength

#### Scenario: Session-specific selection remains isolated
- **WHEN** a user changes a session's model or reasoning strength
- **THEN** the current session receives an explicit override while future sessions inherit the same values from the remembered defaults

### Requirement: First available model fallback
When no remembered model exists or the remembered model is unavailable in the current workspace, the desktop SHALL select the first valid model of the first connected provider with models, preserving the provider and model order returned by OpenCode.

#### Scenario: No previous model selection
- **WHEN** a new session is created and no model has previously been selected
- **THEN** the session uses the first model of the first connected provider that has models

#### Scenario: Previous model is unavailable
- **WHEN** a remembered model is no longer available in the workspace provider catalog
- **THEN** the desktop replaces it with the first available provider/model fallback without opening the model chooser

#### Scenario: No model provider is available
- **WHEN** no connected provider exposes a valid model
- **THEN** the session remains without a selected model and the existing connect-provider state is shown

### Requirement: Reasoning compatibility
The desktop SHALL validate a remembered reasoning strength against the selected model before display or submission and SHALL use the model's effective default when the remembered value is unsupported.

#### Scenario: Remembered strength is supported
- **WHEN** the remembered reasoning strength exists on the selected model
- **THEN** the new session preserves that strength

#### Scenario: Remembered strength is unsupported
- **WHEN** the remembered reasoning strength does not exist on the selected or fallback model
- **THEN** the new session uses the selected model's effective default reasoning behavior
