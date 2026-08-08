## Context

JuggleWork has three overlapping runtime layers. `apps/server` owns API, storage, workspace state, runtime configuration, and can spawn OpenCode. Electron already imports `apps/server/dist/embedded.js` and always chooses the direct runtime for normal desktop startup. `apps/orchestrator` still contains a second OpenCode supervisor, workspace daemon, sidecar acquisition, TUI, Docker/Apple Container hosting, detach behavior, runtime upgrade control, and CLI clients. Desktop, headless development, Docker development, release automation, and sandbox diagnostics retain references to it.

OpenWork retired its orchestrator only after workspace authority, managed OpenCode, embedded startup, runtime configuration, web serving, and worker heartbeat moved into server or deployment layers. It did not copy the orchestrator CLI into server: TUI, daemon control, detach, sandbox launching, and sidecar acquisition were retired or externalized.

The migration must preserve JuggleWork-specific contracts: `JUGGLEWORK_*` variables, `X-JuggleWork-*` headers, `jugglework-cloud`, JuggleWork runtime databases and paths, managed models URL, Safe Grep and Context Overflow plugins, and compaction defaults.

## Goals / Non-Goals

**Goals:**

- Establish `apps/server` as the only owner of managed OpenCode and workspace runtime state.
- Make embedded and standalone server lifecycle transactional, idempotent, and leak-free.
- Run headless and container deployments directly through `jugglework-server`.
- Preserve Desktop sandbox support by moving host Docker orchestration into Desktop and running Server directly inside the sandbox.
- Remove inactive orchestrator runtime code, sidecars, package/release wiring, and duplicated state after active callers migrate.
- Provide an explicit compatibility decision and migration path for the `jugglework` command.

**Non-Goals:**

- Do not merge OpenCode into the Server process.
- Do not give Server host Docker privileges or make it create child Server containers.
- Do not make Server download or replace its own executable.
- Do not copy the monolithic orchestrator CLI into `apps/server`.
- Do not rename JuggleWork protocols, stores, plugins, or cloud contracts to OpenWork equivalents.

## Decisions

### 1. Server owns runtime core; hosts own provisioning

Server owns workspace registry, managed OpenCode, runtime configuration, HTTP API, health, and shutdown. Electron, Docker image construction, Cloud provisioners, and an optional thin CLI own binary location, container creation, process service management, and updates.

This follows the proven OpenWork boundary and avoids a Server → Orchestrator → Server dependency loop.

Alternative considered: compile the entire orchestrator into Server. Rejected because it couples TUI, Solid/OpenTUI, Docker privileges, downloaders, and release policy to the API/security boundary.

### 2. Harden lifecycle before migrating callers

`startEmbeddedServer` and standalone CLI shall use a shared resource lifecycle with startup rollback and idempotent asynchronous shutdown. Runtime-config listeners, trusted process registrations, managed OpenCode children, heartbeat timers, and HTTP listeners are tracked resources.

OpenCode startup failure and timeout shall always terminate the child. Trusted identities use PID plus random nonce, never credentials. The implementation must reconcile the actual bound Server port with the URL injected into OpenCode; silent fallback may not leave the child configured with a stale URL.

### 3. Headless directly invokes Server

Headless scripts and container entrypoints prepare an OpenCode binary and invoke Server with `JUGGLEWORK_MANAGE_OPENCODE=1` and `JUGGLEWORK_OPENCODE_BIN`. Server-side workspace, health, SSE, token, environment, and shutdown behavior become the tested contract.

Sidecar acquisition remains in installer/build/deployment code. Server receives a resolved executable path.

### 4. Desktop sandbox uses a dedicated Desktop module

Stage 4 uses option A. Host-level sandbox operations move to `apps/desktop/electron/sandbox-runtime.mjs` (or an equivalent Desktop-local module): Docker discovery, doctor, validated mount construction, container naming, detached start, stop, cleanup, inspect/log diagnostics, and sandbox probe.

The container entrypoint runs one `jugglework-server` process with managed OpenCode. The module must retain mount allowlist and sensitive-path rejection semantics from the orchestrator. Sandbox IPC names become sandbox/runtime names and no longer depend on an orchestrator sidecar.

Alternative considered: put Docker control routes in Server. Rejected because it crosses the authorization and host privilege boundary.

### 5. Remove legacy runtime IPC after a compatibility transition

Normal runtime APIs use `runtimeStatus`, workspace activation, and engine reload/dispose terminology. Existing `orchestrator*` IPC may temporarily delegate to the new methods for one transition period, but must not spawn or inspect the orchestrator.

### 6. CLI compatibility is thin or retired

Before deleting the npm package, inventory actual CLI users. If compatibility is required, retain a thin `jugglework` launcher/client that starts or connects to `jugglework-server`, without a workspace registry, duplicate OpenCode manager, Server sidecar downloader, or runtime control server. TUI and daemon behavior require explicit product justification and tests; otherwise they are retired with migration documentation.

### 7. Deletion is the last phase

Only after active code paths and tests no longer reference it will the change remove `apps/orchestrator`, Electron sidecar resources, release jobs, npm platform packages, lockfile dependencies, and docs. Persisted orchestrator state is not silently treated as Server state; import or cleanup is explicit.

## Risks / Trade-offs

- [Headless behavior changes while replacing a mature wrapper] → Add direct-Server smoke tests for health, workspace, session, SSE, shutdown, and orphan cleanup before changing entrypoints.
- [Port race gives OpenCode a stale Server URL] → Make bound port authoritative and test collisions; either bind before spawning OpenCode or fail/retry the whole startup generation.
- [Desktop sandbox loses mount protections] → Port allowlist and blocked-path tests before removing orchestrator sandbox code.
- [Removing the npm CLI breaks automation] → Decide thin compatibility launcher versus retirement, publish migration commands, and stage deprecation before removal.
- [Server package gains too many host concerns] → Keep Docker, downloading, updater, and TUI code outside Server.
- [Large cross-cutting change is difficult to review] → Implement and verify each numbered stage independently; keep OpenSpec tasks and commits separable.
- [Existing orchestrator daemon state becomes orphaned] → Add a documented cleanup/import path and never reinterpret incompatible workspace IDs.
- [Platform-specific shutdown regressions] → Test macOS, Linux/container, and Windows process termination paths; use idempotent deadlines and execution generations.

## Migration Plan

1. Add lifecycle tests and harden Server embedded/CLI/managed OpenCode behavior without changing callers.
2. Change headless development and Docker/worker entrypoints to direct Server startup and verify parity.
3. Remove dead Desktop orchestrator startup code and migrate runtime IPC names/callers.
4. Implement Desktop-owned sandbox runtime, change sandbox IPC to it, and remove sandbox dependency on the orchestrator binary.
5. Implement or explicitly retire the thin CLI/TUI compatibility surface.
6. Remove orchestrator package, sidecar assets, release automation, dependencies, and documentation references.
7. Run full Server, Desktop runtime, headless, Docker, sandbox, release-review, and package-content verification.

Rollback is stage-local until phase 6: callers can be switched back to the existing orchestrator while its package remains. Phase 6 is performed only after direct paths pass and can be reverted as one cleanup unit if release packaging fails.

## Open Questions

- Does the published `jugglework` CLI have external users requiring a deprecation release, or can it be retired immediately after a documented replacement?
- Is Apple Container support still required, or is Desktop sandbox support explicitly Docker/microsandbox-only?
- Should old `~/.jugglework/jugglework-orchestrator` state be imported, archived, or only documented for manual removal?
- Is a production headless static UI required, or is direct Server plus a separately hosted web build sufficient?
