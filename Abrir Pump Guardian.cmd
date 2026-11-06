@echo off
setlocal
cd /d "%~dp0"
set "PYTHON=%~dp0.venv\Scripts\python.exe"
if exist "%PYTHON%" goto executar
set "PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%PYTHON%" goto executar
echo Python nao encontrado. Consulte o README.md para preparar o ambiente.
pause
exit /b 1
:executar
"%PYTHON%" -u backend\server.py --abrir %*
if errorlevel 1 (
  echo Nao foi possivel iniciar. Confira a mensagem acima.
  if /I not "%~1"=="--teste" pause
  exit /b 1
)
