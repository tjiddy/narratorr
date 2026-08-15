import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import globalTeardown from './global-teardown.js';
import { _resetCurrentRunForTests, createRunTempDirs, getCurrentRun } from './fixtures/temp-dirs.js';
import { registerFake, _resetRegisteredFakesForTests, getRegisteredFakes } from './fixtures/run-state.js';

// Spied, not replaced: every case but the isolation one below removes real directories.
const actualRemoveTree = await vi.importActual<typeof import('../src/core/utils/remove-tree.js')>('../src/core/utils/remove-tree.js');

vi.mock('../src/core/utils/remove-tree.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  removeTreeSync: vi.fn(),
}));

import { removeTreeSync } from '../src/core/utils/remove-tree.js';

describe('globalTeardown', () => {
  const orphans: string[] = [];

  beforeEach(() => {
    _resetCurrentRunForTests();
    _resetRegisteredFakesForTests();
    orphans.length = 0;
    vi.mocked(removeTreeSync).mockReset();
    vi.mocked(removeTreeSync).mockImplementation(actualRemoveTree.removeTreeSync);
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

  it('one target whose removal keeps failing does not abort the loop', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);
    writeFileSync(run.dbPath, 'db-bytes');

    // Exactly one target fails, and it is not the last — the later ones are the observation point.
    vi.mocked(removeTreeSync).mockImplementation((target: string) => {
      if (target === run.libraryPath) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      actualRemoveTree.removeTreeSync(target);
    });

    await expect(globalTeardown()).resolves.toBeUndefined();

    const attempted = vi.mocked(removeTreeSync).mock.calls.map(([target]) => target);
    expect(attempted).toEqual([
      dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath,
    ]);
    expect(existsSync(dirname(run.dbPath))).toBe(false);
    expect(existsSync(run.configPath)).toBe(false);
    expect(existsSync(run.downloadsPath)).toBe(false);
    expect(existsSync(run.sourcePath)).toBe(false);
    // The failing one is the only survivor, which is what makes the assertions above non-vacuous.
    expect(existsSync(run.libraryPath)).toBe(true);
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
