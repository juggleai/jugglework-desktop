## Context

See `proposal.md`. Packaged version `1.2.14` uses `electron-updater` 6.8.3 and rewrites its feed to GitHub at runtime. Its installed `app-update.yml`, stable/Alpha feeds, targeted-version feed, architecture replacement lookup, and release fallback all refer to GitHub. Qiniu bucket `juggleim` has public CDN `https://downloads.jugglechat.cn`, but currently contains only `v1.2.14/mac/arm64/jugglework-mac-arm64-1.2.14.dmg`; stable/alpha manifests and ZIP payloads are absent. `MacUpdater` explicitly requires a compatible ZIP and rejects DMG-only manifests. Differential download is currently disabled, so initial production traffic is full ZIP download. `https://work.jugglechat.cn/download` does not exist, so manual replacement must resolve a DMG from the release manifest in the first phase.

## Goals / Non-Goals

**Goals:**
- Make Qiniu the only update discovery/download origin for Qiniu-enabled clients, including stable, Alpha, Den-targeted versions, and architecture replacement
- Create a reproducible, fail-closed release workflow with immutable version objects, atomic channel promotion, remote/CDN verification, audit evidence, and no repository-stored secrets
- Publish `1.2.15` directly through Qiniu and prove Qiniu-only upgrades to later versions
- Preserve application identity, user data, updater recovery behavior, and platform-correct feed routing

**Non-Goals:**
- Reusing the existing same-version `1.2.14` DMG as an automatic update
- Enabling differential download in the first Qiniu release
- Building new Windows/Linux binaries in the first Qiniu-only release; feed resolution remains platform-correct so later releases can add them safely
- Migrating already-installed clients that remain pinned to a retired GitHub updater feed
- Implementing a new Den administration API in this repository; publication coordinates with the existing authorized administration path
- Implementing a public download web page; the first phase uses manifest-selected signed DMGs directly
- Automatic version downgrade as rollback

## Decisions

1. **Centralize a platform/channel/version feed resolver.** Replace independent GitHub constants with one pure resolver based on platform, channel, and optional strict target version. Stable macOS resolves to `/stable/mac`, Alpha macOS to `/alpha/mac`, and targeted macOS to `/v<version>/mac`; Windows/Linux use their own segments. `electron-updater`, architecture replacement, manual fallback, tests, and packaged configuration share this contract.
   - Rejected: changing only `ELECTRON_UPDATER_FEEDS`; targeted versions, `app-update.yml`, and manual URLs would still reach GitHub.
   - Rejected: fetching the feed origin from authenticated Den configuration; updates must work before sign-in and must not send Cloud credentials to the public CDN.

2. **Use one macOS manifest per channel/version and architecture-specific immutable subdirectories.** Layout:
   ```text
   jugglework/releases/v1.2.15/mac/latest-mac.yml
   jugglework/releases/v1.2.15/mac/arm64/jugglework-mac-arm64-1.2.15.{zip,dmg}
   jugglework/releases/stable/mac/latest-mac.yml
   jugglework/releases/alpha/mac/latest-mac.yml
   ```
   A manifest can list arm64, x64, or universal artifacts; `MacUpdater` filters by architecture. Absolute CDN URLs ensure version manifests remain valid when copied to channel locations.
   - Rejected: per-architecture manifest directories; Rosetta/native architecture selection belongs to the updater and a shared manifest supports future multi-architecture releases.

3. **ZIP is the automatic payload; DMG is manual-install inventory.** Continue building ZIP and DMG together. Preserve generated blockmaps even while `disableDifferentialDownload` remains true. Normalize/validate electron-builder's manifest so top-level `path`/`sha512` select a ZIP and every file entry points to the immutable CDN URL.
   - Rejected: DMG-only updater feed; electron-updater 6.8.3 `MacUpdater` throws `ERR_UPDATER_ZIP_FILE_NOT_FOUND`.

4. **Package a generic Qiniu fallback per platform and still set the feed explicitly at runtime.** Move `publish` into platform-specific electron-builder configuration (macOS stable URL first), so `app-update.yml` is correct even before runtime override. Runtime still selects stable/Alpha/targeted feeds explicitly. Packaged verification fails if `app-update.yml` or compiled code contains an active GitHub update origin.

5. **Use a repository release tool with explicit phases and no secret persistence.** Add a script that supports `plan`, `build`, `verify-local`, `upload-version`, `verify-cdn`, `promote-channel`, and `verify-only`/`resume`. It invokes authenticated local/CI `qshell` without reading or logging raw credentials. All version keys are preflighted; matching partial uploads may be verified/resumed, mismatches fail, and immutable objects are never uploaded with `--overwrite`.

6. **Make channel promotion the only mutable step.** Upload and verify ZIP/DMG/blockmaps first, then the immutable version manifest. Acquire CI serialization plus a non-overwriting bucket lock/lease before promotion. Replace only `stable/mac/latest-mac.yml` or `alpha/mac/latest-mac.yml`, assign revalidation cache headers, refresh CDN, and read back the public manifest until its digest matches. Release the lock after verification; stale-lock breaking is an explicit audited operation.
   - Qiniu object replacement is atomic for one key, but publication as a whole is made observable only through the final channel manifest.

7. **Verify both Qiniu metadata and public bytes.** For every immutable object, compare local size/Qiniu ETag with `qshell stat`; then GET through `downloads.jugglechat.cn` and verify size/SHA-512 (and SHA-256 audit hash). Probe HTTPS certificate, MIME, Content-Length, and byte ranges. Manifest validation rejects missing, cross-origin, mutable-directory, duplicate, wrong-architecture, wrong-version, or hash-mismatched references.

8. **Stable macOS promotion is notarization-gated.** Change production packaging from `notarize: false` to an explicit environment-gated notarization path backed by CI/local secret names. Verify bundle id `com.juggleai.jugglework`, Team `H7PDHSK3C7`, hardened runtime, deep signing, notarization result, stapled ticket, Gatekeeper acceptance, and ZIP contents before promotion. Missing credentials may produce a candidate but cannot advance stable.
   - Alpha policy may be configured separately, but an unnotarized Alpha artifact must never be promoted as stable.
   - One migration-only exception is explicitly authorized for stable `1.2.15`. It requires an audited reason and may bypass only notarization, stapling, and Gatekeeper status; Developer ID identity, Team, hardened runtime, package inventory, immutable hashes, Qiniu/CDN verification, and real-client canary gates remain mandatory. The exception is rejected for every other version.

9. **Start Qiniu-only publication with version `1.2.15`.** Build `1.2.15` with Qiniu feed code, publish immutable Qiniu artifacts and the version manifest, run a targeted version-feed canary, and promote Qiniu stable. Do not publish updater artifacts or manifests to GitHub. Prove `1.2.15 → 1.2.16` using Qiniu only.

10. **Do not silently fall back or downgrade.** A Qiniu-enabled client treats a missing/malformed Qiniu feed as an update error/no update and keeps the current app. Disable stable `allowDowngrade`; emergency recovery ships a higher patch. A separately audited manual rollback can remain operational documentation, not normal updater behavior.

11. **Resolve manual DMGs from the same manifest.** Architecture mismatch and manual fallback parse the selected Qiniu manifest and choose the matching signed DMG. They do not fabricate a filename or require a nonexistent website. If an official download page is added later, it can become a presentation link without changing update trust.

12. **Coordinate Den only after client canary.** Qiniu immutable publication and targeted-feed installation happen first, then channel promotion/read-back, then Den `publishedDesktopVersions` and `latestAppVersion`. Organization `allowedDesktopVersions` are never mass-mutated by the release script; they remain explicit policy actions. The release evidence records the Den read-back. If the existing administration path is unavailable, metadata announcement remains blocked and is handled in a separate server-repo change.

13. **Store a non-secret release record.** Generate a versioned JSON/Markdown record containing commit, version, artifact names/keys, sizes, SHA-256/SHA-512, Qiniu ETags, signer/notarization evidence, channel manifest digest, CDN checks, Den read-back, and timestamps. No access keys, tokens, cookies, private keys, or notarization credentials are recorded.

14. **Allow one audited `1.2.16` live-upgrade exception.** The operator explicitly authorizes stable `1.2.16` to be exposed before its real-client canary and without notarization so the already-installed production `1.2.15` UI can discover and install it through the normal Den-selected flow. Tooling requires separate long-form notarization and pre-canary reasons and hard-codes the exact stable `1.2.16` coordinate. It still requires the expected Developer ID/Team, hardened runtime, immutable artifact digests, Qiniu/CDN verification, promotion lock, refresh, and read-back. A present failed canary is never ignored. After the update, record the operator-observed `1.2.15 → 1.2.16` result; later versions return to normal notarization-first and canary-first ordering.

## Risks / Trade-offs

- **[Old clients may remain pinned to GitHub]** They will not discover Qiniu-only releases automatically → treat them as outside this migration scope and use an explicitly supported manual installation path when needed.
- **[ZIP traffic is about 228 MB per update]** Differential download remains disabled → validate reliability first; enable blockmap differentials only in a separate measured change.
- **[Mutable manifest is cached]** Clients may see stale stable/alpha pointers → use revalidation/short TTL, explicit CDN refresh, and read-back before Den announcement.
- **[Concurrent publishers race]** Two releases can overwrite the channel pointer → CI concurrency plus bucket promotion lock; immutable object preflight remains fail-closed.
- **[Notarization blocks release]** Existing configuration disables it and credentials may be absent → separate candidate creation from stable promotion and request credentials through private setup only.
- **[One-time 1.2.15 notarization exception]** The migration release may be accepted without an Apple ticket only under the explicit audited exception → hard-code the exact stable version coordinate and preserve every other release gate; later releases fail closed.
- **[Qiniu outage removes update discovery]** No silent GitHub fallback preserves the declared trust boundary → current installation remains usable; retry and manifest-selected manual DMG remain available when CDN recovers.
- **[Manifest itself is not natively signed by electron-updater]** Integrity is SHA-512 plus HTTPS and Apple code signing → protect Qiniu credentials, restrict promotion access, audit every manifest digest, and verify the installed Team identity in canary.
- **[Den inventory and Qiniu diverge]** Clients can target missing versions → order Den updates after CDN canary and fail publication evidence if Den read-back disagrees.
- **[Platform paths regress]** A global macOS URL could break Windows/Linux → platform resolver tests and packaged `app-update.yml` checks for every supported build target.

## Migration Plan

1. Implement feed/layout resolvers, generic packaged configuration, manual-DMG resolution, monotonic behavior, diagnostics, and focused unit tests without changing any channel manifest.
2. Implement release tooling, manifest normalization/validation, non-overwrite/version locking, Qiniu/CDN verification, dry-run/resume, cache refresh, and release evidence generation.
3. Configure Apple notarization secrets privately; build and fully verify `1.2.15` arm64 ZIP/DMG/blockmaps and Qiniu-enabled packaged defaults.
4. Upload immutable `v1.2.15` objects, publish its version manifest, and use a clean, unpublished lower-version canary build containing the new updater code to perform a targeted-feed download/install/restart test. This proves the Qiniu version feed before `1.2.15` is promoted; `1.2.15` cannot validate an update to itself.
5. Promote and read back Qiniu stable. Do not publish updater assets or manifests to GitHub.
6. Update/read back Den published/latest metadata; leave org allowlists unchanged unless authorized separately.
7. Build/publish a Qiniu-only `1.2.16` test or production patch and prove `1.2.15 → 1.2.16` has no GitHub requests, retains user state, and passes signing/Gatekeeper checks.
8. Document routine Qiniu release, failed-stage resume, promotion lock recovery, higher-patch rollback, and the Qiniu-only support boundary.

Rollback before stable promotion leaves the existing channel untouched. After promotion, stop Den rollout and publish a higher patch that restores known-good behavior; do not move stable backwards automatically.
