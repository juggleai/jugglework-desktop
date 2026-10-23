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

- [x] 4.1 Implement a versioned host-level registry, identity scope, global projection, runtime MCP overlay, root-level APIs, operation idempotency, ownership conflicts, rollback/recovery, and no workspace-ledger promotion.
- [ ] 4.2 Verify isolated workspace enablement of globally installed plugins on a shared runtime before exposing switches for those sources. (Still intentionally unavailable: host-global installation is shared across workspaces.)
- [x] 4.3 Restore the safety boundary until 4.1: organization Marketplace packages are read-only in the standalone catalog, workspace ledgers do not populate Installed, and workspace delivery/status/action copy is hidden.
- [x] 4.4 Connect the standalone catalog and Installed sidebar to host records, support local and remote managed JuggleWork hosts, atomic identity switching, executable confirmation, confirmed uninstall, and orphaned installed-package cleanup.
- [x] 4.5 Harden startup/sign-out and failure behavior with host/owner auth, fail-closed projection recovery, operation journal, quarantine, pure-Cloud dematerialization, exact delivery metadata, remote host-token separation, and host/workspace ownership serialization.
- [x] 4.6 Add explicit workspace-copy migration planning and confirmed cross-scope transaction with fingerprints, durable journal, exact rollback/startup recovery, multi-workspace UI, and no automatic promotion.

## 5. Public, organization, and personal catalog sources

- [x] 5.1 Add shared source header, preserve category sidebar, separate public plugins from org membership and environment installs.
- [x] 5.2 Classify Skills and Connectors identically; keep public directory entries visible after local installation and show honest empty public skill inventory.
- [x] 5.3 Synchronize organization switches, clear stale inventory/details, and isolate environment-local loads.
- [x] 5.4 Add source/isolation regressions and run focused tests and typechecks.

## 6. Add anywhere and stable tab switching

Clarification: navigation to Personal applies to custom Add, not installing/connecting an existing Public directory item.

- [x] 6.1 Show Skills and Connectors Add on every source; successful local additions navigate to Personal, cancellation/failure does not.
- [x] 6.2 Remove source-only remounts, preserve search, keep toolbar/description/content/scrollbar geometry stable, retain context isolation.
- [x] 6.3 Verify success, failure, cancellation, stale completion and source-switch regressions with focused tests and typecheck (133 tests passed).

## 7. Mutually exclusive origins

- [x] 7.1 Retain Public provenance on connection/install and app edits; custom additions remain Personal, with collision protection.
- [x] 7.2 Keep built-in public plugins out of Personal; aggregate installed sources with origin labels and correct navigation, including organization capabilities.
- [x] 7.3 Verify provenance persistence, legacy identity matching, custom collisions, installed-source aggregation and typecheck (179 focused tests passed).

## 8. Public connector retirement

- [x] 8.1 Remove GitHub, Notion, Linear, Sentry, Stripe, and Context7 from Public Connectors; organization-provided connectors remain available under the organization source.

## 9. Connector readiness visibility

- [x] 9.1 Show installed plus real connection status and safe guidance; no OAuth action for static/token credentials.
- [x] 9.2 Keep unavailable configured connectors in the composer menu, block all activation paths, and add workspace management navigation.
- [x] 9.3 Verify runtime status transitions, missing state, refresh failure, token auth and menu interactions (94 tests passed in separate processes due to shared test mocks; app typecheck passed).

## 10. Inline catalog detail pages

## 11. Catalog card and Installed icon clarity

- [x] 11.1 Remove redundant Installed/Enabled card labels, retain Add/overflow actions, and show enabled state only on the plugin icon.
- [x] 11.2 Carry actual plugin/skill/connector icons to Installed shortcuts with category fallbacks.
- [x] 11.3 Verify enabled/disabled cards, install actions, icon metadata/fallbacks, typecheck and build (35 focused tests, app typecheck and production build passed).

## 12. Plugin component catalog deduplication

- [x] 12.1 Add exact-path plugin ownership provenance to Skill inventory from active host registry and workspace ledgers.
- [x] 12.2 Exclude plugin-owned skills from standalone Skills lists and Installed shortcuts while retaining runtime and plugin-detail visibility.
- [x] 12.3 Verify same-name isolation, organization scope switching, workspace compatibility, app/server typechecks and focused tests.

## 12. Avoid package-component duplication

- [x] 12.1 Remove organization plugin-membership Skills and exact host-projected plugin Skill targets from standalone Skills and Installed, while retaining them in plugin detail and session runtime.

- [x] 10.1 Share a sidebar-preserving detail page frame and retain legacy modal presentation outside the standalone catalog.
- [x] 10.2 Route plugin/skill/connector cards and Installed shortcuts by stable identity to the same details; retain source/search on breadcrumb return.
- [x] 10.3 Verify inline/modal behavior, pending inventory selections, navigation, and typecheck/build (131 tests across separate processes, app typecheck and production build passed). Global skill paths outside the owning workspace remain metadata-only because the current read API cannot safely load them; no desktop name fallback.
- [x] 10.4 Restore full global-skill Overview and Files content through an exact-path, owning-runtime detail API; verify traversal/symlink/size limits, same-name isolation, remote ownership, UI parity, typechecks and build (65 focused tests, app/server typechecks and production build passed).
- [x] 10.5 Remove the organization raw-source detail branch so all skill sources share sanitized Markdown Overview/Files presentation without local-file fallback.
- [x] 10.6 Hide the Files tab when a skill has no local file inventory while retaining it for exact and legacy local skills (40 tests and app typecheck passed).

## 11. Bundled public skill creator

- [x] 11.1 Package and preinstall `skill-creator` as a JuggleWork-owned global skill, list it under Skills → Public, exclude it from Personal, preserve exact detail loading, and classify its Installed shortcut as Public.

## 12. Plugin card installation actions

- [x] 12.1 Treat public built-in plugins as preinstalled, add upper-right Add actions for uninstalled Marketplace plugins, add installed actions menus with Uninstall, and retain Enable/Disable as the only built-in lifecycle action.

## 13. Host plugin startup lifecycle

- [x] 13.1 Move host identity-scope activation out of the Plugins route into the always-mounted signed-in workspace shell, reuse the same controller in Settings, deactivate on sign-out/identity change, preserve the direct-OpenCode remote guard, and revalidate before session skill discovery or execution after a fail-closed server restart.
- [x] 13.2 Add global-shell integration coverage for activation without opening Plugins, sign-out cleanup, direct-remote abandonment, and in-place restart recovery; run focused tests and app typecheck.
