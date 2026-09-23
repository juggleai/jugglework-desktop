## Why

JuggleWork's macOS distribution currently mixes incompatible Node/Electron ABIs in a shipped native module, cross-packages host-architecture binaries into Intel artifacts, and advertises a lower macOS baseline than its required sidecars and helpers actually support. The release workflows also depend on an imminently retired macOS runner and an unsupported Electron major, so compatibility and release reliability need to be made explicit and mechanically enforced now.

## What Changes

- Rebuild and verify native Node modules against the packaged Electron runtime and target CPU architecture.
- Produce architecture-correct macOS arm64 and x64 helpers, sidecars, and native dependencies, with a packaged Mach-O audit that fails mixed-architecture releases.
- Upgrade Electron to a currently supported major and adapt affected APIs and tests.
- **BREAKING**: Declare macOS 14 as the minimum supported version for the complete JuggleWork desktop product, matching the Computer Use helper and release validation.
- Move macOS CI and release jobs off the retiring `macos-14` runner while preserving explicit arm64 and Intel build coverage.
- Use ScreenCaptureKit exclusively for screenshots and provide the required screen-capture usage description.
- Correct electron-builder hook architecture handling so post-pack sidecar selection, helper signing, and validation execute for every target.

## Capabilities

### New Capabilities

- `macos-desktop-compatibility`: Defines the supported macOS baseline, architecture-pure artifacts, Electron/native-module compatibility, screen-capture behavior, and release-time validation for macOS desktop distributions.

### Modified Capabilities

None.

## Impact

- Desktop packaging and native dependencies in `apps/desktop`, including Electron, `better-sqlite3`, `node-pty`, sidecars, signing hooks, entitlements, and the Swift Computer Use helper.
- macOS installer and release/CI workflows under `.github/workflows`.
- Computer Use screenshot implementation in `packages/handsfree/native/HandsFree`.
- Supported-platform documentation and release validation tests.
