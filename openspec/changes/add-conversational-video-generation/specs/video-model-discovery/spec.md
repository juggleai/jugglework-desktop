## Purpose

Defines how JuggleWork discovers executable video-generation models from the providers configured for a workspace and selects a compatible model without guessing from model names.

## ADDED Requirements

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
