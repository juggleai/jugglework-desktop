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

### Requirement: Composer image-generation mode
The desktop composer SHALL expose image generation as an explicit add-menu mode, SHALL discover ready text-to-image models in the active workspace, and SHALL carry the selected model and normalized generation parameters into the image-generation tool request without changing the normal chat-model selection.

#### Scenario: Ready image model enables the menu entry
- **WHEN** the active workspace has at least one configured, credential-ready text-to-image model
- **THEN** the add menu enables Image generation and activating it shows model, aspect-ratio, and style controls above the prompt editor

#### Scenario: No ready image model hides the menu entry
- **WHEN** image-model discovery is loading, fails, or returns no ready text-to-image models
- **THEN** the add menu does not display the Image generation entry

#### Scenario: Selected parameters are submitted deterministically
- **WHEN** a member submits a prompt while Image generation is active
- **THEN** the generated request names the selected provider and model, maps the selected aspect ratio to a normalized size, applies the selected style instruction, and routes generation through `jugglework_image_generate`

#### Scenario: Member exits image generation
- **WHEN** the member closes the Image generation chip
- **THEN** the parameter controls disappear and subsequent prompts resume the ordinary chat submission path

### Requirement: Generated image result presentation
The desktop SHALL present a successfully generated workspace image as a persistent inline transcript preview and SHALL let the member download it or save a copy to a chosen location.

#### Scenario: Image generation completes successfully
- **WHEN** `jugglework_image_generate` returns a validated image artifact
- **THEN** the completed task displays a thumbnail with the generated filename and model, clicking the thumbnail opens a larger preview, and the image also appears in the task artifact list

#### Scenario: Member exports a generated image
- **WHEN** the member chooses Download or Save as from the generated-image result
- **THEN** the desktop downloads the original artifact bytes or opens a native save dialog and writes an identical copy to the selected location

#### Scenario: Persisted artifact can no longer be loaded
- **WHEN** a transcript references a generated image that is missing or unreadable
- **THEN** the result shows a bounded load error without breaking the rest of the conversation
