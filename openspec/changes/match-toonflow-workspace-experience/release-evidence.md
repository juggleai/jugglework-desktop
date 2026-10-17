## Release Evidence

The change-specific release and rollback checks are complete. Repository-wide baseline failures that remain outside this change are recorded explicitly below rather than being treated as passing.

- Shared schema build and tests pass, including the explicit `toonflowImport: "disabled"` contract and validated existing-v2 open request/response.
- Server focused suites pass for migration crash points, storage confinement, semantic command idempotency, all multi-file create/rename/move/reorder/duplicate/delete/restore/import recovery stages, runtime cleanup, session visibility, assistant tools, model policy, workflow projection, and paid generation.
- App focused suites pass for home initialization and attachments, canvas/domain/minimap, retained documents, assets, project assistant, accessibility source contracts, visual token/collision contracts, forbidden imports, and performance fixtures.
- App and server TypeScript checks pass. Server production build passes. App production build passes and `test:toon-bundle` records 60,252 gzip bytes against a 665,600-byte threshold.
- Real headless Chrome evidence in `apps/app/tests/artifacts/toon-browser-performance.json` renders the representative 1,000-node/999-edge canvas with 7,026 DOM nodes, 60,966,950 bytes of JS heap, 18.5 ms zoom-frame p95, and 17.9 ms drag-frame p95. All recorded browser thresholds pass, so P2 node, asset, file-tree, and search-result virtualization remains intentionally unimplemented under the measurement gate.
- Strict global i18n coverage remains blocked by pre-existing incomplete locales other than English and Chinese; this change adds matching English and Chinese keys and focused tests/typecheck pass.
- The complete server suite records 1,292 passing and 10 failing tests. The change-related startup-maintenance race was fixed. The remaining failures are stable unrelated baselines: one user-config-sensitive runtime MCP assertion, seven stale extension-steering text fixtures, and two shared-suite SQLite/cleanup timing failures whose files pass independently.
- The complete app suite retains unrelated sign-in/marketplace source assertions and browser-only JuggleChat `localStorage` setup failures. Toon Factory app suites, the session-shell contract, production build, browser performance run, and all changed contracts pass independently.
- Repeated independent blocker/high reviews finished with no unresolved change-specific product or security issue after fixes to authorization, session visibility, semantic-command CAS, assistant turn lineage, stop/edit branching, startup recovery, project migration, asset confinement, and managed bridge authentication.

## Rollback Evidence

- Advanced workspace routes can still be hidden with `JUGGLEWORK_TOON_ADVANCED_WORKSPACE=0`; v2 read/export remain available and automatic downgrade remains false.
- Existing v2 project open validates in place and does not copy or reinitialize content.
- Toonflow conversion is explicitly disabled; no Toonflow server, remote UMD, provider code, or dynamic evaluation path is introduced.
- Startup journal recovery yields either the previous readable state or the complete committed state. Pre-commit initialization recovery removes only its unpublished project directory so the same operation ID can safely retry.
- Runtime cleanup uses documented grace periods and never deletes portable project roots. Referenced asset trash remains retained.
- Advanced features can be hidden without removing v2 read/export, and no rollback path rewrites v2 projects to v1. Project Assistant runtime mappings, policies, jobs, and conversations remain runtime-only and never become portable credentials or session IDs.
