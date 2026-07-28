#!/usr/bin/env sh
set -eu

JUGGLEWORK_WORKSPACE="${JUGGLEWORK_WORKSPACE:-/workspace}"
JUGGLEWORK_DATA_DIR="${JUGGLEWORK_DATA_DIR:-/data/jugglework-orchestrator}"
JUGGLEWORK_SIDECAR_DIR="${JUGGLEWORK_SIDECAR_DIR:-/data/sidecars}"
JUGGLEWORK_PORT="${JUGGLEWORK_PORT:-8787}"
JUGGLEWORK_OPENCODE_PORT="${JUGGLEWORK_OPENCODE_PORT:-4096}"
JUGGLEWORK_TOKEN="${JUGGLEWORK_TOKEN:-microsandbox-token}"
JUGGLEWORK_HOST_TOKEN="${JUGGLEWORK_HOST_TOKEN:-microsandbox-host-token}"
JUGGLEWORK_APPROVAL_MODE="${JUGGLEWORK_APPROVAL_MODE:-auto}"
JUGGLEWORK_CORS_ORIGINS="${JUGGLEWORK_CORS_ORIGINS:-*}"
JUGGLEWORK_CONNECT_HOST="${JUGGLEWORK_CONNECT_HOST:-127.0.0.1}"
HOME="${HOME:-/root}"
USER="${USER:-root}"
SHELL="${SHELL:-/bin/sh}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

if [ "$HOME" = "/" ]; then
  HOME=/root
  XDG_CONFIG_HOME="$HOME/.config"
  XDG_CACHE_HOME="$HOME/.cache"
  XDG_DATA_HOME="$HOME/.local/share"
  XDG_STATE_HOME="$HOME/.local/state"
fi

export HOME USER SHELL XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME

mkdir -p "$JUGGLEWORK_WORKSPACE" "$JUGGLEWORK_DATA_DIR" "$JUGGLEWORK_SIDECAR_DIR"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

printf '%s\n' "Starting JuggleWork micro-sandbox"
printf '%s\n' "- workspace: $JUGGLEWORK_WORKSPACE"
printf '%s\n' "- home: $HOME"
printf '%s\n' "- jugglework url: http://$JUGGLEWORK_CONNECT_HOST:$JUGGLEWORK_PORT"
printf '%s\n' "- client token: $JUGGLEWORK_TOKEN"
printf '%s\n' "- host token: $JUGGLEWORK_HOST_TOKEN"
printf '%s\n' "- health: curl http://$JUGGLEWORK_CONNECT_HOST:$JUGGLEWORK_PORT/health"
printf '%s\n' "- auth test: curl -H \"Authorization: Bearer $JUGGLEWORK_TOKEN\" http://$JUGGLEWORK_CONNECT_HOST:$JUGGLEWORK_PORT/workspaces"

exec jugglework serve \
  --workspace "$JUGGLEWORK_WORKSPACE" \
  --remote-access \
  --jugglework-port "$JUGGLEWORK_PORT" \
  --opencode-host 127.0.0.1 \
  --opencode-port "$JUGGLEWORK_OPENCODE_PORT" \
  --jugglework-token "$JUGGLEWORK_TOKEN" \
  --jugglework-host-token "$JUGGLEWORK_HOST_TOKEN" \
  --approval "$JUGGLEWORK_APPROVAL_MODE" \
  --cors "$JUGGLEWORK_CORS_ORIGINS" \
  --connect-host "$JUGGLEWORK_CONNECT_HOST" \
  --allow-external \
  --sidecar-source external \
  --opencode-source external \
  --jugglework-server-bin /usr/local/bin/jugglework-server \
  --opencode-bin /usr/local/bin/opencode
