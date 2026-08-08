## Why

JuggleWork currently has overlapping runtime ownership across `apps/orchestrator`, `apps/server`, and the Electron main process, even though the normal desktop path already embeds the server and lets it manage OpenCode. This duplication causes lifecycle drift, larger release artifacts, stale IPC and documentation, and separate workspace, port, credential, environment, and shutdown implementations.

## What Changes

- Make `apps/server` the single runtime owner for local workspace state, managed OpenCode, runtime configuration, health, and headless operation.
- Harden server startup and shutdown so embedded and standalone modes clean up listeners, trusted identities, OpenCode children, and HTTP listeners on success, failure, restart, and signals.
- Replace headless development and Docker entrypoints that launch `jugglework-orchestrator` with direct `jugglework-server` startup using server-managed OpenCode.
- Remove obsolete desktop orchestrator runtime paths and rename compatibility IPC to runtime/engine terminology where still needed.
- Keep desktop sandbox support by moving host-level Docker sandbox creation, probing, stopping, and cleanup into a dedicated Desktop runtime module; containers run `jugglework-server` directly.
- Retain only a thin `jugglework` CLI compatibility surface if required, without a second workspace registry or duplicate OpenCode/server supervision.
- **BREAKING**: retire the standalone orchestrator daemon/router state, TUI, sidecar-server download protocol, and orchestrator runtime-upgrade ownership after replacements and compatibility guidance are in place.
- Remove orchestrator package, sidecar assets, release jobs, dependencies, and stale documentation only after all active callers are migrated.

## Capabilities

### New Capabilities
- `server-owned-runtime`: JuggleWork Server owns managed OpenCode, workspace runtime state, deterministic lifecycle, and direct headless startup.
- `desktop-sandbox-runtime`: Electron owns host-level sandbox orchestration while sandbox containers run JuggleWork Server directly.
- `orchestrator-retirement`: Active callers, packaging, IPC, release automation, CLI compatibility, and persisted-state behavior are migrated before the orchestrator package is removed.

### Modified Capabilities

None. This repository does not currently contain baseline OpenSpec capability specs for the affected runtime behavior.

## Impact

- Server: `apps/server/src/cli.ts`, `embedded.ts`, `managed-opencode.ts`, runtime config lifecycle, heartbeat/static hosting as required, tests, and package entrypoints.
- Desktop: `apps/desktop/electron/runtime.mjs`, main-process IPC, sandbox implementation, sidecar preparation, electron-builder resources, and runtime tests.
- App/types: desktop IPC names, debug/sandbox callers, compatibility adapters, and UI references.
- Headless/deployment: `scripts/dev-headless-web.ts`, Docker Compose/Dockerfiles/entrypoints, Cloud worker launch commands, and operational documentation.
- Distribution: orchestrator npm/platform packages, GitHub release workflow, sidecar manifests, version parity checks, lockfile, and translated READMEs.
- Users of `jugglework-orchestrator`, daemon/router, TUI, detach, or sandbox commands require either a compatibility CLI or explicit migration guidance.
