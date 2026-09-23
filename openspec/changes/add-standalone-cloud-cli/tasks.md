## 1. Command and Configuration Foundation

- [x] 1.1 Refactor argument parsing into hierarchical command objects while preserving positional prompts and the existing `resume`, `sessions`, and `status` aliases.
- [x] 1.2 Add distinct Cloud configuration fields and precedence for `--cloud-url`, `JUGGLEWORK_CLOUD_URL`, `JUGGLEWORK_CLOUD_TOKEN`, and `JUGGLEWORK_CLOUD_ORG`, with `https://work.jugglechat.cn` as the default.
- [x] 1.3 Split Cloud-only dispatch from runtime dispatch and add tests proving account and read-only inventory commands never resolve OpenCode or start an embedded Server.
- [x] 1.4 Align CLI version sourcing with the package/release version so help, native binaries, tags, and package metadata cannot drift.

## 2. Cloud Account and Organization

- [x] 2.1 Implement strict Cloud URL normalization and endpoint derivation for origin, `/jwork`, supported API suffixes, and rejected credential/query/fragment inputs.
- [x] 2.2 Implement a browser-neutral Cloud HTTP client for handoff exchange, current user, organizations, provider inventory, provider connection details, public catalog metadata, and logout with normalized redacted errors.
- [x] 2.3 Implement protected, atomic, deployment-keyed Cloud profile storage with malformed-file recovery, per-profile organization selection, and non-persistent environment token override.
- [x] 2.4 Implement `login`, `login status`, and `logout`, accepting raw one-time grants and CLI handoff links without logging them and documenting browser-and-paste behavior for local and remote terminals.
- [x] 2.5 Implement `org list` and `org use` with exact ID/slug matching, interactive disambiguation, stale-membership handling, and deterministic non-interactive errors.
- [x] 2.6 Add tests for expired/replayed/malformed grants, profile permissions, atomic replacement, multi-deployment isolation, login-status exit codes, secret redaction, and organization headers.
- [x] 2.7 Add a pre-runtime, unauthenticated interactive sign-in selector with browser/paste/continue paths and non-echoing handoff input, while bypassing onboarding for scripted and connected commands.

## 3. Provider and Model Inventory

- [x] 3.1 Implement separately labeled `catalog list`, `provider list`, and `model list` commands with human and NDJSON renderers.
- [x] 3.2 Ensure public catalog requests never receive account or organization headers and organization inventory requests always receive the selected organization headers.
- [x] 3.3 Add runtime status fields that distinguish published, imported, loaded, authenticated, enabled, and verified-executable models.
- [x] 3.4 Add fixture and contract tests for empty inventories, removed publications, pagination if present, unknown provider types, and credential-free output.

## 4. Safe Provider Import

- [x] 4.1 Extract browser-neutral provider eligibility, credential resolution, model metadata, environment naming, runtime patch, and import-baseline helpers into a shared package used by Desktop and CLI.
- [x] 4.2 Add host-authorized Server routes and client methods to set and remove workspace-scoped OpenCode provider authentication without returning or auditing credential bodies.
- [x] 4.3 Add CLI runtime client methods for protected user environment updates, provider authentication, workspace config patching, reload, and provider visibility checks.
- [x] 4.4 Implement idempotent `provider import` and `provider remove` orchestration with staged redacted errors and no blind destructive rollback.
- [x] 4.5 Add tests for missing host authority, retries after each import-stage failure, pre-existing values, Desktop-compatible baselines, concurrent reconciliation, and post-import verification.

## 5. Self-Contained OpenCode Distribution

- [x] 5.1 Define the supported OpenCode version/source, license attribution, per-platform acquisition or build process, and integrity metadata for release artifacts.
- [x] 5.2 Extend CLI build staging to include the matching OpenCode sidecar, required plugins, and a checksummed compatibility manifest for macOS, Linux, and Windows targets.
- [x] 5.3 Update runtime resolution to prefer the manifest-declared adjacent sidecar in installed releases while retaining explicit source/development overrides.
- [x] 5.4 Add package-content, checksum, executable-permission, version-compatibility, code-signing/notarization, and clean-machine startup checks to release CI.
- [x] 5.5 Remove Desktop/global OpenCode as a documented installation requirement and produce per-platform installation and upgrade instructions.

## 6. Codex-Style Execution and Interaction

- [x] 6.1 Add explicit `exec` mode with positional-or-stdin prompts, separate piped context, progress on stderr, final response on stdout, NDJSON, final-message file output, and schema-constrained results.
- [x] 6.2 Add grouped session commands for list, show, resume, fork, queue, rename, archive, unarchive, and confirmed deletion while retaining high-frequency aliases.
- [x] 6.3 Add workspace command foundations and a compact searchable contextual slash-command palette for model, organization, permissions, status, planning, sessions, workspace, Connect, MCP, skills, extensions, compact, copy, doctor, logout, and exit.
- [x] 6.4 Preserve explicit sandbox and approval dimensions, fail closed in non-interactive runs, and add conspicuously named expert-only bypass flags subject to Server policy.
- [x] 6.5 Add completion generation, hierarchical help snapshots, contextual command-availability tests, terminal/no-terminal behavior tests, and stable exit-code tests.

## 7. Diagnostics, Documentation, and Release

- [x] 7.1 Implement redacted `doctor` human and JSON reports covering Cloud reachability/login, organization selection, sidecar manifest/assets, workspace access, runtime health, and provider/model states.
- [x] 7.2 Update CLI, root, Server, bootstrap, Docker, and release documentation to distinguish the retired orchestrator from the supported standalone `jugglework` CLI.
- [x] 7.3 Add CLI tests and native packaging smoke tests to standard CI and add `@jugglework/cli` artifacts to the release/publish workflow.
- [ ] 7.4 Run CLI unit/integration tests, typecheck, Server provider-auth regression tests, Desktop provider-import regression tests, native clean-machine smoke tests, package-content checks, and strict OpenSpec validation.
- [x] 7.5 Record user-reported local installation, successful CLI login, and basic usage smoke test.
- [ ] 7.6 Complete release canary: verify the exact Cloud endpoint, organization provider import, and task execution on a clean machine without Desktop or global OpenCode; record artifact identity, signing, promotion, and rollback evidence.

User-reported evidence for 7.5 (2026-09-23): the user installed the JuggleWork CLI on their machine and verified login and basic usage. This is a manual report, not an independently captured CLI transcript. The report does not establish the precise Cloud endpoint, organization provider import, packaged sidecar isolation, a clean-machine test, or a published/signed release; those remain in 7.6. Task 7.4 remains open pending its full verification gates.
