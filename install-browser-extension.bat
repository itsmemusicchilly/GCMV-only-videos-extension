@echo off
setlocal EnableDelayedExpansion
title Gacha MV Player - Extension Browser Installer

set "EXT_DIR=%~dp0extension"
set "FIREFOX_DIR=%~dp0extension\firefox"

:menu
cls
echo ==========================================================
echo 🌸 Gacha MV Player - Extension Browser Installer (Windows)
echo ==========================================================
echo Extension Path: %EXT_DIR%
echo.
echo Select a browser to install or launch the extension:
echo   [1] Google Chrome
echo   [2] Microsoft Edge
echo   [3] Brave Browser
echo   [4] Mozilla Firefox
echo   [5] Vivaldi
echo   [6] Opera
echo.
echo   [7] 📱 Android / Kiwi Browser Guide
echo   [8] 📋 Copy Extension Path to Clipboard
echo   [0] ❌ Exit
echo ==========================================================
set /p CHOICE="Enter choice [0-8]: "

if "%CHOICE%"=="1" goto chrome
if "%CHOICE%"=="2" goto edge
if "%CHOICE%"=="3" goto brave
if "%CHOICE%"=="4" goto firefox
if "%CHOICE%"=="5" goto vivaldi
if "%CHOICE%"=="6" goto opera
if "%CHOICE%"=="7" goto android
if "%CHOICE%"=="8" goto copy_path
if "%CHOICE%"=="0" goto end
if /i "%CHOICE%"=="q" goto end
goto menu

:chrome
cls
echo 🌸 Google Chrome Options:
echo   [1] 🚀 Instant Test Run (Launch Chrome with extension loaded)
echo   [2] 📌 Open chrome://extensions & copy path to clipboard
echo   [0] ⬅️  Back
set /p OPT="Select [1-2, 0 to back]: "
if "%OPT%"=="1" (
    start "" chrome --load-extension="%EXT_DIR%" "https://www.youtube.com"
    echo Launched Google Chrome!
    timeout /t 3 >nul
    goto menu
)
if "%OPT%"=="2" (
    echo %EXT_DIR%| clip
    start "" chrome "chrome://extensions"
    echo.
    echo ==========================================================
    echo 📌 Extension path copied to your clipboard!
    echo 1. In Chrome, enable "Developer mode" in the top right.
    echo 2. Click "Load unpacked".
    echo 3. Paste the path into the folder selector and click Select.
    echo ==========================================================
    pause
    goto menu
)
goto menu

:edge
cls
echo 🌸 Microsoft Edge Options:
echo   [1] 🚀 Instant Test Run (Launch Edge with extension loaded)
echo   [2] 📌 Open edge://extensions & copy path to clipboard
echo   [0] ⬅️  Back
set /p OPT="Select [1-2, 0 to back]: "
if "%OPT%"=="1" (
    start "" msedge --load-extension="%EXT_DIR%" "https://www.youtube.com"
    echo Launched Microsoft Edge!
    timeout /t 3 >nul
    goto menu
)
if "%OPT%"=="2" (
    echo %EXT_DIR%| clip
    start "" msedge "edge://extensions"
    echo.
    echo ==========================================================
    echo 📌 Extension path copied to your clipboard!
    echo 1. In Edge, enable "Developer mode" toggle.
    echo 2. Click "Load unpacked".
    echo 3. Paste the path into the folder selector and click Select.
    echo ==========================================================
    pause
    goto menu
)
goto menu

:brave
cls
echo 🌸 Brave Browser Options:
echo   [1] 🚀 Instant Test Run (Launch Brave with extension loaded)
echo   [2] 📌 Open brave://extensions & copy path to clipboard
echo   [0] ⬅️  Back
set /p OPT="Select [1-2, 0 to back]: "
if "%OPT%"=="1" (
    start "" brave --load-extension="%EXT_DIR%" "https://www.youtube.com"
    echo Launched Brave Browser!
    timeout /t 3 >nul
    goto menu
)
if "%OPT%"=="2" (
    echo %EXT_DIR%| clip
    start "" brave "brave://extensions"
    echo.
    echo ==========================================================
    echo 📌 Extension path copied to your clipboard!
    echo 1. In Brave, enable "Developer mode" in top right.
    echo 2. Click "Load unpacked".
    echo 3. Paste the path into the folder selector.
    echo ==========================================================
    pause
    goto menu
)
goto menu

:firefox
cls
echo 🌸 Mozilla Firefox Options:
echo   [1] 📌 Open about:debugging#/runtime/this-firefox & copy path
echo   [2] 🚀 Instant Run via web-ext (requires Node.js)
echo   [0] ⬅️  Back
set /p OPT="Select [1-2, 0 to back]: "
if "%OPT%"=="1" (
    echo %FIREFOX_DIR%\manifest.json| clip
    start "" firefox "about:debugging#/runtime/this-firefox"
    echo.
    echo ==========================================================
    echo 📌 Firefox manifest path copied to your clipboard!
    echo 1. In Firefox, click "Load Temporary Add-on..."
    echo 2. Paste or select: %FIREFOX_DIR%\manifest.json
    echo ==========================================================
    pause
    goto menu
)
if "%OPT%"=="2" (
    where npx >nul 2>nul
    if %ERRORLEVEL% equ 0 (
        cd "%FIREFOX_DIR%"
        npx --yes web-ext run --url="https://www.youtube.com"
        cd "%~dp0"
    ) else (
        echo Node.js / npx not found.
        pause
    )
    goto menu
)
goto menu

:vivaldi
cls
echo 🌸 Vivaldi Options:
echo   [1] 🚀 Instant Test Run
echo   [2] 📌 Open vivaldi://extensions & copy path
set /p OPT="Select [1-2, 0 to back]: "
if "%OPT%"=="1" (
    start "" vivaldi --load-extension="%EXT_DIR%" "https://www.youtube.com"
    goto menu
)
if "%OPT%"=="2" (
    echo %EXT_DIR%| clip
    start "" vivaldi "vivaldi://extensions"
    pause
    goto menu
)
goto menu

:opera
cls
echo 🌸 Opera Options:
echo   [1] 🚀 Instant Test Run
echo   [2] 📌 Open opera://extensions & copy path
set /p OPT="Select [1-2, 0 to back]: "
if "%OPT%"=="1" (
    start "" opera --load-extension="%EXT_DIR%" "https://www.youtube.com"
    goto menu
)
if "%OPT%"=="2" (
    echo %EXT_DIR%| clip
    start "" opera "opera://extensions"
    pause
    goto menu
)
goto menu

:android
cls
echo ==========================================================
echo 📱 Gacha MV Player on Android
echo ==========================================================
echo Option 1: Standalone APK (Recommended)
echo   Transfer GachaMVPlayer-YouTube.apk to your phone and install!
echo.
echo Option 2: Kiwi / Lemur Browser
echo   1. Transfer extension\gcmv-extension.zip to your phone.
echo   2. Open chrome://extensions in Kiwi Browser.
echo   3. Enable Developer Mode, tap "+ (from .zip/.crx)".
echo   4. Select gcmv-extension.zip and open https://m.youtube.com.
echo ==========================================================
pause
goto menu

:copy_path
echo %EXT_DIR%| clip
echo.
echo ✅ Copied: %EXT_DIR% to clipboard!
pause
goto menu

:end
echo 👋 Happy listening!
