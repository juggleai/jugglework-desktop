#!/usr/bin/env bash
set -euo pipefail

# Start all services for the Daytona/devcontainer workspace.
# Launches the real Electron app with a virtual display.
#
# Usage: bash .devcontainer/start-services.sh
#
# Services started:
#   - Xvfb + noVNC (port 6080) — see the Electron app in your browser
#   - Vite dev server (port 5173) — React UI with HMR
#   - Electron app — the real desktop app on the virtual display
#   - CDP debugging (port 9825) — for automation
#
cd /workspace

# ── 1. Virtual display ──
echo "==> Starting virtual display..."
.devcontainer/start-daytona-vnc.sh
sleep 2

# ── 2. Vite dev server on 0.0.0.0 (so Electron can reach it via 127.0.0.1) ──
echo "==> Starting Vite on :5173..."
cd apps/app
OPENWORK_DEV_MODE=1 nohup npx vite --host 0.0.0.0 --port 5173 > /tmp/vite.log 2>&1 &
cd /workspace
sleep 3

# ── 3. Electron app ──
echo "==> Starting Electron app..."
bash .devcontainer/start-daytona-electron.sh --detach

# ── 4. Wait for Electron to be ready ──
echo "==> Waiting for Electron..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:9825/json/list >/dev/null 2>&1; then
    echo "Electron CDP ready."
    break
  fi
  sleep 2
done

echo ""
echo "============================================"
echo "  All services running!"
echo ""
echo "  Desktop App (noVNC):  http://localhost:6080"
echo "  CDP Debug:            ws://127.0.0.1:9825"
echo "  Vite HMR:             http://localhost:5173"
echo "============================================"
echo ""

# Keep alive
wait
