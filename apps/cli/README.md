# JuggleWork CLI

`jugglework` runs JuggleWork agent tasks from a terminal. It can own a temporary local runtime for the current directory or act only as a client of an existing JuggleWork Server.

## Usage

```bash
# Interactive mode in the current directory
jugglework

# One task, then exit
jugglework "review this repository and run its focused tests"

# Read a one-shot prompt from a pipe
printf '%s\n' "summarize this diff" | jugglework

# Continue the most recently updated session
jugglework --continue "apply the fixes"

# Resume an exact session; without a prompt this enters the REPL on a TTY
jugglework resume ses_123

# List sessions or inspect Server/runtime status
jugglework sessions
jugglework status
```

With no prompt, the line-oriented REPL is available only when both stdin and stdout are TTYs and `--json` is not set. Ordinary lines submit follow-up tasks to the selected session. These slash commands are available:

| Command | Behavior |
| --- | --- |
| `/help` | Show interactive command help. |
| `/new [title]` | Create and select a new session. |
| `/sessions` | List recent root sessions. |
| `/resume <id>` | Select an existing session. |
| `/status` | Show workspace, session, active-run, and Server status. |
| `/stop` | Request abort of the current run without deleting its session. |
| `/exit`, `/quit` | Stop the owned runtime, if any, and exit. |

Run `jugglework --help` for all flags.

## Local And Connected Modes

Local mode is the default. The CLI resolves the workspace from `--workspace`, configuration, or the current directory; starts an embedded Server on loopback with generated in-memory credentials; starts managed OpenCode; stores runtime state separately from JuggleWork Desktop; and performs bounded shutdown of processes it owns.

OpenCode resolution can use `--opencode-bin`, `JUGGLEWORK_OPENCODE_BIN`, `PATH`, source-checkout assets, an installed JuggleWork Desktop sidecar, or correctly staged native-distribution assets.

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
  "workspace": "/absolute/project/path",
  "workspaceId": "workspace-id",
  "opencodeBin": "/path/to/opencode",
  "pluginDir": "/path/to/jugglework-opencode-plugins",
  "model": "provider/model",
  "agent": "agent-name",
  "reasoningEffort": "high"
}
```

Unknown fields and non-string values are rejected. The CLI reads the file but does not write credentials to it. If you create it, restrict it to your user, for example with `chmod 600 ~/.config/jugglework/cli.json`.

Precedence from highest to lowest is:

1. Command-line flags.
2. Environment variables.
3. Config-file values.
4. Built-in defaults.

Supported environment variables are `JUGGLEWORK_SERVER_URL`, `JUGGLEWORK_TOKEN`, `JUGGLEWORK_HOST_TOKEN`, `JUGGLEWORK_WORKSPACE`, `JUGGLEWORK_WORKSPACE_ID`, `JUGGLEWORK_OPENCODE_BIN`, `JUGGLEWORK_EXTENSIONS_PLUGIN_DIR`, `JUGGLEWORK_MODEL`, and `JUGGLEWORK_AGENT`. `JUGGLEWORK_REASONING_EFFORT` is also supported.

Credential-shaped fields and occurrences of the actual bearer or host token in rendered messages are redacted. Avoid passing tokens directly on a shared machine's command line because process-list and shell-history exposure happens before the CLI can redact output; prefer environment variables or a user-readable config file.

## Interactions And Access

The default permission mode requests approval. In the human REPL, pending permission requests can be allowed once, granted for the session when supported, or rejected. Questions display their options and accept one or more answers. One-shot, piped, non-TTY, and `--json` runs never open readline prompts and never silently approve; a pending permission or question fails the command with an actionable error and requests run abort.

Full access is never inferred. `--full-access` applies only to newly created sessions and asks the Server to activate its current versioned Full access profile before the first task. In connected mode this normally requires `--host-token` or `JUGGLEWORK_HOST_TOKEN` and remains subject to Server policy. A refusal is fatal and is not reported as success.

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

## NDJSON Output

`--json` makes stdout NDJSON-only, even when attached to a TTY. Each non-empty line is one JSON object. It disables ANSI color and all readline-based human prompts. Operational failures are JSON `error` records on stdout; stderr remains available for failures outside the renderer/runtime boundary.

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

## Packaging Limitations

- Source mode relies on repository Server outputs and plugin assets; run the package scripts so Server build prerequisites are available.
- A Bun-compiled native CLI is not by itself a complete JuggleWork distribution. OpenCode and the JuggleWork OpenCode plugin assets must be installed or staged where runtime resolution expects them.
- Release staging can instead set `JUGGLEWORK_EXTENSIONS_PLUGIN_DIR` to the packaged plugin directory and `JUGGLEWORK_OPENCODE_BIN` to an executable OpenCode binary.
- Missing OpenCode or plugin assets fail startup before task execution. The CLI does not download, extract, repair, or silently substitute those assets.
- Building native targets does not publish binaries, install them into `PATH`, sign/notarize macOS artifacts, code-sign Windows artifacts, or create platform installers.
- The CLI uses its own runtime storage and does not discover or copy Desktop bearer/host credentials, Desktop sessions, or Desktop runtime databases.
