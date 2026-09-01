## 1. Native SQLite ABI

- [x] 1.1 Enable Electron-targeted native dependency rebuilds and add a packaged `better-sqlite3` in-memory query smoke test.
- [x] 1.2 Verify the current arm64 package no longer reports a Node module ABI mismatch.

## 2. Architecture-Correct Native Artifacts

- [x] 2.1 Make all node-pty platform packages available as direct optional desktop dependencies.
- [x] 2.2 Compile the Computer Use Swift helper for the requested target triple.
- [x] 2.3 Add packaged Mach-O architecture validation and exercise it for arm64 and x64 release jobs.

## 3. Supported Electron Runtime

- [x] 3.1 Upgrade Electron to the current supported 44.x release and refresh the lockfile.
- [x] 3.2 Adapt affected desktop APIs and pass Electron unit, bridge, and runtime checks.

## 4. macOS Support Baseline

- [x] 4.1 Declare macOS 14.0 as the desktop and installer minimum system version.
- [x] 4.2 Update source-build and support documentation and validate generated bundle metadata.

## 5. Supported macOS CI Runners

- [x] 5.1 Move Apple Silicon CI and release jobs from `macos-14` to a supported arm64 runner.
- [x] 5.2 Build and smoke-test x64 desktop and installer artifacts on a supported Intel runner.

## 6. ScreenCaptureKit-Only Capture

- [x] 6.1 Remove deprecated Core Graphics screenshot fallbacks from Computer Use.
- [x] 6.2 Add the screen-capture usage description and pass Swift helper build checks.

## 7. Post-Pack Architecture Handling and Verification

- [x] 7.1 Normalize electron-builder numeric and string architecture values in the post-pack hook.
- [x] 7.2 Add hook regression tests for sidecar selection, helper processing, and unsupported architectures.
- [x] 7.3 Run OpenSpec validation, dependency checks, desktop tests, packaging smoke tests, and review the final diff.
