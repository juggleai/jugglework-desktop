## 1. Capability Schema and Provider Discovery

- [x] 1.1 Add shared, runtime-validated media-generation capability types for T2V, I2V, image constraints, output MIME types, durations, and resolutions.
- [x] 1.2 Extend cloud provider metadata allowlisting/version migration and custom provider model configuration to preserve validated media-generation metadata.
- [x] 1.3 Project normalized media capabilities into desktop model options without changing existing chat-model selection behavior.
- [x] 1.4 Implement workspace-aware video model discovery that combines provider connection state, credential readiness, mode compatibility, and registered adapter support.
- [x] 1.5 Add discovery tests for ready, missing-credential, unsupported-adapter, workspace-hidden, T2V-only, I2V-only, and no-model results.

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
