@echo off
title Gacha MV Player - Phone Remote Server
echo ==========================================================
echo 🌸 Starting Gacha MV Player - Phone Web Remote Server...
echo ==========================================================
where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo 🚀 Running with Node.js...
    node "%~dp0extension\server\server.js"
    goto end
)
where python >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo 🚀 Running with Python...
    python "%~dp0extension\server\server.py"
    goto end
)
echo ❌ Error: Neither Node.js nor Python was found. Please install Node.js or Python.
pause
:end
