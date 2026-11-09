@echo off
cd /d "%~dp0"
if "%ANTHROPIC_API_KEY%"=="" (
  echo Manca la chiave. Prima esegui:  setx ANTHROPIC_API_KEY "la-tua-chiave"
  echo poi chiudi e riapri questa finestra.
  pause
  exit /b
)
start "" http://localhost:3000
node server.js
