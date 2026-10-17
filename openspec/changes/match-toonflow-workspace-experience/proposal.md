## Why

The initial Toon Factory implementation provides the safe project, workflow, and generation foundation, but its interaction model remains substantially simpler than the Toonflow workspace users expect. Toon Factory should match Toonflow's project creation, spatial canvas, document workspace, and project-aware Agent experience while retaining JuggleWork as the sole authority for models, providers, credentials, permissions, and durable generation jobs.

## What Changes

- Match Toonflow's inspiration-led home experience, project catalog behavior, attachments, import/open semantics, and transition from an idea into an initialized project workspace.
- Replace the basic canvas interaction layer with a production spatial canvas supporting multiple retained canvases, selection, grouping, clipboard, history, arrangement, snapping, minimap, import, shortcuts, and safe autosave.
- Add a project-aware persistent Agent assistant with conversation history, streaming responses, stop/edit/resend, attachments, node and asset mentions, tool progress, questions, subagents, and controlled canvas operations.
- Add a retained Canvas/Document workspace with a safe file tree, multi-document editing, revision conflicts, search, preview, and layout persistence.
- Add project asset management and explicit media import/output lifecycle while keeping paid generation review and adoption gates.
- Use only connected, policy-allowed JuggleWork text models and configured JuggleWork image/video generation models; remove or disable Toonflow provider, API-key, balance, marketplace, TF-Router, and dynamic provider concepts.
- Preserve the existing Toon Factory project safety, workflow approvals, compute authorization, generation idempotency, artifact validation, and delivery semantics.
- Do not embed Vue, Element Plus, Electrobun, Toonflow's server, dynamically evaluated provider code, or remote UMD node scripts.

## Capabilities

### New Capabilities
- `toon-spatial-canvas`: Multi-canvas spatial editing, node interactions, history, clipboard, grouping, layout controls, imports, and retained canvas runtimes.
- `toon-project-assistant`: Persistent project-scoped Agent conversations, JuggleWork model selection, attachments and mentions, streaming, interactions, subagents, and controlled Toon tools.
- `toon-document-workspace`: Retained file tree and multi-document workspace with autosave, revisions, conflicts, search, and project-node documents.
- `toon-project-assets`: Project asset upload, import, indexing, preview, reuse, references, and safe lifecycle management.
- `toon-workspace-files`: Domain-safe project file operations, canvas catalogs, semantic commands, idempotent operations, and crash recovery needed by canvas, documents, assets, and Agent tools.

### Modified Capabilities
- `toon-factory-navigation`: Extend the project route into a retained Canvas/Document workspace with Toonflow-compatible floating and docked controls.
- `toon-factory-projects`: Extend the portable project format for multiple canvas descriptors, node configuration, project assets, documents, and migration from the existing version.
- `toon-factory-models`: Apply JuggleWork provider and policy validation to every persistent Agent turn and node-level model override without introducing Toonflow provider settings.
- `toon-factory-generation`: Expose generation through canvas nodes and Agent tools while preserving explicit authorization, idempotent jobs, review, adoption, and unknown-submission handling.
- `toon-factory-workflow`: Coordinate freeform canvas and Agent operations with the existing staged workflow and prevent conversational language from implicitly approving content, compute, or adoption.
- `ui-theme-tokens`: Add Toonflow-style spatial hierarchy, floating toolbars, dockable panels, and document layout using JuggleWork semantic tokens and accessibility behavior.

## Impact

- Significant React domain refactor under `apps/app/src/react-app/domains/toon-factory/`, including dedicated home, workspace, canvas, assistant, document, asset, workflow, and generation modules.
- New shared schemas and migrations for canvas catalogs, node configuration, assets, documents, Agent APIs, and semantic project commands.
- New JuggleWork server services and routes for project file operations, canvas lifecycle, assets, project Agent sessions, events, interactions, and restricted Toon tools.
- OpenCode session visibility and event routing must distinguish normal chat, transient generation sessions, persistent Toon project assistants, and their descendants.
- A React-native graph engine and document workspace dependencies may be introduced, but no Vue, Electrobun, `@toonflow/*`, provider runtime, or dynamic script execution dependency is permitted.
- Existing project files remain readable and migrate explicitly; runtime session IDs and credentials never enter portable project files.
