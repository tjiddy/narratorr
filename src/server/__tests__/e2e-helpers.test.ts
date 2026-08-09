import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, writeFileSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createE2EApp } from './e2e-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Windows skips removal assertions because libSQL keeps the DB handle open after Client.close().
describe('createE2EApp harness', () => {
  const orphans: string[] = [];

  afterEach(() => {
    for (const p of orphans) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // Test cleanup is best-effort.
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
    // Listener leaks compound across consumer suites and trigger MaxListenersExceededWarning.
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
    const fixture = resolve(__dirname, 'e2e-helpers-abnormal-exit.fixture.ts');
    const result = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
      encoding: 'utf-8',
      timeout: 30_000,
    });

    // Exit 130 with no signal proves the handler, not spawnSync's timeout, ended the child.
    expect(result.error, `child spawn error (likely timeout):\n${String(result.error)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBeUndefined();
    expect(result.signal, `child was killed by external signal instead of handling SIGINT itself:\nstderr:\n${result.stderr}`).toBeNull();
    expect(result.status, `child exited with wrong code — handler must exit(130):\nstderr:\n${result.stderr}`).toBe(130);

    const firstLine = result.stdout.split('\n').find((l) => l.startsWith('{'));
    expect(firstLine, `child stdout missing dir payload:\n${result.stdout}\n---stderr---\n${result.stderr}`).toBeTruthy();
    const { dir } = JSON.parse(firstLine!) as { dir: string };
    orphans.push(dir); // Defensive cleanup in case the signal handler misses it.

    expect(dir.startsWith(join(tmpdir(), 'narratorr-e2e-'))).toBe(true);
    expect(existsSync(dir)).toBe(false);
  }, 30_000);
});
