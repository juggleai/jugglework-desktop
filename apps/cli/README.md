# JuggleWork CLI

`jugglework` runs JuggleWork agent tasks from a terminal. It can own a temporary local runtime for the current directory or act only as a client of an existing JuggleWork Server.

This is the supported standalone JuggleWork CLI. It is not the retired
`jugglework-orchestrator` launcher that previously used the same command name.
Manifest-backed native release archives include the compatible OpenCode engine
and JuggleWork plugins; JuggleWork Desktop and a global `opencode` installation
are not prerequisites for those releases.

## Install Or Upgrade A Native Release

Download the archive whose release asset name matches your operating system and
CPU. Native distributions currently target macOS, Linux, and Windows on arm64
and x64. A release archive is a complete
directory, not a single executable: keep `bin`, `sidecars`, `opencode-plugins`,
`licenses`, `THIRD_PARTY_NOTICES.md`, and `manifest.json` together.

The repository builds and can publish these archives through the manual CLI
release workflow. It does not provide an npm package, package-manager formula,
installer, or automatic updater.
Use a published manifest-backed archive when one is available; a lone binary
from `dist/bin` is a development build, not an installable release.

### macOS

Extract the matching `bun-darwin-arm64` (Apple Silicon) or `bun-darwin-x64`
(Intel) archive into a versioned directory, then link only its CLI entrypoint:

```bash
mkdir -p "$HOME/.local/share/jugglework-cli/<version>" "$HOME/.local/bin"
tar -xf <downloaded-archive> -C "$HOME/.local/share/jugglework-cli/<version>"
ln -sfn "$HOME/.local/share/jugglework-cli/<version>/bin/jugglework" "$HOME/.local/bin/jugglework"
jugglework doctor
```

Use the archive's actual format with the matching extraction tool. Do not move
`bin/jugglework` out of its distribution directory. Release artifacts must pass
the project's signing/notarization checks before publication; do not bypass
macOS security warnings for an unverified build.

### Linux

Extract `bun-linux-arm64` or `bun-linux-x64` into a versioned directory and put a
link to the entrypoint on `PATH`:

```bash
mkdir -p "$HOME/.local/share/jugglework-cli/<version>" "$HOME/.local/bin"
tar -xf <downloaded-archive> -C "$HOME/.local/share/jugglework-cli/<version>"
ln -sfn "$HOME/.local/share/jugglework-cli/<version>/bin/jugglework" "$HOME/.local/bin/jugglework"
jugglework doctor
```

The archive preserves executable bits. If an intermediary removed them, treat
the archive as damaged and download it again rather than repairing individual
files without verifying the published checksum.

### Windows

Extract `bun-windows-arm64` or `bun-windows-x64` as one directory, for example:

```powershell
$version = "<version>"
$install = Join-Path $env:LOCALAPPDATA "JuggleWork\CLI\$version"
New-Item -ItemType Directory -Force $install | Out-Null
Expand-Archive -Path .\<downloaded-archive>.zip -DestinationPath $install
& "$install\bin\jugglework.exe" doctor
```

Add that version's `bin` directory to the user `PATH`, or invoke the executable
by its full path. Keep `manifest.json`, `sidecars\opencode.exe`, and the other
archive directories at their original relative paths.

### Upgrade Or Roll Back

Extract each version into a new directory, run its `doctor`, and then switch the
symlink or `PATH` entry. Do not overlay a new archive onto an old one because
stale plugins or a mismatched sidecar make the installation invalid. Roll back
by repointing to the previous intact directory. Cloud profiles and CLI workspace
state live outside the release directory and are not removed by this process.

## Usage

On a bare interactive launch without a saved Cloud login, `jugglework` first
shows a sign-in menu. Use the arrow keys and Enter (or 1–3) to open the Cloud
sign-in page, paste a one-time handoff from another device, or continue without
Cloud. The grant/link input is hidden. This menu does not interrupt one-shot,
`exec`, JSON, non-TTY, or explicitly connected Server commands. JuggleWork
does not currently offer a device-code or direct API-key login flow.

```bash
# Interactive mode in the current directory
jugglework

# Existing interactive one-shot behavior
jugglework "review this repository and run its focused tests"

# Deterministic non-interactive execution
jugglework exec "review this repository and run its focused tests"

# With no positional prompt, exec reads the instruction from stdin
printf '%s\n' "summarize this diff" | jugglework exec

# With both, stdin is separate, explicitly delimited context
git diff | jugglework exec "review this diff"

# Continue the most recently updated session
jugglework --continue "apply the fixes"

# Resume an exact session; without a prompt this enters the REPL on a TTY
jugglework resume ses_123

# List sessions or inspect Server/runtime status
jugglework sessions
jugglework status

# Manage the Server workspace registry (host authority is required in connected mode)
jugglework workspace list
jugglework workspace add /absolute/project/path
jugglework workspace open ws_123

# Sign in through the browser, then paste the one-time handoff result
jugglework login
jugglework login status
jugglework org list
jugglework org use my-organization
jugglework provider list
jugglework model list
jugglework catalog list

# Import an organization-published provider into the local CLI runtime
jugglework provider import <publication-id>

# Redacted diagnostics; an embedded runtime is never started
jugglework doctor
jugglework doctor --json

# Generate completion for the current shell
jugglework completion bash
jugglework completion zsh
jugglework completion fish
jugglework completion powershell
```

With no prompt, the line-oriented REPL is available only when both stdin and stdout are TTYs and `--json` is not set. Ordinary lines submit follow-up tasks to the selected session. `/help [search]` searches the compact contextual palette.

| Command | Behavior |
| --- | --- |
| `/help` | Show interactive command help. |
| `/new [title]` | Create and select a new session. |
| `/sessions` | List recent root sessions. |
| `/resume <id>` | Select an existing session. |
| `/status` | Show workspace, session, active-run, and Server status. |
| `/model` | Show the configured model; restart with `--model provider/model` to change it. |
| `/org` | List Cloud organizations without changing the selection. |
| `/permissions [request-approval\|full-access]` | Show or change the selected session's Server-authoritative mode. Full access requires typed acknowledgement and remains policy-gated. |
| `/plan` | Show runtime-reported task items for the selected session. |
| `/workspace` | List workspaces and show the supported top-level mutation commands. |
| `/compact` | Request real runtime compaction; requires `--model provider/model`. |
| `/copy` | Print the last response as explicitly labeled copy-ready text; it does not claim clipboard access. |
| `/logout` | Invalidate and remove the selected Cloud profile. |
| `/fork [id]` | Fork the selected session or an explicitly identified session through the Server API. |
| `/connect`, `/mcp`, `/skills`, `/extensions`, `/doctor` | Clearly labeled read-only guidance/status entries where this CLI lacks safe mutation or complete inventory APIs. |
| `/stop` | Request abort of the current run without deleting its session. |
| `/exit`, `/quit` | Stop the owned runtime, if any, and exit. |

Run `jugglework --help` for the command index or `jugglework <command> --help` for contextual help.

`doctor` checks the Cloud URL/profile/login/organization, workspace access, packaged manifest/assets (or development sidecar/plugins), and a redacted provider/model summary. A packaged CLI briefly starts its embedded runtime to check Server health and compares organization publications with runtime visibility. Connected mode checks the selected Server; provider visibility requires its host token. Source-mode diagnostics require an explicit Server connection for runtime health. Warnings such as no Cloud login are non-fatal, while failed checks return exit code `1`. Human and `--json` reports expose status, IDs, versions, and counts, but never token or provider credential values.

## Scripted Execution

`jugglework exec [prompt]` is the stable automation boundary. It never enters the interactive prompt loop. If no positional prompt is supplied, it reads the prompt from piped stdin. If both are supplied, the positional text remains the instruction and stdin is sent as a separate text part between `BEGIN PIPED STDIN CONTEXT` and `END PIPED STDIN CONTEXT` markers.

In plain exec mode, stdout contains only the final assistant response. Runtime setup, session selection, retries, warnings, and diagnostics use stderr. `--json` instead reserves stdout for NDJSON lifecycle records and emits no human decoration.

Use `--output-last-message <path>` to write the final assistant response to a file in addition to normal stdout or NDJSON output. Use `--output-schema <path>` with a JSON Schema object to request OpenCode's schema-constrained output; invalid JSON and non-object schema roots are rejected before the run starts. These two options are valid only with `exec`.

```bash
jugglework exec "return the changed package names" \
  --output-schema ./package-list.schema.json \
  --output-last-message ./result.json
```

## Local And Connected Modes

Local mode is the default. The CLI resolves the workspace from `--workspace`, configuration, or the current directory; starts an embedded Server on loopback with generated in-memory credentials; starts managed OpenCode; stores runtime state separately from JuggleWork Desktop; and performs bounded shutdown of processes it owns.

Installed native distributions resolve OpenCode from their adjacent `manifest.json` and verify the declared sidecar, plugin, notice, and CLI checksums before startup. A present but invalid manifest fails closed as an incomplete installation; it does not search `PATH` or JuggleWork Desktop. Source/development runs retain `--opencode-bin`, `JUGGLEWORK_OPENCODE_BIN`, `PATH`, source-checkout, and Desktop fallbacks. Explicit plugin overrides remain available through `--plugin-dir` and `JUGGLEWORK_EXTENSIONS_PLUGIN_DIR`.

Connected mode is explicit:

```bash
jugglework \
  --server http://127.0.0.1:9000 \
  --token "$JUGGLEWORK_TOKEN" \
  --workspace-id my-workspace \
  "inspect the active branch"
```

The CLI health-checks the Server and requires a response containing `ok: true` and a non-empty `version`. It does not start, restart, or stop an external Server. If more than one workspace exists, use `--workspace-id` or `--workspace`; human interactive mode can ask for a selection, while non-interactive and JSON modes fail rather than guess.

## Configuration

The default config path is `~/.config/jugglework/cli.json` on macOS/Linux and `%LOCALAPPDATA%\JuggleWork\cli.json` on Windows. Override it with `--config` or `JUGGLEWORK_CLI_CONFIG`.

Only these JSON fields are accepted, and every value must be a string:

```json
{
  "serverUrl": "https://server.example.test",
  "token": "server-bearer-token",
  "hostToken": "host-authority-token",
  "cloudUrl": "https://work.jugglechat.cn",
  "cloudOrg": "organization-id-or-slug",
  "workspace": "/absolute/project/path",
  "workspaceId": "workspace-id",
  "opencodeBin": "/path/to/opencode",
  "pluginDir": "/path/to/jugglework-opencode-plugins",
  "model": "provider/model",
  "agent": "agent-name",
  "reasoningEffort": "high",
  "sandbox": "workspace-write",
  "approval": "on-request"
}
```

Unknown fields and non-string values are rejected. The CLI reads the file but does not write credentials to it. If you create it, restrict it to your user, for example with `chmod 600 ~/.config/jugglework/cli.json`.

Precedence from highest to lowest is:

1. Command-line flags.
2. Environment variables.
3. Config-file values.
4. Built-in defaults.

Supported environment variables are `JUGGLEWORK_SERVER_URL`, `JUGGLEWORK_TOKEN`, `JUGGLEWORK_HOST_TOKEN`, `JUGGLEWORK_CLOUD_URL`, `JUGGLEWORK_CLOUD_TOKEN`, `JUGGLEWORK_CLOUD_ORG`, `JUGGLEWORK_WORKSPACE`, `JUGGLEWORK_WORKSPACE_ID`, `JUGGLEWORK_OPENCODE_BIN`, `JUGGLEWORK_EXTENSIONS_PLUGIN_DIR`, `JUGGLEWORK_MODEL`, `JUGGLEWORK_AGENT`, `JUGGLEWORK_SANDBOX`, and `JUGGLEWORK_APPROVAL`. `JUGGLEWORK_REASONING_EFFORT` is also supported. The Cloud token is an ephemeral override and is never persisted.

Cloud commands default to `https://work.jugglechat.cn`; this is independent from the runtime `--server` URL. `jugglework login` opens the Cloud sign-in page where possible and always prints it. After sign-in, paste the resulting `jugglework-cli://den-auth?...` link or raw one-time grant into the hidden prompt. The bare interactive sign-in menu offers the same handoff with a paste-only choice for remote terminals. On SSH or another non-interactive terminal, pipe the result to `jugglework login --grant-stdin`. Account, organization, catalog, provider-list, and model-list commands do not start the local runtime.

A typical first run is `jugglework login`, `jugglework org list`,
`jugglework org use <id-or-slug>`, `jugglework provider list`, and
`jugglework provider import <publication-id>`. Provider import starts or connects
to the runtime because it writes the selected organization's provider into that
runtime; inventory and account commands remain Cloud-only.

Credential-shaped fields and occurrences of the actual bearer or host token in rendered messages are redacted. Avoid passing tokens directly on a shared machine's command line because process-list and shell-history exposure happens before the CLI can redact output; prefer environment variables or a user-readable config file.

## Interactions And Access

Sandbox scope and approval policy are separate CLI dimensions. Defaults are `--sandbox workspace-write` and `--approval on-request`. `workspace-write` describes the requested workspace boundary; the current Server API does not expose an independent process-level sandbox switch, so the CLI reports that limitation instead of claiming enforcement. `on-request` maps sessions to Server `request-approval`; `never` rejects permission prompts unless paired with `danger-full-access`.

In the human REPL, pending permission requests can be allowed once, granted for the session when supported, or rejected. Questions display their options and accept one or more answers. `exec`, piped, non-TTY, and `--json` runs never open readline prompts and never silently approve; a pending permission or question fails the command with an actionable error and requests run abort.

Full access is never inferred. The conspicuous expert form `--dangerously-bypass-approvals-and-sandbox` selects `--sandbox danger-full-access --approval never`; the older `--full-access` spelling remains an alias. This applies only to newly created sessions and asks the Server to activate its current versioned Full access profile before the first task. In connected mode this normally requires `--host-token` or `JUGGLEWORK_HOST_TOKEN`. Organization policy, Server roles/read-only mode, hard denies, OS authorization, provider/connector scopes, and execution-time policy remain authoritative. A refusal is fatal and is not reported as success. Because Server exposes Full access as one versioned mode, `danger-full-access` with `on-request` is rejected rather than approximated.

## Signals And Exit Codes

Signals are contextual:

- `SIGINT` during an active run requests authenticated abort, starts bounded shutdown after that request settles, and leaves the session resumable.
- `SIGINT` while idle exits interactive mode.
- `SIGTERM` and `SIGHUP` request active-run abort when possible and start bounded cleanup.
- A second signal once shutdown has started forces process exit.
- Owned Server/OpenCode cleanup is bounded; external Servers are never stopped.

Stable exit codes:

| Code | Meaning |
| ---: | --- |
| `0` | Command completed successfully. |
| `1` | Configuration file, connection, health, Server, interaction, timeout, or execution failure. |
| `2` | Invalid command-line syntax or option. |
| `129` | Exit initiated by `SIGHUP`. |
| `130` | Active run aborted or idle interactive exit initiated by `SIGINT`. |
| `143` | Exit initiated by `SIGTERM`. |

`doctor` returns `0` when it has no failed checks and `1` when one or more checks fail. Completion and help return `0`; an unsupported completion shell is command-line syntax error `2`.

## NDJSON Output

`--json` makes stdout NDJSON-only, even when attached to a TTY. Each non-empty line is one JSON object. It disables ANSI color and all readline-based human prompts. Operational failures are JSON `error` records on stdout; stderr remains available for failures outside the renderer/runtime boundary. For plain `exec`, stdout is instead reserved for the final assistant response and all progress goes to stderr.

Current event types are:

| Type | Meaning |
| --- | --- |
| `ready` | Server/workspace selection completed. Includes workspace identity, Server URL, and ownership. |
| `session` | A session was created or selected. |
| `sessions` | A session-list command result. |
| `run_started` | A task was accepted; includes session and run IDs when available. |
| `delta` | Newly appended assistant text with optional message/part IDs. |
| `final` | Terminal assistant text and session ID. |
| `status` | Informational lifecycle text or a structured status command result. |
| `warning` | Retry, abort, cleanup, or other non-fatal warning. |
| `error` | Fatal command error. |
| `help` | Help text requested with `--help --json`. |
| `version` | Version requested with `--version --json`. |

Consumers should tolerate additional fields and future event types. A successful lifecycle normally includes `ready`, `session`, `run_started`, zero or more `delta` records, and one `final` record.

## Development

From this repository:

```bash
pnpm --filter @jugglework/cli dev -- "summarize the current diff"
pnpm --filter @jugglework/cli typecheck
pnpm --filter @jugglework/cli test
pnpm --filter @jugglework/cli build
./apps/cli/dist/bin/jugglework --help
```

Source/development mode is intentionally different from an installed release.
It may resolve OpenCode from `--opencode-bin`, `JUGGLEWORK_OPENCODE_BIN`, `PATH`,
source-checkout assets, or a Desktop sidecar. Override plugins with
`--plugin-dir` or `JUGGLEWORK_EXTENSIONS_PLUGIN_DIR`. Override the production
Cloud origin with `--cloud-url` or `JUGGLEWORK_CLOUD_URL`, and connect to an
already running runtime with `--server`, `JUGGLEWORK_SERVER_URL`, and the
corresponding client/host tokens. These are development or connected-mode
controls, not extra installation steps for a native release.

## Native Distribution Staging

OpenCode is pinned to upstream version `1.18.15` from
`https://github.com/anomalyco/opencode/releases/tag/v1.18.15`. The committed
descriptor at `distribution/opencode-v1.18.15.json` records the source commit,
archive name, format, and upstream SHA-256 digest for macOS arm64/x64, Linux
arm64/x64, and Windows arm64/x64.

Release automation must:

1. Download the target archive named in the descriptor from the pinned release.
2. Verify the archive SHA-256 before extraction.
3. Extract only the `opencode` or `opencode.exe` executable into a local directory shaped as `<sidecar-dir>/<bun-target>/opencode[.exe]`.
4. Build with matching explicit targets and `--sidecar-dir`, for example `bun script/build.ts --outdir dist/bin --target bun-darwin-arm64 --sidecar-dir /verified/opencode`.
5. Package each `dist/bin/distributions/<bun-target>` directory as one platform artifact without rearranging its contents.

Staging never downloads binaries. It consumes already verified, extracted local
inputs and emits this layout:

```text
bin/jugglework[.exe]
sidecars/opencode[.exe]
opencode-plugins/*.js
licenses/OpenCode-LICENSE.txt
THIRD_PARTY_NOTICES.md
manifest.json
```

The generated manifest pins CLI, Server, OpenCode, target, plugin set, and
SHA-256 checksums. Fixture tests exercise this process without downloading
large binaries. OpenCode's MIT license and attribution are committed under
`distribution/` and copied into every staged artifact.

## Packaging Limitations

- Source mode relies on repository Server outputs and plugin assets; run the package scripts so Server build prerequisites are available.
- A Bun-compiled native CLI by itself is not a release artifact. Release artifacts must use the manifest-backed distribution layout above.
- `--sidecar-dir` stages only local pre-extracted sidecars; archive acquisition, archive-digest verification, extraction, signing, and notarization remain release-pipeline responsibilities.
- Missing OpenCode or plugin assets fail startup before task execution. The CLI does not download, extract, repair, or silently substitute those assets.
- Building native targets does not publish binaries, install them into `PATH`, sign/notarize macOS artifacts, code-sign Windows artifacts, or create platform installers.
- The CLI uses its own runtime storage and does not discover or copy Desktop bearer/host credentials, Desktop sessions, or Desktop runtime databases.

Release operators should follow [RELEASE.md](./RELEASE.md); it records the
implemented staging boundary and the checks that remain release-pipeline work.
