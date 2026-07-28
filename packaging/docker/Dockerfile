FROM node:22-bookworm-slim

ARG JUGGLEWORK_ORCHESTRATOR_VERSION=0.11.22

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tar \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "jugglework-orchestrator@${JUGGLEWORK_ORCHESTRATOR_VERSION}"

# Persistent directories (mount volumes here on PaaS/SSH).
ENV JUGGLEWORK_DATA_DIR=/data/jugglework-orchestrator
ENV JUGGLEWORK_SIDECAR_DIR=/data/sidecars

# The workspace is mounted from the host/volume.
ENV JUGGLEWORK_WORKSPACE=/workspace

# JuggleWork host contract surface.
EXPOSE 8787

VOLUME ["/workspace", "/data"]

# Defaults:
# - JuggleWork server is published intentionally via --remote-access
# - OpenCode stays internal (127.0.0.1:4096)
# - JuggleWork server proxies OpenCode via localhost
CMD [
  "jugglework",
  "serve",
  "--workspace", "/workspace",
  "--remote-access",
  "--jugglework-port", "8787",
  "--opencode-host", "127.0.0.1",
  "--opencode-port", "4096",
  "--connect-host", "127.0.0.1",
  "--cors", "*",
  "--approval", "manual"
]
