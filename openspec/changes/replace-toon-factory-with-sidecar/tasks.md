## 1. Baseline and Navigation

- [x] 1.1 Stage the Toonflow v2 source module and add a desktop build entry.
- [x] 1.2 Add the 漫剧工厂 overflow item below Code Review and route it to the sidecar surface.
- [x] 1.3 Add persistent pin and unpin support for 漫剧工厂 in the primary navigation rail.
- [x] 1.4 Update navigation, inset-page, route, and translation tests for the replacement surface.
- [x] 1.5 Remove the native React Toon Factory from runtime routing and define the native project migration/removal boundary.

## 2. Workspace-Bound Desktop Runtime

- [x] 2.1 Add a dedicated Electron Toonflow manager that starts Bun on loopback and embeds a sandboxed `WebContentsView`.
- [x] 2.2 Add typed renderer-to-main commands for opening, laying out, and observing the sidecar.
- [x] 2.3 Change the route and open contract to carry the active workspace ID and reject missing or stale identity.
- [x] 2.4 Isolate the sidecar data directory and browser partition by an opaque workspace identifier.
- [x] 2.5 Serialize workspace switches so the old process, view, tokens, broker state, timers, and listeners are destroyed first.
- [x] 2.6 Add explicit hide, close/restart, crash state, sign-out/update/permission cleanup, bounded process-tree termination, and lifecycle tests.
- [x] 2.7 Authenticate all sidecar browser requests, restrict navigation and origins, and ensure capabilities never enter URLs, storage, projects, or logs.

## 3. Managed Toonflow Mode

- [x] 3.1 Add a JuggleWork model settings surface to the Toonflow Web application.
- [x] 3.2 Skip Toonflow onboarding and open the project home on first managed launch.
- [x] 3.3 Define a managed UI panel allowlist and remove TF-Router, provider, balance, marketplace, MCP/A2A, mobile-link, and developer controls.
- [x] 3.4 Server-side reject dynamic provider/tool/node/extension/agent installation and external MCP/A2A/mobile/developer endpoints in managed mode.
- [x] 3.5 Load only build-staged resources with a pinned inventory/hash and add endpoint-bypass tests.
- [x] 3.6 Hide or disable unsupported AI node types such as audio without offering Toonflow provider configuration.

## 4. JuggleWork Model Broker

- [x] 4.1 Add an authenticated Toonflow bridge route and omit API keys and base URLs from model catalog responses.
- [x] 4.2 Replace direct `auth.json` and raw provider-key fallback with canonical workspace policy and credential provenance checks.
- [x] 4.3 Add workspace-bound, cancellable, bounded text streaming through JuggleWork/OpenCode and cover agent/tool-call event mapping.
- [x] 4.4 Replace direct image provider calls with durable JuggleWork jobs, stable request IDs, and validated artifact import.
- [x] 4.5 Replace the in-memory video job map with durable JuggleWork submission, polling, cancellation, restart recovery, and no implicit resubmission.
- [x] 4.6 Ensure provider result downloads use JuggleWork SSRF protections and the sidecar never fetches arbitrary result URLs.
- [x] 4.7 Add cross-workspace credential isolation, secret-redaction, idempotency, restart, cancellation, and unknown-outcome tests.

## 5. Reproducible Packaging

- [x] 5.1 Include the staged Toonflow distribution in Electron Builder resources.
- [x] 5.2 Make a clean root checkout install and build the module without pre-existing nested `node_modules`.
- [x] 5.3 Pin and checksum target-specific Bun binaries and emit a sidecar inventory manifest.
- [x] 5.4 Add module paths to Electron CI triggers and execute the clean sidecar build in release jobs.
- [x] 5.5 Verify packaged inventory, Bun format/architecture, executable permissions, hashes, macOS signing, and Windows/Linux equivalents.

## 6. Verification and Rollout

- [x] 6.1 Fix the Electron Toonflow smoke runner and verify first launch, model listing without secrets, workspace A-to-B switch, hide/reopen, and clean shutdown.
- [x] 6.2 Run focused App, Server, Desktop, Toonflow Web/Server typechecks and tests from a clean dependency state.
- [ ] 6.3 Run production builds and unpacked package verification on each supported target or record explicit CI evidence.
- [x] 6.4 Validate this OpenSpec change strictly and document completed evidence, rollback behavior, and any deferred migration decision.
