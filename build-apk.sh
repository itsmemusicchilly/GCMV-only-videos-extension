#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/.android-sdk}"
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
cp -r "$SCRIPT_DIR/extension/content/"* "$SCRIPT_DIR/android-app/app/src/main/assets/extension/"
cp "$SCRIPT_DIR/extension/chrome_polyfill.js" "$SCRIPT_DIR/android-app/app/src/main/assets/extension/chrome_polyfill.js"
cp -r "$SCRIPT_DIR/extension/popup/"* "$SCRIPT_DIR/android-app/app/src/main/assets/extension/popup/"
cp -r "$SCRIPT_DIR/extension/icons/"* "$SCRIPT_DIR/android-app/app/src/main/assets/extension/icons/"

# 2. Build APK with Gradle
echo "⚙️ Running Gradle assembleDebug..."
cd "$SCRIPT_DIR/android-app"
./gradlew assembleDebug

# 3. Copy APK to root directory
APK_SRC="$SCRIPT_DIR/android-app/app/build/outputs/apk/debug/app-debug.apk"
APK_DEST="$SCRIPT_DIR/GachaMVPlayer-YouTube.apk"

if [ -f "$APK_SRC" ]; then
    cp "$APK_SRC" "$APK_DEST"
    echo "=========================================================="
    echo "✅ SUCCESS: APK generated at:"
    echo "   $APK_DEST"
    echo "   File size: $(du -h "$APK_DEST" | cut -f1)"
    echo "=========================================================="
else
    echo "❌ ERROR: Output APK not found at $APK_SRC"
    exit 1
fi
