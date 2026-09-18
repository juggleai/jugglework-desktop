## Context

See `proposal.md` for motivation and scope. JuggleWork currently obtains provider/model records from the OpenCode provider list, imports cloud provider metadata through a controlled allowlist, and projects a reduced model shape into the desktop picker. Model metadata already represents attachment and text/image modalities, but there is no normalized or executable video-generation capability.

Media generation already has one useful precedent: the OpenAI image-generation server extension resolves credentials server-side, invokes an external generation API, safely writes an artifact into the active workspace, and exposes the operation through extension actions. Video APIs add long-running provider jobs, polling, cancellation, large result downloads, process-restart recovery, and higher duplicate-charge risk. Workspace configuration is stored in the runtime database; session model overrides are currently renderer-local and partitioned by workspace.

## Goals / Non-Goals

**Goals:**

- Add a provider-neutral contract that can support materially different video APIs without exposing those differences to the agent or UI.
- Make capability discovery authoritative by combining declared model metadata, provider readiness, workspace visibility, and adapter availability.
- Persist generation lifecycle state so accepted jobs survive UI refreshes and server restarts.
- Reuse existing extension-action, image-attachment, workspace authorization, and artifact conventions where safe.
- Keep preference resolution deterministic and separate from chat-model preferences.
- Produce a first-provider MVP without preventing later adapters or managed-cloud providers.

**Non-Goals:**

- Routing video-generation models through the normal `session.prompt` LLM path.
- General video upload, chat-model video understanding, video editing, multi-image storyboards, audio generation, or local transcoding in the first release.
- A provider marketplace or automatic installation of missing video providers.
- A cross-provider lowest-price or highest-quality optimization algorithm; fallback is capability and preference based.

## Decisions

### 1. Add a provider-neutral Media Generation server domain

The server will own a `MediaGenerationService` that resolves models, validates requests, creates jobs, delegates provider operations, and publishes artifacts. It will be exposed initially through a `media-generation` extension with actions for model listing, generation, job status, cancellation, and defaults.

This follows the current image-generation extension's credential and workspace boundary while avoiding provider-specific actions in the conversation protocol. The existing extension list/call HTTP routes and agent affordance bridge can remain generic.

**Alternative considered:** teach each chat model to call provider-specific APIs directly. Rejected because credentials and binary downloads would leak into model/tool context, contracts would differ per provider, and long-running jobs could not be reliably recovered.

**Alternative considered:** send the request through `session.prompt` using a video model as if it were a chat model. Rejected because most video APIs use submit/poll/download semantics and do not implement the chat completion contract.

### 2. Require explicit executable capability metadata

Shared model projections will gain a validated `mediaGeneration` capability with independent `textToVideo` and `imageToVideo` flags plus supported input/output constraints. A model is `ready` only when its provider is connected and allowed in the workspace, credentials pass readiness checks, the requested mode is declared, and an adapter accepts the model.

Cloud provider metadata will pass the field through a controlled allowlist and metadata-version migration. Custom compatible-provider configuration will permit the same constrained structure. Picker options will retain normalized capabilities rather than discarding them.

Output modality alone and model-name matching are insufficient. This avoids showing models that advertise video conceptually but cannot be invoked by JuggleWork.

**Alternative considered:** maintain a hard-coded list of known Sora/Veo/Kling model names. Rejected because aliases and API compatibility change, custom providers cannot be represented safely, and a recognized name does not guarantee credentials or an implemented endpoint.

### 3. Use a persistent asynchronous job state machine

Accepted requests will create a runtime-database record before provider submission. The record carries the workspace/session identity, selected model, mode, redacted options, idempotency identity, provider job ID, status, progress, artifact metadata, and sanitized terminal error.

The canonical lifecycle is:

```text
queued -> submitting -> submitted -> running -> downloading -> completed
                       \-------------------------------> failed
queued/submitting/submitted/running -> cancel_requested -> cancelled
```

A background reconciler will poll active jobs with bounded backoff and recover incomplete jobs on startup. Adapters may translate verified webhook callbacks to the same state transitions in future. State updates and completion handling must be idempotent.

**Alternative considered:** hold the original extension HTTP request until the video completes. Rejected because provider work can exceed normal tool/request timeouts, cancellation is unreliable, and server restart loses progress.

### 4. Define a narrow provider adapter contract

Each adapter will implement model matching, submit, status, optional cancel, and result acquisition. Provider-specific duration, aspect ratio, resolution, image upload, and error semantics are normalized at this boundary. The first adapter proves text-to-video; image-to-video is enabled only when both metadata and adapter behavior support it. A second adapter should be added before declaring the contract stable.

The adapter receives a resolved credential reference from the existing provider/environment infrastructure, never from the renderer request. It returns sanitized statuses and either a guarded result stream or a download descriptor that the service validates.

**Alternative considered:** a single switch statement in the extension action. Rejected because provider polling and result acquisition differences would quickly couple UI, validation, and lifecycle logic.

### 5. Materialize reference images as dedicated generation input

The composer continues to accept and preview images using `ComposerAttachment`. For an I2V request, the image is materialized into the workspace inbox and the server receives a workspace-relative source path plus MIME type. The service resolves the path against the active workspace, rejects traversal and unsupported content, enforces adapter limits, and stages/uploads the image as required.

The general chat attachment MIME policy will not be expanded to `video/*`. Generated video artifacts are displayable outputs, not automatically readable chat inputs.

**Alternative considered:** send a base64 image through the agent's tool arguments. Rejected because it inflates transcripts/tool payloads and risks durable leakage of source media.

### 6. Store independent defaults with explicit precedence

Workspace configuration in the runtime database will gain `media.defaultVideoModel`. A separate session media preference store, partitioned by workspace and session, will mirror the existing renderer model override pattern for the first release. It uses a new storage key and contains only `{providerID, modelID}` plus optional mode intent. It can later migrate to server session metadata without changing resolution semantics.

Resolution order is explicit request, session, workspace, optional user-wide default, and stable first compatible model. Every candidate is revalidated for the requested mode at execution time; stale choices are skipped with sanitized diagnostics.

**Alternative considered:** reuse `defaultModel` and session chat overrides. Rejected because generation providers have different costs and capabilities and often are not chat models.

### 7. Write artifacts atomically and render them as video-specific outputs

Completed results are downloaded to a temporary child path under the workspace, bounded by configured byte/time limits, checked for approved MIME and file signatures, and renamed to `artifacts/<slug>-<job-id>.<ext>` only after validation succeeds. The artifact descriptor includes relative path, MIME, bytes, provider/model, and available duration/resolution metadata.

The transcript will render a video job/artifact component with status, cancellation, retry, `<video controls preload="metadata">`, and open/download controls. Provider URLs are never rendered or persisted.

**Alternative considered:** stream the provider's signed result URL directly into the player. Rejected because URLs expire, can disclose provider information, and do not produce a durable workspace artifact.

### 8. Enforce idempotency, redaction, and workspace policies centrally

The generation service will deduplicate accepted requests using a client request identity scoped to workspace/session. It will cap concurrent jobs, duration, resolution, and output bytes using workspace policy before submission. Normal logs and job records exclude secrets, authorization headers, signed URLs, and base64 media. Provider safety refusals and rate limits become stable sanitized error codes with retryability metadata.

This control remains server-side so agent and direct UI entry points behave identically.

### 9. Configure one model type inside desktop custom model groups

The existing Custom provider form replaces its free-form model textarea with a structured model list followed by an Add model action. Adding or editing one row opens a single-model editor below the list with model ID and display name, followed by one mutually exclusive model-type choice: text, image, or video. Text is the default. Text models configure context/output limits, Chat Completions or Responses API, and supported reasoning depths. Image models configure an OpenAI-style generation-mode multi-select for text-to-image, image-to-image, and multi-image-to-image, with all modes selected by default. Video models configure their API protocol, a text-to-video/image-to-video mode multi-select with both modes selected by default, maximum duration, and supported resolutions. Saving writes only the selected type's metadata, so generation-only models cannot accidentally remain chat models and unrelated fields are not shown. Legacy mixed metadata is resolved deterministically for editing: video first, then image, otherwise text. One provider can still contain heterogeneous model IDs, with each ID selecting its own type.

Each video-capable model also selects its video API protocol independently. `openai` uses asynchronous `/videos` routes. `volcengine-ark-v3` uses Ark V3 `POST /contents/generations/tasks` and `GET /contents/generations/tasks/{id}`, submits image references as validated base64 data URLs, maps Ark task states to the provider-neutral job states, and downloads the short-lived `content.video_url` through the existing guarded artifact publisher. Ark V3 does not expose a documented task-cancellation endpoint, so the adapter does not claim provider-side cancellation.

Supported video resolutions use the Ark V3 canonical preset vocabulary: `480p`, `720p`, `1080p`, and `4k`. The model editor presents these as a fixed multi-select dropdown (`480P`, `720P`, `1080P`, `4K`) so invalid free-form dimensions cannot enter capability metadata. Ark V3 receives the selected preset directly. The OpenAI adapter maps presets to documented/common landscape dimensions (`854x480`, `1280x720`, `1920x1080`, `3840x2160`) while preserving explicitly supplied pixel dimensions for backwards-compatible requests.

Editing a local model group must round-trip each model's independent limits and `mediaGeneration` metadata plus the provider's declared credential environment key instead of reducing models back to `{id, name}`. The provider keeps an explicit non-reserved environment key derived from the provider ID by default, and the desktop mirrors a newly entered API key into the JuggleWork user environment store under that key in addition to OpenCode's auth store. This allows normal chat authentication and server-side video adapters to share one user action without writing the secret into `opencode.jsonc`.

The edit round trip reads the raw global OpenCode JSONC provider block as its source of truth and enriches it with runtime provider details only where safe. OpenCode's `provider.list()` response is intentionally normalized and does not retain JuggleWork-specific `mediaGeneration` metadata, so using it as the edit source would silently turn saved video models back into text defaults.

Text-capable models can explicitly declare supported reasoning depths from `none`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. The single-model editor exposes a fixed multi-select and writes each selected key to OpenCode `variants`; effort values receive a matching `reasoningEffort`, while `none` is an empty variant that lets a session explicitly disable deep reasoning without sending an unsupported `reasoningEffort: "none"` value. An empty selection writes no variants and means the model does not support a reasoning-depth selector. No reasoning support is inferred from the model ID, because gateways can expose the same named model with different capabilities.

Conversely, session model selection consumes OpenCode's runtime projection, where modalities are represented as boolean `capabilities.output` flags. Chat filtering therefore recognizes both raw `modalities.output` arrays and normalized `capabilities.output.video/text` flags, excludes video-only models from the picker, and repairs remembered/default chat selections that point at a video-only model.

Local media-model discovery uses the same effective provider configuration as OpenCode: global `opencode.jsonc` merged with workspace runtime provider patches. Reading only the runtime database would hide member-authored local image/video model groups and cause agents to miss configured models even though the chat engine can see them.

Configured provider/model names are never skills. Agent steering routes image/video requests through local extension discovery and execution, permits the skill loader only for exact system-advertised skill names, and explicitly forbids synthesizing names such as `doubao-image-gen` from provider branding. This prevents a configured model from being mistaken for an unavailable OpenCode skill.

Because text models can ignore a two-step generic extension protocol in favor of more salient Cloud or shell tools, the OpenCode plugin also exposes direct `jugglework_image_*` and `jugglework_video_*` tools. Their names and descriptions match the user's intent and internally route to the same local extension actions, making configured media generation the mechanically obvious first choice rather than relying only on prompt steering.

### 10. Add an explicit image-generation composer mode

The composer add menu includes Image generation immediately below Draw when the local image extension discovers at least one ready `text-to-image` model in the active workspace. The entry is omitted while discovery is loading, after discovery fails, and whenever no configured model is executable. Enabling it adds a compact, horizontally scrollable parameter strip above the prompt editor with a removable mode chip, explicit image-model picker, normalized aspect-ratio picker, and provider-neutral style picker. The ordinary chat-model picker remains unchanged because image-only models do not implement the chat completion contract.

Submission retains the member's visible prompt as the user turn and adds structured image-generation options plus a resolved tool instruction. The resolved instruction is merged into the per-request system context rather than replacing the visible user part, so the transcript stays faithful while the ordinary chat model is required to call the image tool. That instruction locks the provider/model, maps `1:1`, `3:2`, and `2:3` to normalized pixel sizes, expresses style as a prompt constraint rather than a provider-specific API field, and calls the direct `jugglework_image_generate` tool. This keeps direct send, queue, and steering semantics aligned while avoiding unsupported `style` fields on OpenAI-compatible image endpoints.

**Alternative considered:** put image-only models into the existing chat model picker. Rejected because selecting a generation endpoint as the session LLM would send it an incompatible chat request and would couple image parameters to chat-model state.

**Alternative considered:** call the image extension directly from the renderer and skip the session. Rejected for this increment because it would create an artifact without a corresponding conversational turn or agent summary; the direct agent tool preserves transcript and artifact behavior while honoring explicit UI selections.

**Alternative considered:** make members edit raw JSON and duplicate the API key under Settings → Environment. Rejected because it makes the normal model-group form destructive on subsequent edits and leaves a configured video model in `missing_credentials` after an apparently successful connection.

### 11. Add an explicit video-generation composer mode

The composer add menu includes Video generation immediately below Image generation only when submission is enabled and workspace-scoped discovery returns at least one ready `text-to-video` model. A disabled rollout flag, loading, discovery failure, missing credentials, unsupported adapters, and an empty ready-model list all omit the entry rather than presenting a dead action. Image and video generation are mutually exclusive composer modes, while the ordinary chat-model picker remains unchanged.

Enabling video generation adds a compact strip above the prompt editor with a removable mode chip, an explicit model picker, and a combined settings popover. The popover stays at a compact 368-pixel desktop width (bounded by the viewport), uses a four-column ratio grid, and follows the desktop design with Auto, `3:4`, `4:3`, `9:16`, `16:9`, `1:1`, and `21:9` ratios plus a discrete 4–15 second duration control defaulting to 10 seconds. The desktop settings trigger and changing duration readout reserve stable widths, so selecting a differently sized ratio label or moving between one- and two-digit durations does not move the open popover. When the window narrows below the compact breakpoint, the inline settings label collapses to an overflow icon. Opening the overflow first reveals a compact current-value row such as `Auto · 10s`; activating that row opens the viewport-contained ratio/duration popover. Non-auto ratios map to deterministic dimensions with a 720-pixel short-edge baseline; Auto omits resolution so the provider chooses it.

Submission preserves the member's text as the visible user turn and injects a model-locked system instruction for the direct `jugglework_video_generate` tool. The instruction fixes text-to-video mode, provider/model, duration, and optional resolution; requires exactly one paid submission; and keeps the direct tool active while it observes the persisted job without automatically resubmitting failures. The structured video options remain on queued drafts so direct send, queue, and steering use the same parameters.

The direct video tool owns terminal waiting after its single submission instead of relying on the language model to issue shell sleeps or remember a later poll. It returns only after completion, failure, cancellation, or a bounded timeout, allowing the same assistant turn to summarize the result. Independently, the transcript video card polls non-terminal jobs so UI status continues after an interrupted model turn. A terminal transition creates an in-app notification-center entry, an immediate success/error toast, and a preference-respecting desktop notification when the app is in the background.

Completed cards load the workspace-confined artifact through the authenticated file endpoint and render an inline metadata-preloaded video player. The card provides download and expanded-dialog playback controls; it never renders the provider result URL.

**Alternative considered:** submit the video job directly from the renderer. Rejected because it would bypass the conversation turn, agent summary, existing tool transcript, and queued/steered draft semantics.

## Risks / Trade-offs

- **[Provider metadata may be incomplete or stale]** → Require an adapter match and live readiness validation in addition to catalog metadata; expose diagnostic states without making them selectable.
- **[Video jobs can be costly and retries may duplicate charges]** → Persist before submit, use idempotency keys where providers support them, reconcile ambiguous submissions, and require explicit retry after non-retryable failures.
- **[Server restarts during submit can leave an ambiguous provider job]** → Store submission identity before the call, capture provider IDs immediately, and make adapter reconciliation part of its contract where supported.
- **[Large video downloads consume disk and bandwidth]** → Apply workspace quotas, concurrent-download limits, streaming byte caps, temporary-file cleanup, and metadata-only preload in the UI.
- **[Session defaults are initially device-local]** → Scope keys by workspace/session and document the limitation; preserve a migration path to server session metadata.
- **[Provider cancellation may be best-effort]** → Represent `cancel_requested` distinctly and reconcile a provider-completed race rather than falsely claiming immediate cancellation.
- **[Reference images are sent to an external provider]** → Show the selected provider before submission, validate only one image in the first release, and delete staging material according to retention policy.
- **[Adding model metadata may affect existing provider reconciliation]** → Version the metadata projection and add migration/regression tests around cloud and custom providers.

## Migration Plan

1. Add shared capability types and runtime validation while treating missing `mediaGeneration` as unsupported; existing providers remain unchanged.
2. Extend cloud/custom provider projections behind the controlled metadata version and register the first adapter without exposing UI generation until discovery tests pass.
3. Add the runtime job table/repository and worker. The migration is additive and can coexist with older workspaces.
4. Register read-only model/status actions, then generation/status/cancel actions behind a feature flag.
5. Add artifact rendering and text-to-video UI; canary with one provider and bounded quotas.
6. Add I2V materialization and capability filtering after text-to-video lifecycle metrics are stable.
7. Add workspace/session defaults and then a second adapter before removing the feature flag.

Rollback disables new generation entry points and worker submission while leaving status/read access available for already submitted jobs. Active jobs are reconciled to a terminal state and completed artifacts remain ordinary workspace files. The additive database schema is retained during rollback to avoid losing provider job identities.

## Open Questions

- Which configured provider and exact API/model should be the first production adapter? The adapter contract and capability requirements are fixed, but credentials, endpoint limits, and rollout ownership depend on the selected provider.
- What default workspace quota values should apply to duration, resolution, concurrent jobs, and retained artifact bytes? These are policy defaults and do not change the behavior contract.
