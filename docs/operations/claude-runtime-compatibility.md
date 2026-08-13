# Claude Agent runtime compatibility

This page is the release contract for the baseline, run-per-query Claude Agent
runtime. It records what JuggleWork packages and tests; it does not imply that
every Claude SDK feature is enabled. Runtime descriptors and policy remain the
authority for feature availability.

## Version contract

| Component | Release contract |
| --- | --- |
| Claude Agent SDK | Exact pin from `apps/claude-agent-worker/package.json`; currently `0.3.226` |
| Claude Code executable | Platform optional package at the same SDK version; CLI version is recorded in `manifest.json` and runtime diagnostics |
| Worker Node | Exact Node 24 package pin from `package-assets.mjs`; currently `24.19.0` |
| Worker protocol | Worker and Server must agree before a run is accepted |
| Baseline execution | Resumable run-per-query; advanced resident/steer behavior is not part of this matrix |

An SDK, CLI, Node, protocol, or target change is a compatibility change. Update
the pin, package-content checks, installed smoke evidence, and this table in the
same release. Do not infer compatibility from a semver range.

## Desktop matrix

All supported desktop installers package `worker`, `node`, and `claude` under
the application's real resources directory, outside `app.asar`. The packaged
manifest target must equal the installer target. The release workflow runs the
package-content and installed-worker smoke on a target-compatible runner.

| OS | Architecture | Target triple | Updater feed | Claude sandbox backend | Release state |
| --- | --- | --- | --- | --- | --- |
| macOS | Apple silicon | `aarch64-apple-darwin` | `latest-mac.yml` | `seatbelt` | Packaged and release-tested |
| macOS | Intel | `x86_64-apple-darwin` | `latest-mac.yml` | `seatbelt` | Packaged and release-tested |
| Linux (glibc) | arm64 | `aarch64-unknown-linux-gnu` | `latest-linux-arm64.yml` | `bubblewrap` | Packaged and release-tested |
| Linux (glibc) | x64 | `x86_64-unknown-linux-gnu` | `latest-linux.yml` | `bubblewrap` | Packaged and release-tested |
| Windows | arm64 | `aarch64-pc-windows-msvc` | `latest.yml` | `windows-sandbox` | Packaged and release-tested |
| Windows | x64 | `x86_64-pc-windows-msvc` | `latest.yml` | `windows-sandbox` | Packaged and release-tested |

Rosetta, Windows emulation, musl Linux, and other operating systems are not
separate supported targets. Install the artifact matching the native process
architecture. The macOS x64 release smoke currently runs under Rosetta on the
Apple silicon release runner; all other matrix smoke jobs run on their target
architecture. A sandbox backend being named in the table means the worker will
request it fail-closed; startup still reports unavailable if the host facility
or its dependencies cannot be initialized.

## Headless matrix

Headless support is intentionally narrower than desktop support.

| Distribution or integration | OpenCode runtime | Claude Agent runtime | Operator contract |
| --- | --- | --- | --- |
| `jugglework-server` npm CLI | Supported | Not enabled as a standalone supported distribution | The npm package contains the worker JS and exact SDK diagnostic metadata, but does not bundle target Node/Claude binaries or provide a standalone secret broker. Leave `JUGGLEWORK_CLAUDE_AGENT_ENABLED` unset. |
| Docker and microsandbox images in `packaging/docker` | Supported on Linux x64/arm64 | Not packaged | Images are OpenCode-only. They use Node 22 and contain neither the Claude target bundle nor the required headless credential broker. |
| Source/library host integration | Supported | Supported only for a host that supplies every contract below | Use Node 24+, a matching native Claude executable, the packaged worker, an approved `ClaudeCredentialBroker`, isolated profile data, and deterministic headless approval policy. Run package-content and installed smoke on the deployed target. |

A headless host must not set `JUGGLEWORK_CLAUDE_AGENT_ENABLED=1` unless all of
these are true:

- `JUGGLEWORK_CLAUDE_AGENT_WORKER_PATH` is readable.
- `JUGGLEWORK_CLAUDE_AGENT_NODE_PATH` is a native Node 24 executable.
- `JUGGLEWORK_CLAUDE_EXECUTABLE_PATH` is the matching native Claude executable.
- The host injects an approved credential broker and a private profile data directory.
- The host selects `deny`, explicitly pre-approved, or bounded-wait interaction policy; no approval may wait forever.
- The SDK sandbox initializes fail-closed and `allowUnsandboxedCommands` remains false.

The runtime also requires a valid staged rollout decision: `internal` with an
internal cohort marker, `opt-in` with explicit user opt-in, or `ga`. The global
`JUGGLEWORK_CLAUDE_AGENT_KILL_SWITCH=1` overrides every stage and restores
OpenCode-only startup without requiring Claude assets.

Missing Claude assets never block an OpenCode-only deployment. If Claude is
explicitly enabled with an incomplete contract, startup must fail with a
provisioning, credential, target, Node, or sandbox diagnostic instead of falling
back to OpenCode for a Claude-bound session.

## Sandbox boundaries

The Claude SDK sandbox is defense in depth. It does not replace JuggleWork's
canonical path, symlink, sensitive-path, command, network, actor, and tool-input
policy. Mandatory policy runs before tools even when the runtime would approve
them. Unsandboxed command escape and bypass permission mode remain disabled.

Desktop's Docker `sandbox-runtime` is a separate host/container boundary. Its
current image runs JuggleWork Server with managed OpenCode and does not turn the
container into a supported Claude headless distribution.

## Updater compatibility

Every desktop update replaces the complete app, including the target Claude
runtime directory. A release is invalid when an updater manifest references a
missing artifact, has a stale size or SHA-512, omits the zip/NSIS blockmap, or
does not record the AppImage embedded block map. Mixed SDK/CLI/Node assets are
not supported. Roll back the whole desktop release; never copy only a newer
Claude executable into an older installed app.

See [the release operator runbook](./claude-runtime-release-runbook.md) for the
required checks and rollback procedure. Complete the
[legal-review checklist](./claude-runtime-legal-review.md) against the final
target artifacts before publication.

For the separately reversible post-14.3 compatibility cleanup, see
[mounted OpenCode client cleanup evidence](./opencode-mounted-client-cleanup.md).
That cleanup removes mounted client session/event/interaction protocols while
retaining the Server-side OpenCode adapter, historical-session importer, and
provider/configuration engine integration.
