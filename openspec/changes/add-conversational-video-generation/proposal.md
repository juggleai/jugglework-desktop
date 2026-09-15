## Why

JuggleWork users can currently ask for media in a conversation, but the app cannot discover and invoke configured video-generation models or return a playable video artifact. Adding a provider-neutral video workflow makes text-to-video and image-to-video generation available directly in the conversation while preserving workspace isolation, explicit model selection, and honest failure when no capable model is configured.

## What Changes

- Add normalized discovery of text-to-video and image-to-video capabilities across configured, enabled model providers.
- Add a provider-neutral asynchronous video-generation workflow with persistent jobs, polling, cancellation, recovery, and workspace artifact output.
- Support text prompts and an optional single reference image supplied through the existing composer attachment flow.
- Add independent default video-model preferences at workspace and session scope, including deterministic fallback when a preferred model is unavailable or incompatible.
- Expose video model discovery, generation, status, cancellation, and preference operations to the conversation agent and direct UI controls.
- Render generation progress, failures, and completed playable/downloadable video artifacts in the conversation.
- Return an explicit no-model result rather than pretending to generate when no configured provider has a usable video model.
- Keep video generation separate from normal chat-model prompting and from general video-understanding/upload support.

## Capabilities

### New Capabilities

- `video-model-discovery`: Discover configured and executable video-generation models, represent their T2V/I2V constraints, and resolve explicit or default model choices.
- `conversational-video-generation`: Create and manage text-to-video and image-to-video jobs from a conversation and publish secure workspace video artifacts with user-visible progress.
- `video-model-preferences`: Configure and apply independent workspace-level and session-level default video models.

### Modified Capabilities

None.

## Impact

- Desktop provider catalog and model capability projections.
- Cloud-managed and custom provider model metadata validation and configuration.
- JuggleWork server extension actions, provider adapters, runtime database migrations, background job processing, and artifact storage.
- Composer image attachment materialization, session transcript rendering, settings, and model picker UI.
- Workspace configuration and local session preference storage.
- Security, privacy, quota, audit, and test coverage for long-running paid media-generation requests.
