@echo off
REM ── Hipis flight-price proxy launcher ──
cd /d "%~dp0"
echo Starting Hipis price proxy...
node proxy.js
pause
