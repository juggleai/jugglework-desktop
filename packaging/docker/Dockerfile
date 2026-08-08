FROM node:22-bookworm-slim

ARG JUGGLEWORK_SERVER_VERSION=1.1.30
ARG OPENCODE_VERSION=1.18.7
ARG OPENCODE_DOWNLOAD_URL=

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tar \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "jugglework-server@${JUGGLEWORK_SERVER_VERSION}"

RUN set -eux; \
  plugin_dir="$(npm root -g)/jugglework-server/dist/opencode-plugins"; \
  test -d "$plugin_dir"; \
  ln -s "$plugin_dir" /opt/jugglework-opencode-plugins

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) asset="opencode-linux-x64-baseline.tar.gz" ;; \
    arm64) asset="opencode-linux-arm64.tar.gz" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  url="$OPENCODE_DOWNLOAD_URL"; \
  if [ -z "$url" ]; then \
    url="https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${asset}"; \
  fi; \
  tmpdir="$(mktemp -d)"; \
  curl -fsSL "$url" -o "$tmpdir/$asset"; \
  tar -xzf "$tmpdir/$asset" -C "$tmpdir"; \
  binary="$(find "$tmpdir" -type f -name opencode | head -n 1)"; \
  test -n "$binary"; \
  install -m 0755 "$binary" /usr/local/bin/opencode; \
  rm -rf "$tmpdir"

# Persistent directories (mount volumes here on PaaS/SSH). Keep the historical
# data path so existing volumes remain attached; no orchestrator runs here.
ENV JUGGLEWORK_DATA_DIR=/data/jugglework-orchestrator
ENV JUGGLEWORK_SIDECAR_DIR=/data/sidecars

# The workspace is mounted from the host/volume.
ENV JUGGLEWORK_WORKSPACE=/workspace
ENV JUGGLEWORK_EXTENSIONS_PLUGIN_DIR=/opt/jugglework-opencode-plugins
ENV OPENCODE_MODELS_URL=https://work.juggle.im/jwork/models

# JuggleWork host contract surface.
EXPOSE 8787

VOLUME ["/workspace", "/data"]

# Defaults:
# - JuggleWork Server binds the published container interface.
# - OpenCode is managed by JuggleWork Server and stays internal.
CMD ["/bin/sh", "-lc", "export JUGGLEWORK_MANAGE_OPENCODE=1 JUGGLEWORK_OPENCODE_BIN=/usr/local/bin/opencode; exec jugglework-server --workspace \"${JUGGLEWORK_WORKSPACE:-/workspace}\" --host 0.0.0.0 --port \"${JUGGLEWORK_PORT:-8787}\" --cors \"${JUGGLEWORK_CORS_ORIGINS:-*}\" --approval \"${JUGGLEWORK_APPROVAL_MODE:-manual}\""]
