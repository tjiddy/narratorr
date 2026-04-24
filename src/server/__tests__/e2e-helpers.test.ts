import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, writeFileSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createE2EApp } from './e2e-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tests that assert on post-cleanup filesystem state (existsSync === false)
// are skipped on Windows because libSQL's native binding leaks the DB file
// handle past Client.close(), preventing rmSync from removing the run dir.
// Cleanup still runs — it's just best-effort on Windows (see rmDirOrLeak).
describe('createE2EApp harness', () => {
  const orphans: string[] = [];

  afterEach(() => {
    for (const p of orphans) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // Best-effort — test-scope cleanup.
      }
    }
    orphans.length = 0;
  });

  it('creates a per-run directory under tmpdir with the narratorr-e2e- prefix', async () => {
    const e2e = await createE2EApp();
    orphans.push(e2e.dir);

    expect(existsSync(e2e.dir)).toBe(true);
    expect(e2e.dir.startsWith(join(tmpdir(), 'narratorr-e2e-'))).toBe(true);
    expect(existsSync(join(e2e.dir, 'narratorr.db'))).toBe(true);

    await e2e.cleanup();
  });

  it.skipIf(process.platform === 'win32')('cleanup() removes the entire run directory including WAL/SHM sidecars', async () => {
    const e2e = await createE2EApp();
    orphans.push(e2e.dir);
    const dbPath = join(e2e.dir, 'narratorr.db');

    // Simulate libSQL WAL/SHM sidecars that may materialize after writes.
    writeFileSync(`${dbPath}-wal`, 'wal-bytes');
    writeFileSync(`${dbPath}-shm`, 'shm-bytes');

    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);

    await e2e.cleanup();

    expect(existsSync(e2e.dir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('sequential createE2EApp() calls produce distinct run directories', async () => {
    const a = await createE2EApp();
    orphans.push(a.dir);
    const b = await createE2EApp();
    orphans.push(b.dir);

    expect(a.dir).not.toBe(b.dir);
    expect(existsSync(a.dir)).toBe(true);
    expect(existsSync(b.dir)).toBe(true);

    await a.cleanup();
    await b.cleanup();

    expect(existsSync(a.dir)).toBe(false);
    expect(existsSync(b.dir)).toBe(false);
  });

  it('registers signal handlers only once across repeated createE2EApp() calls', async () => {
    // Guard against regression of registerSignalHandlersOnce() — without the
    // once-only check, each of the 10+ consumer suites would add three more
    // listeners (SIGINT/SIGTERM/exit) and trip MaxListenersExceededWarning.
    // Prime the module state with one call so handlers are definitely
    // registered, capture the baseline listener counts, then make additional
    // calls and assert the counts stay flat. If the guard is removed the
    // second call would grow each count by 1 and this test fails.
    const primed = await createE2EApp();
    orphans.push(primed.dir);

    const baseline = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      exit: process.listenerCount('exit'),
    };

    const second = await createE2EApp();
    orphans.push(second.dir);
    const third = await createE2EApp();
    orphans.push(third.dir);

    expect(process.listenerCount('SIGINT')).toBe(baseline.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.sigterm);
    expect(process.listenerCount('exit')).toBe(baseline.exit);

    await primed.cleanup();
    await second.cleanup();
    await third.cleanup();
  });

  it.skipIf(process.platform === 'win32')('removes the run directory when the process is interrupted by SIGINT', () => {
    // Spawn a child that boots createE2EApp, prints its dir, then SIGINTs
    // itself. The module-level signal handler must purge the dir before the
    // child exits, leaving nothing behind for the parent to observe.
    const fixture = resolve(__dirname, 'e2e-helpers-abnormal-exit.fixture.ts');
    const result = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
      encoding: 'utf-8',
      timeout: 30_000,
    });

    // Verify the child actually completed via the installed SIGINT handler
    // rather than the parent's timeout fallback. spawnSync surfaces a
    // timeout kill as `result.error` plus a non-null `signal`; our handler
    // returns exit code 130 after purging dirs, so a clean run must show
    // status === 130 and signal === null.
    expect(result.error, `child spawn error (likely timeout):\n${String(result.error)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBeUndefined();
    expect(result.signal, `child was killed by external signal instead of handling SIGINT itself:\nstderr:\n${result.stderr}`).toBeNull();
    expect(result.status, `child exited with wrong code — handler must exit(130):\nstderr:\n${result.stderr}`).toBe(130);

    // Extract the dir the child reported on its first stdout line.
    const firstLine = result.stdout.split('\n').find((l) => l.startsWith('{'));
    expect(firstLine, `child stdout missing dir payload:\n${result.stdout}\n---stderr---\n${result.stderr}`).toBeTruthy();
    const { dir } = JSON.parse(firstLine!) as { dir: string };
    orphans.push(dir); // Defensive in case the signal handler missed it.

    expect(dir.startsWith(join(tmpdir(), 'narratorr-e2e-'))).toBe(true);
    expect(existsSync(dir)).toBe(false);
  }, 30_000);
});
