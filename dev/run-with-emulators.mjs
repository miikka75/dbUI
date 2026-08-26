#!/usr/bin/env node
// Start Firebase emulators, run one or more commands against them, then HARD-kill by port.
//
// Replaces `firebase emulators:exec`, whose shutdown is signal-based: on Windows
// the emulator JVM ignores the soft Ctrl-C/SIGINT the CLI sends on teardown, so
// `emulators:exec` blocks forever waiting for a process that never dies (an
// orphaned emulator left holding port 8080). Here we own the lifecycle: start
// the emulators, run the test, then taskkill the process tree AND free the ports
// in a finally — a hard kill Windows actually honors — so the run never hangs.
//
// Usage: node run-with-emulators.mjs --only <svcs> --project <id> -- <cmd...> [--and <cmd...>]
//   firebase runs from the repo root (where firebase.json lives);
//   each <cmd...> runs from this dev/ directory, in order, against ONE emulator instance.
//
// SEVERAL COMMANDS PER START, because starting them is the expensive part: `test:all` ran four
// emulator-backed suites and paid the ~6s JVM boot four times over, for nothing. One instance serves
// all of them — each suite pins its own projectId (demo-rules / demo-diff / demo-image / demo-app) and
// uploads its own ruleset through initializeTestEnvironment, and the emulator namespaces data AND
// rules per project. That is what makes sharing safe: `storage-rules.mjs` deliberately runs against
// OPEN Firestore rules, and does so without loosening anything for the suites either side of it.
// (The four still have their own npm scripts, and CI keeps using them — a failed step there should say
// WHICH suite failed in the job list, which is worth more than the seconds.)
//
// A failing command does NOT stop the ones after it. The point of an aggregate run is to learn
// everything that is broken in one go, and the time was already spent; the summary at the end names
// each suite's exit code, and the process exits non-zero if any failed.
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
// `--and` splits the tail into one command per suite. With no `--and` this is a single-element list,
// which is exactly the old behaviour — the four per-suite npm scripts still call it that way.
const cmds = (sep === -1 ? [] : argv.slice(sep + 1))
  .reduce((acc, a) => { if (a === '--and') acc.push([]); else acc[acc.length - 1].push(a); return acc; }, [[]])
  .filter((c) => c.length);
const opt = (name) => { const i = opts.indexOf(name); return i === -1 ? undefined : opts[i + 1]; };
const only = opt('--only');
const project = opt('--project');
if (!only || !project || cmds.length === 0) {
  console.error('usage: node run-with-emulators.mjs --only <svcs> --project <id> -- <cmd...> [--and <cmd...>]');
  process.exit(2);
}

const log = (s) => process.stdout.write(s);

// The emulators run entirely on loopback, and the Storage emulator's rules engine makes a
// cross-service HTTP call to the Firestore emulator (the image-upload registration gate). In a
// sandboxed environment that forces an outbound proxy (HTTPS_PROXY / a JAVA_TOOL_OPTIONS
// -Dhttp.proxyHost=...), that proxy hijacks the loopback call and the gate lookup fails-closed —
// denying every registered write. Nothing the emulators do needs egress once the JARs are cached,
// so run them with the proxy stripped. No-op in CI / on a normal dev box where these aren't set.
function emulatorEnv() {
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'JAVA_TOOL_OPTIONS']) {
    delete env[k];
  }
  return env;
}

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
    env: emulatorEnv(),
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
    const results = [];
    for (const cmd of cmds) {
      log(`\n[run-with-emulators] ready — running: ${cmd.join(' ')}\n\n`);
      const code = await new Promise((res) => {
        const child = spawn(cmd[0], cmd.slice(1), { cwd: devDir, shell: true, stdio: 'inherit' });
        child.on('exit', (c) => res(c ?? 1));
        child.on('error', (e) => { log(`\n[run-with-emulators] failed to run command: ${e.message}\n`); res(1); });
      });
      results.push({ cmd: cmd.join(' '), code });
    }
    exitCode = results.some((r) => r.code !== 0) ? 1 : 0;
    if (results.length > 1) {
      log(`\n[run-with-emulators] ${results.length} suites, one emulator start:\n`);
      for (const r of results) log(`  ${r.code === 0 ? 'ok  ' : 'FAIL'}  ${r.cmd}\n`);
    }
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
