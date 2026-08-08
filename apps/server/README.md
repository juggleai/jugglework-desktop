# JuggleWork Server

Filesystem-backed API for JuggleWork remote clients. This package provides the JuggleWork server layer described in `apps/app/pr/jugglework-server.md` and is intentionally independent from the desktop app.

## Quick start

JuggleWork Server is the headless runtime entrypoint. To let it start and stop
OpenCode as a managed child process, install both binaries and pass the resolved
OpenCode path through the environment:

```bash
npm install -g jugglework-server
curl -fsSL https://opencode.ai/install | bash

export JUGGLEWORK_MANAGE_OPENCODE=1
export JUGGLEWORK_OPENCODE_BIN="$(command -v opencode)"
export JUGGLEWORK_TOKEN="$(openssl rand -hex 32)"
export JUGGLEWORK_HOST_TOKEN="$(openssl rand -hex 32)"

jugglework-server \
  --workspace /path/to/workspace \
  --host 127.0.0.1 \
  --port 8787 \
  --approval manual \
  --cors "http://localhost:5173" \
  --verbose
```

`jugglework-server` ships as a compiled binary, so Bun is not required at runtime.
With `JUGGLEWORK_MANAGE_OPENCODE=1`, Server owns OpenCode startup, runtime
configuration, health, and shutdown. `JUGGLEWORK_OPENCODE_BIN` must point to an
executable OpenCode binary; Server does not download one. Keep the client and
host tokens secret, especially when binding outside `127.0.0.1`.

Or from source:

```bash
pnpm --filter jugglework-server dev -- \
  --workspace /path/to/workspace \
  --approval auto
```

The server logs the client token and host token on boot when they are auto-generated.

Add `--verbose` to print resolved config details on startup. Use `--version` to print the server version and exit.

## Config file

Defaults to `~/.config/jugglework/server.json` (override with `JUGGLEWORK_SERVER_CONFIG` or `--config`).

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "approval": { "mode": "manual", "timeoutMs": 30000 },
  "workspaces": [
    {
      "path": "/Users/susan/Finance",
      "name": "Finance",
      "workspaceType": "local",
      "baseUrl": "http://127.0.0.1:4096",
      "directory": "/Users/susan/Finance"
    }
  ],
  "corsOrigins": ["http://localhost:5173"]
}
```

## Environment variables

- `JUGGLEWORK_SERVER_CONFIG` path to config JSON
- `JUGGLEWORK_HOST` / `JUGGLEWORK_PORT`
- `JUGGLEWORK_TOKEN` client bearer token
- `JUGGLEWORK_HOST_TOKEN` host approval token
- `JUGGLEWORK_APPROVAL_MODE` (`manual` | `auto`)
- `JUGGLEWORK_APPROVAL_TIMEOUT_MS`
- `JUGGLEWORK_WORKSPACES` (JSON array or comma-separated list of paths)
- `JUGGLEWORK_CORS_ORIGINS` (comma-separated list or `*`)
- `JUGGLEWORK_OPENCODE_BASE_URL`
- `JUGGLEWORK_OPENCODE_DIRECTORY`
- `JUGGLEWORK_OPENCODE_USERNAME`
- `JUGGLEWORK_OPENCODE_PASSWORD`
- `JUGGLEWORK_MANAGE_OPENCODE` (`1` makes Server manage an OpenCode child)
- `JUGGLEWORK_OPENCODE_BIN` (resolved OpenCode executable for managed mode)
- `JUGGLEWORK_MANAGED_OPENCODE_CWD` (optional managed OpenCode working directory)

Token management (scoped tokens):

- `JUGGLEWORK_TOKEN_STORE` path to token store JSON (default: alongside `server.json`)

File injection / artifacts:

- `JUGGLEWORK_INBOX_ENABLED` (`1` | `0`)
- `JUGGLEWORK_INBOX_MAX_BYTES` (default: 50MB, capped)
- `JUGGLEWORK_OUTBOX_ENABLED` (`1` | `0`)

Sandbox advertisement (for capability discovery):

- `JUGGLEWORK_SANDBOX_ENABLED` (`1` | `0`)
- `JUGGLEWORK_SANDBOX_BACKEND` (`docker` | `container` | `none`)

## Endpoints

- `GET /health`
- `GET /status`
- `GET /capabilities`
- `GET /whoami`
- `GET /workspaces`
- `GET /workspace/:id/config`
- `PATCH /workspace/:id/config`
- `GET /workspace/:id/events`
- `POST /workspace/:id/engine/reload`
- `GET /workspace/:id/plugins`
- `POST /workspace/:id/plugins`
- `DELETE /workspace/:id/plugins/:name`
- `GET /workspace/:id/skills`
- `POST /workspace/:id/skills`
- `GET /workspace/:id/mcp`
- `POST /workspace/:id/mcp`
- `DELETE /workspace/:id/mcp/:name`
- `GET /workspace/:id/commands`
- `POST /workspace/:id/commands`
- `DELETE /workspace/:id/commands/:name`
- `GET /workspace/:id/audit`
- `GET /workspace/:id/export`
- `POST /workspace/:id/import/preview`
- `POST /workspace/:id/import`

Token management (host/owner auth):

- `GET /tokens`
- `POST /tokens` (body: `{ "scope": "owner"|"collaborator"|"viewer", "label"?: string }`)
- `DELETE /tokens/:id`

Inbox/outbox:

- `POST /workspace/:id/inbox` (multipart upload into `.opencode/jugglework/inbox/`)
- `GET /workspace/:id/artifacts`
- `GET /workspace/:id/artifacts/:artifactId`
- `POST /workspace/:id/files/sessions`
- `POST /files/sessions/:sessionId/renew`
- `DELETE /files/sessions/:sessionId`
- `GET /files/sessions/:sessionId/catalog/snapshot`
- `GET /files/sessions/:sessionId/catalog/events`
- `POST /files/sessions/:sessionId/read-batch`
- `POST /files/sessions/:sessionId/write-batch`
- `POST /files/sessions/:sessionId/ops`

Toy UI (static assets served by the server):

- `GET /ui`
- `GET /w/:id/ui`
- `GET /ui/assets/*`

OpenCode proxy:

- `GET|POST|... /opencode/*`
- `GET|POST|... /w/:id/opencode/*`

## Approvals

All writes are gated by host approval.

Host APIs accept either:

- `X-JuggleWork-Host-Token: <token>` (legacy host token), or
- `Authorization: Bearer <token>` where the token scope is `owner`.

Approvals endpoints:

- `GET /approvals`
- `POST /approvals/:id` with `{ "reply": "allow" | "deny" }`

Set `JUGGLEWORK_APPROVAL_MODE=auto` to auto-approve during local development.

## Migration from `jugglework`

The `jugglework-orchestrator` package and its bare `jugglework` command are
retired. There is no thin compatibility CLI. Use `jugglework-server` as the
runtime entrypoint and use the Server API for remote operations.

| Retired command or option | Direct-Server replacement |
|---|---|
| `jugglework`, `jugglework start`, `jugglework serve` | Start `jugglework-server` with `JUGGLEWORK_MANAGE_OPENCODE=1` and `JUGGLEWORK_OPENCODE_BIN` as shown above. |
| Interactive TUI, `--no-tui` | Use Server logs, `GET /health`, `GET /status`, or the Desktop app. Server has no TUI mode. |
| `--detach` | Run Server under Docker Compose (`docker compose up -d`), systemd, or another process supervisor. |
| `jugglework daemon ...` | Run one supervised Server process. Configure workspaces with repeatable `--workspace`, `JUGGLEWORK_WORKSPACES`, or `server.json`. |
| `jugglework status` | Call `GET /health` and authenticated `GET /status`. |
| `jugglework approvals list/reply` | Call `GET /approvals` and `POST /approvals/:id` with host authorization. |
| `jugglework files ...` | Use `/workspace/:id/files/sessions` and `/files/sessions/:sessionId/*`. |
| `--sandbox`, `--sandbox-image`, `--sandbox-mount` | Use the Desktop sandbox flow, owned by Desktop's `sandbox-runtime`, or provision Docker directly. Server does not create containers. |
| `--sidecar-*`, `--*-source`, `--allow-external` | Install OpenCode in the deployment layer and set `JUGGLEWORK_OPENCODE_BIN`. Server does not download or update sidecars. |
| `--jugglework-server-bin` | Invoke that `jugglework-server` executable directly. |
| `--data-dir` | Use `JUGGLEWORK_DATA_DIR` only for Server-owned data. Do not point it at legacy orchestrator state. |
| `--jugglework-host`, `--jugglework-port` | Use `--host`, `--port` or `JUGGLEWORK_HOST`, `JUGGLEWORK_PORT`. |
| `--jugglework-token`, `--jugglework-host-token` | Use `--token`, `--host-token` or `JUGGLEWORK_TOKEN`, `JUGGLEWORK_HOST_TOKEN`. |
| `--remote-access` | Bind explicitly with `--host 0.0.0.0`; add TLS and access controls before exposing port `8787`. |
| `--opencode-bin` | Set the absolute executable path in `JUGGLEWORK_OPENCODE_BIN`. |
| `--opencode-workdir` | Set `JUGGLEWORK_MANAGED_OPENCODE_CWD`. |
| `--opencode-host`, `--opencode-port`, `--opencode-auth`, managed OpenCode username/password flags | No managed-mode replacement. Server keeps generated OpenCode credentials and its selected loopback endpoint internal. |
| OpenCode hot-reload flags | No launcher-level replacement. Server refreshes managed runtime configuration; call `POST /workspace/:id/engine/reload` when an explicit reload is required. |
| `--approval`, `--approval-timeout`, `--read-only`, `--cors`, `--log-format`, `--verbose` | These Server options retain the same names. |
| `--check`, `--check-events` | Probe `GET /health`, authenticated `GET /status`, and `GET /workspace/:id/events` from deployment health checks. |
| `--connect-host` | Configure the public hostname in your reverse proxy or deployment platform; it is not a Server runtime option. |
| `--run-id`, color flags | Use supervisor/container log metadata and output controls; Server has no run-ID or ANSI-color option. |

See [Migrate from JuggleWork Orchestrator](../../packages/docs/start-here/migrate-from-orchestrator.mdx)
for API examples, systemd configuration, sandbox guidance, and safe legacy-state
cleanup.
