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
process.stdout.write(`${JSON.stringify({ dir: run.dir })}\n`, () => {
  process.kill(process.pid, 'SIGINT');
});
