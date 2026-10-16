@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: ============================================================
::  run-mode configuration (change the variables below to switch)
:: ============================================================
::  platform: DevTools (simulator) or RealDevice (real device)
set PLATFORM=RealDevice
::  real-device QR scan timeout (seconds), default 120
set REMOTE_TIMEOUT=180
::  IDE automation WebSocket port (default 9420; not to be confused with the service port in IDE settings)
set AUTO_PORT=9420
:: ============================================================

:: locate the workspace root (4 levels up from this script directory)
set "WS_ROOT=%~dp0..\..\..\.."
pushd "%WS_ROOT%"

echo.
echo ╔══════════════════════════════════════════════════╗
if "%PLATFORM%"=="RealDevice" (
    echo ║     miniapp-autotest — real-device mode (RealDevice) ║
) else (
    echo ║     miniapp-autotest — simulator mode (DevTools)     ║
)
echo ║     usage: run_all.bat testPlan1.json [testPlan2] ║
echo ║     working dir: %CD%                             ║
echo ╚══════════════════════════════════════════════════╝
echo.

:: check Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed or not in PATH
    popd
    pause
    exit /b 1
)

:: check the CLI
set CLI_PATH=C:\tools\devtools\cli.bat
if not exist "%CLI_PATH%" (
    echo [ERROR] WeChat devtools CLI not found: %CLI_PATH%
    popd
    pause
    exit /b 1
)

:: check npm dependencies (node_modules at the workspace root)
if not exist "node_modules\miniprogram-automator" (
    echo [SETUP] installing miniprogram-automator (at the workspace root)...
    npm install miniprogram-automator
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] npm install failed
        popd
        pause
        exit /b 1
    )
)

:: merge testPlan paths (comma-separated)
set PLANS=
if "%~1"=="" (
    echo [ERROR] missing testPlan path arguments
    echo usage: run_all.bat plan1.json [plan2.json] [plan3.json] ...
    pause
    exit /b 1
)

set FIRST=1
:loop_args
if "%~1"=="" goto done_args
if not exist "%~1" (
    echo [WARN] file does not exist, skipping: %~1
    shift
    goto loop_args
)
if %FIRST%==1 (
    set PLANS=%~1
    set FIRST=0
) else (
    set PLANS=!PLANS!,%~1
)
shift
goto loop_args
:done_args

if "%PLANS%"=="" (
    echo [ERROR] no valid testPlan file
    pause
    exit /b 1
)

echo [CHECK] Node.js: OK
echo [CHECK] WeChat devtools CLI: OK
echo [CHECK] miniprogram-automator: OK
echo [PLANS] !PLANS!
echo.

set RESULT_FILE=_run_result.log

node "%~dp0auto.js" ^
  --batch ^
  --clear-auth ^
  --auto-authorize ^
  --retries 3 ^
  --test-project-path ".codebuddy\skills\miniapp-autotest\assets\testproject" ^
  --test-plan-path "!PLANS!" ^
  --platform "%PLATFORM%" ^
  --auto-port "%AUTO_PORT%" ^
  --remote-timeout "%REMOTE_TIMEOUT%000" ^
  --result-path "autotest\TestResult" ^
  --timeout 120000 ^
  > %RESULT_FILE% 2>&1

set EXIT_CODE=%ERRORLEVEL%

echo.
echo ╔══════════════════════════════════════════════════╗
if %EXIT_CODE% EQU 0 (
    echo ║  √ all batch tests passed!                        ║
) else (
    echo ║  !  batch complete (some tests failed)            ║
)
echo ║  log: %RESULT_FILE%                               ║
echo ║  results: autotest\TestResult\                    ║
echo ║  report: autotest\TestResult\batch_report_*.md    ║
echo ╚══════════════════════════════════════════════════╝
echo.

start "" "autotest\TestResult"
type %RESULT_FILE%
popd
pause
exit /b %EXIT_CODE%
