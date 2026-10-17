// ask.mjs — the prompts the setup scripts use to fill in what flags and environment did not give.
//
//   const a = asker();  await a.ask('Project ref', { def: 'abc' });  await a.ask('SMTP password', { secret: true });
//   a.close();
//
// A secret is read with echo off, so it never reaches the screen, the shell history or a log. With no
// terminal (CI, a pipe) nothing is asked: `ask` rejects, naming what is missing, so a script fails loudly
// rather than hanging on a prompt nobody can answer.
import { createInterface } from 'node:readline';

export function asker() {
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout, terminal: true }) : null;
  let muted = false;
  if (rl) {
    // Echo off for secrets: swallow what readline would write back while a secret is being typed.
    const write = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    rl._writeToOutput = function(s) { if (!muted && write) write(s); else if (muted && /\r|\n/.test(s) && write) write('\n'); };
  }
  return {
    interactive: tty,
    ask(question, opts) {
      const o = opts || {};
      if (!rl) return Promise.reject(new Error('missing: ' + question + ' (no terminal to ask on -- pass it as a flag or environment variable)'));
      const label = question + (o.def ? ' [' + o.def + ']' : '') + ': ';
      return new Promise((resolve) => {
        process.stdout.write(label);
        muted = !!o.secret;
        rl.question('', (answer) => {
          muted = false;
          const v = String(answer || '').trim();
          resolve(v || o.def || '');
        });
      });
    },
    async confirm(question, def) {
      if (!rl) return !!def;
      const v = (await this.ask(question + (def ? ' (Y/n)' : ' (y/N)'))).toLowerCase();
      return v ? v === 'y' || v === 'yes' : !!def;
    },
    async choose(question, choices, def) {
      if (!rl) return def;
      const v = (await this.ask(question + ' (' + choices.join(' / ') + ')', { def })).toLowerCase();
      return choices.indexOf(v) >= 0 ? v : this.choose(question, choices, def);
    },
    close() { if (rl) rl.close(); }
  };
}
