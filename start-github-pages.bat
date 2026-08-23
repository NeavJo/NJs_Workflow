@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
)
echo Building production bundle (GitHub Pages simulation)...
call npm run build
echo.
echo ============================================================
echo  Serving dist/ at https://localhost:4173
echo  LAN: https://<this-pc-ip>:4173
echo  Simulates GitHub Pages: static files, relative paths.
echo  Self-signed cert: on first visit click "Advanced" then
echo  "Proceed to ... (unsafe)" to pass the warning.
echo  Press Ctrl+C to stop.
echo ============================================================
call npx vite preview --host
