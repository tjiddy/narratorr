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
    await expect(globalTeardown()).resolves.toBeUndefined();
  });

  it('removes the DB, library, config, and downloads directories', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    // Include libSQL's sidecars to verify deleting the enclosing DB directory.
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

  it('removes the temp dirs of every recorded run (root + subpath + forms)', async () => {
    const root = createRunTempDirs();
    const subpath = createRunTempDirs('subpath');
    const forms = createRunTempDirs('forms');
    orphans.push(
      dirname(root.dbPath), root.libraryPath, root.configPath, root.downloadsPath, root.sourcePath,
      dirname(subpath.dbPath), subpath.libraryPath, subpath.configPath, subpath.downloadsPath, subpath.sourcePath,
      dirname(forms.dbPath), forms.libraryPath, forms.configPath, forms.downloadsPath, forms.sourcePath,
    );

    writeFileSync(root.dbPath, 'db-bytes');
    writeFileSync(subpath.dbPath, 'db-bytes');
    writeFileSync(forms.dbPath, 'db-bytes');

    await globalTeardown();

    for (const run of [root, subpath, forms]) {
      expect(existsSync(dirname(run.dbPath))).toBe(false);
      expect(existsSync(run.libraryPath)).toBe(false);
      expect(existsSync(run.configPath)).toBe(false);
      expect(existsSync(run.downloadsPath)).toBe(false);
      expect(existsSync(run.sourcePath)).toBe(false);
    }
  });

  it('does not throw when a target directory was already removed', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    rmSync(run.libraryPath, { recursive: true, force: true });

    await expect(globalTeardown()).resolves.toBeUndefined();

    expect(existsSync(run.libraryPath)).toBe(false);
    expect(existsSync(dirname(run.dbPath))).toBe(false);
    expect(existsSync(run.configPath)).toBe(false);
    expect(existsSync(run.downloadsPath)).toBe(false);
  });

  it('closes registered fake-server handles before removing temp directories', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    const closeMam = vi.fn(async () => { /* no-op */ });
    const closeQbit = vi.fn(async () => { /* no-op */ });
    registerFake({ name: 'mam', close: closeMam });
    registerFake({ name: 'qbit', close: closeQbit });

    await globalTeardown();

    expect(closeMam).toHaveBeenCalledTimes(1);
    expect(closeQbit).toHaveBeenCalledTimes(1);
    expect(getRegisteredFakes()).toEqual([]);
  });

  it('does not throw when a fake-server handle rejects during close', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    registerFake({ name: 'mam', close: async () => { throw new Error('boom'); } });
    const qbitClose = vi.fn(async () => { /* no-op */ });
    registerFake({ name: 'qbit', close: qbitClose });

    await expect(globalTeardown()).resolves.toBeUndefined();

    // The second fake must still close even though the first threw.
    expect(qbitClose).toHaveBeenCalledTimes(1);
    expect(existsSync(run.libraryPath)).toBe(false);
  });

  it('removes sourcePath alongside the other temp dirs', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    expect(existsSync(run.sourcePath)).toBe(true);

    await globalTeardown();

    expect(existsSync(run.sourcePath)).toBe(false);
  });

  it('ignores temp dirs created by an unrelated process', async () => {
    // Teardown must never touch paths absent from this process's run registry.
    const unrelatedDir = mkdtempSync(join(tmpdir(), 'narratorr-e2e-other-'));
    orphans.push(unrelatedDir);

    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    await globalTeardown();

    expect(existsSync(unrelatedDir)).toBe(true);
    expect(getCurrentRun()).toEqual(run);
  });
});
