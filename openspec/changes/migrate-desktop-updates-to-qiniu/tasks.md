## 1. Qiniu feed resolution

- [x] 1.1 Add one tested update-feed resolver for stable, Alpha, and strict targeted versions across macOS, Windows, and Linux using `https://downloads.jugglechat.cn/jugglework/releases`
- [x] 1.2 Route `electron-updater` stable/Alpha checks and Den-selected targeted updates through the resolver, removing active GitHub fallback and rejecting mismatched target manifests
- [x] 1.3 Disable normal stable-channel downgrade while preserving current version comparison, retry, progress, download, install, and restart behavior
- [x] 1.4 Replace architecture-replacement and manual-fallback GitHub URL construction with manifest parsing that selects the native architecture's DMG or returns unavailable
- [x] 1.5 Migrate Alpha release/download constants and every updater-facing active GitHub URL, removing legacy GitHub updater publication tooling
- [x] 1.6 Add unit tests for platform/channel/version URL resolution, Alpha behavior, target-version mismatch, same/older versions, unavailable feeds, architecture selection, and absence of silent fallback

## 2. Packaged updater configuration

- [x] 2.1 Replace the top-level GitHub electron-builder publisher with platform-specific generic Qiniu feed configuration so every packaged `app-update.yml` resolves to its own platform
- [x] 2.2 Extend packaged verification to fail when `app-update.yml` or compiled updater/manual-download code contains an active GitHub update origin
- [x] 2.3 Extend packaged verification to assert the selected macOS feed, bundle id, expected Team identity, hardened runtime, and monotonic updater settings
- [x] 2.4 Preserve ZIP and DMG build targets and both blockmaps, with focused packaging tests proving macOS automatic update inventory includes a ZIP

## 3. Manifest construction and validation

- [x] 3.1 Add a deterministic macOS manifest normalizer that emits absolute immutable Qiniu URLs and selects the compatible ZIP as top-level `path`/`sha512`
- [x] 3.2 Add strict manifest validation for version, platform, architecture, object key layout, duplicate/missing files, HTTPS origin, size, SHA-512, and ZIP-primary requirements
- [x] 3.3 Add tests for arm64-only, x64-only, mixed-architecture, universal, wrong-origin, mutable-object, DMG-only, stale-version, and corrupted-hash manifests
- [x] 3.4 Add release metadata generation for SHA-256, SHA-512 Base64, file size, MIME type, and Qiniu ETag without reading or logging credential values

## 4. Qiniu release workflow

- [x] 4.1 Add a release CLI with `plan`, `build`, `verify-local`, `upload-version`, `verify-cdn`, `promote-channel`, `verify-only`, and safe `resume` phases
- [x] 4.2 Implement dry-run output and strict version/channel/platform/architecture inputs with no filesystem, Qiniu, CDN, or Den mutation
- [x] 4.3 Implement immutable-object preflight and non-overwrite upload for ZIP, DMG, blockmaps, and version manifest; resume only exact remote matches
- [x] 4.4 Implement CI serialization plus a non-overwriting Qiniu promotion lock, explicit stale-lock diagnostics, and audited manual lock recovery
- [x] 4.5 Promote the mutable stable/alpha manifest only after all immutable objects and version-feed canary gates pass, then refresh/purge CDN and verify public digest convergence
- [x] 4.6 Verify Qiniu stat size/ETag plus CDN HTTPS, MIME, Content-Length, byte range, full GET, size, and SHA-512 for every referenced object
- [x] 4.7 Generate a non-secret release evidence artifact containing commit, version, keys, hashes, sizes, ETags, signing/notarization, manifest digest, CDN checks, Den read-back, and timestamps
- [x] 4.8 Add mocked/fixture tests for preflight refusal, matching resume, mismatched remote objects, partial upload, lock contention, failed canary, failed CDN refresh/read-back, and promotion ordering

## 5. macOS signing and notarization gate

- [x] 5.1 Replace the hard-coded `notarize: false` production path with explicit environment-gated Apple notarization while keeping credentials in local/CI secret storage only
- [x] 5.2 Verify the signed `.app`, ZIP contents, and DMG use bundle id `com.juggleai.jugglework`, Team `H7PDHSK3C7`, hardened runtime, and the expected minimum macOS version
- [x] 5.3 Verify notarization submission, stapled ticket, `codesign --deep --strict`, and Gatekeeper acceptance; prevent stable promotion when any gate is unavailable or fails
- [x] 5.4 Add candidate-only behavior for environments without notarization credentials, proving it cannot call stable promotion

## 6. Build and publish Qiniu-only 1.2.15

- [x] 6.1 Bump app/desktop/embedded-server versions from 1.2.14 to 1.2.15 only after updater and release tooling tests pass
- [x] 6.2 Build isolated macOS arm64 ZIP, ZIP blockmap, DMG, DMG blockmap, and normalized version manifest with Qiniu packaged defaults
- [x] 6.3 Complete local package, native module, updater inventory, Developer ID, version, architecture, and embedded-origin verification; record the explicitly authorized one-time `1.2.15` notarization exception
- [x] 6.4 Upload and remotely verify immutable `jugglework/releases/v1.2.15/mac/arm64/` artifacts and `v1.2.15/mac/latest-mac.yml` without overwrite
- [x] 6.5 Use a clean unpublished lower-version build containing the new updater code to install `1.2.15` through the targeted Qiniu version feed, restart, and verify version, user data, workspace authorization, permissions, and successful Chat/Contacts IM bootstrap
- [ ] 6.6 Promote and read back `stable/mac/latest-mac.yml`, then verify a clean Qiniu-enabled lower-version client discovers the stable feed
- [x] 6.7 Remove stable and Alpha GitHub updater publication paths; `1.2.15` and all later updater assets/manifests are Qiniu-only
- [x] 6.8 Update and read back Den published/latest version metadata only after Qiniu canary and stable promotion pass; leave organization allowlists unchanged unless separately authorized

## 7. Prove Qiniu-only ongoing updates

- [x] 7.1 Prepare a newer Qiniu-only patch release (planned 1.2.16) with the same immutable artifact, signing, notarization, and promotion gates, using the separately audited stable `1.2.16` notarization and pre-canary exceptions
- [x] 7.2 Upgrade a clean `1.2.15` installation to the newer release and prove manifest/download traffic uses Qiniu with no GitHub request
- [ ] 7.3 Verify interrupted download, missing/malformed manifest, hash mismatch, wrong architecture, wrong publisher, stale stable pointer, retry, install restart, and stuck ShipIt cleanup behavior
- [ ] 7.4 Verify stable, Alpha, targeted-version, architecture-replacement, and manual-DMG paths against public CDN responses

## 8. Documentation and final validation

- [x] 8.1 Document routine Qiniu release, dry-run, verification-only, safe resume, promotion lock recovery, CDN cache refresh, Den ordering, Qiniu-only policy, and higher-patch rollback
- [x] 8.2 Run updater/release unit tests, app and Electron typechecks, complete Desktop tests, packaged macOS verification, strict OpenSpec validation, and `git diff --check`
- [x] 8.3 Record final 1.2.15 and Qiniu-only canary evidence in the change without secrets and confirm all versioned remote size/hash values match local artifacts

## 9. Stable 1.2.15 rollout evidence (2026-09-09)

- Release evidence: `release-evidence-1.2.15.json`
- Den rollout evidence: `den-rollout-1.2.15.json`
- Final app commit: `7813649f5a4258ce925280035a1d4651c7484b85`; release-tooling follow-up commit: `4f3421a22d78fc8a227b4b433c73deb593138471`
- Stable manifest: `https://downloads.jugglechat.cn/jugglework/releases/stable/mac/latest-mac.yml`; SHA-256 `e9f4f2a3bd91edc622fa4c156ff26f8781754be309ece52ffe55d8e572a683c7`; size `706` bytes
- macOS arm64 ZIP: SHA-256 `9fab962328857ccd031f2b6a708ceff2f75d7fbc2ab10c96ad5439959d4d99d6`; size `238675780` bytes
- macOS arm64 DMG: SHA-256 `0c9520d19cca7ff40f635edd294478c6c85836e60e2f08d86c432dbe156c1fb9`; size `241446316` bytes
- Targeted `1.2.14` to `1.2.15` canary passed discovery, download, native installation, restart, installed-version, user-data, workspace-access, and permission checks. Chat/Contacts IM bootstrap under real signed-in state was subsequently operator-verified successfully on 2026-09-09, completing task 6.5.
- Stable promotion and public digest read-back passed. Task 6.6 remains open until a lower-version client independently discovers the promoted stable feed rather than the immutable targeted feed.
- China Den (`work.jugglechat.cn`) was updated and verified before overseas Den (`work.juggle.im`). Both advertise latest `1.2.15`, publish `[0.1.0, 1.2.15]`, retain minimum `0.1.0`, and retain their organization allowlists unchanged.

## 10. Immutable 1.2.16 candidate evidence (2026-09-09)

- Candidate evidence: `candidate-evidence-1.2.16.json`
- Built from clean `dev` commit `d67258b9d4c158287fb5d5147e1d6368e6b94ab9` in an isolated worktree with a three-package `1.2.16` version overlay; the main worktree remained unchanged.
- Developer ID, Team `H7PDHSK3C7`, bundle id `com.juggleai.jugglework`, hardened runtime, arm64 inventory, native modules, Qiniu-only packaged defaults, artifact hashes, Qiniu size/ETag, and full public CDN behavior passed.
- The immutable ZIP, DMG, both blockmaps, and `v1.2.16/mac/latest-mac.yml` were uploaded without overwrite. At candidate-verification time stable and both Den environments remained on `1.2.15`; section 11 records the subsequently authorized promotion.
- Apple notarization credentials were unavailable, so the original artifact was an unnotarized candidate. The separately audited exact `stable 1.2.16` exceptions described in section 11 subsequently authorized task 7.1 and promotion without weakening the remaining gates.

## 11. Stable 1.2.16 live-upgrade authorization (2026-09-09)

- The operator explicitly authorized exposing both stable `1.2.15` and `1.2.16` to users and requested that the formally installed `1.2.15` UI discover and install `1.2.16` through its normal Check for Updates action.
- The operator separately authorized stable `1.2.16` to proceed without notarization and before its real-client canary. Tooling restricts both exceptions to exact stable `1.2.16` and preserves signing identity, Team, hardened runtime, immutable artifact, Qiniu/CDN, locking, refresh, and read-back gates.
- The earlier statement that stable promotion was prohibited is superseded only for this exact audited `1.2.16` rollout. Task 7.2 remains open until the operator completes and confirms the formal installed-client update.
- Stable `1.2.16` promotion completed at `2026-09-09T09:06:24.593Z`; public manifest SHA-256 is `1ae948c9e23d692941ebc8f8417725790559407cc382974fcde759aa2bc38eae`, and its cache policy was conditionally corrected to `no-cache, max-age=0, must-revalidate` without changing immutable objects.
- China Den was updated and verified before overseas Den. Both now advertise latest `1.2.16` and publish `[0.1.0, 1.2.15, 1.2.16]`; organization allowlists were not modified.

## 12. Formal 1.2.15 live-upgrade failure evidence (2026-09-09)

- The formally installed `/Applications/JuggleWork.app` discovered and downloaded `1.2.16`; the staged bundle is version `1.2.16`, passes `codesign --deep --strict`, retains bundle id `com.juggleai.jugglework`, Team `H7PDHSK3C7`, and hardened runtime, and exactly matches the current `1.2.16` source for `electron/main.mjs` and `electron/updater.mjs`.
- Selecting Install and Restart started ShipIt and hid the window, but left the installed `1.2.15` process alive. ShipIt remains in an install request waiting for that source process to exit, while `/Applications/JuggleWork.app` remains `1.2.15`.
- The installed `1.2.15` `electron/main.mjs` and `electron/updater.mjs` hashes are `f20af6c9471b4e151fdbfa0098ff0a45a7e3b6f454f081f1289afaf3f3715f7f` and `4998c8ba6eb9e1a09b380b817d9740fd4fc8503a872b2b38adb3d0e87b7030e1`. Those bytes lack the updater-install quit-intent flag included in `1.2.16`.
- Root cause: Electron closes all windows before invoking Squirrel's relaunch-to-install path. The older close-to-tray handler converts that close into hide, so Electron never reaches the path that rewrites `launchAfterInstallation` from `false` to `true` and terminates the process. ShipIt therefore cannot replace the running bundle.
- `launchAfterInstallation=false` is not a second replacement blocker: Squirrel stages every update with `false`, and ShipIt consults the flag only for post-install relaunch. Once the old process fully exits, ShipIt can replace the bundle, but this attempt may require manually reopening JuggleWork.
- This initial failure was recovered without deleting the staged ShipIt cache; the completed result is recorded below.

## 13. Formal 1.2.15 to 1.2.16 live-upgrade completion (2026-09-09)

- The operator manually terminated the stuck legacy `1.2.15` process. ShipIt began installation at `2026-09-09T12:46:18.865Z`, replaced `/Applications/JuggleWork.app`, completed successfully at `2026-09-09T12:46:21.084Z`, and automatically relaunched the application at `2026-09-09T12:46:21.747Z`; its final exit code was `0`.
- The relaunched installation reports `1.2.16`. It retains bundle id `com.juggleai.jugglework`, Team `H7PDHSK3C7`, hardened runtime, and passes `codesign --deep --strict`. Installed `electron/main.mjs` and `electron/updater.mjs` exactly match the verified `1.2.16` package and contain the updater-install quit-intent fix.
- The updater cache contains `jugglework-mac-arm64-1.2.16.zip` with size `238676213` and SHA-256 `8c4fc2cddea827e95d852a0bf14a68292e2ad4c917b59b75e4bc12ff7a03790b`, exactly matching the published immutable Qiniu object. Installed `app-update.yml` points to `https://downloads.jugglechat.cn/jugglework/releases/stable/mac`; packaged runtime update code contains the Qiniu resolver and no active GitHub updater origin.
- The signed-in state, current session, session history, workspace authorization, and workspace read/write access survived the replacement. macOS Accessibility and Screen Recording permissions remain granted. A direct post-restart IM conversation-list call succeeded, proving Chat bootstrap. A Contacts service probe returned a business `not_found`, so Contacts is not separately claimed as verified by this completion record.
- Task 7.2 is complete. Task 7.3 remains open for the rest of its failure-mode matrix, and task 6.6 remains open because this normal Den-selected upgrade used the immutable targeted feed rather than independently proving lower-client stable-feed discovery.

## 14. Stable 1.2.17 notarization authorization (2026-09-11)

- The operator explicitly authorized exact stable `1.2.17` to proceed without Apple notarization, stapling, and Gatekeeper acceptance.
- This authorization is notarization-only: it does not authorize promotion before a valid lower-version canary and does not bypass Developer ID/Team, bundle id, hardened runtime, artifact integrity, immutable Qiniu publication, CDN verification, promotion locking, cache refresh, or read-back.
- Tooling hard-codes the exception to `stable-1.2.17-only`; later versions fail closed unless separately reviewed and authorized.
- The first clean `1.2.17` arm64 package verification caught an x64 `@lydell/node-pty-darwin-x64` optional prebuild inside `app.asar.unpacked`. Publication stopped before upload. The target-aware after-pack hook now removes non-target `node-pty` prebuild packages and fails if the expected target package is absent; the release is rebuilt from scratch after this fix.

## 15. Stable 1.2.17 rollout evidence (2026-09-11)

- The clean rebuilt arm64 release from commit `68db59f939164075348b927a8f2a63633a51899a` passed packaged architecture, Developer ID, Team `H7PDHSK3C7`, bundle id `com.juggleai.jugglework`, hardened-runtime, native-module, Qiniu-only updater, artifact-integrity, and public-CDN verification. The ZIP SHA-256 is `73cbfd73c97376e232f4783ba6b680a13afc37773d57645aed0f3ac497b9cbda`; the DMG SHA-256 is `dd84a3b3859f5bedb0b0e99e02213618d5901a9110e754ff7133d828d674206f`.
- A clean isolated signed `1.2.16` copy discovered the immutable `v1.2.17/mac` feed, downloaded the exact published ZIP, exited without external termination, completed ShipIt replacement, and restarted as `1.2.17`. Its isolated user-data marker, workspace registration and file access, and granted signing/runtime identity remained intact; the running production `/Applications/JuggleWork.app` was not exited or overwritten.
- Stable promotion completed at `2026-09-11T10:29:45.325Z`. The public mutable manifest has SHA-256 `d44e55bde6fe356509d91ff368268c517afb1737c523300c3bb44e271fe366be`, size `706`, and Qiniu ETag `FryTa05sBLvAWVVcz3VTBe2YOBJU`. Its inherited long-lived cache metadata was conditionally changed, without changing its bytes, to `no-cache, no-store, must-revalidate`, followed by CDN refresh and digest read-back.
- Server landing commit `ab2c8b6368d6ec931d69dac50f523e24e070c3e4` was deployed to China first and overseas second using the same Linux amd64 artifact SHA-256 `bcdaf62e9eca40fb1da2d2c1066c4ecb95ce3631842aa9a27aaa832931a4d83b`. Both public Den environments advertise latest `1.2.17`, publish `[0.1.0, 1.2.15, 1.2.16, 1.2.17]`, serve both landing links to the immutable `1.2.17` DMG, and passed local/public health, readiness, console, runtime-version, listener, and post-restart log checks.
- The production allowlists already contained the published versions and were extended with `1.2.17` in both environments so the newly published version is permitted. Task 6.6 remains open because this canary intentionally exercised the immutable targeted feed rather than independent mutable stable-feed discovery; tasks 7.3 and 7.4 remain open for their broader failure/path matrices.
- After rollout verification, the `apps/app`, `apps/desktop`, and `apps/server` source package versions were synchronized from `1.2.15` to the published `1.2.17` baseline so subsequent development and packaging no longer require the temporary release-worktree version overlay.

## 16. Windows ARM64 and x64 1.2.17 candidates (2026-09-14)

- GitHub Actions run `34822913609` built the installer on the native `windows-11-arm` runner from commit `e651137a52d57d6024e73b5b2950fb2043114351`. Application compilation, Windows ARM64 native-module rebuild, packaged runtime checks, NSIS packaging, inventory verification, and workflow-artifact retention passed.
- The immutable installer is `jugglework/releases/v1.2.17/windows/arm64/jugglework-win-arm64-1.2.17.exe`: size `198810602`, SHA-256 `e10c8444bc5a7c47e6c87f838626be9af2902b2670fb668ad52e172b809e1429`, and Qiniu ETag `lquNqc0l5t2U9LRtkxh7HA0WIysV`.
- Its blockmap is `jugglework/releases/v1.2.17/windows/arm64/jugglework-win-arm64-1.2.17.exe.blockmap`: size `204450`, SHA-256 `563846c0e3ed197771ea7fa0b07b3bdc3f52e8c53036a0c02c2c3aefb2e62817`, and Qiniu ETag `Fug592b_wh88GGjF5wKgmNNVPAxb`.
- GitHub Actions run `34827705679` built the x64 installer on the native `windows-2022` runner from commit `a9599214988bd520a5d99d7b3d7e3cb428130d4d`. Application compilation, Windows x64 native-module rebuild, packaged runtime checks, NSIS packaging, inventory verification, and workflow-artifact retention passed.
- The immutable x64 installer is `jugglework/releases/v1.2.17/windows/x64/jugglework-win-x64-1.2.17.exe`: size `210361007`, SHA-256 `38aa96c9829e078e2ec3708964cb9cf4be655b1e2234cb7224f081484c32c4b8`, and Qiniu ETag `lg6EQNRJAzN7rvlrB-PAGys3eylK`.
- Its blockmap is `jugglework/releases/v1.2.17/windows/x64/jugglework-win-x64-1.2.17.exe.blockmap`: size `217426`, SHA-256 `aa6a78d738c89edb3f84bf415122fa94d595a6f3fe6436ebfafb8992d7d3fc4e`, and Qiniu ETag `Fs_HtBv5LYpDsNgI0bixjf5hsplF`.
- The version manifest `jugglework/releases/v1.2.17/windows/latest.yml` was finalized after both architecture payloads existed: size `531`, SHA-256 `26320e5ef73acd7db2f200d26a647af570c46d5ec6c0d01a6a4a27960b790a36`, and Qiniu ETag `FrE6iymA2hcpkjnFQGTGM9CthR61`. It uses absolute immutable CDN URLs, and the production `electron-updater` resolver was exercised to prove ARM64 and x64 select their matching installers.
- Qiniu stat, public HTTPS range requests, MIME/size/ETag headers, manifest byte comparison, and complete public installer/blockmap SHA-256 downloads all matched the local artifacts.
- This candidate is unsigned because Windows SignPath credentials/policy are not enabled for the dedicated build. It was not promoted to `stable/windows/latest.yml`; Windows ARM64 code-signing and a real-device install/update canary remain required before broad automatic-update promotion.
- These candidates are unsigned because Windows SignPath credentials/policy are not enabled for the dedicated builds. They were not promoted to `stable/windows/latest.yml`; Windows code-signing and real-device install/update canaries remain required before broad automatic-update promotion.

## 17. Windows x64/arm64 production specification

- [x] 17.1 Update `design.md`, publication requirements, and delivery requirements to define the Windows x64/arm64 trust, immutable layout, shared-manifest, promotion, canary, install-intent, and stale-`updateId` contracts
- [x] 17.2 Preserve the historical unsigned Windows ARM64 `1.2.17` candidate as immutable, unpromoted evidence and require the formal Windows rollout to use a version greater than `1.2.17`
- [x] 17.3 Implement dual-native-architecture Windows release planning: require exactly arm64 and x64 staging directories, reject formal release versions at or below `1.2.17`, and deterministically merge final architecture outputs into one immutable `v<version>/windows/latest.yml` whose authoritative `files` inventory has no top-level `path`/`sha512`
- [x] 17.4 Add mandatory SignPath orchestration code for each native Windows architecture, including pinned-source matrix builds, protected-configuration presence checks, unsigned artifact submission, signed artifact retrieval, and aggregation of both signed outputs
- [x] 17.5 Replace each unsigned EXE with the SignPath result, regenerate its blockmap after signing, and refresh its per-architecture staging manifest from the final signed size/SHA-512 before shared-manifest merge
- [x] 17.6 Implement fail-closed Windows local verification and evidence gates for native PE machine, explicit packaged `publisherName`, valid SHA-256 Authenticode chain, trusted RFC 3161 timestamp within certificate validity, same publisher across architectures, post-sign blockmap reproduction, complete immutable URLs, and exact merged-manifest/local-evidence digests
- [x] 17.7 Implement independent cooperative non-overwrite promotion locks by platform/channel, with lock size/ETag ownership verification, optimistic expected-previous-manifest digest recheck before overwrite, CDN refresh/read-back, and audited stale-lock recovery; do not claim provider atomic CAS
- [x] 17.8 Implement and verify conditional channel-object cache metadata mutation to `no-cache, no-store, must-revalidate` under the promotion lock before CDN refresh, retaining the lock on condition or verification failure
- [x] 17.9 Keep `autoInstallOnAppQuit` disabled for the full updater lifecycle and implement opaque process-local single-use `updateId` fencing across check, download, explicit `Install and restart`, invalidation, failure, channel/target changes, replay, and process restart
- [x] 17.10 Add focused tests for dual-architecture planning/merge, absence of shared-manifest top-level selection fields, runtime native selection/injection, SignPath post-sign blockmap order, PE/publisher/timestamp/local-evidence rejection, independent cooperative lock contention and optimistic rechecks, ordinary-exit non-installation, and stale/missing/mismatched/consumed `updateId` rejection
- [x] 17.11 Wire the Windows x64/arm64 build, mandatory SignPath, aggregation, local evidence, immutable upload/CDN verification, canary validation, optional promotion, and retained evidence stages into `.github/workflows/qiniu-desktop-release.yml`
- [x] 17.12 Remove the obsolete release workflow input/job/finalizer dependency on the missing Daytona snapshot reusable workflow so release workflow references match the current repository
- [ ] 17.13 Configure the real protected SignPath token, organization/project/policy/artifact settings, approved production `publisherName` allowlist, Qiniu credentials, and timestamp policy in the protected CI environment
- [ ] 17.14 Run the protected workflow and obtain real successful SignPath signing and native x64/arm64 packaged-verification CI results for one formal version greater than `1.2.17`
- [ ] 17.15 Provision one physical Windows x64 machine and one physical Windows arm64 machine, then run targeted-feed canaries from a supported lower signed version against the exact shared immutable manifest and verify native selection, publisher, download, explicit install/restart, version, user data, workspace authorization, and application behavior
- [ ] 17.16 Publish and remotely verify the complete signed x64/arm64 immutable Qiniu release with a version greater than `1.2.17`; do not overwrite, complete, re-sign, or promote any `v1.2.17/windows` object
- [ ] 17.17 After both physical canaries and cache-metadata implementation pass, promote and read back `stable/windows/latest.yml` under its independent cooperative lock, then update and verify China Den before overseas Den; leave organization allowlists unchanged unless separately authorized
- [ ] 17.18 Record non-secret final Windows rollout evidence covering the protected signed CI, local/package gates, immutable Qiniu/CDN bytes, both physical canaries, cache metadata, stable promotion/read-back, and Den rollout; run strict OpenSpec validation and final target diff checks without treating code-only or mocked evidence as rollout proof

## 18. Stable 1.2.18 release authorization (2026-09-15)

- [x] 18.1 Record the operator's correction from `2.1.18` to exact stable `1.2.18` and delete the never-promoted `v2.1.18` Qiniu objects after exact ETag/size verification
- [x] 18.2 Record the operator's exact authorization for stable macOS arm64 `1.2.18` to proceed without Apple notarization, stapling, Gatekeeper acceptance, or a local macOS canary while preserving Developer ID/Team, hardened runtime, package inventory, integrity, immutable publication, CDN, promotion-lock, refresh, and read-back gates
- [x] 18.3 Keep the formal Windows x64/ARM64 release fail-closed without Authenticode, trusted timestamp, dual-architecture inventory, physical canary, cache-metadata, or public read-back evidence
- [x] 18.4 Build, verify, immutably publish, and promote macOS arm64 stable `1.2.18` using the exact notarization and pre-canary exceptions
- [ ] 18.5 Complete protected SignPath signing, immutable publication, physical x64/ARM64 canaries, cache-metadata verification, and Stable promotion for Windows `1.2.18`
- [x] 18.6 Leave landing on its existing `1.2.17` manual-download URL and expose exact `1.2.18` through configuration-only Den metadata, China first and overseas second

## 19. Stable macOS 1.2.18 rollout evidence (2026-09-15)

- [x] 19.1 Build exact commit `5e1c8ac50b3fdc113167880e795cfb3d6ae331b1` as macOS arm64 `1.2.18` in an isolated clean worktree and verify Developer ID Team `H7PDHSK3C7`, bundle id `com.juggleai.jugglework`, deep/strict signing, hardened runtime, target-only Mach-O inventory, native modules, sidecars, ZIP, DMG, blockmaps, and the Qiniu-only updater feed
- [x] 19.2 Publish all five immutable `v1.2.18/mac` objects only after absence preflight; verify Qiniu size/ETag plus public HTTPS MIME, length, range, full SHA-256, and full SHA-512. ZIP SHA-256 is `a99bb89e657a443290d26a89746fce8d248139f6fba99d877bb2fd30c8fa081f`; DMG SHA-256 is `da4f9b1643d66efbef5000040b7896ce2094a7dea0ede457c9b0a4eaf0ac701c`
- [x] 19.3 Promote the exact 706-byte immutable manifest under the stable macOS lock and read it back with SHA-256 `0f98bde210c39e6cd0129fabc93f95adeca16fcc86b79f77e261291d30d96e2c` and Qiniu ETag `Fom96EgoS43jEBWVtqUnNZ5_i84_`; confirm the lock was released and all referenced immutable objects remain available
- [x] 19.4 Record the operator's post-promotion authorization to retain `Cache-Control: public, max-age=31536000` for exact `stable/mac/latest-mac.yml` version `1.2.18` and continue Den/landing rollout without weakening any other release gate
- [x] 19.5 Back up each environment's private configuration independently, add `1.2.18` only to `latestAppVersion`, `publishedDesktopVersions`, and the already-present `allowedDesktopVersions`, and restart the unchanged production binary. China PID changed to `3801769` and overseas PID to `180472`; both retained binary SHA-256 `803431b9b2a768cf658c6110f2961938436396e9a2c92b69d3a9ddb592b7d4b1`, passed local/public health and readiness, runtime-config, console, loopback-only 8021, and post-restart log checks, and publicly returned latest/published `1.2.18`
- [x] 19.6 Revert the unshipped server landing-link commit with `6442e264aa0cc293f057aa39608a494908f12c6d`, preserving the two existing `1.2.17` macOS DMG links and deploying no new server binary or database migration for this rollout

## 20. Stable macOS 1.2.19 release authorization (2026-09-16)

- [x] 20.1 Record exact stable macOS arm64 `1.2.19` scope: signed DMG/ZIP and automatic-update publication only; no Windows work, no landing change, no new Den binary deployment
- [x] 20.2 Record separate operator authorizations to skip production notarization/stapling/Gatekeeper and the local installation/upgrade canary for `stable-1.2.19-only`, while preserving every unrelated release gate
- [x] 20.3 Synchronize all three package versions to `1.2.19`, validate release tooling and product typechecks/tests, push dev, and fast-forward main
- [x] 20.4 Build exact application commit `7da2ad4b0b0c4a1e600e1fc8cecf6f78155fd939` in an isolated worktree and verify Developer ID Team `H7PDHSK3C7`, bundle id `com.juggleai.jugglework`, deep/strict signing, hardened runtime, arm64-only Mach-O inventory, native modules, sidecars, ZIP/DMG/blockmaps, and Qiniu-only updater configuration
- [x] 20.5 Publish and fully verify all five immutable macOS objects, then promote Stable with the two exact exceptions. ZIP SHA-256 is `d78eb8a2c5aaa90dd08477d037abf0ea406e95f514cc0c5c85b50052fa696c55`; DMG SHA-256 is `e2c173b071f7994967821aa6247720be883833059ce4dbbd0aacba692f023ec0`; manifest SHA-256 is `9e690c9d07252194e4592980e179549817197139dc952d2290582b49846c04b2` with Qiniu ETag `FvDO57zuBt2XTe02qiMzjLu63jiK`
- [x] 20.6 Fix the release-control endpoint allowlist in `91309edd58b4d502fdc5497cffb46c83a2a3a5d4` to accept Qiniu's production `*.qbox.me` RS domains without accepting suffix-confusion hosts; audit and recover both retained pre-refresh promotion locks; use qshell's decrypted in-memory credentials rather than its encrypted on-disk SecretKey field; conditionally set and verify `Cache-Control: no-cache, no-store, must-revalidate`; refresh CDN; and read back the exact 706-byte Stable manifest after three attempts with the lock released
- [x] 20.7 Expose `1.2.19` through configuration-only Den metadata in China first and overseas second. China retained binary SHA-256 `5d9b512320207d6fe28966478bccb4cc99d89b946980f6fd2fb99b83286fc7cb`, restarted to PID `3836402`, and backed up config at `backups/config.yml.before-desktop-1.2.19-20260916T110250Z`; overseas retained binary SHA-256 `6854367869b1184bbddcf2f00fa79ae42876b000eb48ce1f7f81e61a567aac78`, restarted to PID `191480`, and backed up config at `backups/config.yml.before-desktop-1.2.19-20260916T110344Z`. Both passed local/public health and readiness, runtime-config, console, loopback-only 8021, post-restart log checks, and public latest/published `1.2.19`; landing remained on `1.2.17` and Windows state remained untouched
