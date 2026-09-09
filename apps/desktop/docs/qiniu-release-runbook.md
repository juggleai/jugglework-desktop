# Qiniu Desktop Release Runbook

The repository-local release tool lives in `apps/desktop/scripts/qiniu-release/`. It publishes immutable desktop artifacts through the installed authenticated `qshell`; it never reads or prints Qiniu credentials. Run it directly with Node because package scripts are intentionally not required:

```sh
node apps/desktop/scripts/qiniu-release/cli.mjs plan \
  --version 1.2.15 --channel stable --platform mac --arch arm64 \
  --dist apps/desktop/dist-electron --evidence /secure/release-evidence-1.2.15.json --dry-run
```

Production CI uses the manually dispatched `.github/workflows/qiniu-desktop-release.yml` workflow and the protected `qiniu-desktop-release` environment. Configure that environment's deployment-branch policy to allow only the protected `dev` branch; both Qiniu publication and the one-time GitHub bridge check out `dev` explicitly rather than accepting an arbitrary release ref. Its per-channel concurrency group has `cancel-in-progress: false`, so another run cannot overlap or cancel a publisher that may hold the Qiniu lock. Routine Alpha publication no longer runs on every `dev` push; the old GitHub Alpha workflow is manual, confirmation-gated bridge tooling only. Stable GitHub desktop upload is restricted to the exact manually dispatched `v1.2.15` bridge coordinate.

All commands require `--version`, `--channel`, `--platform`, `--arch`, `--dist`, and `--evidence`. Stable versions must be plain `X.Y.Z`. Alpha accepts plain versions and SemVer prereleases such as `1.2.16-alpha.1`; prereleases cannot target stable, and build metadata is rejected. Channels remain restricted to `stable` and `alpha`, the platform to `mac`, and architectures to `arm64`, `x64`, or `universal`. Supply `arm64,x64` for a mixed manifest. The expected local names are `jugglework-mac-<arch>-<version>.zip`, `.zip.blockmap`, `.dmg`, and `.dmg.blockmap`.

## Routine Sequence

1. Run `plan --dry-run`. Review every immutable key and the final mutable channel key. Dry-run computes local hashes but performs no Qiniu, CDN, GitHub, or Den mutation.
2. Run an explicit build command through the safe wrapper: `build [release options] -- executable arg1 arg2`. The executable and arguments are passed directly with `shell: false`; no command string is parsed. `--dry-run` reports the executable and argument count but never starts it. The caller remains responsible for choosing the repository packaging/signing/notarization command.
3. Run `plan` without `--dry-run` to persist `qiniu-v<version>-latest-mac.yml` with immutable absolute URLs using `wx`. Have `verify-packaged-macos` inspect the app, ZIP, DMG, both blockmaps, and that exact normalized manifest and write local verification JSON. Then run `verify-local --commit <git-commit> --local-verification <path> [--canary <path>]` to create release evidence with `wx`. Local verification is digest-bound to every artifact and the normalized manifest; it does not infer or invent missing notarization, stapling, Gatekeeper, credential, or canary results.
4. Local verification uses schema `com.juggleai.jugglework.macos-local-verification`, version `1`, producer `verify-packaged-macos`. The after-sign hook captures the non-secret submission ID from `notarytool --wait --output-format json` and writes a version/bundle-bound machine receipt only after Apple reports `Accepted` and staple validation succeeds. The package verifier accepts it only together with a currently valid staple and Gatekeeper assessment. Stable authorization requires release state `release`, credential state `available`, exact bundle ID `com.juggleai.jugglework`, exact Team ID `H7PDHSK3C7`, accepted `codesign --deep --strict`, hardened runtime `enabled`, notarization `accepted`, staple `validated`, and Gatekeeper `accepted`. Candidate, unavailable, failed, missing-credential, missing-field, wrong-producer, wrong-schema, and wrong-identity states fail closed. A candidate record can be retained as evidence but cannot promote stable.
5. Run `upload-version`. The tool preflights every immutable key with `qshell stat`, uploads binaries without `--overwrite`, verifies each upload, and uploads the immutable version manifest last.
6. Run `verify-cdn` or `verify-only`. Both compare Qiniu size/ETag and public HTTPS metadata, MIME, required Content-Length on HEAD/range/full responses, byte range, full size, SHA-256, and SHA-512 for every object. Successful Qiniu/CDN checks are written atomically into the evidence by the CLI. Failed or unavailable checks are not synthesized.
7. Supply a machine-generated canary document using schema `com.juggleai.jugglework.macos-update-canary`, version `1`, producer `jugglework-macos-update-canary`. It must identify a semantically older source version, the target version, exact architecture set, immutable manifest SHA-256, targeted immutable feed URL, channel, run ID, Qiniu manifest/artifact origins, timestamp, and passed clean-client, discovery, download, install, restart, installed-version, user-data, workspace-access, and permissions checks. Arbitrary `canaryPassed` booleans or prose are not authorization. If the canary was not available when evidence was created, pass the actual result to a post-upload `verify-only --canary <path>` run; the CLI validates and records it with fresh remote checks. Do not invent it.
8. Run `promote-channel`. Promotion validates evidence schema `com.juggleai.jugglework.qiniu-release-evidence`, version `2`, exact release coordinates and artifact identities, digest-bound machine local verification, machine canary, and CLI-recorded immutable/CDN results before making any Qiniu call. Promotion acquires `jugglework/releases/locks/<channel>-mac.lock` without overwrite, rechecks immutable objects, overwrites only `<channel>/mac/latest-mac.yml`, runs `qshell cdnrefresh`, and polls public read-back with bounded retry until digest and Content-Length converge before removing its owned lock. If refresh or read-back fails after channel mutation, the lock is deliberately retained for audited recovery.
9. Update Den published/latest metadata only after Qiniu channel read-back and a real client canary succeed. Read Den metadata back and record it in evidence. Never change organization allowlists as part of this release procedure.

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

## 1.2.15 Bridge And Den

For the `1.2.15` migration bridge, complete Qiniu immutable publication, targeted-feed install/restart canary, stable promotion, cache refresh, and read-back first. The Qiniu workflow retains one exact release bundle containing the signed ZIP, DMG, both blockmaps, immutable manifest, machine verification, and release evidence. Dispatch `.github/workflows/github-desktop-bridge.yml` with that successful Qiniu run ID and the required confirmation phrase. The bridge workflow recomputes every local digest, requires the recorded stable promotion/read-back to match, copies the immutable manifest byte-for-byte to GitHub's `latest-mac.yml`, refuses to overwrite an existing updater asset, uploads without `--clobber`, downloads and byte-compares every asset before making the release public, and records the GitHub release ID/tag in a retained evidence artifact. It never rebuilds the application. Preserve that bridge release. Determine separately whether installed legacy Alpha clients require a semantically newer Alpha bridge. Routine releases after the bridge must not publish desktop updater assets to GitHub.

Only after the Qiniu canary and required GitHub bridge canary pass may Den advertise the version in published/latest metadata. Record GitHub identifiers and Den read-back in evidence; these systems are deliberately not mutated by this repository-local tool.

## Failure And Rollback

Before channel promotion, stop and resume or verify; the existing channel is untouched. If refresh/read-back fails after channel overwrite, keep Den unchanged, investigate CDN state, and retain the evidence and lock diagnostics. After a bad stable promotion, stop Den rollout and ship a higher patch containing the known-good behavior. Do not move stable backwards or enable automatic downgrade. Manual recovery must be separately audited.

Never place `accessKey`, `secretKey`, `apiKey`, `clientSecret`, `authorization`, session/access/refresh tokens, cookies, passwords, private keys, notarization credentials, or raw credential command output in evidence, logs, arguments, repository files, or support messages. Evidence rejects these and related secret-like key names recursively. Qshell error output is conservatively redacted and truncated, but operators must still avoid commands or paths containing credentials. Authenticate `qshell` outside this workflow using approved local or CI secret storage.
