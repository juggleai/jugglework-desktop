# Qiniu Desktop Release Runbook

The repository-local release tool lives in `apps/desktop/scripts/qiniu-release/`. It publishes immutable desktop artifacts through the installed authenticated `qshell`; it never reads or prints Qiniu credentials. Run it directly with Node because package scripts are intentionally not required:

```sh
node apps/desktop/scripts/qiniu-release/cli.mjs plan \
  --version 1.2.15 --channel stable --platform mac --arch arm64 \
  --dist apps/desktop/dist-electron --evidence /secure/release-evidence-1.2.15.json --dry-run
```

Production CI uses the manually dispatched `.github/workflows/qiniu-desktop-release.yml` workflow and the protected `qiniu-desktop-release` environment. Configure that environment's deployment-branch policy to allow only the protected `dev` branch; Qiniu publication checks out `dev` explicitly rather than accepting an arbitrary release ref. Its per-channel concurrency group has `cancel-in-progress: false`, so another run cannot overlap or cancel a publisher that may hold the Qiniu lock. Desktop stable and Alpha updater publication is Qiniu-only; GitHub release workflows do not publish updater assets or manifests.

All commands require `--version`, `--channel`, `--platform`, `--arch`, `--dist`, and `--evidence`. Stable versions must be plain `X.Y.Z`. Alpha accepts plain versions and SemVer prereleases such as `1.2.16-alpha.1`; prereleases cannot target stable, and build metadata is rejected. Channels remain restricted to `stable` and `alpha`, the platform to `mac`, and architectures to `arm64`, `x64`, or `universal`. Supply `arm64,x64` for a mixed manifest. The expected local names are `jugglework-mac-<arch>-<version>.zip`, `.zip.blockmap`, `.dmg`, and `.dmg.blockmap`.

## Routine Sequence

For local macOS release packaging, use the repository wrapper instead of invoking electron-builder directly:

```sh
pnpm --dir apps/desktop package:mac-release -- --arch arm64
```

The wrapper uses the default `JUGGLEWORK_NOTARY_PROFILE` keychain profile (override with `APPLE_NOTARY_KEYCHAIN_PROFILE`), the expected local Developer ID identity, and `MACOS_NOTARIZE=true`. It notarizes and staples the signed `.app` before ZIP/DMG creation, then validates the electron-builder-signed outer DMG, submits and staples that DMG, regenerates the DMG blockmap from the final stapled bytes, and rewrites `latest-mac.yml` from the final ZIP/DMG size and SHA-512. Never run `plan`, upload, or retain a builder-generated DMG blockmap before this finalizer succeeds.

1. Run `plan --dry-run`. Review every immutable key and the final mutable channel key. Dry-run computes local hashes but performs no Qiniu, CDN, or Den mutation.
2. Run an explicit build command through the safe wrapper: `build [release options] -- executable arg1 arg2`. The executable and arguments are passed directly with `shell: false`; no command string is parsed. `--dry-run` reports the executable and argument count but never starts it. The caller remains responsible for choosing the repository packaging/signing/notarization command.
3. Run `plan` without `--dry-run` to persist `qiniu-v<version>-latest-mac.yml` with immutable absolute URLs using `wx`. Have `verify-packaged-macos` inspect the app, ZIP, DMG, both blockmaps, and that exact normalized manifest and write local verification JSON. Then run `verify-local --commit <git-commit> --local-verification <path> [--canary <path>]` to create release evidence with `wx`. Local verification is digest-bound to every artifact and the normalized manifest; it does not infer or invent missing notarization, stapling, Gatekeeper, credential, or canary results.
4. Local verification uses schema `com.juggleai.jugglework.macos-local-verification`, version `1`, producer `verify-packaged-macos`. The after-sign hook captures the non-secret `.app` submission ID, and the finalizer captures a separate non-secret outer-DMG submission ID. Stable authorization requires both receipts, valid `.app` and DMG stapled tickets, accepted Gatekeeper assessments, a verified disk image, exact bundle ID `com.juggleai.jugglework`, exact Team ID `H7PDHSK3C7`, accepted deep/strict app signing, and hardened runtime. A keychain profile or the CI API-key triplet satisfies credential availability; profile names and key paths are never written to evidence. Candidate, unavailable, failed, missing-credential, missing-field, wrong-producer, wrong-schema, and wrong-identity states fail closed.
   - Explicitly audited notarization exceptions are hard-coded to exact approved stable versions through `1.2.20`: `promote-channel --notarization-exception-reason "<at least 20 characters>"`. They bypass only notarization/staple/Gatekeeper state after Developer ID, Team, hardened-runtime, artifact digest, and Qiniu/CDN gates pass. Separately audited pre-canary exceptions are hard-coded only for approved stable versions, including exact macOS arm64 `1.2.22` through `1.2.31`, with version-specific scopes. Windows, Alpha and other architectures for these versions remain fail-closed for pre-canary exceptions; `1.2.31` permits separately audited pre-canary and metadata-only exceptions under the latest authorization below, while notarization remains mandatory. Future `1.2.32` is not authorized for any exception.
5. Run `upload-version`. The tool preflights every immutable key with `qshell stat`, uploads binaries without `--overwrite`, verifies each upload, and uploads the immutable version manifest last.
6. Run `verify-cdn` or `verify-only`. Both compare Qiniu size/ETag and public HTTPS metadata, MIME, required Content-Length on HEAD/range/full responses, byte range, full size, SHA-256, and SHA-512 for every object. Successful Qiniu/CDN checks are written atomically into the evidence by the CLI. Failed or unavailable checks are not synthesized.
7. Supply a machine-generated canary document using schema `com.juggleai.jugglework.macos-update-canary`, version `1`, producer `jugglework-macos-update-canary`. It must identify a semantically older source version, the target version, exact architecture set, immutable manifest SHA-256, targeted immutable feed URL, channel, run ID, Qiniu manifest/artifact origins, timestamp, and passed clean-client, discovery, download, install, restart, installed-version, user-data, workspace-access, and permissions checks. Arbitrary `canaryPassed` booleans or prose are not authorization. If the canary was not available when evidence was created, pass the actual result to a post-upload `verify-only --canary <path>` run; the CLI validates and records it with fresh remote checks. Do not invent it.
8. Run `promote-channel`. Promotion validates evidence schema `com.juggleai.jugglework.qiniu-release-evidence`, version `2`, exact release coordinates and artifact identities, digest-bound machine local verification, machine canary, and CLI-recorded immutable/CDN results before making any Qiniu call. Promotion acquires `jugglework/releases/locks/<channel>-mac.lock` without overwrite, rechecks immutable objects, overwrites only `<channel>/mac/latest-mac.yml`, runs `qshell cdnrefresh`, and polls public read-back with bounded retry until digest and Content-Length converge before removing its owned lock. If refresh or read-back fails after channel mutation, the lock is deliberately retained for audited recovery.
9. Update Den published/latest metadata only after Qiniu channel read-back and a real client canary succeed, unless an exact-version pre-canary exception was explicitly authorized. Read Den metadata back and record it in evidence. Never change organization allowlists without explicit policy authorization.

## 1.2.31 Current Scoped Release Authorization

The operator's latest continuation explicitly authorizes completing stable macOS ARM64 `1.2.31`, including signed/notarized DMG and updater ZIP, Qiniu immutable upload and Stable promotion, then configuration-only China and overseas Den rollout. It supersedes the earlier real-canary requirement below: skip the real-client upgrade canary and Qiniu Cache-Control metadata mutation/validation using separate audited `--pre-canary-exception-reason` and `--metadata-exception-reason` values. Both are scoped to `stable-1.2.31-only`. The current tooling supports these independent exceptions; a present failed/mismatched canary remains rejected. Signing, notarization, staples, Gatekeeper, full package and immutable/CDN verification, serialized workflow, locks, predecessor checks, channel size/ETag, CDN refresh and exact public digest/size read-back remain mandatory. Do not claim installation/relaunch or retained state was verified. Windows, website, GitHub Release and Den binary deployment are outside this continuation.

## 1.2.31 Earlier Cache Metadata Only Authorization (Superseded)

The operator explicitly requires a real local upgrade canary for exact stable macOS ARM64 `1.2.31` and authorizes only skipping Qiniu mutable Stable Cache-Control metadata mutation/validation. "Do not validate Qiniu cache" does not waive CDN refresh, public byte verification, or any other release gate. Supply a separate `--metadata-exception-reason "<at least 20 characters>"` describing this authorization; evidence records it as `stable-1.2.31-only`. Do not supply `--pre-canary-exception-reason`, `--notarization-exception-reason`, or the older broader `--cache-exception-reason`: all are rejected for `1.2.31`.

Before promotion, run a real isolated lower-version macOS ARM64 client against the exact immutable `1.2.31` feed. Observe discovery, download, install, old-process exit, relaunch into `1.2.31`, and retained user data, workspace access, and permissions. Record the actual machine-generated result using the routine canary schema and import it with `verify-only --canary <path>` if evidence already exists. Missing, failed, wrong-version, wrong-architecture, wrong-feed, or wrong-manifest-digest canaries fail closed. Do not substitute a smoke test, fabricated result, or the earlier `1.2.30` pre-canary exception.

Keep Developer ID/Team and bundle identity, hardened runtime, separate accepted app/outer-DMG notarization receipts, staples, Gatekeeper, complete package verification, immutable non-overwrite Qiniu/CDN integrity checks, promotion lock and prior-digest race checks, and channel object size/ETag verification. Only Cache-Control metadata preflight, mutation, and validation are skipped. CDN refresh and exact public Stable SHA-256/size read-back remain mandatory, and refresh/read-back/durable-evidence failures retain the lock. Inherited long-lived headers may still leave clients stale despite observed read-back; do not claim all clients have converged.

This exception excludes Windows, x64/mixed/universal architectures, Alpha, other channels, and future `1.2.32`. Prior exact-version authorizations remain unchanged. This tooling-only preparation does not authorize or perform version changes, commits, merges, packaging, publication, promotion, or Den changes.

## 1.2.30 Scoped Release Authorization

The operator explicitly authorized exact stable macOS ARM64 `1.2.30`: synchronize App, Desktop, and embedded Server versions, commit/push `dev`, merge/push `main`, build a signed/notarized DMG and updater ZIP, finalize both blockmaps and the immutable manifest, publish immutable objects, promote Stable, then update China Den followed by overseas Den. Windows and the public website remain unchanged. Mark operational tasks complete only after execution and verification. Before public publication, resolve the existing Office SDK distribution-approval task; the release request alone does not prove third-party distribution rights.

For that later promotion, supply separate `--pre-canary-exception-reason` and `--metadata-exception-reason` values of at least 20 characters each. Both are recorded with exact scope `stable-1.2.30-only`. Skip only the real-client upgrade canary and Qiniu mutable Stable Cache-Control metadata change/verification. The older `--cache-exception-reason` is forbidden for `1.2.30`: CDN refresh and exact public Stable SHA-256/size read-back remain mandatory. A present failed or mismatched canary is rejected, not waived.

Preserve Developer ID/Team and bundle identity, hardened runtime, separate accepted app/outer-DMG notarization receipts, staples, Gatekeeper, complete ZIP/DMG/blockmap/package verification, immutable non-overwrite Qiniu/CDN integrity checks, promotion locking and prior-digest race checks, and Stable object size/ETag verification. Failed refresh, public read-back, or durable evidence persistence retains the lock for audited recovery. Neither exception permits notarization bypass, Windows, x64/mixed/universal architectures, Alpha, other channels, or `1.2.31` under this authorization; previous exact-version authorizations remain unchanged.

Only after verified Stable promotion may Den be changed, configuration only: independently back up and verify China first, then overseas. Preserve each environment's existing inventory and policy, add `1.2.30` to published inventory and the effective allowed list when present, and verify latest version, health/readiness, runtime config, console, unchanged binary checksum, and loopback-only 8021 before proceeding. Upgrading the embedded Server package is not authorization to deploy a Den server binary. Do not update Windows or website links.

Risk: inherited long-lived cache headers may leave clients stale despite one matching public read-back. Without a real-client canary, installation/relaunch and retained state remain unproven; do not report them as verified.

## 1.2.29 Scoped Release Authorization

The operator authorized stable macOS ARM64 `1.2.29` like `1.2.28`: version synchronization, commit/push and merge into main, a signed/notarized DMG and updater ZIP, both final blockmaps, immutable manifest, Stable promotion, then China Den followed by overseas Den. Windows and the public website remain unchanged. Each operational step must be completed and evidenced before marking it done.

For that later promotion, supply separate `--pre-canary-exception-reason` and `--metadata-exception-reason` values of at least 20 characters each. Evidence records both with exact scope `stable-1.2.29-only`. Omit only the real-client upgrade canary and Qiniu mutable Stable Cache-Control metadata change/verification. The older `--cache-exception-reason` is forbidden for `1.2.29`: CDN refresh and exact public Stable SHA-256/size read-back remain mandatory. A present failed or mismatched canary is rejected, not waived.

Preserve Developer ID/Team and bundle identity, hardened runtime, separate accepted app/outer-DMG notarization receipts, staples, Gatekeeper, full ZIP/DMG/blockmap/package verification, immutable non-overwrite integrity and Qiniu/CDN checks, promotion lock and prior-digest race check, and Stable object size/ETag verification. Failed refresh, read-back, or durable evidence persistence retains the lock for audited recovery. Neither exception under this authorization permits notarization bypass, Windows, x64/mixed/universal architectures, Alpha, or another version without separate exact-version authorization.

Only after verified Stable promotion may Den be changed, configuration only: back up and verify China first, then independently back up and verify overseas. Preserve each environment's existing inventory and policy, add `1.2.29` to published inventory and the effective allowed list when present, and verify latest version, health/readiness, runtime config, console, unchanged binary checksum, and loopback-only 8021 before proceeding. Do not deploy a server binary or update website/Windows links for this release.

Risk: inherited long-lived cache headers may leave clients stale despite one matching public read-back. Without a real-client canary, installation/relaunch and retained state are unproven; do not report them as verified.

## Verification And Resume

`verify-only` never uploads or promotes. Use it to reconstruct remote/CDN evidence after an interrupted run.

Use `resume` only after a partial immutable upload. Existing keys are accepted only when Qiniu size and ETag exactly match local metadata; a mismatch fails and is never overwritten. Missing keys are uploaded in binary-first, manifest-last order. Do not use `upload-version` for an existing key because normal publication intentionally refuses it.

## Lock Recovery

The production workflow serializes runs by channel with `cancel-in-progress: false`; do not bypass that workflow for production promotion. The Qiniu lock is defense in depth, not a substitute for scheduler concurrency.

Lock contention means another publisher may be active. Inspect CI concurrency and the lock's Qiniu `putTime`; textual and JSON `putTime` values are normalized to exact decimal strings so JavaScript number precision cannot collapse distinct timestamps. Do not delete a live lock. After confirming the publisher has terminated and the channel state is understood, record the operator and reason, dry-run recovery, then recover explicitly:

```sh
node apps/desktop/scripts/qiniu-release/cli.mjs recover-lock \
  --version 1.2.15 --channel stable --platform mac --arch arm64 \
  --dist apps/desktop/dist-electron --evidence /secure/release-evidence-1.2.15.json \
  --actor release-operator --reason "CI run 1234 terminated before channel mutation" \
  --audit /secure/qiniu-lock-recovery.jsonl --dry-run
```

Remove `--dry-run` only after review. Immediately before deletion, recovery re-stats the lock and requires exact size, ETag, and `putTime` ownership to match the inspected object; a replacement lock is never deleted. The CLI durably appends authorization and completion records to the required local JSONL audit path. Keep that artifact with release records. This reduces the inspect/delete race but Qiniu does not expose a conditional delete in this adapter, so an unavoidable provider-level race can remain between the final stat and delete. Lock deletion is not rollback; verify channel and immutable objects again before retrying promotion.

## CDN Cache

The installed `qshell v2.19.10` documents `cdnrefresh`; the adapter passes the channel URL through stdin rather than shell interpolation. Promotion fails if refresh is unavailable, fails, or bounded public read-back does not converge to the local SHA-256 digest and expected Content-Length. Immutable version objects may use long-lived immutable caching. Configure the mutable stable/alpha manifest for short TTL or revalidation in Qiniu/CDN administration; the installed CLI does not expose a proven cache-header command, so that policy remains an explicit infrastructure prerequisite.

## 1.2.15 Qiniu-only Release And Den

Publish `1.2.15` directly to Qiniu as the first Qiniu-only stable release. Complete immutable publication, targeted-feed install/restart canary, stable promotion, cache refresh, and read-back. The workflow retains the signed ZIP, DMG, both blockmaps, immutable manifest, machine verification, and release evidence. Do not publish these updater assets or manifests to GitHub. Clients that still check the retired GitHub updater feed are outside this release's migration scope and must install a Qiniu-enabled release through an explicitly supported manual path.

Only after the Qiniu canary and stable channel read-back pass may Den advertise the version in published/latest metadata. Record Den read-back in evidence; Den is deliberately not mutated by this repository-local tool.

## Failure And Rollback

Before channel promotion, stop and resume or verify; the existing channel is untouched. If refresh/read-back fails after channel overwrite, keep Den unchanged, investigate CDN state, and retain the evidence and lock diagnostics. After a bad stable promotion, stop Den rollout and ship a higher patch containing the known-good behavior. Do not move stable backwards or enable automatic downgrade. Manual recovery must be separately audited.

Never place `accessKey`, `secretKey`, `apiKey`, `clientSecret`, `authorization`, session/access/refresh tokens, cookies, passwords, private keys, notarization credentials, or raw credential command output in evidence, logs, arguments, repository files, or support messages. Evidence rejects these and related secret-like key names recursively. Qshell error output is conservatively redacted and truncated, but operators must still avoid commands or paths containing credentials. Authenticate `qshell` outside this workflow using approved local or CI secret storage.
