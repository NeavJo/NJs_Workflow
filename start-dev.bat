@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
)
echo.
echo ============================================================
echo  Dev server (HTTPS) - Vite
echo  Open https://localhost:5173
echo  LAN: https://<this-pc-ip>:5173
echo  Self-signed cert: on first visit click "Advanced" then
echo  "Proceed to ... (unsafe)" to pass the warning.
echo  Press Ctrl+C to stop.
echo ============================================================
call npm run dev -- --host
