# Standalone CLI Release Guide

This guide covers the supported standalone `jugglework` CLI. It does not cover
the retired `jugglework-orchestrator` package, the Desktop release, or the
independently deployed `jugglework-server` host.

## Implemented Packaging Boundary

`apps/cli/script/build.ts` can compile macOS, Linux, and Windows arm64/x64 CLI
binaries and stage a manifest-backed distribution when passed matching local
OpenCode sidecars through `--sidecar-dir`. The stage contains:

```text
bin/jugglework[.exe]
sidecars/opencode[.exe]
opencode-plugins/*.js
licenses/OpenCode-LICENSE.txt
THIRD_PARTY_NOTICES.md
manifest.json
```

`manifest.json` records the target and CLI, Server, and pinned OpenCode versions,
plus SHA-256 checksums for executable, plugin, and notice files. At startup an
installed CLI verifies the manifest target, checksums, executable access, and
required plugin set before creating a task session. It does not fall back to
Desktop or a global OpenCode when a manifest is present but invalid.

The build script stages already verified sidecars. The manual release workflow
acquires and checks upstream archives, signs production executables, validates
the staged files, creates flat installable archives, and uploads them to an
existing GitHub release when a tag is supplied. It does not create installers,
publish an npm package, or update an installation. Do not publish
`dist/bin/jugglework-*` alone as a standalone CLI release.

## Stage A Target

1. Read `distribution/opencode-v1.18.15.json` and acquire the exact archive for the target from its declared upstream release.
2. Verify the archive SHA-256 from that descriptor before extraction.
3. Extract only `opencode` or `opencode.exe` into `<sidecar-dir>/<bun-target>/`.
4. Build `jugglework-server` and its required plugin assets.
5. Run the CLI build with an explicit target and the verified sidecar root.

For example:

```bash
pnpm --filter jugglework-server build
bun apps/cli/script/build.ts \
  --outdir apps/cli/dist/bin \
  --target bun-darwin-arm64 \
  --sidecar-dir /absolute/path/to/verified-sidecars
```

The complete staging root is
`apps/cli/dist/bin/distributions/<bun-target>`. Archive its contents at the
archive root so extraction produces `bin/`, `sidecars/`, and `manifest.json`
directly. Repeat with target-native sidecars for
`bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-arm64`, `bun-linux-x64`,
`bun-windows-arm64`, and `bun-windows-x64`.

## Release Checks

Before publishing any target, the release pipeline must verify the upstream
archive digest, staged manifest and file checksums, executable permissions,
reported CLI and OpenCode versions, required plugin set, and clean-machine task
startup without Desktop or OpenCode on `PATH`. It must also perform the relevant
macOS signing/notarization and Windows code-signing checks.

The release workflow defines these automated gates. Its presence is not
evidence that a production artifact has passed them; record each target's run
and canary result before claiming it was published, signed, or notarized.

## Promotion And Rollback

Publish each target as a complete archive with its archive checksum. Canary on
the matching OS and CPU, then verify `jugglework doctor`, Cloud login against
`https://work.jugglechat.cn`, organization selection, provider import, and task
execution on a machine without Desktop or global OpenCode.

Promote only the exact canary bytes. Roll back by withdrawing the affected
release channel or asset and restoring the previous complete archive. Do not
mix a previous `bin` directory with newer sidecars or plugins. User Cloud
profiles and workspace runtime state are outside the installation directory and
do not require migration for an archive rollback.
