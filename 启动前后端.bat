@echo off
title infOS Launcher
color 0A
setlocal EnableExtensions

set "PROJ="

rem ---- 1. drag-drop or argument ----
if not "%~1"=="" (
    if exist "%~1\package.json" (
        for %%I in ("%~1") do set "PROJ=%%~fI"
    )
)

rem ---- 2. walk up from script dir, max 5 levels ----
if not defined PROJ if exist "%~dp0package.json" set "PROJ=%~dp0"
if not defined PROJ if exist "%~dp0..\package.json" for %%I in ("%~dp0..") do set "PROJ=%%~fI"
if not defined PROJ if exist "%~dp0..\..\package.json" for %%I in ("%~dp0..\..") do set "PROJ=%%~fI"
if not defined PROJ if exist "%~dp0..\..\..\package.json" for %%I in ("%~dp0..\..\..") do set "PROJ=%%~fI"
if not defined PROJ if exist "%~dp0..\..\..\..\package.json" for %%I in ("%~dp0..\..\..\..") do set "PROJ=%%~fI"

if defined PROJ if "%PROJ:~-1%"=="\" set "PROJ=%PROJ:~0,-1%"

if not defined PROJ (
    echo [ERROR] package.json not found near "%~dp0".
    echo         Drop the project folder onto this .bat, or pass it as argument.
    pause
    exit /b 1
)

echo Project : %PROJ%
echo.

where pnpm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] pnpm not found. Install Node.js and enable pnpm.
    pause
    exit /b 1
)

echo [1/2] Starting backend ^(pnpm dev^) ...
start "infOS-backend-Hono-9120" /d "%PROJ%" cmd /k "pnpm dev"

timeout /t 5 /nobreak >nul

echo [2/2] Starting frontend ^(pnpm dev:frontend^) ...
start "infOS-frontend-Vite" /d "%PROJ%" cmd /k "pnpm dev:frontend"

exit /b 0