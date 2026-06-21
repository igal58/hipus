@echo off
chcp 65001 >nul
REM ── Hipis flight search — one-click launcher ──
cd /d "%~dp0"
echo.
echo  Hipis flight search starting...
echo  A browser window will open at http://localhost:8787
echo  Keep THIS window open while using the site.
echo.
node server.js
echo.
echo  Server stopped. Press any key to close.
pause >nul
