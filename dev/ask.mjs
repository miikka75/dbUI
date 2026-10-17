// ask.mjs — the prompts the setup scripts use to fill in what flags and environment did not give.
//
//   const a = asker();  await a.ask('Project ref', { def: 'abc' });  await a.ask('SMTP password', { secret: true });
//   a.close();
//
// A question is the readline prompt itself: printing it first and then calling question('') does not work,
// because readline's first redraw clears the line -- the question vanished and the script looked stuck.
// A secret is read straight off the terminal in raw mode, one `*` per character typed, so it never reaches
// the screen, the shell history or a log, and typing visibly does something. With no terminal (CI, a pipe,
// Git Bash's mintty without winpty) nothing is asked: `ask` rejects naming what is missing, so a script
// fails loudly rather than hanging on a prompt nobody can answer.
import { createInterface } from 'node:readline';

export function isInteractive() { return !!(process.stdin.isTTY && process.stdout.isTTY); }

export function question(label, io) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: (io && io.stdin) || process.stdin, output: (io && io.stdout) || process.stdout, terminal: true });
    rl.on('SIGINT', () => { rl.close(); process.stdout.write('\n'); process.exit(130); });
    rl.question(label, (answer) => { rl.close(); resolve(answer); });
  });
}

// Raw-mode reading: Enter ends, Backspace erases, Ctrl+C quits; a pasted token arrives as one chunk.
export function readSecret(label, io) {
  const stdin = (io && io.stdin) || process.stdin, out = (io && io.stdout) || process.stdout;
  return new Promise((resolve) => {
    out.write(label);
    let buf = '';
    const finish = () => { stdin.removeListener('data', onData); if (stdin.setRawMode) stdin.setRawMode(false); stdin.pause(); out.write('\n'); resolve(buf); };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') { finish(); return; }
        if (ch === '\u0003') { if (stdin.setRawMode) stdin.setRawMode(false); out.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { if (buf) { buf = buf.slice(0, -1); out.write('\b \b'); } continue; }
        if (ch < ' ') continue;                                    // other control keys: ignored
        buf += ch; out.write('*');
      }
    };
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

export function asker() {
  const tty = isInteractive();
  return {
    interactive: tty,
    async ask(q, opts) {
      const o = opts || {};
      if (!tty) throw new Error('missing: ' + q + ' (no terminal to ask on -- pass it as a flag or environment variable)');
      const label = q + (o.def ? ' [' + o.def + ']' : '') + ': ';
      const v = String((o.secret ? await readSecret(label) : await question(label)) || '').trim();
      return v || o.def || '';
    },
    async confirm(q, def) {
      if (!tty) return !!def;
      const v = (await this.ask(q + (def ? ' (Y/n)' : ' (y/N)'))).toLowerCase();
      return v ? v === 'y' || v === 'yes' : !!def;
    },
    async choose(q, choices, def) {
      if (!tty) return def;
      const v = (await this.ask(q + ' (' + choices.join(' / ') + ')', { def })).toLowerCase();
      return choices.indexOf(v) >= 0 ? v : this.choose(q, choices, def);
    },
    close() {}
  };
}
