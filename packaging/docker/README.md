# JuggleWork Host (Docker)

This directory contains the desktop companion host packaging. It runs:

- `opencode serve` on the container loopback interface.
- `jugglework-server` on port `8787` as the only published API.

The hosted JuggleWork control plane and inference services are maintained in the
separate `jugglework-server` repository.

## Local run

From this directory:

```bash
docker compose up --build
```

Then open `http://127.0.0.1:8787/ui`.

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
