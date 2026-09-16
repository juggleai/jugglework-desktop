## Purpose

Defines how JuggleWork discovers executable video-generation models from the providers configured for a workspace and selects a compatible model without guessing from model names.

## ADDED Requirements

### Requirement: Desktop-configured typed model groups
The desktop SHALL let a member select exactly one text, image, or video type for each model ID while creating or editing a local OpenAI-compatible model group, SHALL show only fields applicable to the selected type, and SHALL write normalized capability metadata only on the corresponding model.

#### Scenario: Member reviews configured models
- **WHEN** a custom model group contains one or more configured models
- **THEN** the desktop shows a model list containing each model ID and its text, text-to-video, and image-to-video capability labels

#### Scenario: Member adds a model
- **WHEN** the member clicks Add model below the list
- **THEN** the desktop opens a single-model editor below the list for model ID and display name, defaults the model type to text, and shows context/output limits, text protocol, and reasoning depth

#### Scenario: Member selects an image model
- **WHEN** the member selects image as the model type
- **THEN** the desktop hides text and video fields and shows a generation-mode multi-select with text-to-image, image-to-image, and multi-image-to-image all selected by default

#### Scenario: Member selects a video model
- **WHEN** the member selects video as the model type
- **THEN** the desktop hides text and image fields and shows video protocol, a mode multi-select with text-to-video and image-to-video both selected by default, maximum duration, and supported resolutions

#### Scenario: Member edits legacy mixed metadata
- **WHEN** an existing model contains multiple historical model-type metadata blocks
- **THEN** the editor resolves video before image before text and saving retains only the explicitly selected model type

#### Scenario: Provider mixes Chat and Responses text models
- **WHEN** one custom provider contains text models using both Chat Completions and Responses API
- **THEN** the desktop preserves each model's protocol independently, displays the protocol in the model list, and writes the matching OpenCode model-level provider adapter

#### Scenario: Provider mixes OpenAI and Ark V3 video models
- **WHEN** one custom provider contains video models using OpenAI asynchronous video routes and Volcengine Ark V3 task routes
- **THEN** the desktop preserves and displays each model's video protocol independently and model discovery selects the matching adapter

#### Scenario: Member selects supported video resolutions
- **WHEN** a member configures a video model's supported resolutions
- **THEN** the desktop provides a multi-select dropdown limited to 480P, 720P, 1080P, and 4K and persists the canonical `480p`, `720p`, `1080p`, and `4k` values

#### Scenario: Member configures reasoning depths for a text model
- **WHEN** a member enables text capability and selects one or more of none, low, medium, high, xhigh, max, and ultra
- **THEN** the desktop writes matching model variants and the session reasoning selector offers exactly those values

#### Scenario: Member makes no-reasoning selectable
- **WHEN** a member selects the `none` reasoning depth
- **THEN** the desktop writes an empty `none` variant and the session can explicitly disable deep reasoning without sending `reasoningEffort: "none"`

#### Scenario: Member leaves reasoning depths unconfigured
- **WHEN** a text model has no selected reasoning depths
- **THEN** the desktop writes no reasoning variants and treats the model as not supporting configurable reasoning depth

#### Scenario: Member edits or deletes a model
- **WHEN** the member selects edit or delete for one configured model
- **THEN** only that model's configuration is changed or removed and all other model definitions remain unchanged

#### Scenario: Member creates a text-to-video model group
- **WHEN** a member adds a custom model group containing a chat model and a text-to-video model
- **THEN** only the video model contains validated `mediaGeneration.textToVideo` metadata and the configured video output constraints

#### Scenario: Member edits an existing video model group
- **WHEN** a member opens and saves a local model group that already contains video capability metadata
- **THEN** the model list and single-model editor restore and preserve that model's limits and capability metadata instead of silently stripping it

#### Scenario: Runtime provider projection omits video metadata
- **WHEN** OpenCode's runtime provider list omits custom `mediaGeneration` fields that remain present in the raw global JSONC
- **THEN** the desktop uses the raw JSONC provider block for editing and continues to show the model as video-capable

#### Scenario: Runtime projection exposes a video-only output capability
- **WHEN** OpenCode reports a model with `capabilities.output.video=true` and `capabilities.output.text=false`
- **THEN** the desktop excludes that model from the session chat picker and does not retain or choose it as the default chat model

#### Scenario: Models have incompatible capability metadata
- **WHEN** an existing model group contains different video capability metadata for different models
- **THEN** the desktop restores the corresponding independent controls for every model and preserves the differences after save

### Requirement: Desktop credential readiness
Saving a local video model group with an API key SHALL store the credential in OpenCode authentication and in the JuggleWork user environment under the provider's declared credential key, without writing the credential into provider configuration.

#### Scenario: New video model group includes an API key
- **WHEN** a member saves a video-capable custom provider with a non-empty API key
- **THEN** the provider declares a valid non-reserved environment key, the environment store contains the credential under that key, and video model discovery can report the provider as credential-ready

#### Scenario: Existing key is left unchanged during edit
- **WHEN** a member edits a video model group and leaves the API key field blank
- **THEN** neither the OpenCode credential nor the mirrored environment credential is deleted or replaced

### Requirement: Normalize video-generation capabilities
The system SHALL represent text-to-video and image-to-video as explicit, independently queryable model capabilities, including provider-reported input and output constraints that JuggleWork can validate.

#### Scenario: Model supports both generation modes
- **WHEN** a configured model declares both text-to-video and image-to-video support
- **THEN** the system reports both modes and their validated constraints in the normalized model descriptor

#### Scenario: Output modality alone is insufficient
- **WHEN** a model only declares video as an output modality but has no executable video-generation capability and no registered adapter
- **THEN** the system does not expose that model as an executable video-generation model

### Requirement: List only executable models for automatic selection
The system SHALL consider a video model automatically selectable only when its provider is enabled and configured for the current workspace, its credentials are usable, its requested generation mode is supported, and JuggleWork has a registered adapter capable of invoking it.

#### Scenario: Ready model is available
- **WHEN** a configured provider exposes a model compatible with the requested generation mode and its adapter and credentials are ready
- **THEN** the model appears in the list of selectable video models

#### Scenario: Provider is configured but not executable
- **WHEN** a model advertises video capability but its credentials are missing or no compatible adapter is registered
- **THEN** the system excludes it from automatic selection and makes a non-secret diagnostic reason available to settings surfaces

### Requirement: Filter discovery by generation mode
The system SHALL allow callers to request models compatible with text-to-video or image-to-video and SHALL exclude models that cannot execute the requested mode.

#### Scenario: Image-to-video filter
- **WHEN** the caller requests image-to-video models
- **THEN** the result includes only ready models that accept a reference image for video generation

### Requirement: Report absence of a usable video model
The system SHALL return a stable `no_video_model_available` result when no configured model can execute the requested video-generation mode and SHALL NOT claim that a video was generated.

#### Scenario: No text-to-video provider is configured
- **WHEN** a user requests text-to-video generation and discovery returns no ready text-to-video model
- **THEN** the request ends without creating a provider job and the user is told that the configured providers currently contain no usable text-to-video model

#### Scenario: Image-to-video is unavailable but text-to-video exists
- **WHEN** a request contains a reference image and the workspace has ready text-to-video models but no ready image-to-video model
- **THEN** the system reports that image-to-video is unavailable and does not silently discard the image
