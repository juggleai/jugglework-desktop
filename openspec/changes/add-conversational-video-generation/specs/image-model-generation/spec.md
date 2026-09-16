## ADDED Requirements

### Requirement: Per-model image generation modes
The desktop SHALL let members choose image as a custom model ID's exclusive model type, configure text-to-image, image-to-image, and multi-image-to-image through a mode multi-select, and preserve those capabilities across edits.

#### Scenario: Provider mixes text and image models
- **WHEN** a custom provider contains an ordinary text model and a separate image model
- **THEN** only the image model receives image-generation metadata and a generation-only image model is omitted from the session chat picker

#### Scenario: Member configures multiple image modes
- **WHEN** the member enables one or more image modes for a model
- **THEN** the model list displays each enabled mode and the saved model contains matching explicit capability flags

#### Scenario: Member creates an image model
- **WHEN** the member changes a new model from the default text type to image
- **THEN** text-to-image, image-to-image, and multi-image-to-image are all selected by default and text/video-only configuration fields are hidden

### Requirement: Provider-neutral configured image invocation
The image-generation extension SHALL discover configured ready image models and SHALL support text-to-image, image-to-image, and multi-image-to-image without silently ignoring reference images.

#### Scenario: Text-to-image uses the generations route
- **WHEN** a ready OpenAI-style model receives a text-to-image request
- **THEN** JuggleWork calls `/images/generations` with the configured provider base URL, credential, model ID, and prompt

#### Scenario: Single or multiple references use the edits route
- **WHEN** a ready model receives image-to-image or multi-image-to-image input
- **THEN** JuggleWork validates every workspace image and submits all references to `/images/edits`

#### Scenario: No compatible model exists
- **WHEN** no configured ready model supports the requested image mode
- **THEN** JuggleWork returns an explicit no-model result and does not fall back to text generation or ignore references

#### Scenario: Local model group lives in global OpenCode config
- **WHEN** a member configures an image model in the desktop global `opencode.jsonc` and no runtime provider patch duplicates it
- **THEN** image discovery merges global and runtime configuration and reports that local model

### Requirement: Secure image artifacts
Generated images SHALL be validated by MIME type, file signature, size, workspace containment, and atomic-write rules before being returned as workspace artifacts.

#### Scenario: Provider returns base64 image data
- **WHEN** a provider returns a valid base64 PNG, JPEG, or WebP image
- **THEN** JuggleWork validates and writes it under the current workspace `artifacts/` directory

#### Scenario: Provider returns an unsafe URL or malformed image
- **WHEN** the result URL is non-HTTPS or the bytes do not match an allowed image signature
- **THEN** JuggleWork rejects the result without publishing an artifact
