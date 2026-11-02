# Bundled media tools: source audit, implementation and release gates

## Decision

Bundled-only FFmpeg/FFprobe is implemented, including development staging, using
native macOS builds of official FFmpeg 7.1.5 and x264 b35605a sources. The rejected
eugeneware Darwin ARM64 pair below MUST NOT ship. System lookup has been removed.
This record is engineering evidence, not legal approval. Real release signing,
notarization, installed-app testing and native Intel execution remain open.

## Historical rejected binary evidence (retained; not the active source lock)

- Release and public asset digests:
  https://api.github.com/repos/eugeneware/ffmpeg-static/releases/tags/b6.1.1
- Human-readable release:
  https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- Upstream acquisition script:
  https://raw.githubusercontent.com/eugeneware/ffmpeg-static/b6.1.1/download-binaries/index.sh
- Upstream build site for Darwin ARM64: https://osxexperts.net/
- All asset URLs below use the exact prefix:
  `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/`

Existing `modules/toonflowV2/packages/ffmpeg/src/catalog.ts` names this release
alongside mirrors/proxies; that catalog does not establish approved redistribution
or pinned executable trust. No mirror/proxy, Homebrew binary, credential store,
or local signing identity was used in this audit.

### Published SHA-256 values (candidate evidence, NOT an approved allowlist)

| Asset | SHA-256 |
| --- | --- |
| ffmpeg-darwin-arm64 | `a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584` |
| ffprobe-darwin-arm64 | `bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64` |
| ffmpeg-darwin-x64 | `ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894` |
| ffprobe-darwin-x64 | `fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0` |
| ffmpeg-win32-x64 | `04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00` |
| ffprobe-win32-x64 | `3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4` |

Only the ARM64 pair was downloaded and independently hashed locally. GitHub
reported the other four values; they are not local validation results.

### Actual Darwin ARM64 results

- FFmpeg size: 45,568,216 bytes; FFprobe size: 45,528,808 bytes.
- Both headers: Mach-O, Darwin, ARM64 (checked by repository executable parser).
- Both `-version`: **6.0**, Apple clang 13.1.6.
- Both configurations contain `--enable-gpl --enable-libx264 --enable-version3`
  and **`--enable-nonfree`**.
- Both `-L` report: `This version of ffmpeg [ffprobe] has nonfree parts compiled
  in. Therefore it is not legally redistributable.`
- `/usr/bin/otool -L` lists only `/usr/lib/` and `/System/Library/` dependencies;
  no Homebrew or other developer-machine libraries were found.
- With child environment `PATH=""`, absolute-path FFmpeg enumerated libx264,
  encoded a 2-second 160x90/24fps synthetic source, re-encoded a 0.75-second cut
  starting at 0.5 seconds, and decoded the full result without errors.
- Absolute-path FFprobe returned H.264, 160x90, duration `0.750000` with empty PATH.
- Files were confined to a fresh temporary audit directory; no cat1/user media
  or running Desktop instance was used. No binaries entered application resources.

The upstream ARM64 LICENSE asset is a general FFmpeg licensing explanation,
not evidence that this binary is redistributable. It explicitly explains that
`--enable-nonfree` can make a binary unredistributable. Its README is generic
FFmpeg documentation, not a complete corresponding-source/build manifest.

## Rejected candidate platform disposition

| Target | Disposition |
| --- | --- |
| macOS ARM64 | Candidate rejected: explicit nonfree/nonredistributable build; executable/media checks passed only as research |
| macOS x64 | Candidate assets exist; README describes 8.0 while acquisition script requests 6.1.1; actual binary/version, linkage, source correspondence and license remain unverified |
| Windows x64 | Candidate assets exist, acquisition script references Gyan 6.1.1 essentials; native execution, PE imports, source correspondence and redistribution review remain unverified |
| Windows ARM64 | No asset in this release; acceptable native source not established; blocked, no x64 fallback |

This is not a claim that no native Windows ARM64 build exists anywhere. It is a
statement that this investigation has not accepted one.

## Historical implementation checklist (now implemented for native Mac)

1. Prefer an upstream build with a complete, exact source/dependency/build record.
   Otherwise build a minimal FFmpeg + static x264 distribution from reviewed,
   fixed upstream source revisions on native target CI. Pin source archives and
   toolchains, retain build recipes/patches, and publish the matching source bundle
   alongside binaries. Do not replace provenance with locally calculated hashes
   of unexplained third-party bytes. Do not enable nonfree components.
2. Review GPL obligations for FFmpeg plus x264 and all linked libraries: package
   license texts/notices and establish the applicable corresponding-source
   delivery mechanism, including build/install scripts and modifications. A link
   to FFmpeg HEAD or an unrelated release is insufficient. Record release-review
   evidence; do not label this engineering task as legal approval.
3. Commit an approved target lock with exact version, artifact URL, publisher
   digest evidence, compressed/uncompressed SHA-256, source references and binary
   names. Downloader must validate online and offline cache bytes before staging,
   reject missing targets, mismatched hashes, architecture and nonfree flags, and
   fail closed. Do not accept arbitrary mirrors or regenerate trust from cache.
4. Stage `apps/desktop/resources/mediaTools` separately from `toonFactoryV2`;
   include `ffmpeg.exe`/`ffprobe.exe` on Windows, provenance, license/source notices,
   and a dedicated manifest. `buildToonFactory.mjs` must require/build it, and
   builder `extraResources` must package it. After-pack and final macOS/Windows
   verifiers must require the target pair and notices, not merely optional files.
5. Retain Bun's current upstream byte hash, upstream Team `7FRXF46ZSN` signature,
   exact-path signer exclusion, and unchanged Toonflow inventory. Media tools
   cannot share that exclusion: verify approved input hashes before signing;
   sign the accepted media binaries with the resolved application identity;
   record post-sign hashes in their separate manifest **before** the outer app
   seals resources. Ensure the default signer does not subsequently mutate them;
   reverify signatures and hashes after signing. Do not rewrite Bun's manifest.
   Final verification must establish the signed manifest's app trust and preserved
   approved provenance, not accept an arbitrary self-updated manifest as trust.
6. Pass an application-owned media resource root from `toonFactoryRuntime.mjs`
   to the editor. Packaged runtime uses only the bundled verified paths; dev uses
   the same verified staging. Missing/invalid tools prompt a rebuild/reinstall,
   never brew, PATH lookup, project executables or model-selected commands.
   Preserve host grants, realpath containment, fixed argv, cancellation and limits.
7. Native target CI must verify Mach-O/PE architecture, system-only dynamic imports,
   exact versions/configuration/licenses, libx264 encoding, probe/trim/full decode
   with no system FFmpeg, then signing and installed artifact behavior. Extend
   existing root Desktop tests; add no tests inside the vendored module. A missing
   Windows ARM64 approved source blocks that target explicitly.

## Active source lock and authenticity (2026-10-30)

Source of truth: `apps/desktop/electron/mediaToolsSources.json`.

| Input | Exact origin / version | SHA-256 |
| --- | --- | --- |
| FFmpeg source | https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz | `de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f` |
| Detached signature | https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz.asc | `7ce4b9d56e3ef0cd4c3a9c0b2c8a034ac91e6c4c011c1f10b05a8aa7292fca35` |
| Release public key | https://ffmpeg.org/ffmpeg-devel.asc | `397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5` |
| x264 source tar | Official `https://code.videolan.org/videolan/x264.git`, commit `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`, tree `0700538866963f968154ea768289bf100350e84e`; `git archive --format=tar --prefix=x264/` | `97011e241beb7322b21643d3c029b15d7d81018ae0332a44d1578ee11df00475` |

FFmpeg upstream detached RSA signature was actually verified with OpenPGP.js
6.3.0 in an isolated temporary installation (no project dependency or user keyring).
The verifier checked public fingerprint
`FCF986EA15E6E293A5644F10B4322F04D67658D8` against the official
https://ffmpeg.org/download.html instructions before accepting the signature.
The fresh official download was 11,050,340 bytes and matched the committed lock.
Builds enforce that authenticated SHA-256, rather than redoing PGP with a mutable key.
The pinned signature/public key ship beside the archive for independent verification.

Independent source evidence is pinned to immutable downstream recipe commits:
- [MacPorts FFmpeg7](https://github.com/macports/macports-ports/blob/a7206b2edba87a797c781810ce489b36330a7d93/multimedia/ffmpeg7/Portfile) corroborates the FFmpeg archive hash.
- [Homebrew x264](https://github.com/Homebrew/homebrew-core/blob/0244e0cd56a4944e1ada0e15855f21d4a7e809f3/Formula/x/x264.rb) corroborates the exact stable source commit.

No Homebrew/MacPorts binaries or build variants are used. x264 archive SHA-256
is locally calculated from the fixed official Git object; no independent upstream
signed digest/commit verification is claimed. This is the remaining intake assurance
limitation. The attempted FFmpeg `.tar.xz.sha256` URL returned 404; the actual
upstream detached signature, not an invented checksum endpoint, supplies authenticity.

## Implemented chain

- `buildMediaTools.mjs`: native Mac-only gate, fixed HTTPS downloads/Git commit+tree,
  online/offline source SHA-256 checks before extracting/executing, recipe-aware staging
  reuse, verified complete output replacement. Shell build logs remain in temporary
  directories on failure. Unsupported targets and foreign host architectures fail.
- `build-media-tools.sh`: standalone hash-enforced recipe, unmodified sources, GPL
  enabled/nonfree disabled, static x264 and FFmpeg, no host library autodetection,
  assembly disabled (no nasm requirement), only file/pipe protocols. Controlled
  x264-only pkg-config adapter. Actual compiler/SDK/configuration records are included.
- Independent `resources/mediaTools` includes both binaries, source archives,
  public signature evidence, lock, recipes, GPL/LGPL/x264/license texts, NOTICE and
  build information. Executable build hashes are local receipts, not publisher hashes.
- `build:electron` already invokes `buildToonFactory`, which now requires the media
  build; extraResources, after-pack and native Mac CI smoke are connected.
- `signMediaTools.mjs` verifies built inventory before signing, requires a real
  application identity, verifies Team `H7PDHSK3C7`/hardened runtime/timestamp,
  prohibits non-executable byte changes and records signed inventory before outer
  app sealing. Default signing excludes only the exact two media executables.
- Final Mac app/ZIP/DMG checks verify outer app trust plus media signatures/inventory;
  Windows and Linux final verifiers fail closed. Runtime validates outer app trust
  before accepting signed media. Development accepts the host-owned built staging.
- The editor launches only absolute bundled paths with `PATH=""`, retaining grants,
  realpath/symlink containment, fixed argv, size/time limits and cancellation.

## Native platform matrix

| Target | Implementation | Evidence / gate |
| --- | --- | --- |
| macOS ARM64, minimum 14.0 | Native source recipe and full integration | Forced online-evidence and offline source recompilation, real-media smoke passed locally; release signing/install gates open |
| macOS x64, minimum 14.0 | Same native recipe, `macos-15-intel` CI | Not executed on native Intel in this session; no Rosetta/cross-build claim |
| Windows x64 / ARM64 | No accepted native source recipe | Build, after-pack and final verification fail; this blocks the containing Desktop release, not merely an optional feature |
| Linux x64 / ARM64 | Not implemented in this scope | Same explicit build/package gate; existing Linux jobs cannot publish successfully |

## Actual verification

Repository baseline: `e09323a797836ac52db76ca2ebca95c78cc796e9` plus dirty worktree.
Existing implementation was reviewed and extended rather than overwritten. Native
ARM64 compiler: Apple clang 21.0.0 (`clang-2100.3.34.2`), SDK 27.0, deployment 14.0.
This records the actual toolchain; CI versions are not bit-reproducibility pins.

Commands executed from repository root:

```sh
node apps/desktop/scripts/buildMediaTools.mjs --force
MEDIA_TOOLS_OFFLINE=1 node apps/desktop/scripts/buildMediaTools.mjs --force
MEDIA_TOOLS_SMOKE=1 node --test \
  apps/desktop/scripts/buildToonFactory.test.mjs \
  apps/desktop/electron/toonFactoryRuntime.test.mjs \
  apps/desktop/scripts/verify-packaged-linux.test.mjs \
  apps/desktop/scripts/verify-packaged-macos.test.mjs \
  apps/desktop/scripts/electron-after-pack.test.cjs \
  apps/desktop/scripts/office-engine-resources.test.cjs \
  apps/desktop/scripts/verify-packaged-windows.test.mjs
BUN_BINARY=/absolute/path/to/verified/bun MEDIA_TOOLS_OFFLINE=1 \
  node apps/desktop/scripts/buildToonFactory.mjs
pnpm --dir apps/desktop typecheck:electron
```

- **98 tests passed, zero skipped/failing**, including real native ARM64 media:
  2-second 160x90/24fps libx264+AAC synthetic source; 0.5–1.25s trim; probe;
  extraction/separation/scene analysis+JPEG; two 0.5-second clips concatenated,
  including a silent source given generated silence; full video decode.
  All FFmpeg/FFprobe child processes use empty PATH.
- Missing bundle, corrupt offline source, foreign target, traversal, symlink,
  ungranted directory, arbitrary argv, no-overwrite, no-audio extraction and
  pre-aborted cancellation rejection passed. Rewriting inventory cannot bless
  a forged pinned source archive. Ad-hoc signing mutates bytes and preserves
  build receipts/non-executable inventory; release verification rejects ad-hoc.
- Both `-L` report GPL version 2 or later; neither contains nonfree/nonredistributable
  text. `-version` reports 7.1.5 with explicit gpl/libx264/disable-nonfree/network.
  `otool -L` lists only libSystem, CoreFoundation, CoreVideo and CoreMedia at Apple
  system paths. No x264 dylib, Homebrew path or external dylib is required.
- Complete Toonflow build passed: 1,035 files; inventory
  `246d4928480e36cea8f142bd90061006316983b119b995f5f9149afd9f119fa6`, identical
  to the pre-build inventory. Bun 1.3.14 original binary SHA-256 remains
  `e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233`.
- Electron typecheck failed in existing file-window/Office selection/font test
  types and socket-tos-compat types. No diagnostics named mediaTools or the changed
  media runtime. Full typecheck is therefore **not passed**.
- OpenSpec CLI was recovered from an existing isolated validation cache;
  `openspec validate replace-toon-factory-with-sidecar --strict` passed.
  `git diff --check` passed. No dependency or account configuration was changed.
- Final native staging has 21 inventoried files, 33,482,735 bytes (excluding the
  manifest). Local receipt: FFmpeg SHA-256
  `6b354a2dbd0d3547ff5a847aff9e01bd9e0b89d53590d36e1f87b4a7c14a999e`;
  FFprobe `dbdbffcc011d626af5c9ef8a61212f695c639e009baef4d2ce2fa453ad03034a`;
  manifest `a8b495bee446e1adb2c610234d7c27c91c5f71c45a3772732eb5c58240c401e5`.
  These hashes identify this build only, not a reproducibility or publisher guarantee.
- Final unchanged Bun executable also passed actual Apple-anchored upstream Team
  `7FRXF46ZSN` signature verification with hardened runtime and secure timestamp.

No cat1/user media was accessed; no app restart, account configuration change,
credential-store read, commit/push or external Skill modification occurred.

## Remaining release gates

Native Intel execution; real Developer ID app/media signing, notarization and final
ZIP/DMG/installed behavior; broader codec/performance and macOS 14 minimum-runtime
testing; final GPL corresponding-source/notices/distribution review. These are not
proven by staging, unit tests or ad-hoc fixtures. The running Desktop UI tasks remain
open as instructed. Do not claim this engineering work constitutes legal approval.
