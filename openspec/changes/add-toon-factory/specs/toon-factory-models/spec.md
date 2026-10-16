## ADDED Requirements

### Requirement: Text models come from the current JuggleWork catalog
The workbench SHALL list only connected, text-capable models allowed by current desktop policy for the active workspace.

#### Scenario: User opens the text-model picker
- **WHEN** connected providers contain text, image-only, and video-only models
- **THEN** the picker shows allowed text-capable models
- **AND** excludes pure image and pure video models and policy-blocked models

### Requirement: Image and video models come from configured JuggleWork runtimes
The workbench SHALL discover image and video models through JuggleWork's configured generation runtimes and SHALL filter options by the requested generation mode and readiness.

#### Scenario: User configures image-to-video generation
- **WHEN** the video picker is opened for image-to-video
- **THEN** it lists only ready video models that support image-to-video and are eligible for submission

#### Scenario: Image provider lacks usable credentials
- **WHEN** an image model is declared but its credentials are unavailable
- **THEN** it is not offered as a ready generation model
- **AND** the workbench reports that no usable configured model is available if no alternative remains

### Requirement: Missing model categories are explicit blocking states
The workbench SHALL display a localized actionable error when text, image, or video work requires a model category with no usable configured model.

#### Scenario: No text model is connected
- **WHEN** the user opens or runs a text-dependent stage and no text model is available
- **THEN** the stage shows `no_text_model_available`
- **AND** text generation remains disabled

#### Scenario: No image model is ready
- **WHEN** the user prepares image generation and no ready image model supports the selected mode
- **THEN** the workbench shows `no_image_model_available`
- **AND** does not silently hide the reason or submit a request

#### Scenario: Video submission is unavailable
- **WHEN** no ready eligible video model exists or video submission is disabled
- **THEN** the workbench shows `no_video_model_available` or `video_submission_disabled` as applicable
- **AND** video submission remains disabled

### Requirement: Persisted model selections are revalidated before use
The system MUST validate the stored provider and model reference immediately before every generation and MUST NOT silently substitute a different media model.

#### Scenario: Selected image model was removed
- **WHEN** a project references an image model that is no longer ready
- **THEN** the workbench marks the selection unavailable and requires a new explicit selection
- **AND** no other image model is used automatically

#### Scenario: Selected text model becomes policy-blocked
- **WHEN** a previously selected text model is no longer permitted
- **THEN** text generation is blocked with `selected_model_unavailable`
- **AND** the user can select another currently allowed text model

### Requirement: Model responses do not expose credentials
The model-discovery APIs SHALL return public identifiers, display names, capabilities, readiness, and sanitized diagnostics only.

#### Scenario: Workbench loads model availability
- **WHEN** the server responds with text, image, or video model descriptors
- **THEN** the response excludes API keys, environment values, credential material, and private provider configuration
