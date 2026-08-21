@echo off
setlocal EnableExtensions
REM ============================================================================
REM  split-supabase-commits.bat   (Windows / cmd.exe - no WSL or sandbox needed)
REM
REM  Splits the current uncommitted working tree into TWO commits on the current
REM  branch:
REM    Commit 1 = your Firebase modular-SDK / named-database refactor
REM    Commit 2 = the Supabase backend + GitHub Pages work (depends on commit 1)
REM
REM  Local only: it never pushes and never touches the remote. Run it ONCE.
REM  Requires Git for Windows on PATH. Double-click it, or run from a cmd prompt.
REM  This script is untracked and is never added to either commit.
REM ============================================================================

cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git for Windows is not on PATH. Install it or open "Git CMD".
  goto :fail
)

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo [ERROR] This folder is not a git repository.
  goto :fail
)

for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%B"
echo ============================================================================
echo  Repo   : %CD%
echo  Branch : %BRANCH%
echo ============================================================================
echo.
echo Current status:
git status --short
echo.
echo This creates TWO local commits on branch "%BRANCH%". Nothing is pushed.
echo Press Ctrl+C to abort, or
pause

REM ---------------------------------------------------------------------------
REM  COMMIT 1 - Firebase modular SDK + named-database refactor (your work)
REM ---------------------------------------------------------------------------
echo.
echo === [1/2] Staging your refactor files ===
git add .gitignore backend-firebase.js storage-firestore.js firebase.json dev/server.js dev/dev-client.js dev/test-ui/firebase-emulator.spec.js MIGRATION.md dev/gen-csp.js dev/test/multi-schema.test.js
if errorlevel 1 goto :fail

echo.
echo === Pick the NON-Supabase hunks in the two mixed files ===
echo.
echo   You'll be asked y/n for each hunk. Simple rule:
echo     * hunk mentions the word  supabase   --  press  n   (skip; saved for commit 2)
echo     * anything else (loadModule, db=, ES modules, named database)  --  press  y
echo     * a hunk that mixes both:  press  s  to split, or  e  to edit by hand.
echo.
pause
git add -p index.html app-core.js

echo.
echo === Staged for commit 1: ===
git status --short
echo.
echo Press Ctrl+C to abort, or continue to create commit 1.
pause
git commit -m "Firebase modular SDK + named-database support"
if errorlevel 1 goto :fail

REM ---------------------------------------------------------------------------
REM  COMMIT 2 - Supabase backend + GitHub Pages (sits on top of commit 1)
REM ---------------------------------------------------------------------------
echo.
echo === [2/2] Staging the Supabase files ===
git add backend-supabase.js storage-supabase.js supabase-schema.sql SUPABASE.md .github/workflows/deploy-pages.yml dev/test/storage-supabase.test.js ui.html dev/test/backend-conformance.test.js
if errorlevel 1 goto :fail

REM  index.html / app-core.js now have ONLY the Supabase hunks left unstaged
REM  (commit 1 already took the refactor hunks), so a plain add is clean here.
git add index.html app-core.js
if errorlevel 1 goto :fail

echo.
echo === Staged for commit 2: ===
git status --short
echo.
echo Press Ctrl+C to abort, or continue to create commit 2.
pause
git commit -m "Add Supabase backend + GitHub Pages deploy"
if errorlevel 1 goto :fail

echo.
echo ============================================================================
echo  Done. Two commits on "%BRANCH%":
git --no-pager log --oneline -2
echo.
echo  Left UNTRACKED on purpose (review / .gitignore / delete yourself):
echo    - drive-sync-export-2026-07-31.json
echo    - drive-sync-export-2026-07-31 (1).json
echo    - firebase-tehtavat-board-import.json
echo    - scripts\    (your folder; add to commit 1 if it belongs there)
echo.
echo  Nothing was pushed. When ready:  git push
echo ============================================================================
pause
endlocal
exit /b 0

:fail
echo.
echo [ABORTED] Something failed above. Your repo is unchanged past the last
echo           successful step. Fix the issue and re-run, or ask for help.
echo.
pause
endlocal
exit /b 1
