#!/usr/bin/env bash
set -euo pipefail

# ==========================================================
# 🌸 Gacha MV Player - Local NAS & PC Sync Server Launcher
# ==========================================================

PORT="${PORT:-3000}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"
TOKEN="${NAS_AUTH_TOKEN:-gacha-mv-secret-token-2026}"

echo "=========================================================="
echo "🌸 Starting Gacha MV Player NAS Sync Server..."
echo "=========================================================="

# Determine local IP address for easy connection from phone/browser
LOCAL_IP="127.0.0.1"
if command -v hostname >/dev/null 2>&1; then
    LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')" || LOCAL_IP="127.0.0.1"
fi

echo "📡 Server Port:        $PORT"
echo "🔑 Auth Token:         $TOKEN"
echo "🌐 Local PC URL:       http://127.0.0.1:$PORT"
if [ -n "$LOCAL_IP" ] && [ "$LOCAL_IP" != "127.0.0.1" ]; then
    echo "📱 Mobile/LAN URL:     http://$LOCAL_IP:$PORT"
fi
echo "=========================================================="
echo "💡 INSTRUCTIONS TO CONNECT YOUR APP / EXTENSION:"
echo "1. Open ⚙️ Settings in your Gacha MV Player app / extension"
echo "2. Enable 'NAS Server Sync'"
echo "3. Enter Server URL:   http://$LOCAL_IP:$PORT"
echo "4. Enter Auth Token:   $TOKEN"
echo "5. Tap 'Test Connection' & 'Auto-Sync'!"
echo "=========================================================="

export PORT="$PORT"
export BIND_HOST="$BIND_HOST"
export NAS_AUTH_TOKEN="$TOKEN"

if command -v node >/dev/null 2>&1; then
    echo "🚀 Running with Node.js..."
    exec node extension/server/server.js
elif command -v python3 >/dev/null 2>&1; then
    echo "🚀 Running with Python 3..."
    exec python3 extension/server/server.py
else
    echo "❌ Error: Neither Node.js nor Python 3 was found. Please install Node.js or Python 3."
    exit 1
fi
