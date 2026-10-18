## Context

The branch contains an initial Toonflow v2 module, Bun build/staging script, Electron service/view manager, app route and navigation entry, and JuggleWork Server model bridge. The implementation currently runs Toonflow as a separate loopback service and embeds its Vue application in a sandboxed `WebContentsView`, but it still shares one runtime/data directory across workspaces, retains Toonflow onboarding and dynamic extension surfaces, resolves credentials outside the canonical workspace policy path, and submits media through a second non-durable provider path. The build also depends on preinstalled module dependencies and does not yet prove target-platform Bun inventory or signing.

The replacement changes the architecture selected by the earlier native Toon Factory work. The sidecar is an application component maintained and distributed with JuggleWork, while code installable from the Toonflow UI is not trusted and cannot inherit the sidecar broker capability.

## Goals / Non-Goals

**Goals:**

- Replace the native Toon Factory UI/runtime with the managed Toonflow v2 sidecar.
- Preserve the requested overflow-menu placement, Chinese product name, and pin behavior.
- Bind every running instance, data directory, browser partition, broker call, and credential decision to one JuggleWork workspace.
- Keep provider secrets inside JuggleWork and enforce the same policy/provenance used by normal JuggleWork model calls.
- Reuse durable and idempotent JuggleWork media jobs and validated artifacts.
- Make clean checkout builds and packaged startup reproducible on every supported desktop target.
- Bound startup, hide/close, workspace switch, crash, sign-out, update, and application-exit behavior.

**Non-Goals:**

- Supporting Toonflow’s own provider accounts, TF-Router login, balances, provider marketplace, or editable provider runtime.
- Treating `node:vm`, UMD plugins, or dynamically imported tools as a security sandbox.
- Running multiple Toonflow workspaces concurrently in the first release.
- Exposing JuggleWork API keys, OpenCode auth files, host tokens, or unrestricted Desktop IPC to the sidecar or its page.
- Preserving the native Toon Factory runtime after migration; compatibility/import must be an explicit migration path rather than two production implementations.
- Adding audio-generation providers in this change. Managed mode disables unsupported AI node types with a clear explanation.

## Decisions

### 1. One workspace-bound sidecar at a time

Electron owns a dedicated serialized manager with `open(workspaceId)`, `hide()`, `close()`, `restart(workspaceId)`, `status()`, and `dispose()`. Opening a different workspace MUST stop and destroy the old view, server, broker, tokens, timers, and listeners before starting the new one. Data lives below an opaque hash of the workspace ID, and the `WebContentsView` partition is also workspace-specific.

This is preferred over one global sidecar because model credentials, project history, and settings must not leak across workspaces. It is preferred over concurrent instances because Toonflow retains process-global configuration and module singletons.

### 2. Sandboxed view, authenticated loopback server

The Vue UI remains same-origin with its Bun server and runs in a dedicated `WebContentsView` with sandboxing, context isolation, no Node integration, denied permissions, navigation restrictions, and no JuggleWork preload. The sidecar binds only to `127.0.0.1:0`, reports readiness over a structured process channel, validates a per-instance browser session token, and does not use wildcard CORS.

The broker is not a public Toonflow endpoint. Electron gives the sidecar a short-lived, workspace-bound capability that only reaches an allowlisted JuggleWork Server broker route. Tokens are excluded from URLs, browser storage, logs, project files, and error payloads.

### 3. Managed mode is an allowlist, not scattered UI hiding

`jugglework=1` is a server-enforced runtime mode. The managed Web UI skips `/hello` and exposes only project, workspace, canvas/document/assets, approved built-in nodes/tools, and read-only JuggleWork model selection. The server rejects install/manage calls for providers, tools, nodes, extensions, agents, MCP/A2A external exposure, mobile link, developer operations, and TF-Router services even if a caller bypasses the UI.

Only build-staged resources with an inventory hash are loaded. This avoids granting the broker capability to dynamically installed code in the same Bun process.

### 4. JuggleWork owns model execution

The sidecar receives public descriptors containing `providerID`, `modelID`, names, supported modes, and limits required by the UI. Discovery and execution use canonical workspace-aware JuggleWork provider and policy services; the broker does not read `auth.json`, raw provider keys, or custom provider configuration itself.

Text generation returns a normalized streaming contract that preserves Toonflow’s text/reasoning/tool-call needs while executing through JuggleWork/OpenCode. Each request carries workspace identity, model reference, request ID, cancellation signal, and bounded attachment metadata.

Image/video requests use JuggleWork’s existing media runtime. A client-generated stable request ID is mandatory. Submission creates or reuses a durable job; polling and cancellation operate on that job; completed output is a JuggleWork-validated artifact copied/imported into the Toonflow workspace through a bounded broker operation. Unknown submission outcomes are not automatically retried.

### 5. Reproducible staged distribution

The Toonflow module is tracked at a pinned v2 revision with a deterministic dependency strategy. A clean root install plus the documented build command MUST be sufficient; the build must not rely on an existing nested `node_modules`. Target-specific Bun binaries are selected by target triple, version-pinned, checksum-verified, and recorded in a manifest.

Package verification checks the server/Web/resource inventory, Bun format/architecture, executable permission, hashes, and platform signing. CI path filters include the module and sidecar build/runtime files. A packaged smoke test opens the managed home, lists models without secrets, switches workspaces, hides/reopens, and exits without orphan processes.

### 6. Replacement and rollback

The navigation destination switches to the sidecar immediately, but removal of native storage/schema code happens only after migration and rollback tests exist. During rollout, a build-time emergency flag may restore the old destination without running both runtimes concurrently. Rollback stops the sidecar and restores the previous application version; portable Toonflow project files remain outside credentials and runtime metadata.

## Risks / Trade-offs

- **Two frontend/runtime stacks increase package size and maintenance** → Pin Toonflow/Bun revisions, isolate the module boundary, and automate clean-build/package verification.
- **A sidecar plugin can inherit process capabilities** → Managed mode server-enforces a fixed built-in resource allowlist and disables dynamic installation/execution.
- **Workspace switches can route requests with stale authority** → Serialize lifecycle transitions, scope every token to workspace/instance, and reject mismatched broker requests.
- **Paid generation can be duplicated after network ambiguity** → Require stable request IDs and use durable JuggleWork jobs with no implicit resubmission.
- **Provider output URLs can enable SSRF** → JuggleWork downloads and validates artifacts with its protected fetch path; the sidecar does not fetch arbitrary provider URLs.
- **Bun/native resources can fail after packaging** → Verify target architecture, permissions, hashes, signing, startup, and shutdown from unpacked/final artifacts.
- **Stopping on every navigation is slow** → Hide the view for short navigation intervals, but force close on workspace switch, sign-out, permission revocation, update, explicit close/idle timeout, and app exit.

## Migration Plan

1. Stabilize clean module build, target Bun staging, and package inventory verification.
2. Enforce managed mode and disable dynamic/external extension surfaces server-side and in the UI.
3. Make the route, runtime, data directory, partition, and broker workspace-bound; add lifecycle cleanup.
4. Replace credential fallback and direct provider calls with canonical text and durable media broker services.
5. Complete navigation, pin, translations, and inset-page regressions.
6. Add packaged smoke coverage and release gates.
7. Add native Toon Factory project migration/compatibility decision and remove obsolete native code only after acceptance evidence.

Rollback retains the previous release artifact and native project bytes. A failed sidecar startup shows a bounded error and retry action rather than falling through to an unauthenticated local page.

## Open Questions

- Whether existing native Toon Factory v2 project files are directly compatible, require one-time conversion, or remain read-only imports.
- Whether the initial release stops the hidden sidecar immediately or after a bounded idle timeout.
- Which subset of Toonflow built-in tools/nodes is approved for the first managed inventory.
- Whether audio nodes are hidden or displayed disabled until JuggleWork gains an audio-generation runtime.
