@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:5500
  py -m http.server 5500
  exit /b
)
where python >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:5500
  python -m http.server 5500
  exit /b
)
echo Python is not installed. Open index.html directly or use VS Code Live Server.
pause
