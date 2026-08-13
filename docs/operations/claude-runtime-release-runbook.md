# Claude Agent release operator runbook

Use this runbook for every desktop release that contains the Claude Agent
runtime and for any SDK, CLI, Node, sandbox, packaging, or updater change.

## 1. Review compatibility

1. Confirm the intended targets and support status in
   `docs/operations/claude-runtime-compatibility.md`.
2. Confirm `@anthropic-ai/claude-agent-sdk` is an exact version, its platform
   optional package resolves at that same version, and worker Node remains an
   exact Node 24 version.
3. Treat an SDK, bundled CLI, Node, sandbox backend, worker protocol, or target
   change as a separate compatibility rollout. Do not combine it with an
   unrelated broad feature rollout.
4. Leave the Claude runtime feature flag off for Docker, microsandbox, and the
   standalone npm CLI. Those are currently OpenCode-only distributions.
5. Complete `docs/operations/claude-runtime-legal-review.md` against the final
   target artifacts. A passing technical gate is not legal approval.
6. For the post-14.3 mounted-client cleanup release, review
   `docs/operations/opencode-mounted-client-cleanup.md`. Confirm the cleanup is
   isolated, the retained adapter/importer boundary is unchanged, and rollback
   restores the complete prior release rather than only its proxy routes.

Run the static release gate:

```bash
pnpm release:review --strict
```

Rehearse the rollout locally without publishing any release:

```bash
pnpm rollout:rehearse
```

This writes redacted machine-readable evidence to
`tmp/claude-rollout/rollout-evidence.json`. CI runs the same command and uploads
that exact path as `claude-rollout-rehearsal-<commit>`. The artifact explicitly
records `externalReleasePublished: false`; it is rollout configuration and
rollback evidence, not evidence of an external production release.

## 2. Rehearse staged access

The runtime master flag is necessary but not sufficient. Set one stage and only
the corresponding cohort input:

| Stage | Required launch configuration | Expected non-cohort behavior |
| --- | --- | --- |
| Internal | `JUGGLEWORK_CLAUDE_AGENT_ENABLED=1`, `JUGGLEWORK_CLAUDE_ROLLOUT_STAGE=internal`, `JUGGLEWORK_CLAUDE_INTERNAL_COHORT=1` | OpenCode-only |
| Opt-in | `JUGGLEWORK_CLAUDE_AGENT_ENABLED=1`, `JUGGLEWORK_CLAUDE_ROLLOUT_STAGE=opt-in`, `JUGGLEWORK_CLAUDE_USER_OPT_IN=1` | OpenCode-only until explicit opt-in |
| GA | `JUGGLEWORK_CLAUDE_AGENT_ENABLED=1`, `JUGGLEWORK_CLAUDE_ROLLOUT_STAGE=ga` | Claude available when provisioned and healthy |

Unset/false master flags, missing cohort eligibility, unknown stages, and
`JUGGLEWORK_CLAUDE_AGENT_KILL_SWITCH=1` all fail closed without creating the
worker. Progress internal to opt-in to GA only after the prior stage evidence is
reviewed. Do not set GA merely to make a package smoke pass.

## 3. Build and inspect each desktop target

The release workflow builds all six triples listed in the compatibility matrix.
For a local native-target review, use:

```bash
TARGET=<target-triple> pnpm --filter @jugglework/desktop build:electron
pnpm --dir apps/desktop exec electron-builder --config electron-builder.yml --dir
node apps/claude-agent-worker/scripts/check-package-content.mjs apps/desktop/resources/claude-agent
node apps/claude-agent-worker/scripts/installed-smoke.mjs apps/desktop/resources/claude-agent
```

The checks must prove:

- The manifest target matches the installer target.
- Worker JS is readable; Node and Claude are executable and outside `app.asar`.
- SDK, CLI, and Node diagnostics match the package manifest.
- The worker starts with authenticated loopback transport.
- Fixture initialization, cancellation, and shutdown complete.
- The secret canary is absent from stdout and stderr.
- The worker and its Claude child leave no process behind.

Do not substitute a build-only cross-compile for a target-compatible installed
smoke. The macOS x64 smoke runs under Rosetta on the Apple silicon release
runner; record that limitation in release evidence. macOS artifacts must also
pass signing/notarization, and Windows signing must finish before updater hashes
are checked.

## 4. Verify updater assets

After packaging and any signing transformation, run this against each target's
`dist-electron` directory:

```bash
node scripts/release/verify-electron-updater-assets.mjs \
  apps/desktop/dist-electron \
  --expected-version <version> \
  --target <target-triple>
```

This rejects missing artifacts, stale sizes or SHA-512 values, missing zip/NSIS
blockmaps, missing AppImage embedded block-map metadata, wrong feed names, and
wrong architecture entries. The release merge job repeats the check against the
actual draft GitHub Release asset inventory before publishing merged feeds.

Never edit a generated updater manifest by hand. Rebuild it after signing or
use the checked signing helper that regenerates the Windows blockmap and hash.

## 5. Review sandbox and headless behavior

1. Run the Claude worker sandbox tests and Server adapter fail-closed tests.
2. Verify the runtime reports unavailable if sandbox initialization fails or if
   unsandboxed commands would be allowed.
3. Verify JuggleWork pre-tool policy remains active independently of the SDK sandbox.
4. For an approved source/library headless integration, run package-content and
   installed smoke on the deployment host and test its `deny`, pre-approved, or
   bounded-wait policy with no UI connected.
5. Do not claim Claude support for the repository Docker/microsandbox images or
   npm CLI until they package target assets, a Node 24 worker runtime, an
   approved credential broker, and corresponding target-compatible smoke evidence.

## 6. Release decision

Keep the GitHub Release in draft state until all matrix jobs and merged updater
checks pass. Record in the release review:

- App, Server, SDK, CLI, Node, and worker protocol versions.
- Per-target package-content and installed-smoke job URLs.
- Installer size delta attributable to the worker, Node, and Claude binary.
- Signing/notarization status and updater manifest names.
- Sandbox backend results and any host prerequisite.
- Whether Claude remains disabled by default and the rollout cohort/kill switch.
- Legal-review record, unresolved obligations, and approval/blocking owner.

Block the release for any missing target asset, version mismatch, secret output,
failed cancellation/shutdown, orphan process, unavailable required sandbox,
invalid updater metadata, or undocumented support change. An unsupported Claude
target may ship only when the runtime stays disabled/unavailable and OpenCode
startup is independently verified.

## 7. Rollback

1. Stop cohort expansion and set `JUGGLEWORK_CLAUDE_AGENT_KILL_SWITCH=1`, or
   unset the runtime master flag, then restart. Existing canonical Claude
   projections remain readable.
2. If the defect is isolated to an advanced capability, disable that capability
   and retain baseline run-per-query execution.
3. For package, Node, CLI, sandbox, or updater defects, withdraw the affected
   updater manifests/assets or mark the release non-latest, then republish the
   last known-good complete desktop release. Do not mix runtime directories
   between releases.
4. Do not automatically replay an interrupted turn. A tool may already have
   mutated state; require explicit user confirmation before retry.
5. Verify OpenCode-only startup with Claude disabled and confirm no worker or
   Claude process remains.
6. Preserve the failed package, redacted diagnostics, target triple, manifest,
   and workflow URLs for incident review. Never attach credentials or raw
   private transcripts.

## Directed verification

```bash
node --test scripts/release/verify-electron-updater-assets.test.mjs
node --test apps/desktop/electron/claude-runtime-assets.test.mjs
pnpm --filter @jugglework/claude-agent-worker test
pnpm --filter jugglework-server test:package-content
pnpm release:review --strict
```

The server package-content test performs builds and can take longer than the
static and unit checks. Full installed desktop acceptance remains a
target-compatible CI matrix responsibility.
