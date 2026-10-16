## 1. Navigation and shell

- [x] 1.1 Add localized Toon Factory labels, iconography, More-menu placement after Code Review, and stable multi-item pin persistence.
- [x] 1.2 Add workspace-scoped Toon Factory project routes, navigation callbacks, active-state handling, and route parsing tests.
- [x] 1.3 Add a lazy, retained Toon Factory page using the shared rail, inset surface, secondary-sidebar sizing, topbar, dark-theme tokens, and hidden-view suspension.
- [x] 1.4 Project Toon Factory into JuggleWork semantic context and cover navigation, retention, pin order, and shared-shell behavior with focused tests.

## 2. Shared schemas and safe project storage

- [x] 2.1 Define versioned shared types and validators for projects, episodes, workflow stages, nodes, typed handles, edges, viewports, model references, generation records, and delivery manifests.
- [x] 2.2 Implement workspace-safe project discovery and creation with project-relative directory validation and initial file layout.
- [x] 2.3 Implement atomic project, canvas, and external text reads and writes with content revisions, stale-write errors, schema-version checks, and graph validation.
- [x] 2.4 Add typed server routes and app client methods for project lists, project details, canvas content, text content, and project updates.
- [x] 2.5 Add server tests for traversal and symlink rejection, unsupported versions, revision conflicts, atomic persistence, invalid handles, and portable project reopening.

## 3. Workbench and workflow

- [x] 3.1 Add project creation/opening, project and episode selection, and empty/loading/error states to the secondary sidebar.
- [x] 3.2 Add the static node registry and canvas for text, asset, storyboard, image asset, video asset, image generation, and video generation nodes with typed edge validation.
- [x] 3.3 Add external text editing, debounced canvas persistence, save flushing, conflict presentation, and restoration of canvas viewport and selection.
- [x] 3.4 Implement the six production stages, detailed step records, explicit skip reasons, per-episode progress, and independent content approval, compute authorization, and result adoption state.
- [x] 3.5 Implement dependency tracking that marks affected downstream records stale without deleting previous versions or adoption history.
- [x] 3.6 Add workflow and UI tests for confirmation gates, stage progress, upstream invalidation, episode independence, and truthful delivery labels.

## 4. Model discovery and selection

- [x] 4.1 Reuse the connected text-model query and desktop-policy filters in a Toon Factory text-model picker.
- [x] 4.2 Add a server model facade and UI queries that expose ready image and eligible video models by generation mode without credential material.
- [x] 4.3 Persist project model references and revalidate them before every job without silently substituting image or video models.
- [x] 4.4 Add localized blocking states and settings actions for `no_text_model_available`, `no_image_model_available`, `no_video_model_available`, `video_submission_disabled`, and `selected_model_unavailable`.
- [x] 4.5 Add model discovery tests covering text capability, desktop restrictions, media mode support, missing credentials, disabled submission, model drift, and secret redaction.

## 5. Text generation

- [x] 5.1 Add persistent Toon Factory text-job records with request snapshots, selected model, structured-output schema, status, sanitized error, and result references.
- [x] 5.2 Implement server-owned temporary OpenCode session execution with explicit provider/model selection, terminal-state collection, cancellation handling, and stale-session cleanup.
- [x] 5.3 Add structured script, asset-plan, and storyboard generation actions that write validated results into versioned workflow records rather than approving them automatically.
- [x] 5.4 Add tests for successful structured output, model failure, malformed output, partial-output handling, temporary-session cleanup, and unmounted UI recovery.

## 6. Image and video generation

- [x] 6.1 Add exact generation-plan previews and scoped compute authorization for image and video batches.
- [x] 6.2 Integrate image jobs with the existing image extension and persist request, artifact, provenance, review, and adoption records.
- [x] 6.3 Integrate video jobs with the persistent media-generation service using stable client request IDs and expose progress, cancellation, terminal state, and `submission_unknown` reconciliation.
- [x] 6.4 Add media candidate galleries, preview, rejection, adoption, retry authorization, and non-destructive generation history.
- [x] 6.5 Add integration tests for idempotent video submission, restart recovery, cancellation limitations, safe artifact publication, review state, adoption, and retries that change approved scope.

## 7. Delivery, attribution, and validation

- [x] 7.1 Add per-episode delivery manifests that validate adopted relative artifact paths and report missing outputs without claiming full composition.
- [x] 7.2 Add project export/download affordances for manifests and validated clips while keeping a complete-film timeline and composition explicitly out of scope.
- [x] 7.3 Add Toonflow MIT attribution to the repository's third-party notice or equivalent distribution artifact for substantially reused material.
- [x] 7.4 Run focused app and server tests, typechecks, i18n coverage, and OpenSpec validation; resolve regressions and mark completed tasks accurately.
