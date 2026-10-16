## Why

JuggleWork currently exposes general chat, automation, extensions, and code-review workbenches, but it does not provide a durable workspace for turning source material into episodic scripts, visual assets, storyboards, generated images, and generated video clips. Adding a native Toon Factory makes that workflow available without introducing a second provider configuration system or a visually separate embedded application.

## What Changes

- Add a “Toon Factory” entry immediately below Code Review in the navigation rail’s More menu, with the same pin and unpin behavior as Code Review.
- Add a workspace-scoped Toon Factory route and a retained React workbench that follows the existing JuggleWork shell, theme, sidebar, and accessibility patterns.
- Add file-backed Toon Factory projects, canvases, externalized text content, assets, episode records, workflow checkpoints, and adoption records inside the authorized workspace.
- Add a staged production workflow covering script development, reusable assets, directing and storyboards, image production, video production, review, adoption, and clip delivery.
- Use the connected and policy-allowed JuggleWork text-model catalog for structured text generation, and use the configured JuggleWork image- and video-generation runtimes for media work.
- Present explicit blocking errors when a required text, image, or video model is not configured or is no longer available; do not silently substitute a paid media model.
- Reuse JuggleWork’s persistent video-job lifecycle and safe artifact publication, while recording Toon Factory-specific provenance, authorization, review, and adoption state.
- Add targeted tests for navigation, routing, persistence, model availability, workflow transitions, and generation safety.
- Preserve the Toonflow MIT attribution for substantially reused protocols or implementation ideas.

## Capabilities

### New Capabilities
- `toon-factory-navigation`: Workspace-scoped discovery, routing, page retention, and pinning of the Toon Factory workbench.
- `toon-factory-projects`: File-backed project, canvas, episode, asset, text-content, revision, and portable workspace storage contracts.
- `toon-factory-workflow`: Staged script-to-delivery workflow, confirmation gates, dependency invalidation, candidate review, and adoption semantics.
- `toon-factory-models`: Text, image, and video model discovery, selection, availability validation, and explicit missing-model errors.
- `toon-factory-generation`: Text and media generation jobs, authorization, progress, cancellation, retry safety, provenance, artifact publication, and delivery records.

### Modified Capabilities
- `ui-theme-tokens`: Require the Toon Factory workbench to use the shared application rail, inset surface, theme tokens, and responsive sidebar conventions.

## Impact

- React application shell, workspace route parsing, navigation rail pin persistence, i18n, context projection, and a new Toon Factory domain UI.
- JuggleWork server routes, file repositories, runtime SQLite records, OpenCode session-based text execution, image extension integration, and video-generation service integration.
- Shared request/response and persisted schema types for projects, canvases, workflow state, generation requests, and jobs.
- A new React node-graph dependency is expected for the canvas; Toonflow’s Vue runtime, Electrobun shell, provider configuration, dynamic provider plugins, and dynamic node scripts are not imported.
- Project output remains constrained to authorized workspace paths and must not expose provider credentials or private configuration.
