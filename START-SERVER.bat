@echo off
title Randstad NZ - Job Application Server
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "PATH=C:\Program Files\nodejs;%PATH%"
  ) else (
    echo.
    echo  Node.js is NOT installed.
    echo.
    echo  1. Download from: https://nodejs.org  ^(click LTS^)
    echo  2. Run the installer, then close and reopen this window.
    echo  3. Double-click START-SERVER.bat again.
    echo.
    pause
    exit /b 1
  )
)

echo Node version:
node --version
echo.

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting server at http://localhost:3000
echo Keep this window OPEN while using the website.
echo Press Ctrl+C to stop.
echo.

start "" "http://localhost:3000"
node local-server.js
