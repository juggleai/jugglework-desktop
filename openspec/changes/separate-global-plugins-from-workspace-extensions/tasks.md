## 1. Surface separation

- [x] 1.1 Restore a scoped Plugins group in the session top-right Settings panel without making workspace copies globally installed.
- [x] 1.2 Keep workspace Skill upload/discovery and custom connector creation in their respective workspace dialogs.
- [x] 1.3 Update panel types, counts, copy, and tests for the four-group workspace model.

## 2. Application-level plugin catalog

- [x] 2.1 Stop projecting the selected workspace's imported Cloud plugin ledger into dedicated catalog installation state.
- [x] 2.2 Keep built-in and Cloud/organization discovery and readiness available in the dedicated Plugins surface.
- [x] 2.3 Add explicit catalog copy explaining account/organization versus workspace scope.
- [x] 2.4 Verify Plugins, Skills, Connectors, and Installed navigation retains existing global actions and does not use workspace ledgers.

## 3. Compatibility and validation

- [x] 3.1 Preserve legacy workspace plugin installation data and advanced management paths.
- [x] 3.2 Add focused tests for catalog scope and workspace panel separation.
- [x] 3.3 Run the focused test suite and application typecheck.
- [x] 3.4 Wire workspace skill and supported plugin policy hooks through the session panel, test toggles and unsupported sources, and run focused verification.

## 4. Follow-up: complete global plugin installation

Pre-commit safety review: plugin policy is unavailable on the shared runtime and its API rejects writes. Skill policy is gated to trusted managed engines. Hook state is synchronously fenced on workspace/client changes.

- [ ] 4.1 Design and implement a host-level plugin installation registry and safe materialization for desktop-only Marketplace packages; no workspace ledger promotion.
- [ ] 4.2 Verify isolated workspace enablement of globally installed plugins on a shared runtime before exposing switches for those sources.

## 5. Public, organization, and personal catalog sources

- [x] 5.1 Add shared source header, preserve category sidebar, separate public plugins from org membership and environment installs.
- [x] 5.2 Classify Skills and Connectors identically; keep public directory entries visible after local installation and show honest empty public skill inventory.
- [x] 5.3 Synchronize organization switches, clear stale inventory/details, and isolate environment-local loads.
- [x] 5.4 Add source/isolation regressions and run focused tests and typechecks.

## 6. Add anywhere and stable tab switching

- [x] 6.1 Show Skills and Connectors Add on every source; successful local additions navigate to Personal, cancellation/failure does not.
- [x] 6.2 Remove source-only remounts, preserve search, keep toolbar/description/content/scrollbar geometry stable, retain context isolation.
- [x] 6.3 Verify success, failure, cancellation, stale completion and source-switch regressions with focused tests and typecheck (133 tests passed).
