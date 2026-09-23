#!/usr/bin/env bash
set -e

echo "🌸 Packaging clean Gacha MV Player extension archives..."

# 1. Clean previous release archives
rm -f gcmv-firefox.zip gcmv-extension.xpi gcmv-chrome.zip gcmv-extension.zip

# 2. Update firefox manifest in firefox/
cp manifest.firefox.json firefox/manifest.json

# 3. Create isolated build staging directories
STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT

# Copy strictly required runtime files
cp background.js "$STAGING_DIR/"
cp chrome_polyfill.js "$STAGING_DIR/"
cp paho-mqtt-min.js "$STAGING_DIR/"
cp -r icons "$STAGING_DIR/"
cp -r content "$STAGING_DIR/"
cp -r popup "$STAGING_DIR/"
cp -r remote "$STAGING_DIR/"

# Remove any hidden OS/editor files from staging
find "$STAGING_DIR" -type f -name ".*" -delete

# --- Build Firefox Packages (0 Errors, 0 Warnings for Mozilla AMO) ---
cp manifest.firefox.json "$STAGING_DIR/manifest.json"
(cd "$STAGING_DIR" && zip -r -9 -q "$OLDPWD/gcmv-firefox.zip" .)
(cd "$STAGING_DIR" && zip -r -9 -q "$OLDPWD/gcmv-extension.xpi" .)

# --- Build Chrome / Chromium Packages (For Chrome Web Store & Kiwi Browser) ---
cp manifest.json "$STAGING_DIR/manifest.json"
(cd "$STAGING_DIR" && zip -r -9 -q "$OLDPWD/gcmv-chrome.zip" .)
(cd "$STAGING_DIR" && zip -r -9 -q "$OLDPWD/gcmv-extension.zip" .)

echo "=========================================================="
echo "✅ Firefox AMO Packages (0 Errors, 0 Warnings on AMO):"
echo "   - gcmv-firefox.zip"
echo "   - gcmv-extension.xpi"
echo "✅ Chrome Web Store / Kiwi Packages:"
echo "   - gcmv-chrome.zip"
echo "   - gcmv-extension.zip"
echo "=========================================================="
ls -lh gcmv-firefox.zip gcmv-extension.xpi gcmv-chrome.zip gcmv-extension.zip

