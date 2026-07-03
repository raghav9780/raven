#!/usr/bin/env node
/**
 * raven — global launcher shim. npm `bin` entries run `node <file>` WITHOUT
 * `--experimental-strip-types`, so this plain-JS shim re-spawns Node with the
 * flag on the harness entry. `stdio: 'inherit'` preserves the raw-mode TTY,
 * arrow-key picker, and Ctrl+C/Ctrl+D. The caller's cwd is inherited, so
 * sessions land under <cwd>/.raven.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'main.ts');

// Let the child (the REPL) own Ctrl+C — the shim must not die on SIGINT while
// the child is interrupting a turn; it exits when the child exits.
process.on('SIGINT', () => {});

const child = spawn(
  process.execPath,
  ['--experimental-strip-types', entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  process.stderr.write(`Failed to launch raven: ${err.message}\n`);
  process.exit(1);
});
