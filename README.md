# 🌸 Gacha MV Player - YouTube Extension & Standalone Android APK

A dedicated YouTube player and browser extension designed for Gacha Music Video enthusiasts! Seamlessly discover, filter, and stream **GCMV (Gacha Club Music Videos)**, **GLMV (Gacha Life Music Videos)**, and **GLMV2 (Gacha Life 2 Music Videos)** directly on YouTube.

---

## 📱 1. Standalone Android App (APK)

The project includes a full-featured standalone Android app that packages YouTube with the GCMV extension natively built-in!

### ✨ Android App Features
- 🌸 **Native Floating Gacha Jukebox**: Always accessible floating button on YouTube with in-page Jukebox player, quick streams, custom skip lists, and settings drawer.
- 🛡️ **Built-in YouTube Ad Blocker**: Skips and mutes pre-roll, mid-roll, and post-roll video ads at high speed, dismissing overlays and cosmetic ads.
- ⏭️ **Smart Non-Gacha Auto-Skipper**: Automatically detects non-gacha music videos, official audio, and standard lyric videos to jump straight to Gacha MV versions.
- 🎵 **Background Audio Playback**: Keep listening to your favorite Gacha music videos even when you switch to other apps or turn off your screen.
- 📺 **Hardware-Accelerated Fullscreen**: Seamless fullscreen video playback with automatic landscape rotation and immersive mode.
- 🏷️ **Quick Search Filter Chips**: Injected directly under the YouTube search bar for 1-click filtering (GCMV, GLMV, GLMV2, etc.).

### 📥 Installing the APK on Android
1. Transfer `GachaMVPlayer-YouTube.apk` to your Android device (or download directly).
2. Tap the APK file to install (enable *"Install from Unknown Sources"* if prompted).
3. Open **Gacha MV Player** and enjoy non-stop Gacha music videos with built-in adblocking and Jukebox!

### 🔨 Building the APK from Source
To build the APK locally:
```bash
# Using the automated build script:
./build-apk.sh

# Or via npm:
npm run build:apk

# Or using Gradle directly:
cd android-app
./gradlew assembleDebug
```
The compiled APK will be output to `GachaMVPlayer-YouTube.apk` and `android-app/app/build/outputs/apk/debug/app-debug.apk`.

---

## 🌐 2. Browser Extension (Chrome & Firefox)

The browser extension source code is located in the `extension/` directory.

### 🚀 Extension Installation

#### ⚡ 1-Click Browser Chooser & Installer (Recommended)
Launch the interactive installer script to auto-detect your installed browsers (Chrome, Chromium, Firefox, Brave, Edge, Vivaldi, Opera) and load or install with 1 click:
```bash
# On Linux / macOS:
./install-browser-extension.sh
# or via npm:
npm run install:extension

# On Windows:
# Double-click install-browser-extension.bat
```

#### 📱 Android Browsers (Kiwi Browser & Lemur Browser)
1. Download `extension/gcmv-extension.zip`.
2. In Kiwi or Lemur Browser, navigate to `chrome://extensions` and enable **Developer mode**.
3. Tap **+ (from .zip / .crx)** and select `gcmv-extension.zip`.
4. Open [m.youtube.com](https://m.youtube.com).

#### 🦊 Firefox (Android & Desktop)
1. In Firefox Desktop, navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and select `extension/manifest.firefox.json` (or `extension/firefox/manifest.json`).
3. Alternatively, install `extension/gcmv-extension.xpi`.

#### 💻 Chromium Desktop Browsers (Chrome, Brave, Edge)
1. Navigate to `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** and select the `extension/` folder.

### 📦 Packaging the Extension
```bash
cd extension
bash package.sh
# or from root:
npm run build:extension
```

---

## 🛠️ Project Structure

```
├── GachaMVPlayer-YouTube.apk   # Ready-to-install Android APK
├── build-apk.sh                # 1-Click APK build script
├── install-browser-extension.sh # 1-Click interactive browser chooser & installer
├── install-browser-extension.bat # Windows browser installer
├── package.json                # NPM build scripts
├── android-app/                # Android WebView app source code
│   ├── app/
│   │   ├── src/main/
│   │   │   ├── java/com/itsmemusicchilly/gachamvplayer/MainActivity.java
│   │   │   ├── assets/extension/  # Injected extension JS, CSS, and Polyfills
│   │   │   ├── res/               # Layouts, themes, and launcher mipmaps
│   │   │   └── AndroidManifest.xml
│   │   └── build.gradle
│   ├── build.gradle
│   ├── settings.gradle
│   └── gradlew
├── extension/                  # WebExtension source code
│   ├── manifest.json           # Chrome MV3 manifest
│   ├── manifest.firefox.json   # Firefox MV2 manifest
│   ├── background.js           # Extension service worker
│   ├── content/                # Content scripts (Jukebox, Auto-Skipper, Adblock)
│   ├── popup/                  # Popup UI & settings
│   ├── icons/                  # High-res icons
│   ├── package.sh              # Extension packaging script
│   ├── gcmv-extension.zip      # Packaged Chrome extension
│   └── gcmv-extension.xpi      # Packaged Firefox extension
└── README.md
```

---

## 💡 License & Credits
Created by `itsmemusicchilly`. Dedicated to the Gacha Life & Gacha Club music community!
