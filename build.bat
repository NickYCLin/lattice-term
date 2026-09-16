@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "RUSTUP_TOOLCHAIN=1.94.0-x86_64-pc-windows-msvc"
rem Keep the build output separate from a running Codex MCP server.
set "CARGO_TARGET_DIR=%CD%\src-tauri\target\mcp-build"
set "OUTPUT=%CARGO_TARGET_DIR%\release\lattice-term.exe"

where npm >nul 2>&1
if errorlevel 1 goto :missing_npm

where rustup >nul 2>&1
if errorlevel 1 goto :missing_rustup

rustup run "%RUSTUP_TOOLCHAIN%" cargo --version >nul 2>&1
if errorlevel 1 goto :missing_toolchain

if not exist "node_modules\@tauri-apps\cli" (
  echo [LatticeTerm] Restoring Node dependencies...
  call npm ci
  if errorlevel 1 goto :failed
)

echo [LatticeTerm] Building release executable...
call npm run tauri -- build --no-bundle
if errorlevel 1 goto :failed

if not exist "%OUTPUT%" goto :missing_output

echo.
echo Build complete:
echo   %OUTPUT%
exit /b 0

:missing_npm
echo ERROR: npm was not found in PATH.
exit /b 1

:missing_rustup
echo ERROR: rustup was not found in PATH.
exit /b 1

:missing_toolchain
echo ERROR: Rust toolchain %RUSTUP_TOOLCHAIN% is required.
echo Install it with:
echo   rustup toolchain install %RUSTUP_TOOLCHAIN% --profile minimal --component clippy --component rustfmt
exit /b 1

:missing_output
echo ERROR: Tauri finished but the expected executable was not found:
echo   %OUTPUT%
exit /b 1

:failed
echo.
echo ERROR: Build failed. See the messages above.
exit /b 1
