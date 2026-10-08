@echo off
title Jeopardy
cd /d "%~dp0"
set "PATH=%PATH%;C:\Program Files\nodejs"
where node >nul 2>nul || (echo Node.js er ikke installert. Last ned fra https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000/admin & start http://localhost:3000/display"
:loop
node server.js
echo.
echo   Serveren stoppet. Starter pa nytt om 2 sekunder... (lukk dette vinduet for a avslutte)
timeout /t 2 >nul
goto loop
