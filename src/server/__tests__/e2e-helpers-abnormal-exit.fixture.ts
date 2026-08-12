/** Child-process fixture for the SIGINT cleanup test in e2e-helpers.test.ts. */
import { createE2EApp } from './e2e-helpers.js';

const run = await createE2EApp();
process.stdout.write(`${JSON.stringify({ dir: run.dir })}\n`);

// Keep libuv alive until SIGINT exits; otherwise fast runs may exit 0 before delivery.
const keepAlive = setInterval(() => {}, 1000);

process.kill(process.pid, 'SIGINT');

// Fail locally instead of hanging until the parent timeout.
setTimeout(() => {
  clearInterval(keepAlive);
  process.stderr.write('fixture: SIGINT handler did not run within 10s\n');
  process.exit(2);
}, 10_000).unref();
