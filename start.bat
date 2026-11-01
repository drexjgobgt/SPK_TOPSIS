@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js tidak ditemukan. Pasang Node.js 18 atau lebih baru dari nodejs.org, lalu jalankan lagi.
  pause
  exit /b 1
)
echo Membuka dashboard di http://localhost:4321
start "" cmd /c "timeout /t 2 >nul & start http://localhost:4321"
node serve.js
