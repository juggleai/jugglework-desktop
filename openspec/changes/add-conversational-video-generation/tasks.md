## 1. Capability Schema and Provider Discovery

- [x] 1.1 Add shared, runtime-validated media-generation capability types for T2V, I2V, image constraints, output MIME types, durations, and resolutions.
- [x] 1.2 Extend cloud provider metadata allowlisting/version migration and custom provider model configuration to preserve validated media-generation metadata.
- [x] 1.3 Project normalized media capabilities into desktop model options without changing existing chat-model selection behavior.
- [x] 1.4 Implement workspace-aware video model discovery that combines provider connection state, credential readiness, mode compatibility, and registered adapter support.
- [x] 1.5 Add discovery tests for ready, missing-credential, unsupported-adapter, workspace-hidden, T2V-only, I2V-only, and no-model results.
- [x] 1.6 Add per-model desktop custom-model-group controls for chat/T2V/I2V capabilities and normalized input/output constraints.
- [x] 1.7 Preserve heterogeneous per-model video metadata and provider credential environment declarations across local model-group edits.
- [x] 1.8 Mirror newly entered custom-provider credentials into the JuggleWork environment key used by video adapter readiness, and add focused persistence tests.
- [x] 1.9 Replace the custom provider model textarea with a configured-model list and add/edit/delete single-model editor.
- [x] 1.10 Store and round-trip context/output limits per model while preserving existing model groups.
- [x] 1.11 Add per-model Chat Completions/Responses protocol selection, model-level adapter persistence, list labels, and round-trip tests.
- [x] 1.12 Add per-model OpenAI/Volcengine Ark V3 video protocol selection, metadata persistence, and list labels.
- [x] 1.13 Replace free-form video resolutions with the Ark-defined 480P/720P/1080P/4K multi-select and normalize adapter payloads.
- [x] 1.14 Read local custom-provider edits from raw JSONC so runtime provider projection cannot strip video metadata.
- [x] 1.15 Exclude runtime-normalized video-only models from the session picker and chat default resolution.
- [x] 1.16 Apply the shared video-only filter to both the compact composer picker and full model picker.
- [x] 1.17 Add per-text-model none/low/medium/high/xhigh/max/ultra reasoning-depth multi-select, explicit variant persistence, and round-trip tests.
- [x] 1.18 Add per-model text-to-image, image-to-image, and multi-image-to-image controls, metadata round-trip, list labels, and chat-picker filtering.
- [x] 1.19 Replace mixed capability switches with one text/image/video model-type selector and type-specific text fields or image/video mode multi-selects.

## 2. Persistent Generation Jobs

- [x] 2.1 Add an additive runtime database migration and repository for video job identity, workspace/session scope, selected model, redacted options, provider job ID, status, progress, artifact metadata, and sanitized errors.
- [x] 2.2 Implement validated job state transitions, terminal-state handling, and idempotent request lookup to prevent duplicate paid submissions.
- [x] 2.3 Implement a background reconciler with bounded polling backoff, startup recovery, cancellation reconciliation, and temporary-file cleanup.
- [x] 2.4 Add repository and worker tests for retries, cancellation races, ambiguous submission, restart recovery, and idempotent completion.

## 3. Provider-Neutral Service and First Adapter

- [x] 3.1 Define the video adapter contract for model matching, submit, status, optional cancellation, and guarded result acquisition.
- [x] 3.2 Select the first production adapter from an actually configured provider, document its supported models and limits, and map its credentials through existing server-side provider/environment infrastructure.
- [x] 3.3 Implement the first adapter's text-to-video submit, poll, cancel when available, error normalization, and result retrieval flows.
- [x] 3.4 Implement `MediaGenerationService` request validation, model resolution, workspace policy checks, job creation, adapter dispatch, and sanitized errors.
- [x] 3.5 Add adapter contract tests and mocked first-provider tests for success, timeout, rate limit, safety refusal, malformed responses, and credential failure.
- [x] 3.6 Implement and test the Volcengine Ark V3 create/query/result adapter for T2V and base64 I2V.
- [x] 3.7 Upgrade the image extension to discover configured OpenAI-style models, invoke generation/edit routes, validate reference images, and securely publish image artifacts.
- [x] 3.8 Steer configured media generation through local extension actions and forbid treating provider/model aliases as skills or silently substituting handcrafted artifacts.
- [x] 3.9 Expose direct image/video model-list and generation tools so agents do not need to infer the generic two-step extension protocol.
- [x] 3.10 Keep the complete asynchronous video lifecycle on direct local tools for model discovery, submission, polling, and cancellation before any Cloud search or handcrafted fallback.
- [x] 3.11 Stop after a failed video submission, forbid direct provider/credential diagnostics, and preserve the session identifier in persisted jobs.

## 4. Extension Actions and Agent Integration

- [x] 4.1 Register provider-neutral `media-generation` actions for status, video model listing, generation, job lookup, and cancellation in the existing extension dispatcher.
- [x] 4.2 Define strict action input/output schemas including prompt, mode, explicit model, source image path, generation options, filename, and idempotency identity.
- [x] 4.3 Update agent-facing action descriptions so the agent discovers models before generation, reports `no_video_model_available` honestly, and never silently ignores an incompatible reference image.
- [x] 4.4 Add server route and affordance integration tests covering action discovery, workspace context propagation, authorization, and stable error codes.

## 5. Secure Artifact Output

- [x] 5.1 Implement workspace-confined temporary and final output path handling with sanitized unique names under `artifacts/`.
- [x] 5.2 Stream provider results with HTTPS/redirect controls, byte and timeout limits, approved MIME and file-signature validation, and atomic final publication.
- [x] 5.3 Return a normalized video artifact descriptor with workspace-relative path, MIME type, bytes, provider/model, and available duration/resolution metadata.
- [x] 5.4 Add security tests for traversal attempts, oversized downloads, MIME spoofing, partial downloads, signed URL redaction, and cross-workspace access.

## 6. Text-to-Video Conversation Experience

- [x] 6.1 Add a conversation/direct-UI entry point that resolves a model and creates T2V jobs without routing the video model through normal chat prompting.
- [x] 6.2 Add a transcript video-job component for queued, running, cancel-requested, cancelled, failed, and completed states.
- [x] 6.3 Add playback with metadata-only preload plus artifact open/download controls and selected provider/model details.
- [x] 6.4 Implement cancel and explicit retry interactions while preserving idempotency and preventing automatic duplicate charges.
- [ ] 6.5 Add UI tests for no-model feedback, progress updates, sanitized failures, cancellation, retry, and completed video playback.

## 7. Image-to-Video Input

- [x] 7.1 Add a dedicated generation-source attachment flow that materializes one composer image into the authorized workspace and passes only its relative path and MIME type to the server.
- [x] 7.2 Validate image existence, workspace confinement, MIME/file signature, size, count, and selected adapter constraints before submission.
- [x] 7.3 Extend the first provider adapter with I2V only if its model and API support it; otherwise add a configured I2V-capable adapter using the same contract.
- [x] 7.4 Keep general `video/*` chat attachments unsupported unless a chat model independently declares validated video-input support.
- [ ] 7.5 Add end-to-end tests proving the reference image is used, incompatible models fall back or fail visibly, and temporary image staging follows retention policy.

## 8. Workspace and Session Video Defaults

- [x] 8.1 Extend workspace runtime configuration and routes with an independent `media.defaultVideoModel` value and authorization checks.
- [x] 8.2 Add a workspace-and-session-scoped local preference store for session video model overrides using a key separate from chat model preferences.
- [x] 8.3 Implement deterministic resolution in the order explicit request, session, workspace, optional user default, then stable first compatible model, with runtime validation and fallback diagnostics.
- [ ] 8.4 Add settings and session UI to set, inspect, and clear video defaults while showing only ready compatible models.
- [x] 8.5 Add tests for preference isolation, precedence, stale/disconnected defaults, mode incompatibility, clearing overrides, and chat-model independence.

## 9. Policy, Privacy, and Rollout

- [x] 9.1 Add configurable workspace limits for concurrent jobs, duration, resolution, output bytes, and retained temporary media, with conservative rollout defaults.
- [x] 9.2 Add structured audit events for workspace/session, model, mode, specifications, state, artifact metadata, and provider-reported usage without credentials, signed URLs, or encoded media.
- [x] 9.3 Add redaction regression tests covering normal logs, job records, action responses, transcript content, and workspace preference storage.
- [x] 9.4 Gate generation submission behind a feature flag while leaving safe job status reconciliation available during rollback.
- [ ] 9.5 Run focused server, desktop, database migration, extension action, and UI tests; manually canary one T2V and one I2V flow against configured providers before enabling the feature broadly.

## 10. Composer Image Generation

- [x] 10.1 Discover credential-ready text-to-image models for the active workspace and hide the add-menu entry when none are available.
- [x] 10.2 Add a removable image-generation mode strip above the prompt editor with model, aspect-ratio, and style selectors.
- [x] 10.3 Preserve the ordinary chat model while carrying the explicit image provider/model and normalized parameters into `jugglework_image_generate`.
- [x] 10.4 Add focused parsing, parameter mapping, deterministic instruction, visibility-state, and composer integration tests.
- [x] 10.5 Render completed image artifacts inline with click-to-preview, download, native Save as, artifact-list integration, and focused parsing tests.
- [ ] 10.6 Manually verify image generation with at least one configured provider and validate generated artifact rendering on macOS and Windows.
