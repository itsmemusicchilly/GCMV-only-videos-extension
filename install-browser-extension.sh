#!/usr/bin/env bash
# ==========================================================
# 🌸 Gacha MV Player - Browser Extension Installer & Launcher
# ==========================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$SCRIPT_DIR/extension"
FIREFOX_DIR="$EXTENSION_DIR/firefox"
XPI_FILE="$EXTENSION_DIR/gcmv-extension.xpi"
FIREFOX_MANIFEST="$EXTENSION_DIR/manifest.firefox.json"

# ANSI Colors
BOLD="\033[1m"
GREEN="\033[0;32m"
CYAN="\033[0;36m"
PINK="\033[38;2;255;46;147m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
GRAY="\033[0;90m"
RESET="\033[0m"

# Print colored banner
print_banner() {
  echo -e "${PINK}==========================================================${RESET}"
  echo -e "${BOLD}🌸 Gacha MV Player - Extension Browser Installer${RESET}"
  echo -e "${PINK}==========================================================${RESET}"
  echo -e "${GRAY}Extension Path: ${RESET}${BOLD}$EXTENSION_DIR${RESET}"
  echo ""
}

# Copy to clipboard helper
copy_to_clipboard() {
  local text="$1"
  if command -v wl-copy >/dev/null 2>&1; then
    printf "%s" "$text" | wl-copy
    return 0
  elif command -v xclip >/dev/null 2>&1; then
    printf "%s" "$text" | xclip -selection clipboard
    return 0
  elif command -v xsel >/dev/null 2>&1; then
    printf "%s" "$text" | xsel --clipboard --input
    return 0
  elif command -v pbcopy >/dev/null 2>&1; then
    printf "%s" "$text" | pbcopy
    return 0
  fi
  return 1
}

# Browser candidate finders
find_browser() {
  local names=("$@")
  for name in "${names[@]}"; do
    if [[ "$name" == /* ]] && [[ -x "$name" ]]; then
      echo "$name"
      return 0
    fi
    local path
    path="$(command -v "$name" 2>/dev/null || true)"
    if [[ -n "$path" && -x "$path" ]]; then
      echo "$path"
      return 0
    fi
  done
  return 1
}

CHROME_BIN="$(find_browser "google-chrome" "google-chrome-stable" "google-chrome-beta" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" || true)"
CHROMIUM_BIN="$(find_browser "chromium" "chromium-browser" "/snap/bin/chromium" "/Applications/Chromium.app/Contents/MacOS/Chromium" || true)"
BRAVE_BIN="$(find_browser "brave-browser" "brave" "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" || true)"
EDGE_BIN="$(find_browser "microsoft-edge" "microsoft-edge-stable" "microsoft-edge-dev" "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" || true)"
FIREFOX_BIN="$(find_browser "firefox" "firefox-esr" "firefox-developer-edition" "firefox-nightly" "/Applications/Firefox.app/Contents/MacOS/firefox" || true)"
VIVALDI_BIN="$(find_browser "vivaldi" "vivaldi-stable" "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi" || true)"
OPERA_BIN="$(find_browser "opera" "/Applications/Opera.app/Contents/MacOS/Opera" || true)"

# Ensure Firefox manifest is up-to-date
prepare_firefox() {
  if [[ -f "$FIREFOX_MANIFEST" ]]; then
    mkdir -p "$FIREFOX_DIR"
    cp "$FIREFOX_MANIFEST" "$FIREFOX_DIR/manifest.json"
  fi
  if [[ ! -f "$XPI_FILE" && -f "$EXTENSION_DIR/package.sh" ]]; then
    echo -e "${CYAN}📦 Packaging Firefox XPI archive first...${RESET}"
    (cd "$EXTENSION_DIR" && bash package.sh >/dev/null 2>&1 || true)
  fi
}

# Handle Chromium-based browsers
install_chromium_browser() {
  local name="$1"
  local bin="$2"
  local settings_url="${3:-chrome://extensions}"

  if [[ -z "$bin" ]]; then
    echo -e "${RED}❌ $name is not detected on your system.${RESET}"
    return 1
  fi

  echo -e "${CYAN}Selected: ${BOLD}$name${RESET} (${GRAY}$bin${RESET})"
  echo ""
  echo "How would you like to install/run the extension?"
  echo -e "  ${BOLD}[1] 🚀 Instant Test Run${RESET} (Launch $name with extension loaded immediately)"
  echo -e "  ${BOLD}[2] 📌 Permanent Developer Mode${RESET} (Guided load into your regular $name profile)"
  echo -e "  ${BOLD}[0] ⬅️  Back to Browser Menu${RESET}"
  echo ""
  read -rp "Select option [1-2, 0 to back]: " opt

  case "$opt" in
    1)
      echo ""
      echo -e "${GREEN}🚀 Launching $name with Gacha MV Player extension...${RESET}"
      echo -e "${GRAY}Command: $bin --load-extension=\"$EXTENSION_DIR\" \"https://www.youtube.com\"${RESET}"
      nohup "$bin" --load-extension="$EXTENSION_DIR" "https://www.youtube.com" >/dev/null 2>&1 &
      echo -e "${GREEN}✨ Launched! Check your open $name window.${RESET}"
      ;;
    2)
      echo ""
      echo -e "${PINK}==========================================================${RESET}"
      echo -e "${BOLD}📌 Installing in $name (Permanent Developer Mode):${RESET}"
      echo -e "${PINK}==========================================================${RESET}"
      echo -e "1. Open the extensions page: ${CYAN}$settings_url${RESET}"
      echo -e "2. In the top-right corner, toggle ${BOLD}Developer mode${RESET} to ON."
      echo -e "3. Click the ${BOLD}Load unpacked${RESET} button."
      echo -e "4. Select this directory:"
      echo ""
      echo -e "   ${BOLD}${GREEN}$EXTENSION_DIR${RESET}"
      echo ""
      if copy_to_clipboard "$EXTENSION_DIR"; then
        echo -e "${GREEN}📋 Copied extension path to your clipboard! Just paste into the file picker.${RESET}"
      fi
      echo ""
      read -rp "Press [Enter] to open $settings_url in $name..." _
      nohup "$bin" "$settings_url" >/dev/null 2>&1 &
      ;;
    *)
      return 0
      ;;
  esac
}

# Handle Firefox
install_firefox() {
  if [[ -z "$FIREFOX_BIN" ]]; then
    echo -e "${RED}❌ Mozilla Firefox is not detected on your system.${RESET}"
    return 1
  fi

  prepare_firefox

  echo -e "${CYAN}Selected: ${BOLD}Mozilla Firefox${RESET} (${GRAY}$FIREFOX_BIN${RESET})"
  echo ""
  echo "How would you like to install/run the extension?"
  echo -e "  ${BOLD}[1] 🚀 Instant Run via web-ext${RESET} (Uses npx web-ext to launch Firefox with extension)"
  echo -e "  ${BOLD}[2] 📌 Load via about:debugging${RESET} (Load temporary add-on in your active Firefox)"
  echo -e "  ${BOLD}[0] ⬅️  Back to Browser Menu${RESET}"
  echo ""
  read -rp "Select option [1-2, 0 to back]: " opt

  case "$opt" in
    1)
      if command -v npx >/dev/null 2>&1; then
        echo ""
        echo -e "${GREEN}🚀 Launching Firefox via web-ext...${RESET}"
        cd "$FIREFOX_DIR"
        npx --yes web-ext run --firefox="$FIREFOX_BIN" --url="https://www.youtube.com"
      else
        echo -e "${YELLOW}⚠️ Node.js / npx not found. Falling back to about:debugging...${RESET}"
        opt=2
      fi
      ;;
    2)
      local manifest_path="$FIREFOX_DIR/manifest.json"
      local xpi_target="$XPI_FILE"
      echo ""
      echo -e "${PINK}==========================================================${RESET}"
      echo -e "${BOLD}📌 Installing in Mozilla Firefox (Temporary Add-on):${RESET}"
      echo -e "${PINK}==========================================================${RESET}"
      echo -e "1. Firefox will open: ${CYAN}about:debugging#/runtime/this-firefox${RESET}"
      echo -e "2. Click ${BOLD}Load Temporary Add-on...${RESET}"
      echo -e "3. Select either of these files:"
      echo -e "   • Manifest: ${BOLD}${GREEN}$manifest_path${RESET}"
      if [[ -f "$xpi_target" ]]; then
        echo -e "   • Or XPI:   ${BOLD}${GREEN}$xpi_target${RESET}"
      fi
      echo ""
      if copy_to_clipboard "$manifest_path"; then
        echo -e "${GREEN}📋 Copied manifest path to your clipboard!${RESET}"
      fi
      echo ""
      read -rp "Press [Enter] to open about:debugging in Firefox..." _
      nohup "$FIREFOX_BIN" "about:debugging#/runtime/this-firefox" >/dev/null 2>&1 &
      ;;
    *)
      return 0
      ;;
  esac
}

# Android / Mobile Guide
show_android_guide() {
  echo ""
  echo -e "${PINK}==========================================================${RESET}"
  echo -e "${BOLD}📱 Gacha MV Player on Android / Mobile${RESET}"
  echo -e "${PINK}==========================================================${RESET}"
  echo -e "You have two great ways to run Gacha MV Player on Android:"
  echo ""
  echo -e "${BOLD}Option 1: Standalone Android App (Recommended)${RESET}"
  echo -e "  • APK location: ${GREEN}$SCRIPT_DIR/GachaMVPlayer-YouTube.apk${RESET}"
  echo -e "  • Built with floating jukebox, adblocker, and background audio!"
  echo -e "  • Transfer and tap to install on your Android device."
  echo ""
  echo -e "${BOLD}Option 2: Mobile Chromium Browser (Kiwi / Lemur)${RESET}"
  echo -e "  1. Transfer ${GREEN}$EXTENSION_DIR/gcmv-extension.zip${RESET} to your phone."
  echo -e "  2. Open Kiwi or Lemur Browser -> go to ${CYAN}chrome://extensions${RESET}."
  echo -e "  3. Enable ${BOLD}Developer mode${RESET}."
  echo -e "  4. Tap ${BOLD}+(from .zip/.crx)${RESET} and choose ${BOLD}gcmv-extension.zip${RESET}."
  echo -e "  5. Open ${CYAN}https://m.youtube.com${RESET} and enjoy!"
  echo ""
  read -rp "Press [Enter] to return to menu..." _
}

# Package extension
run_package_script() {
  echo ""
  echo -e "${CYAN}📦 Running extension packaging script...${RESET}"
  if [[ -f "$EXTENSION_DIR/package.sh" ]]; then
    (cd "$EXTENSION_DIR" && bash package.sh)
    echo -e "${GREEN}✅ Finished packaging!${RESET}"
  else
    echo -e "${RED}❌ $EXTENSION_DIR/package.sh not found.${RESET}"
  fi
  echo ""
  read -rp "Press [Enter] to return to menu..." _
}

# Helper to format status tag
status_tag() {
  local bin="$1"
  if [[ -n "$bin" ]]; then
    echo -e "${GREEN}🟢 Detected${RESET} ${GRAY}($bin)${RESET}"
  else
    echo -e "${GRAY}⚪ Not detected${RESET}"
  fi
}

# Main Interactive Menu
interactive_menu() {
  while true; do
    clear 2>/dev/null || true
    print_banner

    echo -e "${BOLD}Select a browser to install or launch the extension:${RESET}"
    echo -e "  [1] Google Chrome    - $(status_tag "$CHROME_BIN")"
    echo -e "  [2] Chromium         - $(status_tag "$CHROMIUM_BIN")"
    echo -e "  [3] Mozilla Firefox  - $(status_tag "$FIREFOX_BIN")"
    echo -e "  [4] Brave Browser    - $(status_tag "$BRAVE_BIN")"
    echo -e "  [5] Microsoft Edge   - $(status_tag "$EDGE_BIN")"
    echo -e "  [6] Vivaldi          - $(status_tag "$VIVALDI_BIN")"
    echo -e "  [7] Opera            - $(status_tag "$OPERA_BIN")"
    echo ""
    echo -e "  [8] 📱 Android / Kiwi Browser Guide"
    echo -e "  [9] 📦 Re-package Extension Archives (ZIP / XPI)"
    echo -e "  [0] ❌ Exit"
    echo ""
    read -rp "Enter choice [0-9]: " choice

    case "$choice" in
      1) install_chromium_browser "Google Chrome" "$CHROME_BIN" "chrome://extensions" ;;
      2) install_chromium_browser "Chromium" "$CHROMIUM_BIN" "chrome://extensions" ;;
      3) install_firefox ;;
      4) install_chromium_browser "Brave Browser" "$BRAVE_BIN" "brave://extensions" ;;
      5) install_chromium_browser "Microsoft Edge" "$EDGE_BIN" "edge://extensions" ;;
      6) install_chromium_browser "Vivaldi" "$VIVALDI_BIN" "vivaldi://extensions" ;;
      7) install_chromium_browser "Opera" "$OPERA_BIN" "opera://extensions" ;;
      8) show_android_guide ;;
      9) run_package_script ;;
      0|q|Q|exit)
        echo -e "${GREEN}👋 Happy listening!${RESET}"
        exit 0
        ;;
      *)
        echo -e "${RED}Invalid option.${RESET}"
        sleep 1
        ;;
    esac
  done
}

# CLI Argument handling
if [[ $# -gt 0 ]]; then
  case "$1" in
    --chrome)
      print_banner
      install_chromium_browser "Google Chrome" "$CHROME_BIN" "chrome://extensions"
      ;;
    --chromium)
      print_banner
      install_chromium_browser "Chromium" "$CHROMIUM_BIN" "chrome://extensions"
      ;;
    --firefox)
      print_banner
      install_firefox
      ;;
    --brave)
      print_banner
      install_chromium_browser "Brave Browser" "$BRAVE_BIN" "brave://extensions"
      ;;
    --edge)
      print_banner
      install_chromium_browser "Microsoft Edge" "$EDGE_BIN" "edge://extensions"
      ;;
    --vivaldi)
      print_banner
      install_chromium_browser "Vivaldi" "$VIVALDI_BIN" "vivaldi://extensions"
      ;;
    --opera)
      print_banner
      install_chromium_browser "Opera" "$OPERA_BIN" "opera://extensions"
      ;;
    --android)
      print_banner
      show_android_guide
      ;;
    --package)
      run_package_script
      ;;
    -h|--help)
      print_banner
      echo "Usage: ./install-browser-extension.sh [OPTION]"
      echo ""
      echo "Options:"
      echo "  --chrome     Launch/install for Google Chrome"
      echo "  --chromium   Launch/install for Chromium"
      echo "  --firefox    Launch/install for Mozilla Firefox"
      echo "  --brave      Launch/install for Brave Browser"
      echo "  --edge       Launch/install for Microsoft Edge"
      echo "  --vivaldi    Launch/install for Vivaldi"
      echo "  --opera      Launch/install for Opera"
      echo "  --android    Show Android APK & Kiwi Browser guide"
      echo "  --package    Rebuild ZIP & XPI extension packages"
      echo "  -h, --help   Show this help screen"
      echo ""
      echo "Run without options to launch the interactive browser chooser menu."
      exit 0
      ;;
    *)
      echo "Unknown option: $1. Run with --help for options."
      exit 1
      ;;
  esac
  exit 0
fi

# If no arguments, launch interactive menu
interactive_menu
