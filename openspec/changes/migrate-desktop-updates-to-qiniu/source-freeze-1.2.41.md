# 1.2.41 macOS ARM64 Stable: manual transition

- Synchronize App, Desktop and embedded Server to `1.2.41`. The signed ARM64 package's Stable config and runtime use the new origin; previously installed clients must manually install the signed/notarized `1.2.41` DMG. Subsequent Stable updates use the new feed. macOS Intel, Windows, Linux, Alpha and exact historical targets retain their existing runtime feeds.
- Read-only preflight: `qshell domains jugglework` reports `downloads.jugglework.cn`; the release prefix had no objects; authenticated stat reported no Stable manifest or lock, and the public Stable manifest returned `404 {"error":"Document not found"}`. Live absence is revalidated before and under the lock. Verify the bucket/domain mapping against authenticated metadata and public bytes of an approved known object before any publication; a 404 alone does not prove binding.
- No historical evidence rewrite and no legacy writes. Historical runner continuation remains usable for read-only diagnosis. Build and promote this first candidate through the local native ARM64 release wrapper and scoped CLI; the old promotion-only runner is not a bootstrap runner. Any later CI publisher needs new bucket credentials and CDN refresh scope, and explicit predecessor handling. Defer publication for platforms/channels still on legacy feeds.
- Standing policy skips the unattempted lower-version real-client canary and mutable Cache-Control mutation/value gate only. Cache read-back is still recorded; successful refresh does not prove fleet convergence. No predecessor bytes exist for rollback of this first promotion: on uncertainty retain the lock/evidence for audited recovery, do not restore old-origin bytes, and use a higher verified patch when clients may already have seen the release.
- Den and website are later stages. Verify China first; the authorized overseas exception applies only to the existing 5xx in that separate rollout, not to newly introduced failures or publication checks. No production change is part of source freeze.

## Source gate status

Base: `68a8b01631106c2060f97c877e7342ead038a752`. The frozen install, shared Types build, App/Server/Electron typechecks, and strict OpenSpec validation passed. The nine Electron type diagnostics were fixed in three test fixtures only (`file-window-preload`, `native-actions-api`, `terminal-manager`).

- Full Desktop command, including pretests: 1,268 passed, 0 failed, 2 skipped. The opt-in real-media smoke test was run separately and passed; the other skip is the off-macOS test on this macOS host. Focused release tests: 341 passed, 0 failed, 1 skipped. Shared update feed: 6 passed.
- The native ARM64 media tools were built from the pinned, verified sources using CLT SDK `27.2`. The process-local `DEVELOPER_DIR` was passed through the wrapper's clean environment to the unchanged recipe. The generated binaries passed the real-media smoke test, including empty `PATH` and tamper rejection. No generated media or dependency lockfile changes are included.
- A repeat read-only check at `2026-11-23T12:30:44.130Z` confirmed authenticated object absence and the expected public 404 for `jugglework/releases/stable/mac/latest-mac.yml`. This is a preflight, not promotion evidence. Mock tests cover a wrong 404, a 5xx, a post-lock race, and an insert-only collision.

## Next release stage (after source freeze and separate authorization)

On the designated native ARM64 Mac, from a clean worktree at the frozen release commit, first follow the release skill's domain-binding and packaged-media prerequisites. Use a fresh private directory outside the repository for evidence (`RELEASE_EVIDENCE_DIR`).

```bash
pnpm install --frozen-lockfile
xcrun notarytool history --keychain "$HOME/Library/Keychains/login.keychain-db" \
  --keychain-profile JUGGLEWORK_NOTARY_PROFILE --output-format json >/dev/null
APPLE_NOTARY_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db" \
  caffeinate -i pnpm --dir apps/desktop package:mac-release -- --arch arm64

DIST=apps/desktop/dist-electron
EVIDENCE="$RELEASE_EVIDENCE_DIR/qiniu-release-evidence.json"
LOCAL="$RELEASE_EVIDENCE_DIR/macos-local-verification.json"
release_cli() {
  local command="$1"
  shift
  node apps/desktop/scripts/qiniu-release/cli.mjs "$command" \
    --version 1.2.41 --channel stable --platform mac --arch arm64 \
    --bucket jugglework --dist "$DIST" --evidence "$EVIDENCE" "$@"
}
release_cli plan
pnpm --dir apps/desktop verify:mac-package -- \
  --app dist-electron/mac-arm64/JuggleWork.app --arch arm64 --version 1.2.41 \
  --zip dist-electron/jugglework-mac-arm64-1.2.41.zip \
  --dmg dist-electron/jugglework-mac-arm64-1.2.41.dmg \
  --manifest dist-electron/qiniu-v1.2.41-latest-mac.yml \
  --notarization-receipt dist-electron/mac-arm64/jugglework-notarization-receipt.json \
  --dmg-notarization-receipt dist-electron/mac-arm64/jugglework-dmg-notarization-receipt.json \
  --verification-output "$LOCAL"
release_cli verify-local --commit "$(git rev-parse HEAD)" --local-verification "$LOCAL"
```

Only after packaged/media acceptance and the publication authorization, use `release_cli upload-version`, then `release_cli verify-cdn`. Run the following only if those gates pass and there are no unresolved current-candidate canary attempts:

```bash
release_cli promote-channel --bootstrap manual-transition-1.2.41 \
  --standing-policy stable-mac-arm64-standing-policy \
  --pre-canary-exception-reason 'User standing authorization: skip only the absent lower-version real-client upgrade canary.' \
  --metadata-exception-reason 'User standing authorization: skip only mutable Qiniu Cache-Control mutation and required-value validation.'
```
