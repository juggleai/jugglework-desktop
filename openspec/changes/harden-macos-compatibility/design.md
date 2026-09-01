## Context

See `proposal.md` for motivation and `specs/macos-desktop-compatibility/spec.md` for the behavior contract. The desktop currently packages Electron 35 with Node 24-installed dependencies, disables native rebuilds, builds both macOS architectures on an arm64 runner, and compiles the Swift helper for the host rather than the requested target. OpenCode already requires macOS 13 and Computer Use requires macOS 14.

## Goals / Non-Goals

**Goals:**

- Make arm64 and x64 release artifacts self-consistent and mechanically auditable.
- Exercise native modules with the packaged Electron runtime, not only with the build-time Node runtime.
- Establish one complete-product macOS baseline and keep privacy-sensitive capture on supported APIs.
- Preserve the existing DMG/ZIP, updater, signing, and notarization topology.

**Non-Goals:**

- Produce a universal2 desktop artifact; architecture-specific artifacts remain the distribution model.
- Restore full-product support for macOS 11–13.
- Redesign Computer Use permissions or replace Accessibility-based input control.
- Change Linux or Windows minimum operating-system policies beyond dependency-install adjustments required by shared packaging.

## Decisions

### Upgrade Electron to 44

Electron 44 is the current stable supported release, uses Node 24, and makes the runtime ABI consistent with the repository's Node 24 toolchain. Code will be adapted for Electron 44 API changes and the lockfile will pin Electron 44.0.0, because the newer 44.1.0 patch is still inside the repository's dependency minimum-release-age window.

Alternative considered: stay on Electron 35 and rebuild specifically for ABI 133. This would fix one binary but leave the application on an unsupported Chromium/Electron line.

### Let electron-builder rebuild native dependencies for the package target

Remove `npmRebuild: false` and use electron-builder's rebuild flow for the selected platform, architecture, Electron version, and ABI. Add architecture-specific node-pty packages as direct optional dependencies so pnpm makes the target package available to electron-builder instead of retaining only the host package.

Upgrade `better-sqlite3` to 13.x for Electron 44's V8 API and prune its bundled cross-platform prebuilds from each assembled application. The standalone Bun server uses `bun:sqlite` for the same small synchronous API surface, avoiding Bun N-API crashes, while Node/Electron continues to load `better-sqlite3`.

Alternative considered: custom-copy prebuilt binaries. That is faster but fragile across Electron ABI, package layout, and operating-system targets.

### Build native Swift helpers for the requested triple

Normalize `TARGET`, `TAURI_ENV_TARGET_TRIPLE`, and host defaults into an explicit Swift target triple. Pass `--triple` to both helper build invocations and locate output through `--show-bin-path`. Intel artifacts will run on a supported Intel runner as an additional guard against cross-compile blind spots.

### Enforce macOS 14 throughout the bundle

Set electron-builder's macOS minimum version to 14.0, retain the Swift package's existing macOS 14 declaration, and update installer metadata and documentation. OpenCode's lower macOS 13 minimum remains compatible with the containing macOS 14 application.

### Validate the assembled app before publication

A repository script will inspect all Mach-O files with `lipo`, verify the bundle minimum version, confirm required sidecars/helpers, and start the packaged Electron executable in Node mode to exercise `better-sqlite3` and `node-pty`. Release and notarization-smoke workflows will run it on the unpacked `.app`.

### Remove legacy Core Graphics screenshot fallbacks

Window and display screenshots will return ScreenCaptureKit results only. The main application will declare `NSScreenCaptureUsageDescription`; no compatibility fallback will call deprecated capture APIs.

### Normalize electron-builder architecture enums in hooks

The post-pack hook will convert numeric `Arch` enum values and string values to canonical names before selecting a target triple. Unit tests will cover x64, arm64, unsupported values, and the post-pack resource behavior.

## Risks / Trade-offs

- [Electron 44 introduces breaking API changes] → Run desktop unit tests, type checks, build checks, and focused smoke tests; adjust only observed or documented incompatibilities.
- [Native rebuild increases package time] → Keep rebuild scoped to production dependencies and fail early with the packaged-runtime smoke test.
- [macOS 14 baseline drops older partial functionality] → Make the bundle declaration honest and document the breaking support boundary.
- [Intel hosted runners have a finite support horizon] → Use the currently supported explicit Intel label and keep architecture verification independent of runner identity for future migration.
- [Removing legacy capture fallback can turn degraded capture into an error] → Surface the existing screenshot failure path rather than invoking an API Apple has deprecated.

## Migration Plan

1. Land dependency, packaging, helper, and validation changes together so no release is produced with a half-migrated ABI.
2. Run local arm64 packaging and packaged-runtime verification.
3. Run CI on supported arm64 and Intel runners, including signed/notarized smoke coverage.
4. Publish the next release as architecture-specific DMG/ZIP assets with merged updater manifests.
5. Roll back the release tag if packaged-runtime validation or notarization fails; do not roll back to publishing unvalidated Electron 35 artifacts.
