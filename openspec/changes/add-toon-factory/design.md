## Context

JuggleWork Desktop is a React application backed by the JuggleWork local server and OpenCode runtime. Its primary application destinations are parsed from workspace-scoped URLs, rendered inside a shared navigation rail and inset shell, and retained selectively to preserve expensive or draft UI state. Text models come from the connected OpenCode provider catalog, image generation is exposed by the `openai-image-generation` extension, and video generation already has a persistent SQLite job service with idempotent submission and safe workspace artifact publication.

Toonflow is a Vue/Electrobun application whose post-creation experience is a file-backed node canvas, document editor, media nodes, and skill-driven production workflow. Directly embedding it would introduce a second UI framework, provider configuration system, local server, and desktop runtime. This change instead ports the stable domain concepts into JuggleWork and keeps JuggleWork as the authority for workspace access, models, credentials, tasks, and visual design.

## Goals / Non-Goals

**Goals:**

- Add a native, pinnable Toon Factory destination below Code Review in the More menu.
- Support multiple portable Toon Factory projects inside an authorized JuggleWork workspace.
- Preserve the useful Toonflow concepts: typed nodes and ports, file-backed canvases, external text content, staged production, explicit approval gates, media candidates, and adoption records.
- Use only models currently connected and permitted in JuggleWork, with actionable missing-model errors.
- Reuse JuggleWork text-session execution, image adapters, video jobs, workspace path checks, and theme/layout primitives.
- Make interrupted work recoverable and keep generation provenance separate from the currently mounted component.

**Non-Goals:**

- Embedding the Toonflow Vue application or Electrobun runtime.
- Importing Toonflow provider credentials, dynamic TypeScript providers, or dynamic script nodes.
- Delivering audio generation, the 3D director, mobile linking, or remote Toonflow collaboration in the first implementation.
- Claiming a complete film export pipeline before a real timeline, composition, subtitle, and audio-mixing implementation exists.
- Automatically opening arbitrary Toonflow projects without an explicit compatibility/import layer.

## Decisions

### Build a native React workbench instead of embedding Toonflow

The Toon Factory surface will be implemented as a React domain under the existing workspace router. It will reuse `AppNavigationRail`, `AppInsetSurface`, theme tokens, i18n, and accessibility conventions. Its project index uses a focused inspiration composer and responsive project cards; an opened project uses a full-surface canvas with floating workspace controls and a dockable assistant rather than a permanent project sidebar. A native React node canvas with a data model compatible with nodes, edges, handles, and viewport state backs the workspace.

Embedding Toonflow in an iframe or shipping Vue alongside React was rejected because it would duplicate provider settings, routing, design systems, accessibility behavior, and desktop/server lifecycle. A webview boundary would also make workspace authorization, model policy, job state, and theme synchronization harder to reason about.

### Use a creation home and spatial project workspace

The project index presents a large inspiration composer, explicit workspace-relative project location, current text model, and project cards. The initial idea is persisted as a recoverable, scope-keyed initialization operation and becomes the first episode's source text rather than being discarded after project creation. Initialization uses stable IDs and can reconcile uncertain client responses without replacing existing episodes or duplicating canvas content.

An opened project dedicates the inset surface to a dotted node canvas. Project and episode controls live in a floating top toolbar; node creation and canvas controls live near the bottom; workflow, generation, text editing, and delivery remain in a dockable right-side creation assistant. Narrow layouts present the assistant as a bottom sheet. Controls without a real implementation are disabled and described rather than presented as working actions.

### Store portable project truth in workspace files

Each project will live under a user-selected directory inside the current authorized workspace. `toon-project.json` stores versioned project metadata and selected model references; canvases live in `canvases/`; long text is externalized under `content/nodes/`; generated and imported media live under project-controlled asset directories; generation manifests and exports remain project-relative.

The server will enforce normalized workspace-relative paths, reject traversal and unsafe symlink escapes, and publish writes atomically. Reads will return content revisions and writes may include expected revisions so external edits produce conflicts rather than silent overwrites. Runtime SQLite may index jobs and recovery state, but it will not be the only source of project content.

An app-global project database was rejected because it would make projects less portable and would conflict with JuggleWork’s existing workspace/file model.

### Model the workflow as explicit state, not only canvas layout or chat prose

The UI exposes six macro stages: content and script, assets, directing and storyboard, images, videos, and adoption/delivery. Detailed episode steps can be represented within those stages. Records distinguish draft, pending confirmation, approved, queued, running, awaiting review, adopted, failed, cancelled, stale, and skipped states.

Content approval, compute authorization, and result adoption are stored separately. Changing an approved upstream script or adopted asset marks dependent outputs stale or pending review without deleting earlier candidates. This preserves provenance and prevents a generic “continue” action from being interpreted as authorization for a paid retry.

Hard-coding every Toonflow skill step as a route was rejected because Toonflow itself uses a flexible canvas and because projects may skip inapplicable adaptation stages.

### Reuse JuggleWork model catalogs and execution runtimes

Text-model options come from the connected provider list, are filtered to text-capable models, and obey desktop model restrictions. Text generation runs in a server-owned temporary OpenCode session with the selected `{providerID, modelID}` specified at both session creation and prompt time. Structured stages use JSON Schema output where practical. The service collects the authoritative result and then deletes the temporary session so one-shot jobs do not pollute the normal conversation list.

Image models and generation use the existing image extension. Video models and generation use the existing media-generation service and persistent video jobs. Toon Factory stores references to those jobs and records request snapshots and adopted outputs; it does not implement provider credentials or adapters again.

Calling providers directly was rejected because it would duplicate credential resolution, organization restrictions, adapter compatibility, and error redaction.

### Treat model absence and model drift as blocking product states

The workbench will query text, image, and video availability on entry and before generation. Empty catalogs, disabled submission, missing credentials, unsupported adapters, or a previously selected model disappearing are shown as explicit errors with a route to provider settings where applicable. Paid media models are never silently replaced. Text defaults may be proposed from the current allowed catalog, but the selected model reference is persisted and shown to the user.

### Keep generation lifecycle independent of mounted UI

Text jobs have a persisted Toon Factory record around the temporary OpenCode execution. Image jobs persist request and result manifests even though the current image adapter is synchronous. Video jobs reference JuggleWork’s existing idempotent, recoverable job table and use a stable client request ID. All generation records include project, canvas or episode, node, model, prompt snapshot, parameters, references, status, timestamps, output, and sanitized error.

The UI subscribes or polls by job ID and may unmount without cancelling remote work. Retry creates a new attempt unless the previous submission is uncertain, in which case the existing job is reconciled instead of blindly resubmitted.

### Ship static core nodes before a plugin runtime

The initial node registry includes text, asset, storyboard, image asset, video asset, image generation, and video generation nodes. Typed handle compatibility is enforced by shared schemas. Dynamic JavaScript node loading and dynamic provider code are excluded until JuggleWork has an explicit plugin permission, versioning, signing, and isolation model.

### Preserve license attribution without copying private configuration

Substantially reused Toonflow code or protocols retain its MIT copyright and license in third-party notices. Provider keys, local configuration values, and user project content are never copied into repository artifacts or logs.

## Risks / Trade-offs

- **The complete Toonflow workflow is too large for a single safe code slice.** → Deliver vertical milestones with stable schemas first, then canvas/workflow, then generation and delivery; keep advanced modules out of the initial acceptance criteria.
- **A new node-graph dependency increases bundle size.** → Import the workbench lazily and load it only after the route is opened; prefer a focused React graph dependency instead of a second UI framework.
- **Temporary text sessions could remain after crashes.** → Tag sessions with Toon Factory metadata, delete them on success/failure, and add bounded stale-session cleanup by metadata and age.
- **File-backed projects can be edited externally.** → Use revisions, atomic writes, schema versions, recoverable validation errors, and explicit conflict UI.
- **Media generation can incur cost or run remotely after cancellation.** → Require scoped compute authorization, preserve stable client request IDs, display provider cancellation limitations, and never auto-resubmit an uncertain request.
- **The selected model can disappear after project creation.** → Validate immediately before every job and block with `selected_model_unavailable`; do not silently change media models.
- **Retaining a graph-heavy page can consume memory.** → Lazy mount on first visit, suspend queries and rendering while hidden, and add project/node virtualization where necessary.
- **Full compatibility with Toonflow files may be assumed by users.** → Version JuggleWork’s format independently and describe Toonflow import as a future explicit migration, not implicit compatibility.

## Migration Plan

1. Add the navigation, route, retained shell, feature-owned schemas, and read-only empty state behind the new destination.
2. Add workspace-safe project and canvas repositories plus versioned file creation and conflict handling.
3. Add workflow records, static node registry, document editing, and staged confirmation UI.
4. Add model discovery and blocking availability states, followed by text, image, and video execution adapters.
5. Add review/adoption, recovery, delivery manifests, attribution, and focused end-to-end coverage.
6. Keep schema readers backward-compatible within the feature. If rollout must be reversed, remove the navigation exposure while leaving project files intact; no destructive downgrade is performed.

## Open Questions

- Whether the first production release should expose Toonflow project import or only a documented future import contract.
- Whether a timeline/composition feature should become a separate capability after clip delivery is stable.
- Whether the Toon Factory should later expose its workflow as agent tools in addition to the human-facing workbench.
