# JuggleWork Host (Docker)

This directory contains the desktop companion host packaging. The container
runs one runtime entrypoint:

- `jugglework-server` on port `8787` as the only published API.
- Server starts and stops `opencode serve` as a managed child on the container
  loopback interface.

No `jugglework-orchestrator` process or bare `jugglework` CLI is installed or
started. Image construction supplies the OpenCode binary, and the container sets
`JUGGLEWORK_MANAGE_OPENCODE=1` plus `JUGGLEWORK_OPENCODE_BIN` before executing
Server.

The hosted JuggleWork control plane and inference services are maintained in the
separate `jugglework-server` repository.

## Local run

From this directory:

```bash
docker compose up --build
```

Then open `http://127.0.0.1:8787/ui`.

For background operation, let Compose own detach, logs, and shutdown:

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f jugglework-host
docker compose down
```

Recommended environment variables:

- `JUGGLEWORK_TOKEN`
- `JUGGLEWORK_HOST_TOKEN`

Optional:

- `JUGGLEWORK_APPROVAL_MODE=auto|manual`
- `JUGGLEWORK_APPROVAL_TIMEOUT_MS=30000`

The workspace is mounted at `/workspace`; host data and OpenCode state are
mounted at `/data`.

## Pre-baked micro-sandbox image

Build the image from the repository root:

```bash
./scripts/build-microsandbox-jugglework-image.sh
```

Run it locally:

```bash
docker run --rm -p 8787:8787 \
  -e JUGGLEWORK_CONNECT_HOST=127.0.0.1 \
  jugglework-microsandbox:dev
```

Defaults:

- `JUGGLEWORK_TOKEN=microsandbox-token`
- `JUGGLEWORK_HOST_TOKEN=microsandbox-host-token`
- `JUGGLEWORK_APPROVAL_MODE=auto`

OpenCode is never exposed directly; clients connect through the JuggleWork host
API.

Desktop-created Docker sandboxes use Desktop's `sandbox-runtime` for host-level
validation, creation, diagnostics, and cleanup. Each sandbox container still
runs `jugglework-server` directly with managed OpenCode; Server itself never
receives Docker control privileges.

See the [orchestrator migration guide](../../packages/docs/start-here/migrate-from-orchestrator.mdx)
for replacements for the retired TUI, daemon, detach, status, approvals, files,
and sandbox commands.
