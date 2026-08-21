@echo off
setlocal EnableExtensions
REM ============================================================================
REM  make-supabase-pr.bat   (Windows / cmd.exe - no WSL or sandbox needed)
REM
REM  Commits the Supabase changes on the CURRENT branch, pushes to origin, and
REM  opens a Pull Request into main.
REM
REM  Requirements:
REM    - Git for Windows on PATH
REM    - (for auto-PR) GitHub CLI "gh" installed + authenticated: https://cli.github.com
REM      If gh is missing, the script still commits + pushes and prints the URL
REM      you click to open the PR yourself.
REM
REM  Run it ONCE. It never force-pushes. This script is not added to the commit.
REM ============================================================================

cd /d "%~dp0"

set "BASE=main"
set "TITLE=Add Supabase backend + GitHub Pages deploy"

where git >nul 2>nul
if errorlevel 1 ( echo [ERROR] Git for Windows is not on PATH. & goto :fail )

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 ( echo [ERROR] This folder is not a git repository. & goto :fail )

for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%B"
if /I "%BRANCH%"=="%BASE%" (
  echo [ERROR] You are on "%BASE%". Switch to your Supabase branch first:
  echo         git switch -c supabase-backend
  goto :fail
)

echo ============================================================================
echo  Repo   : %CD%
echo  Branch : %BRANCH%   ^-^->   PR base: %BASE%
echo ============================================================================
echo.
echo Files to be committed:
git status --short
echo.
echo Press Ctrl+C to abort, or continue to stage/commit/push and open the PR.
pause

REM --- Stage only the Supabase changeset (not the helper .bat scripts) ---------
git add backend-supabase.js storage-supabase.js supabase-schema.sql SUPABASE.md .github/workflows/deploy-pages.yml dev/test/storage-supabase.test.js index.html ui.html app-core.js dev/test/backend-conformance.test.js
if errorlevel 1 goto :fail

echo.
echo Staged:
git status --short
echo.
pause

git commit -m "%TITLE%"
if errorlevel 1 goto :fail

git push -u origin "%BRANCH%"
if errorlevel 1 goto :fail

REM --- Open the PR with GitHub CLI if available, else print the URL ------------
set "BODYFILE=%TEMP%\supabase_pr_body.md"
> "%BODYFILE%" echo Adds Supabase (Postgres) as a backend mode alongside Firebase/Sheets/CRDT, plus a GitHub Pages deploy workflow.
>> "%BODYFILE%" echo.
>> "%BODYFILE%" echo Firestore's document model is reproduced on a single `kv` table with per-row RLS mirroring firestore.rules.
>> "%BODYFILE%" echo.
>> "%BODYFILE%" echo New: backend-supabase.js, storage-supabase.js, supabase-schema.sql, SUPABASE.md, deploy-pages.yml, storage-supabase.test.js.
>> "%BODYFILE%" echo Wiring: index.html (mode + shared-link + SDK load), ui.html (setup screen), app-core.js (config/shareLink).
>> "%BODYFILE%" echo.
>> "%BODYFILE%" echo Note: tests not run locally (sandbox unavailable) - run: cd dev ^&^& node --test test/storage-supabase.test.js test/backend-conformance.test.js

where gh >nul 2>nul
if errorlevel 1 (
  echo.
  echo [gh not found] Pushed. Open the PR here:
  echo    https://github.com/miikka75/dbUI/compare/%BASE%...%BRANCH%?expand=1
  echo.
  goto :done
)

gh pr create --base "%BASE%" --head "%BRANCH%" --title "%TITLE%" --body-file "%BODYFILE%"
if errorlevel 1 (
  echo.
  echo [gh pr create failed] The branch is pushed. Open the PR manually:
  echo    https://github.com/miikka75/dbUI/compare/%BASE%...%BRANCH%?expand=1
  goto :done
)

:done
echo.
echo ============================================================================
echo  Done. Branch "%BRANCH%" pushed to origin.
echo ============================================================================
pause
endlocal
exit /b 0

:fail
echo.
echo [ABORTED] Nothing was pushed past the last successful step. Fix and re-run.
echo.
pause
endlocal
exit /b 1
