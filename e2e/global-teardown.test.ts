import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import globalTeardown from './global-teardown.js';
import { _resetCurrentRunForTests, createRunTempDirs, getCurrentRun } from './fixtures/temp-dirs.js';

describe('globalTeardown', () => {
  const orphans: string[] = [];

  beforeEach(() => {
    _resetCurrentRunForTests();
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

  it('removes the DB directory, library directory, and config directory', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath);

    // Simulate libSQL having written the DB file and its WAL / SHM sidecars.
    writeFileSync(run.dbPath, 'db-bytes');
    writeFileSync(`${run.dbPath}-wal`, 'wal-bytes');
    writeFileSync(`${run.dbPath}-shm`, 'shm-bytes');

    expect(existsSync(run.dbPath)).toBe(true);
    expect(existsSync(`${run.dbPath}-wal`)).toBe(true);
    expect(existsSync(`${run.dbPath}-shm`)).toBe(true);
    expect(existsSync(run.libraryPath)).toBe(true);
    expect(existsSync(run.configPath)).toBe(true);

    await globalTeardown();

    expect(existsSync(run.dbPath)).toBe(false);
    expect(existsSync(`${run.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${run.dbPath}-shm`)).toBe(false);
    expect(existsSync(dirname(run.dbPath))).toBe(false);
    expect(existsSync(run.libraryPath)).toBe(false);
    expect(existsSync(run.configPath)).toBe(false);
  });

  it('does not throw when a target directory was already removed', async () => {
    // Simulates partial-state recovery — e.g. a crash mid-run that removed
    // the library dir but left the config dir. Teardown should clean what
    // remains without exploding on the missing one.
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath);

    rmSync(run.libraryPath, { recursive: true, force: true });

    await expect(globalTeardown()).resolves.toBeUndefined();

    expect(existsSync(run.libraryPath)).toBe(false);
    expect(existsSync(dirname(run.dbPath))).toBe(false);
    expect(existsSync(run.configPath)).toBe(false);
  });

  it('ignores temp dirs created by an unrelated process', async () => {
    // Scoping guarantee: globalTeardown only removes what was recorded by
    // this process's createRunTempDirs. A dir created by a concurrent run
    // or a prior process must be left alone.
    const unrelatedDir = mkdtempSync(join(tmpdir(), 'narratorr-e2e-other-'));
    orphans.push(unrelatedDir);

    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath);

    await globalTeardown();

    expect(existsSync(unrelatedDir)).toBe(true);
    expect(getCurrentRun()).toEqual(run);
  });
});
