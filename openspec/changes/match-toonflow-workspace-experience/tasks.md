## 1. Completed prerequisite baseline

- [x] 1.1 Retain the existing workspace-scoped Toon Factory navigation, route parsing, pinning, lazy page, hidden-view suspension, and semantic shell tests as the prerequisite navigation baseline.
- [x] 1.2 Retain the existing screenshot-guided inspiration home, project cards, full-surface dotted canvas, floating project and canvas controls, responsive assistant shell, and accessibility regression tests as the visual prerequisite rather than treating them as the completed interaction implementation.
- [x] 1.3 Retain the existing portable v1 project, canvas, external text, typed-edge, revision-conflict, and workspace path-confinement tests as the migration source baseline.
- [x] 1.4 Retain the existing JuggleWork text/image/video model discovery, temporary text execution, durable media jobs, exact compute authorization, candidate review, adoption, and delivery tests as safety prerequisites.
- [x] 1.5 Record that the current baseline has no production multi-canvas catalog, persistent project Agent, document workbench, project asset catalog, or shared semantic mutation command layer; all such work below remains incomplete.

## 2. P0 portable v2 schema and runtime foundation

- [x] 2.1 Define shared v2 schemas for project metadata, ordered canvas folders and canvases, documents, assets, node configuration, stable typed references, public model references, and schema diagnostics; verify validator fixtures accept a complete portable project and reject runtime IDs, credentials, absolute paths, and dangling references.
- [x] 2.2 Define the v1-to-v2 migration planner, backup manifest, journal states, rollback eligibility, and unsupported-newer-version behavior; verify golden migration fixtures preserve all v1 episodes, nodes, edges, content, workflow, generation, and adoption records.
- [x] 2.3 Add runtime SQLite migrations for project discovery mappings, assistant conversations and session lineage, visibility family, event cursors, semantic operation outcomes, write leases, recovery journals, tool calls, and generation links; verify upgrade and downgrade-safe startup against existing databases.
- [x] 2.4 Implement portable-ID-to-runtime reconciliation keyed by workspace scope and project ID without persisting runtime IDs into project files; verify missing rows rebuild and orphan cleanup never deletes portable files.
- [x] 2.5 Implement explicit migration preflight reporting changed files, unsupported content, disk requirements, backup location, and rollback limits; verify declining preflight leaves the complete v1 project byte-for-byte unchanged.
- [x] 2.6 Implement journaled v1-to-v2 publication with root metadata switched last and startup reconciliation for every crash point; verify each injected interruption yields either a valid v1 project or a complete valid v2 project.
- [x] 2.7 Add feature exposure and rollback behavior that can hide advanced routes while retaining v2 read/export support; verify no automatic or lossy v2-to-v1 rewrite occurs.

## 3. P0 semantic workspace command boundary

- [x] 3.1 Define typed read and mutation commands for project, canvas, folder, document, asset, content, references, and canvas patches with actor, origin, stable operation ID, expected revisions, and structured outcomes; verify shared schema round trips.
- [x] 3.2 Implement one project-scoped command coordinator that serializes conflicts, validates workspace and symlink confinement, checks schemas and references, and publishes atomic single-file changes; verify traversal, unsafe symlink, duplicate path, stale revision, and invalid reference tests.
- [x] 3.3 Implement durable prepare/commit/terminal journals for multi-file create, rename, move, reorder, duplicate, delete, restore, and import operations; verify recovery before commit, during publish, and after publish but before response.
- [x] 3.4 Persist idempotent operation outcomes and reject reuse of an operation ID with a different payload; verify lost-response retries neither duplicate entities nor reapply writes.
- [x] 3.5 Record human UI, autosave, migration, assistant tool, and recovery origins with affected portable IDs and sanitized errors; verify audit responses omit credentials, unrestricted absolute paths, private provider configuration, and SQLite IDs.
- [x] 3.6 Replace direct new-feature filesystem writes with semantic commands while leaving existing v1 behavior readable during migration; verify command-level integration tests cover referential integrity across canvas, document, asset, workflow, and assistant references.

## 4. P0 multi-canvas workbench and core interactions

- [x] 4.1 Evaluate a React-native graph dependency for licensing, bundle size, accessibility, typed handles, minimap support, IME compatibility, and testability; record the decision and verify no Vue, Electrobun, `@toonflow/*`, dynamic UMD, or remote script dependency enters the lockfile.
- [x] 4.2 Add domain-owned graph adapters and reducers so dependency objects never become portable schema or command history; verify reducer and serialization tests run without mounting the graph library.
- [x] 4.3 Implement the ordered canvas and folder navigator with create, rename, reorder, move, duplicate, delete, restore, active selection, and stable-ID routing; verify references survive rename and project reload restores organization and active canvas.
- [x] 4.4 Implement P0 pointer interactions for node creation, single and multi-selection, drag, connect/disconnect, deletion, pan, zoom, reset, and fit-to-content; verify typed-handle errors are accessible and invalid edges never enter state.
- [x] 4.5 Implement P0 keyboard focus, movement, copy, cut, paste, duplicate, delete, undo, redo, select-all, zoom, and fit shortcuts using platform conventions; verify editor, menu, dialog, and input focus suppresses destructive canvas shortcuts.
- [x] 4.6 Implement a bounded per-canvas command history with coalesced drag, keyboard-move, and text operations; verify one continuous gesture produces one undo entry and pasted entities receive fresh IDs with valid internal edges.
- [x] 4.7 Persist and retain active canvas, viewport, selection, draft, and command state across Canvas/Document mode changes and app navigation; verify hidden canvases suspend graph rendering, animation, and polling.
- [x] 4.8 Add a discoverable, localized shortcut reference with dynamic enabled states and reasons; verify macOS and non-macOS labels and keyboard-only operation.

## 5. P0 autosave, keepalive, conflicts, and durable history

- [x] 5.1 Implement revision-aware debounced canvas autosave with stable operation IDs, immediate flush before transitions, save-state indicators, and retry reconciliation; verify a committed lost response cannot duplicate a patch.
- [x] 5.2 Implement visible-editor lease or heartbeat acquisition, renewal, expiry, and bounded release; verify crash simulation releases stale leases while preserving acknowledged and journaled commands.
- [x] 5.3 Stop autosave and local undo/redo at external-revision conflicts and offer reload, compare, or conflict-copy recovery; verify no resolution path silently overwrites the server revision or discards the local draft.
- [x] 5.4 Add explicit durable canvas checkpoints and revision history with origin metadata; verify restoring a checkpoint creates a new current revision and preserves intervening history.
- [x] 5.5 Add multi-canvas transition and retained-view integration tests covering dirty flush success, conflict blocking, hidden suspension, restart recovery, and bounded history eviction.

## 6. P0 project asset lifecycle

- [x] 6.1 Implement the portable asset catalog and runtime queries for stable ID, relative path, MIME signature, size, checksum, dimensions or duration, origin, lifecycle state, and references; verify copied projects rebuild runtime indexes from portable data.
- [x] 6.2 Implement atomic asset upload and authorized import with source checks, filename normalization, size limits, MIME-signature validation, collision handling, and idempotent operation IDs; verify mismatched or interrupted imports leave no published partial asset.
- [x] 6.3 Add searchable asset browsing, metadata, safe image/video preview, and reuse from compatible canvas nodes and assistant attachments; verify active content is sandboxed or refused and reuse does not duplicate bytes.
- [x] 6.4 Track asset references from canvases, documents, workflow, assistant messages, generation records, and adoption records; verify referenced deletion lists impact and cannot proceed without a supported replacement or explicit destructive confirmation.
- [x] 6.5 Add recoverable asset trash and tombstones with bounded cleanup while preserving generated-candidate and adoption provenance; verify restore returns the same stable asset ID and cleanup cannot remove retained historical artifacts.

## 7. P0 document workspace

- [x] 7.1 Evaluate and select a lazily loaded React document editor for licensing, bundle size, IME, accessibility, large-file behavior, and testability; record editable P0 formats and verify unsupported formats remain preview-only.
- [x] 7.2 Implement Canvas/Document mode routing and a project-confined file tree with retained expansion and selection; verify traversal, symlink escape, generated-directory, and ignored-path exclusions.
- [x] 7.3 Implement retained multi-tab editing with tab order, active tab, dirty draft, cursor, selection, scroll, and layout state; verify switching tabs, modes, projects, and retained routes never implicitly saves or discards drafts.
- [x] 7.4 Implement atomic expected-revision save and bounded autosave for supported text documents; verify current saves advance revisions and stale saves preserve the draft with compare, reload, and conflict-copy choices.
- [x] 7.5 Implement inspectable revision history and restore-as-new-revision; verify timestamps and human, assistant, migration, or recovery origins remain visible without exposing runtime secrets.
- [x] 7.6 Implement cancellable filename and content search over safe supported project files with bounded incremental results; verify selecting a result opens and reveals the range while cancellation stops scanning.
- [x] 7.7 Implement validated binary/media preview and truthful unsupported-file states without executing active project content; verify preview URLs remain project-authorized and are revoked when no longer needed.

## 8. P0 dedicated project assistant and session visibility

- [x] 8.1 Define dedicated project assistant request, response, interaction, and stream-event schemas for conversations, messages, attachments, stop, edit-and-resend, tools, questions, subagents, and canvas calls; verify backward-compatible event decoding and terminal-state fixtures.
- [x] 8.2 Implement the closed `normal`, `toon_transient_generation`, `toon_project_assistant`, and `toon_project_subagent` visibility family with workspace, project, parent, and descendant lineage; verify every normal and project list/event query excludes foreign families and projects.
- [x] 8.3 Implement dedicated project conversation create/list/read/archive APIs mapped to persistent OpenCode parent sessions; verify restart restores history and copying a portable project does not copy or expose the original runtime conversations.
- [x] 8.4 Implement ordered streaming with stable event IDs, retained cursors, reconnect replay, message finalization, and duplicate suppression; verify disconnect at each event boundary resumes without duplicate terminal messages.
- [x] 8.5 Implement exact-turn stop with truthful local and remote cancellation states; verify stop cannot target another project or completed turn and reports when remote work may continue.
- [x] 8.6 Implement edit-and-resend as a preserved branch with active descendant stop or detach behavior; verify original messages, tool calls, subagents, and outputs remain inspectable.
- [x] 8.7 Add the persistent resizable/collapsible assistant dock in Canvas and Document modes plus the accessible narrow-layout sheet; verify conversation, draft, stream, dimensions, focus trap, and focus restoration across mode and viewport changes.

## 9. P0 assistant context, tools, and model policy

- [x] 9.1 Implement assistant attachment ingestion through project document and asset services and `@node`/`@asset` completion using stable IDs; verify stale, missing, incompatible, cross-project, and unauthorized references are never silently substituted.
- [x] 9.2 Resolve explicit mention context at send time with observed revisions, content-type labels, size and token limits, untrusted-content boundaries, and visible truncation; verify oversized or unsafe context produces stable diagnostics without credential leakage.
- [x] 9.3 Render and persist typed tool progress, structured questions and answers, and subagent lineage under the parent turn; verify an interaction can be answered once and descendants never appear in normal chat.
- [x] 9.4 Implement the least-privilege Toon tool registry with read-only, reversible mutation, destructive mutation, and external/paid risk classes; verify no arbitrary shell, arbitrary path, credential, dynamic provider, dynamic code, or remote script tool is registered.
- [x] 9.5 Compile mutating assistant tools and canvas calls into semantic command proposals with affected IDs, permission checks, confirmations, audit origin, sanitized results, and undo integration; verify denial and invalid proposals produce no file mutation.
- [x] 9.6 Resolve project defaults and explicit turn or node overrides only through live JuggleWork catalogs and workspace/org policy at execution time; verify disconnected, blocked, wrong-capability, or unready models fail with actionable states and never silently substitute.
- [x] 9.7 Remove or reject Toonflow provider, API-key, balance, marketplace, TF-Router, dynamic provider, and UMD fields from all new schemas and imports; verify UI and API contract tests expose only public JuggleWork model descriptors and sanitized diagnostics.

## 10. P0 workflow and paid generation safety

- [x] 10.1 Add stable dependency links from workflow records to canvas, node, document, asset, generation, and adoption revisions; verify relevant upstream edits mark only the dependency closure stale and preserve prior decisions and artifacts.
- [x] 10.2 Route protected assistant proposals through explicit content approval, skip, compute authorization, adoption, and delivery interactions; verify assistant prose, canvas edits, tool success, and question answers cannot directly change protected workflow state.
- [x] 10.3 Integrate canvas-node and assistant-tool generation with the existing durable Toon generation records and shared progress projection; verify canvas, assistant, asset, and workflow views observe one job rather than creating duplicate submissions.
- [x] 10.4 Require human authorization for the exact paid generation plan, including model, object, quantity, prompt, references, parameters, execution count, and cost or unknown-cost marker; verify conversational assent and generic tool permission do not authorize submission.
- [x] 10.5 Invalidate authorization when model, prompt, references, quantity, duration, resolution, or count changes and require fresh authorization for retry; verify equivalent lost-response retries reuse the stable request ID.
- [x] 10.6 Preserve `submission_unknown` reconciliation and prohibit Agent or node auto-resubmission; verify uncertain image/video integration tests produce one paid request and a human-visible recovery path.
- [x] 10.7 Publish completed outputs as awaiting-review candidates and require explicit adoption before changing node, workflow, or delivery truth; verify superseded candidates and adoption history remain inspectable.

## 11. P1 spatial productivity and polished workspace parity

- [x] 11.1 Implement canvas grouping and ungrouping with stable group IDs, nested-policy validation, relative placement, edge preservation, and one-command undo; verify mixed internal and external edges remain valid.
- [x] 11.2 Implement alignment, distribution, snapping guides, grid snapping, z-order controls, and optional supported auto-arrangement through domain commands; verify each action changes only declared layout fields and is deterministically undoable.
- [x] 11.3 Implement minimap navigation and viewport indicators with keyboard and reduced-motion behavior; verify minimap state reflects all visible node bounds and does not persist dependency-specific objects.
- [x] 11.4 Implement drag/drop and chooser imports that atomically create validated project assets and compatible nodes at intended positions; verify unsupported files create neither assets nor partial nodes.
- [x] 11.5 Complete Toonflow-equivalent home catalog sorting, folder/project organization, attachments, open/import affordances, and idea-to-initialized-workspace transitions while keeping unsupported Toonflow conversion explicit; verify idempotent initialization survives route and response loss.
- [x] 11.6 Add cross-surface keyboard navigation, command menus, localized labels, reduced motion, screen-reader announcements, and disabled-reason behavior for canvas, documents, assets, questions, tools, conflicts, and jobs; verify focused accessibility tests in light and dark themes.
- [x] 11.7 Adapt graph, editor, file tree, asset browser, assistant, floating controls, and dock states to JuggleWork semantic tokens; verify visual regression coverage for theme switching, localization growth, dock resize, narrow layout, and control collision.

## 12. P2 scale, optional enhancements, and release validation

- [x] 12.1 Measure bundle, first-open latency, retained hidden memory, canvas frame time, document large-file behavior, search latency, and assistant event volume against recorded thresholds; verify the measurement suite runs on representative small and large projects.
- [x] 12.2 Add node, asset, file-tree, and search-result virtualization only where P2 thresholds are exceeded; verify selection, keyboard navigation, minimap, search reveal, and retained state remain correct with offscreen entities.
- [x] 12.3 Add bounded optional search indexing and cache invalidation only if measured direct search is insufficient; verify ignored, secret, binary, generated, removed, and externally changed files cannot yield stale or unsafe results.
- [x] 12.4 Add lifecycle cleanup for expired leases, completed journals, abandoned runtime mappings, retained assistant events, and recoverable trash using documented grace periods; verify cleanup is idempotent and cannot remove live or referenced portable content.
- [x] 12.5 Decide and implement the explicit Toonflow import contract or keep it disabled with truthful UI; verify no path starts Toonflow's server, evaluates provider code, or loads remote UMD scripts.
- [x] 12.6 Run focused schema, migration crash-point, storage safety, session visibility, command idempotency, canvas, document, asset, assistant, model-policy, workflow, paid-generation, accessibility, i18n, performance, typecheck, and build suites; resolve regressions without weakening the normative safety contracts.
- [x] 12.7 Run `openspec validate match-toonflow-workspace-experience --strict`, inspect the final change diff to confirm only intended implementation and specification files changed, and record release and rollback evidence before marking the change complete.
