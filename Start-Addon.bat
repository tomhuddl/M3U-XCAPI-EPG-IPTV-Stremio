@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
    echo Node.js 22 or 24 is required. Install Node.js, then run this file again.
    pause
    exit /b 1
)
if not exist "node_modules" (
    echo Installing the application dependencies...
    call npm ci --omit=dev
    if errorlevel 1 (
        echo Dependency installation failed. Review the message above.
        pause
        exit /b 1
    )
)
echo Starting the addon. Keep this window open; press Ctrl+C to stop safely.
echo The server will print its port below. Open that address in your browser.
node server.js
if errorlevel 1 (
    echo The application stopped with an error. Review the message above.
    pause
    exit /b 1
)
endlocal
