#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "/home/itsmemusicchilly/.android-sdk" ]; then
    export ANDROID_HOME="/home/itsmemusicchilly/.android-sdk"
else
    export ANDROID_HOME="${ANDROID_HOME:-$HOME/.android-sdk}"
fi
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

echo "=========================================================="
echo "🌸 Building Gacha MV Player - YouTube Android APK"
echo "=========================================================="
echo "  ANDROID_HOME: $ANDROID_HOME"
echo "  JAVA_HOME:    $JAVA_HOME"
echo "=========================================================="

# 1. Sync latest extension files into Android assets
echo "📦 Syncing extension assets to Android project..."
mkdir -p "$SCRIPT_DIR/android-app/app/src/main/assets/extension/icons"
mkdir -p "$SCRIPT_DIR/android-app/app/src/main/assets/extension/popup"
mkdir -p "$SCRIPT_DIR/android-app/app/src/main/assets/extension/remote"
cp -r "$SCRIPT_DIR/extension/content/"* "$SCRIPT_DIR/android-app/app/src/main/assets/extension/"
cp "$SCRIPT_DIR/extension/chrome_polyfill.js" "$SCRIPT_DIR/android-app/app/src/main/assets/extension/chrome_polyfill.js"
cp -r "$SCRIPT_DIR/extension/popup/"* "$SCRIPT_DIR/android-app/app/src/main/assets/extension/popup/"
cp -r "$SCRIPT_DIR/extension/remote/"* "$SCRIPT_DIR/android-app/app/src/main/assets/extension/remote/"
cp -r "$SCRIPT_DIR/extension/icons/"* "$SCRIPT_DIR/android-app/app/src/main/assets/extension/icons/"

# 2. Build APK with Gradle
echo "⚙️ Running Gradle assembleRelease..."
cd "$SCRIPT_DIR/android-app"
./gradlew assembleRelease

# 3. Re-sign with v1 + v2 so cheap Android TV boxes / emulators can install
APK_SRC="$SCRIPT_DIR/android-app/app/build/outputs/apk/release/app-release.apk"
APK_DEST="$SCRIPT_DIR/GachaMVPlayer-YouTube.apk"
if [ -f "/home/itsmemusicchilly/.android/debug.keystore" ]; then
    DEBUG_KEYSTORE="/home/itsmemusicchilly/.android/debug.keystore"
else
    DEBUG_KEYSTORE="${DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"
fi
BUILD_TOOLS_DIR="$(ls -d "$ANDROID_HOME"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
APKSIGNER="${BUILD_TOOLS_DIR}apksigner"
ZIPALIGN="${BUILD_TOOLS_DIR}zipalign"

if [ ! -f "$APK_SRC" ]; then
    echo "❌ ERROR: Output APK not found at $APK_SRC"
    exit 1
fi

echo "🔏 Re-signing APK with v1 (JAR) + v2 signatures for player compatibility..."
ALIGNED="$SCRIPT_DIR/android-app/app/build/outputs/apk/release/app-release-aligned.apk"
SIGNED="$SCRIPT_DIR/android-app/app/build/outputs/apk/release/app-release-signed.apk"
rm -f "$ALIGNED" "$SIGNED"
"$ZIPALIGN" -f -p 4 "$APK_SRC" "$ALIGNED"
"$APKSIGNER" sign \
    --ks "$DEBUG_KEYSTORE" \
    --ks-key-alias androiddebugkey \
    --ks-pass pass:android \
    --key-pass pass:android \
    --min-sdk-version 21 \
    --v1-signing-enabled true \
    --v2-signing-enabled true \
    --v3-signing-enabled false \
    --out "$SIGNED" \
    "$ALIGNED"
"$APKSIGNER" verify --min-sdk-version 21 --verbose "$SIGNED"
cp "$SIGNED" "$APK_SRC"
cp "$SIGNED" "$APK_DEST"
rm -f "$ALIGNED" "$SIGNED"

echo "=========================================================="
echo "✅ SUCCESS: APK generated at:"
echo "   $APK_DEST"
echo "   File size: $(du -h "$APK_DEST" | cut -f1)"
echo "=========================================================="
