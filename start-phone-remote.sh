#!/usr/bin/env bash
set -euo pipefail

# ==========================================================
# 🌸 Gacha MV Player - Phone Web Remote Server Launcher
# ==========================================================

PORT="${PORT:-3000}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"

echo "=========================================================="
echo "🌸 Starting Gacha MV Player - Phone Web Remote Server..."
echo "=========================================================="

LOCAL_IP="127.0.0.1"
if command -v hostname >/dev/null 2>&1; then
    LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')" || LOCAL_IP="127.0.0.1"
fi

echo "📡 Server Port:        $PORT"
echo "🌐 Local PC URL:       http://127.0.0.1:$PORT/remote"
if [ -n "$LOCAL_IP" ] && [ "$LOCAL_IP" != "127.0.0.1" ]; then
    echo "📱 Mobile/LAN URL:     http://$LOCAL_IP:$PORT/remote"
fi
echo "=========================================================="
echo "📱 Open the URL above on your phone to control playback!"
echo "=========================================================="

export PORT="$PORT"
export BIND_HOST="$BIND_HOST"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v node >/dev/null 2>&1; then
    echo "🚀 Running with Node.js..."
    exec node "$SCRIPT_DIR/extension/server/server.js"
elif command -v python3 >/dev/null 2>&1; then
    echo "🚀 Running with Python 3..."
    exec python3 "$SCRIPT_DIR/extension/server/server.py"
else
    echo "❌ Error: Neither Node.js nor Python 3 was found. Please install Node.js or Python 3."
    exit 1
fi
