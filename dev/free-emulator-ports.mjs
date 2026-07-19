#!/usr/bin/env node
// Frees the Firebase emulator ports so an orphaned emulator left behind by an
// interrupted/crashed/hung run can't cause "port taken" cascades. Also used as
// the hard-shutdown primitive by run-with-emulators.mjs (Windows ignores the
// soft Ctrl-C/SIGINT that `firebase emulators:exec` relies on, so we kill by port).
// Cross-platform: win32 uses netstat+taskkill, posix uses lsof+kill.
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// firestore, auth, storage, ui, hub, logging, reserved, firestore-ws
export const EMULATOR_PORTS = [8080, 9099, 9199, 4000, 4400, 4500, 9150];

const isWin = process.platform === 'win32';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function pidsOnPort(port) {
  try {
    if (isWin) {
      const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      return [...new Set(out.trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop()).filter(Boolean))];
    }
    const out = execSync(`lsof -ti tcp:${port} -s tcp:LISTEN`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return out.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return []; // no match => command exits non-zero; that just means the port is free
  }
}

export function freePorts(ports = EMULATOR_PORTS) {
  let killed = 0;
  for (const port of ports) {
    for (const pid of pidsOnPort(port)) {
      if (pid === '0') continue;
      try {
        execSync(isWin ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`, { stdio: 'ignore' });
        console.log(`freed port ${port} (killed PID ${pid})`);
        killed++;
      } catch {
        /* already gone */
      }
    }
  }
  // A just-killed emulator can hold its port briefly while the OS releases it.
  // Wait until every port is actually free (up to ~5s) so the next bind succeeds.
  for (let attempt = 0; attempt < 25; attempt++) {
    if (!ports.some((p) => pidsOnPort(p).some((pid) => pid !== '0'))) break;
    sleep(200);
  }
  return killed;
}

// Run directly as a CLI (npm run free-ports) — but stay importable as a module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const killed = freePorts();
  console.log(killed ? `emulator ports cleared (${killed} orphan(s) killed)` : 'emulator ports already free');
}
