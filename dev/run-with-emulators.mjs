#!/usr/bin/env node
// Start Firebase emulators, run a command against them, then HARD-kill by port.
//
// Replaces `firebase emulators:exec`, whose shutdown is signal-based: on Windows
// the emulator JVM ignores the soft Ctrl-C/SIGINT the CLI sends on teardown, so
// `emulators:exec` blocks forever waiting for a process that never dies (an
// orphaned emulator left holding port 8080). Here we own the lifecycle: start
// the emulators, run the test, then taskkill the process tree AND free the ports
// in a finally — a hard kill Windows actually honors — so the run never hangs.
//
// Usage: node run-with-emulators.mjs --only <svcs> --project <id> -- <command...>
//   firebase runs from the repo root (where firebase.json lives);
//   the test <command...> runs from this dev/ directory.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePorts, EMULATOR_PORTS } from './free-emulator-ports.mjs';

const devDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(devDir, '..');
const isWin = process.platform === 'win32';
const READY = /All emulators ready/i;
const READY_TIMEOUT_MS = 90_000;

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opts = sep === -1 ? argv : argv.slice(0, sep);
const cmd = sep === -1 ? [] : argv.slice(sep + 1);
const opt = (name) => { const i = opts.indexOf(name); return i === -1 ? undefined : opts[i + 1]; };
const only = opt('--only');
const project = opt('--project');
if (!only || !project || cmd.length === 0) {
  console.error('usage: node run-with-emulators.mjs --only <svcs> --project <id> -- <command...>');
  process.exit(2);
}

const log = (s) => process.stdout.write(s);

function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL'); // detached => kill the whole group
  } catch { /* already gone */ }
}

async function main() {
  freePorts(EMULATOR_PORTS); // clean slate before binding

  const emu = spawn('firebase', ['emulators:start', '--only', only, '--project', project], {
    cwd: repoRoot,
    shell: true,
    detached: !isWin,
  });

  let ready = false;
  const waitReady = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`emulators not ready within ${READY_TIMEOUT_MS / 1000}s`)), READY_TIMEOUT_MS);
    const scan = (buf) => { const s = buf.toString(); log(s); if (!ready && READY.test(s)) { ready = true; clearTimeout(timer); res(); } };
    emu.stdout.on('data', scan);
    emu.stderr.on('data', (b) => log(b.toString()));
    emu.on('exit', (code) => { clearTimeout(timer); if (!ready) rej(new Error(`emulators exited before ready (code ${code})`)); });
  });

  let exitCode = 1;
  try {
    await waitReady;
    log(`\n[run-with-emulators] ready — running: ${cmd.join(' ')}\n\n`);
    exitCode = await new Promise((res) => {
      const child = spawn(cmd[0], cmd.slice(1), { cwd: devDir, shell: true, stdio: 'inherit' });
      child.on('exit', (code) => res(code ?? 1));
      child.on('error', (e) => { log(`\n[run-with-emulators] failed to run command: ${e.message}\n`); res(1); });
    });
  } catch (e) {
    log(`\n[run-with-emulators] ${e.message}\n`);
  } finally {
    killTree(emu.pid);            // kill firebase + its JVM children
    freePorts(EMULATOR_PORTS);    // belt-and-suspenders: reap any JVM still bound
    log(`[run-with-emulators] emulators stopped (test exit code ${exitCode})\n`);
  }
  process.exit(exitCode);
}

main();
