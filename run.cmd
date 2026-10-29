@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 exit /b 1

set "REFLOW_NODE="
if exist ".tools\node\node.exe" if exist ".tools\node\node_modules\npm\bin\npm-cli.js" (
  ".tools\node\node.exe" -e "process.exit(process.versions.node.split('.')[0] === '24' ? 0 : 1)" >nul 2>&1
  if not errorlevel 1 set "REFLOW_NODE=%~dp0.tools\node\node.exe"
)
if not defined REFLOW_NODE (
  for /f "delims=" %%N in ('where.exe node.exe 2^>nul') do (
    if not defined REFLOW_NODE (
      "%%N" -e "process.exit(process.versions.node.split('.')[0] === '24' ? 0 : 1)" >nul 2>&1
      if not errorlevel 1 set "REFLOW_NODE=%%N"
    )
  )
)
if defined REFLOW_NODE goto dispatch
if "%~1"=="" goto help_without_node
if /i "%~1"=="help" goto help_without_node
if /i "%~1"=="--help" goto help_without_node
if /i "%~1"=="setup" goto bootstrap

echo Node.js 24 is required. Run "run setup" to install a project-local runtime.
set "REFLOW_EXIT=1"
goto finish

:bootstrap
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-node.ps1"
if errorlevel 1 (
  set "REFLOW_EXIT=1"
  goto finish
)
set "REFLOW_NODE=%~dp0.tools\node\node.exe"

:dispatch
for %%P in ("%REFLOW_NODE%") do set "PATH=%%~dpP;%PATH%"
"%REFLOW_NODE%" "%~dp0scripts\run.mjs" %*
set "REFLOW_EXIT=%ERRORLEVEL%"
goto finish

:help_without_node
echo PDF Reflow developer commands
echo.
echo   run setup        Install Node.js 24 if needed and prepare development tools
echo   run dev          Start the development server
echo   run test         Run all checks and tests
echo   run test-unit    Run unit tests
echo   run test-e2e     Run browser tests
echo   run check        Check types, lint, unit tests, and build
echo   run build        Build the site
echo   run preview      Preview the built site
echo   run lint         Check source code
echo   run typecheck    Check TypeScript
echo   run format       Format source code
echo   run format-check Check formatting
echo   run clean-repo   Remove generated files
echo   run help         Show this help
set "REFLOW_EXIT=0"

:finish
popd
endlocal & exit /b %REFLOW_EXIT%
