## Context

The completed `add-toon-factory` change established a native React Toon Factory, workspace-confined portable projects, static graph nodes, staged workflow approvals, JuggleWork model discovery, durable generation records, and a screenshot-guided home/workbench shell. It intentionally stopped short of Toonflow's deeper workspace behavior: multiple retained canvases, production-grade graph editing, a persistent project Agent, a document IDE, reusable project assets, and semantic file commands.

This change matches those user interactions without importing Toonflow's execution architecture. JuggleWork remains the only authority for provider identity, model eligibility, credentials, workspace authorization, session execution, tool permission, paid generation, and artifact publication. Portable files must remain understandable without the local runtime database, while volatile sessions, jobs, leases, and credentials must never be serialized into a project.

The work crosses the React workbench, shared schemas, local server, OpenCode session projection, SQLite runtime state, file repositories, and generation services. It therefore requires explicit contracts for migration, session visibility, concurrency, tool safety, human authorization, and rollback.

## Goals / Non-Goals

**Goals:**

- Match Toonflow's observable home, multi-canvas, document, asset, and project-assistant interactions using native JuggleWork React surfaces.
- Introduce a portable v2 project schema with canvas folders, documents, assets, node configuration, and stable references while preserving v1 readability and explicit migration.
- Provide deterministic P0 editing, autosave, history, crash recovery, and retained hidden-view behavior before adding P1 productivity interactions.
- Provide persistent project-scoped Agent conversations with history, streaming, stop, edit-and-resend, attachments, `@node` and `@asset` context, questions, subagents, tools, and controlled canvas calls.
- Keep JuggleWork model policy, workspace confinement, tool permissions, and paid-compute authorization authoritative at execution time.
- Expose safe semantic workspace commands shared by humans and Agent tools rather than allowing arbitrary filesystem mutation.
- Preserve existing workflow confirmation, generation idempotency, candidate review, adoption, and delivery semantics.

**Non-Goals:**

- Embedding or porting Vue, Element Plus, Electrobun, Toonflow's server, TF-Router, provider settings, balance or marketplace concepts, dynamic provider code, or remote UMD node scripts.
- Treating Toonflow files as implicitly compatible; imports require an explicit, validated converter.
- Allowing an Agent utterance, tool plan, or canvas edit to approve content, authorize paid compute, or adopt a generated result.
- Storing JuggleWork credentials, absolute paths, runtime session IDs, database row IDs, or provider-private configuration in portable project files.
- Delivering real-time multi-user collaboration, a plugin runtime for arbitrary nodes, or a complete film-composition pipeline in this change.
- Replacing normal JuggleWork chat or exposing project Agent sessions as ordinary conversations.

## Decisions

### Define a v2 portable schema with stable IDs and explicit catalogs

`toon-project.json` v2 is the portable root. It contains project metadata, schema version, ordered canvas and folder descriptors, document and asset catalog references, workflow references, and selected public model references. Canvas bodies remain under `canvases/`; long node content and editable documents remain under `content/` and `documents/`; imported and generated media remain under `assets/`; generation and delivery manifests remain under their existing project-relative locations.

Every portable entity uses a stable opaque ID independent of its current name or path. References are project-relative and typed. Canvas descriptors include folder, order, title, kind, and canvas-file reference. Documents and assets include stable IDs, paths, MIME/kind metadata, and current portable revisions. Node configuration contains public generation parameters and typed references, never runtime handles or secrets.

Alternative: put the complete workspace in one JSON document. Rejected because large media/document edits would create broad conflicts, expensive writes, and poor external-edit behavior. Alternative: make SQLite canonical. Rejected because projects would cease to be portable and inspectable.

### Map portable truth to runtime SQLite without leaking runtime identity

SQLite stores runtime-only mappings and recovery data: project discovery index, portable project ID to normalized authorized root, project Agent conversation/session mappings, parent/child session lineage, visibility family, event cursors, autosave operation IDs, write leases, generation job links, tool-call state, and bounded recovery journals. Rows carry portable IDs plus workspace scope, but portable files never carry SQLite primary keys or OpenCode session IDs.

On open, the server validates the portable project and reconciles runtime rows by `(workspace scope, project ID)`. Missing runtime rows are recreated. Orphan rows are garbage-collected only after the project root is unavailable beyond a bounded grace period; they never cause project files to be deleted.

Alternative: serialize session IDs into `toon-project.json`. Rejected because IDs are machine-local, reveal implementation details, break copied projects, and couple rollback to runtime state.

### Use one ordered semantic command boundary for workspace mutation

Canvas, document, asset, workflow, and Agent mutations use shared semantic commands such as create, rename, move, reorder, duplicate, delete, restore, write-content, attach-asset, and apply-canvas-patch. A command includes workspace/project scope, actor, stable operation ID, expected revisions, and typed payload. The server validates paths, symlinks, schemas, references, permissions, and preconditions before committing atomic file writes and catalog updates.

Multi-file commands use a recoverable journal: prepare validated temporary files, atomically publish in deterministic order, mark committed, and reconcile incomplete journals after restart. Repeating an operation ID returns the recorded outcome. Reads expose revisions; conflicts return current metadata without overwriting external changes.

Alternative: let each UI module manipulate files independently. Rejected because rename/move/delete would produce dangling references and Agent tools could bypass safety invariants.

### Implement the canvas as a React-native graph adapter with a domain-owned command model

A lazily loaded React graph dependency may provide viewport, selection, handles, edges, minimap, and rendering primitives. Domain reducers and schemas, not dependency-specific objects, own commands, history, clipboard format, typed connection validation, persistence, and tests. This permits replacing the graph library without changing portable files.

P0 includes multi-selection, drag, connect/disconnect, create/delete, keyboard movement, copy/cut/paste/duplicate, undo/redo, zoom/pan/fit, autosave, revision conflict handling, and retained viewport/selection. P1 adds groups, alignment/distribution, snapping guides, z-order, minimap, import/drop, and richer keyboard navigation. P2 may add scale-oriented virtualization and optional layout algorithms after measured need.

History is a bounded in-memory command log per open canvas with coalesced drag/text operations. Saved revisions and explicit checkpoints form durable history; undo never silently crosses an external revision conflict. Hidden canvases stop animation and polling but retain serializable UI state. A lightweight lease/heartbeat keeps the active editing runtime alive while visible; lease expiry flushes or recovers pending operations rather than deleting state.

Alternative: copy Toonflow's Vue graph implementation or load UMD nodes. Rejected because it violates the React/runtime boundary and creates dynamic-code risk.

The selected graph dependency is `@xyflow/react` 12.12.0. It is MIT licensed, React-native, compatible with the workspace's React 19 runtime, and provides selection, typed handle rendering, connection events, viewport control, fit-to-content, keyboard-compatible primitives, and a minimap. Its published package is approximately 1.2 MB unpacked and is loaded only by the v2 canvas module. Domain canvases, typed edges, clipboard payloads, grouping, layout commands, and bounded history remain dependency-free; `toon-canvas-xyflow-adapter.ts` is the only conversion boundary. IME input remains owned by normal React editors rather than graph keyboard handlers, and canvas shortcuts explicitly suppress editable, menu, and dialog targets. The lockfile is checked to exclude Vue, Electrobun, `@toonflow/*`, dynamic UMD, and remote-script graph dependencies.

### Use a dedicated project-assistant API and session visibility family

The project Agent uses dedicated project routes for conversations, messages, stream events, stop, edit-and-resend, attachments, interactions, subagents, and canvas calls. It does not masquerade as the normal chat API. A conversation is a durable Toon runtime record mapped to one persistent OpenCode parent session; descendants carry explicit lineage and are projected through the same project API.

Conversation deletion is a persisted cleanup saga. The server first marks the conversation `deleting`, freezes new sends, enumerates every historical root plus turn-owned and recursively discovered descendants, aborts active sessions, and deletes children before roots with bounded per-cycle attempts. Successful `deleted` and `not_found` outcomes are recorded individually. Any failure or remote-continuation uncertainty retains conversation, ownership, lineage, and cleanup rows so the project API can expose and retry pending cleanup; only a fully confirmed family removes runtime records. Writable startup/background reconciliation resumes pending cleanup, while read-only and GET paths remain observe-only.

Session visibility is a closed family:

- `normal`: ordinary user chats, visible in normal conversation surfaces.
- `toon_transient_generation`: one-shot generation sessions, hidden and cleaned up under existing rules.
- `toon_project_assistant`: persistent project parent sessions, visible only in the addressed project's assistant history.
- `toon_project_subagent`: descendants visible under their project parent and never promoted to normal chat.

Visibility and lineage are server-owned metadata. List/event projection filters by family before returning data. A project conversation survives navigation and restart, but copying a portable project creates no implicit session portability.

Alternative: use normal chats with a project tag. Rejected because normal list/event APIs can leak children, cleanup rules differ, and project-specific interactions need stronger scoping.

### Treat assistant context and canvas calls as typed, inspectable inputs

Attachments are uploaded through project asset/document APIs and represented by stable references. `@node` and `@asset` mentions resolve at send time to bounded, revision-tagged context; stale or missing references are shown rather than silently substituted. The message record stores mention references and context revision metadata, not hidden credential-bearing snapshots.

Tool calls, questions, subagents, and canvas calls stream as typed events with stable IDs and recoverable terminal states. Read tools may inspect project summaries and explicitly referenced content. Mutating canvas calls compile to semantic commands, show a proposed operation summary, and require permission according to risk. Tool results are sanitized and size-bounded before entering model context.

The managed OpenCode bridge credential is bound to the lifetime of one managed engine/server instance rather than to the first workspace used as that engine's startup directory. The bridge route dynamically requires the requested workspace to remain in that server's configured local workspace set, so one injected token works for all local directories served by the engine, newly added local workspaces become eligible, and removal revokes eligibility immediately. Remote workspaces remain excluded. This route-level admission only narrows access further: session metadata must name the same workspace and project, and the persisted project/conversation lineage, active-turn ownership, and exact real tool call ID and input must still agree. No other host-authenticated route accepts the engine credential, and a restart rotates it.

Edit-and-resend creates a new branch by asking OpenCode to fork immediately before the edited user message. The server verifies the fork boundary; if that SDK contract is unavailable or includes the edited message, it creates a fresh root and replays only bounded authoritative user/assistant text before the source message with tools disabled and no assistant reply. The prior branch is preserved, branch metadata records the source message and root, and a replacement is durably queued while the current turn is stopping. The server independently reconciles every stopping turn, repeatedly discovers and aborts late descendants, and waits for a persisted quiet window with stable OpenCode lineage/status observations before making the old turn terminal and dispatching the replacement. A bounded deadline prevents indefinite stopping; uncertainty at the deadline is recorded as interrupted with remote work possibly continuing, and the conversation switches to an isolated root even when no replacement is queued so late old-branch outputs and interactions cannot enter any later turn. Old roots and descendants remain permanently owned by their old turns and continue to project inspectable late assistant output onto archived branches. The stopping deadline, quiet observation, descendant ownership, pending replacement, active branch, root mapping, and unacknowledged remote-continuation warning survive restart. Read-only servers never start this mutation timer; list, snapshot, and event GET paths are observe-only SQLite projections that perform no SDK calls or writes; and normal shutdown drains the writable reconciler before closing runtime storage.

### Make JuggleWork the sole model and provider authority

Every assistant turn and node-level override stores only a public `{providerID, modelID}` reference and revalidates it against the live JuggleWork catalog, workspace/org policy, capability, and readiness immediately before execution. The assistant defaults to the project text model when allowed; a node override is explicit and never creates provider settings inside Toon Factory. Removed or blocked models produce an actionable blocking state.

Image and video choices continue through configured JuggleWork media model discovery. No Toonflow provider, key, balance, marketplace, routing, or dynamic adapter schema is introduced. Responses expose only public model descriptors and sanitized diagnostics.

Alternative: import Toonflow provider configuration to improve file compatibility. Rejected because JuggleWork must remain the credential and policy authority.

### Separate tool permission from human paid-compute authorization

Tools are classified as read-only, reversible project mutation, destructive project mutation, or external/paid execution. All calls require workspace and project scope, current user authority, schema validation, path confinement, and audit metadata. Destructive actions require explicit confirmation and present affected stable IDs. Arbitrary shell, arbitrary path, provider credential, dynamic code, and remote script tools are not exposed.

Paid image/video generation always creates an exact generation plan containing model, quantity, prompt, references, parameters, execution count, and known cost or unknown-cost marker. A human must authorize that exact plan through the existing compute-authorization contract. Agent tool permission, a prior similar authorization, conversational assent, or workflow approval is insufficient. Retries or changed plans require fresh authorization; uncertain submissions reconcile by idempotency key and never auto-resubmit.

### Add a React-native document workspace backed by revisioned files

The project workspace has retained Canvas and Document modes. The document mode uses a React-compatible editor loaded lazily behind a domain adapter. The first release supports safe text formats; unsupported or binary files open in preview/download mode. The file tree is derived from the project-safe repository, not from unrestricted filesystem traversal.

The selected editor is CodeMirror 6 through `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, and `@codemirror/lang-markdown`. These packages are MIT licensed, modular, tree-shakeable, and loaded only after Document mode opens through React `lazy()` plus dynamic package imports. The four installed package directories total approximately 2.0 MB unpacked, and the production build emits the React adapter as a separate 2.39 kB minified chunk while keeping the dynamically imported editor modules out of the initial adapter path. CodeMirror owns Unicode-aware selection and browser composition events, so CJK and other IME input does not pass through canvas shortcuts. The adapter enables line numbers, native selection, keyboard commands, focus semantics, read-only state, and JuggleWork token styling without exposing CodeMirror state in portable data. Domain tests cover retention and save behavior without mounting the editor. P0 editing is limited to Markdown and UTF-8 plain text; JSON and all other formats are read-only or preview-only. Files over 2,000,000 characters are also read-only in P0 to avoid an unmeasured large-file editing promise; server reads and explicit previews remain subject to their independent byte limits.

Tabs retain dirty drafts, selection, scroll, and split/layout metadata. Saves carry expected revisions and use atomic writes. External changes produce compare/reload/save-as-conflict choices. Project search is bounded to supported project files, cancellable, and returns path plus line/range previews without indexing secrets or generated binaries. Layout state is runtime-local unless a portable preference is explicitly schema-defined.

Alternative: embed an iframe IDE or Toonflow editor. Rejected because it weakens authorization, theme, accessibility, and revision guarantees.

### Treat assets as cataloged project entities, not arbitrary paths

Imports validate source authorization, filename, size, MIME signature, and destination before atomically publishing into project-controlled storage. The asset catalog records stable ID, portable relative path, media metadata, origin, checksum, and lifecycle state. References from nodes, documents, messages, workflow records, and generation requests are tracked by stable ID.

Delete is blocked or explicitly confirmed when references exist and uses recoverable trash/tombstone semantics before bounded cleanup. Generated candidates remain governed by generation/adoption history; adopting or rejecting does not erase provenance. Previews use safe local URLs and must not execute active content.

### Extend the existing shell without making the screenshot baseline the architecture

The existing inspiration home, full-surface dotted canvas, floating top controls, bottom controls, and dockable assistant are accepted as the completed visual prerequisite. This change makes controls functional and adds retained canvas/document mode, multi-canvas navigation, asset access, and a persistent assistant dock. Narrow windows use a bottom sheet or modal surface while preserving canvas/document access and keyboard focus.

Semantic JuggleWork tokens remain authoritative for colors, elevation, spacing, focus, motion, and disabled states. Graph and editor dependencies receive token adapters; no Toonflow/Element Plus shell or hard-coded provider branding is introduced.

## Risks / Trade-offs

- **Portable v2 migration can partially fail across many files.** -> Preflight the complete project, write a migration journal and backup manifest, publish atomically where possible, and leave v1 untouched on failure.
- **Persistent Agent sessions can leak into normal chat or survive project deletion.** -> Enforce the closed visibility family at list/event boundaries, scope every lookup by workspace/project, and garbage-collect runtime mappings separately from portable data.
- **Agent canvas tools can make broad or unsafe edits.** -> Compile tools to typed semantic commands, preview affected entities, classify risk, require confirmation where needed, and keep undo/checkpoint records.
- **Autosave, external edits, and Agent edits can race.** -> Serialize commands per project, require revisions, coalesce only compatible local operations, and stop autosave on conflicts until the user resolves them.
- **Graph and editor dependencies increase bundle and memory cost.** -> Lazy-load by mode, suspend hidden rendering, use adapters, measure retained memory, and introduce virtualization only when thresholds are exceeded.
- **Context assembled from nodes/assets can exceed model limits or include unsafe content.** -> Resolve explicit references only, enforce type/size limits, label untrusted content, sanitize tool output, and expose truncation to the user.
- **Paid tools can be triggered through persuasive conversation.** -> Keep human compute authorization out-of-band, exact-scope, expiring, and non-transferable between changed plans.
- **Asset deletion can break historical records.** -> Track references, use tombstones/trash, preserve generation/adoption provenance, and block irreversible cleanup while retained records depend on the asset.
- **Exact Toonflow parity can conflict with JuggleWork accessibility or policy.** -> Match interaction outcomes and information architecture, but prefer JuggleWork focus, keyboard, theme, security, and policy contracts.

## Migration Plan

1. Land shared v2 readers, validators, v1-to-v2 planning, runtime tables, and semantic read commands while continuing to write v1 for existing projects.
2. Add an explicit per-project migration preflight showing changed files, unsupported data, required disk space, and rollback availability. Never auto-migrate on open.
3. On approval, acquire a project write lease, create a recovery journal and backup manifest, write v2 catalogs/files to temporary paths, validate the complete result, then atomically switch `toon-project.json` last.
4. Reconcile SQLite mappings from the committed portable IDs. Runtime migration failure leaves the portable project valid and rebuildable on next open.
5. Enable v2 writes, multi-canvas/document/assets, and then project Agent APIs behind independently removable feature exposure. Keep v1 projects read-only or on the existing UI until migrated.
6. Rollback application exposure by disabling project Agent and advanced workspace routes while retaining v2 read/export support. Do not downgrade or destructively rewrite v2 files.
7. For per-project rollback before new v2-only edits, validate the backup manifest and restore v1 through the same journaled command boundary. After v2-only edits exist, offer export/restore-as-copy rather than a lossy in-place downgrade.
8. Recovery on startup inspects incomplete journals: discard uncommitted temporary files, finish a fully published commit when validation succeeds, or restore the pre-migration manifest. Every outcome is surfaced to the user and covered by crash-point tests.

## Open Questions

- Which React graph and document-editor packages best satisfy bundle, licensing, IME, accessibility, and testability requirements after a focused proof of concept?
- Which text document formats are editable in P0 beyond Markdown, plain text, and JSON, and which remain preview-only?
- What measured node/file thresholds trigger P2 virtualization and optional search indexing?
- How long should recoverable asset trash, abandoned conversation runtime mappings, and durable assistant event history be retained?
- Should exported project archives optionally include a redacted assistant transcript, or should conversations remain strictly machine-local runtime state?
