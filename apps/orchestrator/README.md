# JuggleWork Orchestrator

Host orchestrator for opencode + JuggleWork server. This is a CLI-first way to run host mode without the desktop UI.

Published on npm as `jugglework-orchestrator` and installs the `jugglework` command.

## Quick start

```bash
npm install -g jugglework-orchestrator
jugglework start --workspace /path/to/workspace --approval auto
```

When run in a TTY, `jugglework` shows an interactive status dashboard with service health, ports, and
connection details. Use `jugglework serve` or `--no-tui` for log-only mode.

```bash
jugglework serve --workspace /path/to/workspace
```

`jugglework` ships as a compiled binary, so Bun is not required at runtime.

If npm skips the optional platform package, `postinstall` falls back to downloading the matching
binary from the `jugglework-orchestrator-v<version>` GitHub release. Override the download host with
`JUGGLEWORK_ORCHESTRATOR_DOWNLOAD_BASE_URL` when you need to use a mirror.

`jugglework` downloads and caches the `jugglework-server` and `opencode` sidecars on
first run using a SHA-256 manifest. Use `--sidecar-dir` or `JUGGLEWORK_SIDECAR_DIR` to control the
cache location, and `--sidecar-base-url` / `--sidecar-manifest` to point at a custom host.

Use `--sidecar-source` to control where `jugglework-server` is resolved (`auto` | `bundled` |
`downloaded` | `external`), and `--opencode-source` to control `opencode` resolution. Set
`JUGGLEWORK_SIDECAR_SOURCE` / `JUGGLEWORK_OPENCODE_SOURCE` to apply the same policies via env vars.

By default the manifest is fetched from
`https://github.com/juggleai/jugglework-desktop/releases/download/jugglework-orchestrator-v<version>/jugglework-orchestrator-sidecars.json`.

For development overrides only, set `JUGGLEWORK_ALLOW_EXTERNAL=1` or pass `--allow-external` to use
locally installed `jugglework-server` binaries.

Add `--verbose` (or `JUGGLEWORK_VERBOSE=1`) to print extra diagnostics about resolved binaries.

OpenCode hot reload is enabled by default when launched via `jugglework`.
Tune it with:

- `--opencode-hot-reload` / `--no-opencode-hot-reload`
- `--opencode-hot-reload-debounce-ms <ms>`
- `--opencode-hot-reload-cooldown-ms <ms>`

Equivalent env vars:

- `JUGGLEWORK_OPENCODE_HOT_RELOAD` (router mode)
- `JUGGLEWORK_OPENCODE_HOT_RELOAD_DEBOUNCE_MS`
- `JUGGLEWORK_OPENCODE_HOT_RELOAD_COOLDOWN_MS`
- `JUGGLEWORK_OPENCODE_HOT_RELOAD` (start/serve mode)
- `JUGGLEWORK_OPENCODE_HOT_RELOAD_DEBOUNCE_MS`
- `JUGGLEWORK_OPENCODE_HOT_RELOAD_COOLDOWN_MS`

Or from source:

```bash
pnpm --filter jugglework-orchestrator dev -- \
  start --workspace /path/to/workspace --approval auto --allow-external
```

When `JUGGLEWORK_DEV_MODE=1` is set, orchestrator uses an isolated OpenCode dev state for config, auth, data, cache, and state. JuggleWork's repo-level `pnpm dev` commands enable this automatically so local development does not reuse your personal OpenCode environment.

The command prints pairing URLs by default and withholds live credentials from stdout to avoid leaking them into shell history or collected logs. Use `--json` only when you explicitly need the raw pairing secrets in command output.

Use `--detach` to keep services running and exit the dashboard. The detach summary includes the
JuggleWork URL and a redacted `opencode attach` command, while keeping live credentials out of the detached summary.

## Sandbox mode (Docker / Apple container)

`jugglework` can run the sidecars inside a Linux container boundary while still mounting your workspace
from the host.

```bash
# Auto-pick sandbox backend (prefers Apple container on supported Macs)
jugglework start --sandbox auto --workspace /path/to/workspace --approval auto

# Explicit backends
jugglework start --sandbox docker --workspace /path/to/workspace --approval auto
jugglework start --sandbox container --workspace /path/to/workspace --approval auto
```

Notes:

- `--sandbox auto` prefers Apple `container` on supported Macs (arm64), otherwise Docker.
- Docker backend requires `docker` on your PATH.
- Apple container backend requires the `container` CLI (https://github.com/apple/container).
- In sandbox mode, sidecars are resolved for a Linux target (and `--sidecar-source` / `--opencode-source`
  are effectively `downloaded`).
- Custom `--*-bin` overrides are not supported in sandbox mode yet.
- Use `--sandbox-image` to pick an image with the toolchain you want available to OpenCode.
- Use `--sandbox-persist-dir` to control the host directory mounted at `/persist` inside the container.

### Extra mounts (allowlisted)

You can add explicit, validated mounts into `/workspace/extra/*`:

```bash
jugglework start --sandbox auto --sandbox-mount "/path/on/host:datasets:ro" --workspace /path/to/workspace
```

Additional mounts are blocked unless you create an allowlist at:

- `~/.config/jugglework/sandbox-mount-allowlist.json`

Override with `JUGGLEWORK_SANDBOX_MOUNT_ALLOWLIST`.

## Logging

`jugglework` emits a unified log stream from OpenCode and JuggleWork server. Use JSON format for
structured, OpenTelemetry-friendly logs and a stable run id for correlation.

```bash
JUGGLEWORK_LOG_FORMAT=json jugglework start --workspace /path/to/workspace
```

Use `--run-id` or `JUGGLEWORK_RUN_ID` to supply your own correlation id.

OpenCode runs at `INFO` by default, which produces large log files in
`~/.local/share/opencode/log/`. Pass `--opencode-log-level <DEBUG|INFO|WARN|ERROR>` (or set
`JUGGLEWORK_OPENCODE_LOG_LEVEL`) to forward `--log-level` to managed `opencode serve` and reduce log
volume.

JuggleWork server logs every request with method, path, status, and duration. Disable this when running
`jugglework-server` directly by setting `JUGGLEWORK_LOG_REQUESTS=0` or passing `--no-log-requests`.

## Router daemon (multi-workspace)

The router keeps a single OpenCode process alive and switches workspaces JIT using the `directory` parameter.

```bash
jugglework daemon start
jugglework workspace add /path/to/workspace-a
jugglework workspace add /path/to/workspace-b
jugglework workspace list --json
jugglework workspace path <id>
jugglework instance dispose <id>
```

Use `JUGGLEWORK_DATA_DIR` or `--data-dir` to isolate router state in tests.

## Pairing notes

- Use the **JuggleWork connect URL** and **client token** to connect a remote JuggleWork client.
- The JuggleWork server advertises the **OpenCode connect URL** plus optional basic auth credentials to the client.

## Approvals (manual mode)

```bash
jugglework approvals list \
  --jugglework-url http://<host>:8787 \
  --host-token <token>

jugglework approvals reply <id> --allow \
  --jugglework-url http://<host>:8787 \
  --host-token <token>
```

## Health checks

```bash
jugglework status \
  --jugglework-url http://<host>:8787 \
  --opencode-url http://<host>:4096
```

## File sessions (JIT catalog + batch read/write)

Create a short-lived workspace file session and sync files in batches:

```bash
# Create writable session
jugglework files session create \
  --jugglework-url http://<host>:8787 \
  --token <client-token> \
  --workspace-id <workspace-id> \
  --write \
  --json

# Fetch catalog snapshot
jugglework files catalog <session-id> \
  --jugglework-url http://<host>:8787 \
  --token <client-token> \
  --limit 200 \
  --json

# Read one or more files
jugglework files read <session-id> \
  --jugglework-url http://<host>:8787 \
  --token <client-token> \
  --paths "README.md,notes/todo.md" \
  --json

# Write a file (inline content or --file)
jugglework files write <session-id> \
  --jugglework-url http://<host>:8787 \
  --token <client-token> \
  --path notes/todo.md \
  --content "hello from jugglework" \
  --json

# Watch change events and close session
jugglework files events <session-id> --jugglework-url http://<host>:8787 --token <client-token> --since 0 --json
jugglework files session close <session-id> --jugglework-url http://<host>:8787 --token <client-token> --json
```

## Smoke checks

```bash
jugglework start --workspace /path/to/workspace --check --check-events
```

This starts the services, verifies health + SSE events, then exits cleanly.

## Local development

Point to source CLIs for fast iteration:

```bash
jugglework start \
  --workspace /path/to/workspace \
  --allow-external \
  --jugglework-server-bin apps/server/src/cli.ts
```
