## 1. Qiniu feed resolution

- [ ] 1.1 Add one tested update-feed resolver for stable, Alpha, and strict targeted versions across macOS, Windows, and Linux using `https://downloads.jugglechat.cn/jugglework/releases`
- [ ] 1.2 Route `electron-updater` stable/Alpha checks and Den-selected targeted updates through the resolver, removing active GitHub fallback and rejecting mismatched target manifests
- [ ] 1.3 Disable normal stable-channel downgrade while preserving current version comparison, retry, progress, download, install, and restart behavior
- [ ] 1.4 Replace architecture-replacement and manual-fallback GitHub URL construction with manifest parsing that selects the native architecture's DMG or returns unavailable
- [ ] 1.5 Migrate Alpha release/download constants and every updater-facing active GitHub URL, while preserving only the explicitly isolated legacy bridge publication tooling
- [ ] 1.6 Add unit tests for platform/channel/version URL resolution, Alpha behavior, target-version mismatch, same/older versions, unavailable feeds, architecture selection, and absence of silent fallback

## 2. Packaged updater configuration

- [ ] 2.1 Replace the top-level GitHub electron-builder publisher with platform-specific generic Qiniu feed configuration so every packaged `app-update.yml` resolves to its own platform
- [ ] 2.2 Extend packaged verification to fail when `app-update.yml` or compiled updater/manual-download code contains an active GitHub update origin
- [ ] 2.3 Extend packaged verification to assert the selected macOS feed, bundle id, expected Team identity, hardened runtime, and monotonic updater settings
- [ ] 2.4 Preserve ZIP and DMG build targets and both blockmaps, with focused packaging tests proving macOS automatic update inventory includes a ZIP

## 3. Manifest construction and validation

- [ ] 3.1 Add a deterministic macOS manifest normalizer that emits absolute immutable Qiniu URLs and selects the compatible ZIP as top-level `path`/`sha512`
- [ ] 3.2 Add strict manifest validation for version, platform, architecture, object key layout, duplicate/missing files, HTTPS origin, size, SHA-512, and ZIP-primary requirements
- [ ] 3.3 Add tests for arm64-only, x64-only, mixed-architecture, universal, wrong-origin, mutable-object, DMG-only, stale-version, and corrupted-hash manifests
- [ ] 3.4 Add release metadata generation for SHA-256, SHA-512 Base64, file size, MIME type, and Qiniu ETag without reading or logging credential values

## 4. Qiniu release workflow

- [ ] 4.1 Add a release CLI with `plan`, `build`, `verify-local`, `upload-version`, `verify-cdn`, `promote-channel`, `verify-only`, and safe `resume` phases
- [ ] 4.2 Implement dry-run output and strict version/channel/platform/architecture inputs with no filesystem, Qiniu, CDN, GitHub, or Den mutation
- [ ] 4.3 Implement immutable-object preflight and non-overwrite upload for ZIP, DMG, blockmaps, and version manifest; resume only exact remote matches
- [ ] 4.4 Implement CI serialization plus a non-overwriting Qiniu promotion lock, explicit stale-lock diagnostics, and audited manual lock recovery
- [ ] 4.5 Promote the mutable stable/alpha manifest only after all immutable objects and version-feed canary gates pass, then refresh/purge CDN and verify public digest convergence
- [ ] 4.6 Verify Qiniu stat size/ETag plus CDN HTTPS, MIME, Content-Length, byte range, full GET, size, and SHA-512 for every referenced object
- [ ] 4.7 Generate a non-secret release evidence artifact containing commit, version, keys, hashes, sizes, ETags, signing/notarization, manifest digest, CDN checks, bridge IDs, Den read-back, and timestamps
- [ ] 4.8 Add mocked/fixture tests for preflight refusal, matching resume, mismatched remote objects, partial upload, lock contention, failed canary, failed CDN refresh/read-back, and promotion ordering

## 5. macOS signing and notarization gate

- [ ] 5.1 Replace the hard-coded `notarize: false` production path with explicit environment-gated Apple notarization while keeping credentials in local/CI secret storage only
- [ ] 5.2 Verify the signed `.app`, ZIP contents, and DMG use bundle id `com.juggleai.jugglework`, Team `H7PDHSK3C7`, hardened runtime, and the expected minimum macOS version
- [ ] 5.3 Verify notarization submission, stapled ticket, `codesign --deep --strict`, and Gatekeeper acceptance; prevent stable promotion when any gate is unavailable or fails
- [ ] 5.4 Add candidate-only behavior for environments without notarization credentials, proving it cannot call stable promotion

## 6. Build and publish the 1.2.15 bridge

- [ ] 6.1 Bump app/desktop/embedded-server versions from 1.2.14 to 1.2.15 only after updater and release tooling tests pass
- [ ] 6.2 Build isolated macOS arm64 ZIP, ZIP blockmap, DMG, DMG blockmap, and normalized version manifest with Qiniu packaged defaults
- [ ] 6.3 Complete local package, native module, updater inventory, Developer ID, notarization, stapling, Gatekeeper, version, architecture, and embedded-origin verification
- [ ] 6.4 Upload and remotely verify immutable `jugglework/releases/v1.2.15/mac/arm64/` artifacts and `v1.2.15/mac/latest-mac.yml` without overwrite
- [ ] 6.5 Use a clean unpublished lower-version build containing the new updater code to install `1.2.15` through the targeted Qiniu version feed, restart, and verify version, user data, workspace authorization, and permissions
- [ ] 6.6 Promote and read back `stable/mac/latest-mac.yml`, then verify a clean Qiniu-enabled lower-version client discovers the stable feed
- [ ] 6.7 Publish the exact same signed artifacts and manifest once as the final GitHub stable bridge and verify a stock installed `1.2.14` client upgrades to `1.2.15`
- [ ] 6.8 Determine from supported-client inventory whether a legacy Alpha bridge is required; if required, publish and verify a semantically newer Qiniu-enabled prerelease before retiring the GitHub Alpha feed
- [ ] 6.9 Update and read back Den published/latest version metadata only after Qiniu and GitHub bridge canaries pass; leave organization allowlists unchanged unless separately authorized

## 7. Prove Qiniu-only ongoing updates

- [ ] 7.1 Prepare a newer Qiniu-only patch release (planned 1.2.16) with the same immutable artifact, signing, notarization, and promotion gates
- [ ] 7.2 Upgrade a clean `1.2.15` installation to the newer release and prove manifest/download traffic uses Qiniu with no GitHub request
- [ ] 7.3 Verify interrupted download, missing/malformed manifest, hash mismatch, wrong architecture, wrong publisher, stale stable pointer, retry, install restart, and stuck ShipIt cleanup behavior
- [ ] 7.4 Verify stable, Alpha, targeted-version, architecture-replacement, and manual-DMG paths against public CDN responses

## 8. Documentation and final validation

- [ ] 8.1 Document routine Qiniu release, dry-run, verification-only, safe resume, promotion lock recovery, CDN cache refresh, Den ordering, bridge support, and higher-patch rollback
- [ ] 8.2 Run updater/release unit tests, app and Electron typechecks, complete Desktop tests, packaged macOS verification, strict OpenSpec validation, and `git diff --check`
- [ ] 8.3 Record final 1.2.15 and Qiniu-only canary evidence in the change without secrets and confirm all versioned remote size/hash values match local artifacts
