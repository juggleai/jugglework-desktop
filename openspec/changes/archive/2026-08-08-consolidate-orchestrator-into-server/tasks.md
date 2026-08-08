## 1. Server Runtime Hardening

- [x] 1.1 Add managed OpenCode tests for startup success, timeout/parse failure cleanup, idempotent close, and redacted execution snapshots
- [x] 1.2 Make managed OpenCode terminate its child on every readiness failure and use a single idempotent close operation
- [x] 1.3 Add embedded lifecycle tests for startup rollback, repeated/concurrent stop, listener cleanup, and cleanup error aggregation
- [x] 1.4 Make embedded Server track and release runtime-config listeners, trusted identities, HTTP listeners, and OpenCode children transactionally
- [x] 1.5 Replace credential-derived trusted process identities with PID plus a random non-secret generation nonce
- [x] 1.6 Make standalone Server signal shutdown asynchronous, idempotent, deadline-bounded, and responsible for all runtime resources
- [x] 1.7 Resolve the Server port/OpenCode callback URL race and add a collision regression test
- [x] 1.8 Run Server lifecycle, managed OpenCode, embedded, runtime-config, and full typecheck tests

## 2. Direct Headless and Container Runtime

- [x] 2.1 Add a reusable direct-Server headless launcher/configuration that resolves OpenCode and sets managed runtime environment consistently
- [x] 2.2 Change `scripts/dev-headless-web.ts` to start JuggleWork Server directly and preserve health, token, logging, and shutdown behavior
- [x] 2.3 Change Docker development entrypoints to run JuggleWork Server directly with Server-managed OpenCode
- [x] 2.4 Migrate production Docker/Cloud/worker launch commands that still invoke Orchestrator and preserve worker heartbeat requirements
- [x] 2.5 Add direct headless smoke coverage for health, workspace, session, SSE, shutdown, and no orphaned OpenCode process

## 3. Desktop Runtime Cleanup

- [x] 3.1 Remove the unused `startOrchestratorRuntime` and orchestrator daemon state/auth resolution path from Electron runtime
- [x] 3.2 Introduce runtime/engine-named Desktop IPC for status, workspace activation, and engine disposal while preserving temporary compatibility delegates
- [x] 3.3 Migrate App and Desktop callers/types from orchestrator runtime names to runtime/engine names
- [x] 3.4 Add Electron runtime tests proving normal startup and compatibility APIs never locate or spawn an orchestrator binary

## 4. Desktop-Owned Sandbox Runtime (Option A)

- [x] 4.1 Extract Docker discovery, command execution, managed container naming, doctor, stop, cleanup, inspect/log diagnostics, and debug probe into a Desktop-local sandbox runtime module
- [x] 4.2 Port and test sandbox mount allowlist, path normalization, read-only/read-write validation, and sensitive-path rejection from Orchestrator
- [x] 4.3 Implement Desktop sandbox start so the container launches JuggleWork Server directly with Server-managed OpenCode
- [x] 4.4 Migrate sandbox IPC and debug UI to the Desktop sandbox runtime without invoking an orchestrator sidecar
- [x] 4.5 Add sandbox command-construction and lifecycle tests, including unmanaged container rejection and cleanup on failed probes

## 5. CLI and Compatibility Decision

- [x] 5.1 Inventory repository and published automation expectations for `jugglework`, TUI, daemon, detach, files, approvals, and status commands
- [x] 5.2 Implement a thin direct-Server `jugglework` compatibility launcher/client or document and encode an explicit retirement decision
- [x] 5.3 Ensure any retained CLI has no independent workspace registry, duplicate OpenCode manager, Server sidecar downloader, or runtime control server
- [x] 5.4 Add migration documentation for retired commands and safe handling/cleanup of legacy orchestrator state

## 6. Orchestrator Removal and Distribution Cleanup

- [x] 6.1 Remove all active code and configuration references to the orchestrator package, binary, daemon state, and sidecar manifest
- [x] 6.2 Remove orchestrator executables and version assets from Electron preparation, signing, packaging, and runtime resolution
- [x] 6.3 Remove orchestrator GitHub release jobs, npm platform/meta publishing, version parity checks, and server-sidecar release generation
- [x] 6.4 Delete `apps/orchestrator`, update workspace dependencies and lockfile, and remove stale build/test scripts
- [x] 6.5 Update root and translated documentation, bootstrap guidance, Docker docs, and release notes to the direct-Server architecture

## 7. End-to-End Verification

- [x] 7.1 Run Server unit/e2e tests and typecheck
- [x] 7.2 Run Desktop runtime, IPC, sandbox, and packaging tests/typecheck
- [x] 7.3 Run direct headless web and Docker smoke tests (direct headless web passed; Docker command/YAML/lifecycle coverage passed, with live container launch unavailable because Docker is not installed in this environment)
- [x] 7.4 Run release review and inspect Electron/package outputs for absence of orchestrator artifacts and stale Server test files
- [x] 7.5 Verify repository-wide searches contain no unintended active orchestrator references and document any intentional migration-only references
