/**
 * Child-process fixture for the abnormal-exit test in e2e-helpers.test.ts.
 *
 * Boots an E2E app, emits the per-run directory path on stdout, then kills
 * its own process with SIGINT to simulate Ctrl+C. The parent test spawns
 * this via `tsx` and asserts the signal handler registered in e2e-helpers.ts
 * removes the directory before the process dies.
 */
import { createE2EApp } from './e2e-helpers.js';

const run = await createE2EApp();
process.stdout.write(`${JSON.stringify({ dir: run.dir })}\n`);

// Keep the event loop alive until the SIGINT handler in e2e-helpers.ts runs
// and calls process.exit(130). Without this, once the stdout write flushes
// the process can exit naturally with code 0 before the just-queued signal
// is delivered — observed as a flake on CI machines where createE2EApp
// leaves nothing else holding libuv alive.
const keepAlive = setInterval(() => { /* keep event loop alive */ }, 1000);

process.kill(process.pid, 'SIGINT');

// Safety net: if SIGINT isn't delivered within 10s (e.g. a broken handler),
// fail loudly rather than hanging until the parent's spawn timeout.
setTimeout(() => {
  clearInterval(keepAlive);
  process.stderr.write('fixture: SIGINT handler did not run within 10s\n');
  process.exit(2);
}, 10_000).unref();
