import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import globalTeardown from './global-teardown.js';
import { _resetCurrentRunForTests, createRunTempDirs, getCurrentRun } from './fixtures/temp-dirs.js';
import { registerFake, _resetRegisteredFakesForTests, getRegisteredFakes } from './fixtures/run-state.js';

describe('globalTeardown', () => {
  const orphans: string[] = [];

  beforeEach(() => {
    _resetCurrentRunForTests();
    _resetRegisteredFakesForTests();
    orphans.length = 0;
  });

  afterEach(() => {
    for (const p of orphans) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  });

  it('is a no-op when no run state has been recorded', async () => {
    // Ensures globalTeardown is safe to invoke in harnesses where
    // createRunTempDirs never ran (e.g. a misconfigured project).
    await expect(globalTeardown()).resolves.toBeUndefined();
  });

  it('removes the DB, library, config, and downloads directories', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath);

    // Simulate libSQL having written the DB file and its WAL / SHM sidecars.
    writeFileSync(run.dbPath, 'db-bytes');
    writeFileSync(`${run.dbPath}-wal`, 'wal-bytes');
    writeFileSync(`${run.dbPath}-shm`, 'shm-bytes');

    expect(existsSync(run.dbPath)).toBe(true);
    expect(existsSync(`${run.dbPath}-wal`)).toBe(true);
    expect(existsSync(`${run.dbPath}-shm`)).toBe(true);
    expect(existsSync(run.libraryPath)).toBe(true);
    expect(existsSync(run.configPath)).toBe(true);
    expect(existsSync(run.downloadsPath)).toBe(true);

    await globalTeardown();

    expect(existsSync(run.dbPath)).toBe(false);
    expect(existsSync(`${run.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${run.dbPath}-shm`)).toBe(false);
    expect(existsSync(dirname(run.dbPath))).toBe(false);
    expect(existsSync(run.libraryPath)).toBe(false);
    expect(existsSync(run.configPath)).toBe(false);
    expect(existsSync(run.downloadsPath)).toBe(false);
  });

  it('does not throw when a target directory was already removed', async () => {
    // Simulates partial-state recovery — e.g. a crash mid-run that removed
    // the library dir but left the config dir. Teardown should clean what
    // remains without exploding on the missing one.
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath);

    rmSync(run.libraryPath, { recursive: true, force: true });

    await expect(globalTeardown()).resolves.toBeUndefined();

    expect(existsSync(run.libraryPath)).toBe(false);
    expect(existsSync(dirname(run.dbPath))).toBe(false);
    expect(existsSync(run.configPath)).toBe(false);
    expect(existsSync(run.downloadsPath)).toBe(false);
  });

  it('closes registered fake-server handles before removing temp directories', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath);

    const closeMam = vi.fn(async () => { /* no-op */ });
    const closeQbit = vi.fn(async () => { /* no-op */ });
    registerFake({ name: 'mam', close: closeMam });
    registerFake({ name: 'qbit', close: closeQbit });

    await globalTeardown();

    expect(closeMam).toHaveBeenCalledTimes(1);
    expect(closeQbit).toHaveBeenCalledTimes(1);
    // Registry is cleared after teardown so a second run starts clean.
    expect(getRegisteredFakes()).toEqual([]);
  });

  it('does not throw when a fake-server handle rejects during close', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath);

    // A dangling listener is cheaper than a failed teardown — must swallow.
    registerFake({ name: 'mam', close: async () => { throw new Error('boom'); } });
    const qbitClose = vi.fn(async () => { /* no-op */ });
    registerFake({ name: 'qbit', close: qbitClose });

    await expect(globalTeardown()).resolves.toBeUndefined();

    // Second fake still closed even though the first threw.
    expect(qbitClose).toHaveBeenCalledTimes(1);
    expect(existsSync(run.libraryPath)).toBe(false);
  });

  it.todo('removes sourcePath alongside the other temp dirs');

  it('ignores temp dirs created by an unrelated process', async () => {
    // Scoping guarantee: globalTeardown only removes what was recorded by
    // this process's createRunTempDirs. A dir created by a concurrent run
    // or a prior process must be left alone.
    const unrelatedDir = mkdtempSync(join(tmpdir(), 'narratorr-e2e-other-'));
    orphans.push(unrelatedDir);

    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath);

    await globalTeardown();

    expect(existsSync(unrelatedDir)).toBe(true);
    expect(getCurrentRun()).toEqual(run);
  });
});
