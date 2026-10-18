## Why

The native JuggleWork Toon Factory does not preserve the complete Toonflow v2 product and creates a second implementation to maintain. Replace it with a packaged, on-demand Toonflow v2 sidecar while keeping JuggleWork as the sole authority for provider credentials, model policy, paid generation jobs, filesystem authorization, and desktop lifecycle.

## What Changes

- **BREAKING**: Remove the native React/server Toon Factory surface from the product and replace its navigation destination with the managed Toonflow v2 sidecar.
- Add “漫剧工厂” below Code Review in the left navigation overflow menu and allow it to be pinned into the primary rail with the existing pin behavior.
- Start a workspace-bound Bun sidecar and sandboxed `WebContentsView` only when the user opens the surface; isolate its data, browser storage, processes, ports, and capabilities from the normal JuggleWork runtime.
- Add a managed Toonflow mode that skips Toonflow onboarding and removes provider credentials, TF-Router login, balances, marketplace installation, dynamic server plugins, external MCP/A2A exposure, and developer controls.
- Expose only policy-allowed JuggleWork text/image/video models through a least-privilege broker; never expose provider credentials or host tokens to Toonflow.
- Route paid image/video operations through JuggleWork’s durable, idempotent media runtime and validated artifacts instead of creating a second provider execution path.
- Package a pinned Toonflow v2/Bun distribution reproducibly for each desktop platform and verify inventory, architecture, executable permissions, signing, startup, workspace switching, and shutdown.

## Capabilities

### New Capabilities
- `toonflow-sidecar-runtime`: On-demand, workspace-isolated sidecar and sandboxed view lifecycle, navigation integration, managed mode, packaging, and release verification.
- `toonflow-model-broker`: Credential-safe model discovery and text/media execution using JuggleWork policy, durable jobs, cancellation, and validated artifacts.

### Modified Capabilities
- `desktop-sandbox-runtime`: Extend desktop sandbox and process-lifecycle guarantees to the packaged Toonflow sidecar and its view.

## Impact

- Desktop main/preload IPC, runtime cleanup, view layout, packaging scripts, Electron Builder resources, release workflows, and package verification.
- App routes, left navigation overflow/pins, translations, inset-page behavior, and replacement/removal of the native Toon Factory domain.
- Server model discovery, credential resolution, text generation, image/video jobs, authorization, auditing, and artifact delivery.
- A vendored or staged Toonflow v2 module, its managed-mode Web/Server changes, Bun runtime, plugins, FFmpeg/document dependencies, and lockfiles.
- Existing native Toon Factory routes, services, schemas, database tables, tests, and project compatibility require an explicit retirement/migration decision before deletion.
