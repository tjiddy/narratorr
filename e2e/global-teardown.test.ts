import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// Spied, not replaced: every case but the isolation ones below removes real directories.
const actualRemoveTree = await vi.importActual<typeof import('../src/core/utils/remove-tree.js')>('../src/core/utils/remove-tree.js');
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

vi.mock('../src/core/utils/remove-tree.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  removeTreeSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

import { readdirSync, statSync } from 'node:fs';
import { removeTreeSync } from '../src/core/utils/remove-tree.js';
import globalTeardown, { sweepStaleHarnessTempDirs } from './global-teardown.js';
import {
  _resetCurrentRunForTests,
  createRunTempDirs,
  runTempRoots,
  HARNESS_TEMP_PREFIX,
  RUN_MANIFEST_ENV,
  RUN_MANIFEST_FILENAME,
  ROOT_RUN,
  SWEEP_MAX_AGE_MS,
  type RunTempDirs,
} from './fixtures/temp-dirs.js';
import { registerFake, _resetRegisteredFakesForTests, getRegisteredFakes } from './fixtures/run-state.js';

const orphans: string[] = [];

/** A real `narratorr-e2e-*` directory in the OS temp dir, aged to `ageMs` before `now`. */
function agedTempDir(now: number, ageMs: number, prefix = HARNESS_TEMP_PREFIX): { path: string; mtimeMs: number } {
  const path = actualFs.mkdtempSync(join(tmpdir(), prefix));
  orphans.push(path);
  const when = new Date(now - ageMs);
  actualFs.utimesSync(path, when, when);
  return { path, mtimeMs: actualFs.statSync(path).mtimeMs };
}

function writeManifest(dir: string, runs: Record<string, RunTempDirs>): string {
  const file = join(dir, RUN_MANIFEST_FILENAME);
  actualFs.writeFileSync(file, JSON.stringify({ version: 1, runs }), 'utf-8');
  process.env[RUN_MANIFEST_ENV] = file;
  return file;
}

/** Three real runs recorded only in a manifest — nothing is in this process's run map. */
function manifestOnlyRuns(mutate: (runs: Record<string, RunTempDirs>) => void = () => { /* verbatim */ }): {
  manifestPath: string;
  runs: RunTempDirs[];
} {
  const root = createRunTempDirs();
  const subpath = createRunTempDirs('subpath');
  const forms = createRunTempDirs('forms');
  const all = [root, subpath, forms];
  orphans.push(...all.flatMap(runTempRoots));

  const payload: Record<string, RunTempDirs> = { [ROOT_RUN]: root, subpath, forms };
  mutate(payload);
  const manifestPath = writeManifest(root.configPath, payload);
  _resetCurrentRunForTests();
  return { manifestPath, runs: all };
}

describe('globalTeardown', () => {
  beforeEach(() => {
    _resetCurrentRunForTests();
    _resetRegisteredFakesForTests();
    orphans.length = 0;
    delete process.env[RUN_MANIFEST_ENV];
    vi.mocked(removeTreeSync).mockReset();
    vi.mocked(removeTreeSync).mockImplementation(actualRemoveTree.removeTreeSync);
    vi.mocked(readdirSync).mockReset();
    vi.mocked(statSync).mockReset();
    vi.mocked(readdirSync).mockImplementation(actualFs.readdirSync as never);
    vi.mocked(statSync).mockImplementation(actualFs.statSync as never);
  });

  afterEach(() => {
    delete process.env[RUN_MANIFEST_ENV];
    for (const p of orphans) {
      try {
        actualFs.rmSync(p, { recursive: true, force: true });
      } catch {
        // Windows keeps libSQL handles open; a leaked temp dir is cheaper than a red suite.
      }
    }
  });

  it('removes the DB, library, config, and downloads directories', async () => {
    const run = createRunTempDirs();
    orphans.push(...runTempRoots(run));

    // Include libSQL's sidecars to verify deleting the enclosing DB directory.
    actualFs.writeFileSync(run.dbPath, 'db-bytes');
    actualFs.writeFileSync(`${run.dbPath}-wal`, 'wal-bytes');
    actualFs.writeFileSync(`${run.dbPath}-shm`, 'shm-bytes');

    await globalTeardown();

    expect(actualFs.existsSync(run.dbPath)).toBe(false);
    expect(actualFs.existsSync(`${run.dbPath}-wal`)).toBe(false);
    expect(actualFs.existsSync(`${run.dbPath}-shm`)).toBe(false);
    for (const dir of runTempRoots(run)) {
      expect(actualFs.existsSync(dir)).toBe(false);
    }
  });

  it('removes the temp dirs of every recorded run (root + subpath + forms)', async () => {
    const root = createRunTempDirs();
    const subpath = createRunTempDirs('subpath');
    const forms = createRunTempDirs('forms');
    orphans.push(...[root, subpath, forms].flatMap(runTempRoots));

    for (const run of [root, subpath, forms]) actualFs.writeFileSync(run.dbPath, 'db-bytes');

    await globalTeardown();

    for (const dir of [root, subpath, forms].flatMap(runTempRoots)) {
      expect(actualFs.existsSync(dir)).toBe(false);
    }
  });

  it('removes every path a manifest records even when this process allocated none of them', async () => {
    const { manifestPath, runs } = manifestOnlyRuns();

    await globalTeardown();

    for (const dir of runs.flatMap(runTempRoots)) {
      expect(actualFs.existsSync(dir)).toBe(false);
    }
    // The manifest lives inside the root run's configPath; removing that directory takes it with it.
    expect(actualFs.existsSync(manifestPath)).toBe(false);
  });

  it('does not throw when a target directory was already removed', async () => {
    const run = createRunTempDirs();
    orphans.push(...runTempRoots(run));

    actualFs.rmSync(run.libraryPath, { recursive: true, force: true });

    await expect(globalTeardown()).resolves.toBeUndefined();

    for (const dir of runTempRoots(run)) {
      expect(actualFs.existsSync(dir)).toBe(false);
    }
  });

  it('closes registered fake-server handles before removing temp directories', async () => {
    const run = createRunTempDirs();
    orphans.push(...runTempRoots(run));

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
    orphans.push(...runTempRoots(run));

    registerFake({ name: 'mam', close: async () => { throw new Error('boom'); } });
    const qbitClose = vi.fn(async () => { /* no-op */ });
    registerFake({ name: 'qbit', close: qbitClose });

    await expect(globalTeardown()).resolves.toBeUndefined();

    // The second fake must still close even though the first threw.
    expect(qbitClose).toHaveBeenCalledTimes(1);
    expect(actualFs.existsSync(run.libraryPath)).toBe(false);
  });

  it('one target whose removal keeps failing does not abort the loop', async () => {
    const run = createRunTempDirs();
    orphans.push(...runTempRoots(run));
    actualFs.writeFileSync(run.dbPath, 'db-bytes');

    // Exactly one target fails, and it is not the last — the later ones are the observation point.
    vi.mocked(removeTreeSync).mockImplementation((target: string) => {
      if (target === run.libraryPath) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      actualRemoveTree.removeTreeSync(target);
    });

    await expect(globalTeardown()).resolves.toBeUndefined();

    expect(attemptedRemovals()).toEqual(runTempRoots(run));
    expect(actualFs.existsSync(dirname(run.dbPath))).toBe(false);
    expect(actualFs.existsSync(run.configPath)).toBe(false);
    expect(actualFs.existsSync(run.downloadsPath)).toBe(false);
    expect(actualFs.existsSync(run.sourcePath)).toBe(false);
    // The failing one is the only survivor, which is what makes the assertions above non-vacuous.
    expect(actualFs.existsSync(run.libraryPath)).toBe(true);
  });

  it('ignores temp dirs created by an unrelated process', async () => {
    // Fresh, so the 24h floor — not the run registry alone — is what spares it from the sweep.
    const unrelated = agedTempDir(Date.now(), 0, 'narratorr-e2e-other-');

    const run = createRunTempDirs();
    orphans.push(...runTempRoots(run));

    await globalTeardown();

    expect(actualFs.existsSync(unrelated.path)).toBe(true);
    expect(attemptedRemovals()).not.toContain(unrelated.path);
  });

  it('performs zero manifest-owned removals with no manifest, but still closes fakes and sweeps', async () => {
    // An early `return` would pass a bare `resolves` assertion while defeating the sweep entirely.
    const now = Date.now();
    const stale = agedTempDir(now, 25 * 60 * 60 * 1000);
    const close = vi.fn(async () => { /* no-op */ });
    registerFake({ name: 'mam', close });

    await expect(globalTeardown()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
    expect(actualFs.existsSync(stale.path)).toBe(false);
  });

  describe('manifest confinement', () => {
    it('performs zero manifest-owned removals when any manifest path escapes the temp namespace', async () => {
      // The hostile field comes last: an implementation that removed the earlier, valid-looking
      // targets and skipped only this one would still be violating AC15.
      const hostile = join(homedir(), 'narratorr-e2e-not-really-temp');
      const now = Date.now();
      const stale = agedTempDir(now, 25 * 60 * 60 * 1000);
      const close = vi.fn(async () => { /* no-op */ });
      registerFake({ name: 'mam', close });
      const { runs } = manifestOnlyRuns((payload) => {
        payload.forms = { ...payload.forms!, libraryPath: hostile };
      });

      await expect(globalTeardown()).resolves.toBeUndefined();

      expect(attemptedRemovals()).not.toContain(hostile);
      for (const dir of runs.flatMap(runTempRoots)) {
        expect(attemptedRemovals()).not.toContain(dir);
      }
      expect(close).toHaveBeenCalledTimes(1);
      expect(attemptedRemovals()).toContain(stale.path);
    });

    it('performs zero manifest-owned removals for a correct-parent path without the harness prefix', async () => {
      const hostile = join(tmpdir(), 'something-else-abc123');
      const now = Date.now();
      const stale = agedTempDir(now, 25 * 60 * 60 * 1000);
      const { runs } = manifestOnlyRuns((payload) => {
        payload.forms = { ...payload.forms!, downloadsPath: hostile };
      });

      await expect(globalTeardown()).resolves.toBeUndefined();

      expect(attemptedRemovals()).not.toContain(hostile);
      for (const dir of runs.flatMap(runTempRoots)) {
        expect(attemptedRemovals()).not.toContain(dir);
      }
      expect(attemptedRemovals()).toContain(stale.path);
    });
  });

  describe('manifest load failure', () => {
    it.each([
      ['unreadable', (file: string) => { actualFs.rmSync(file); actualFs.mkdirSync(file); }],
      ['truncated JSON', (file: string) => { actualFs.writeFileSync(file, '{"version":1,"runs":{', 'utf-8'); }],
      ['valid JSON of the wrong shape', (file: string) => { actualFs.writeFileSync(file, '{"runs":[1,2,3]}', 'utf-8'); }],
    ])('a %s manifest yields zero owned removals while fakes close and the sweep runs', async (_label, corrupt) => {
      const now = Date.now();
      const stale = agedTempDir(now, 25 * 60 * 60 * 1000);
      const close = vi.fn(async () => { /* no-op */ });
      registerFake({ name: 'mam', close });
      const { manifestPath, runs } = manifestOnlyRuns();
      corrupt(manifestPath);

      await expect(globalTeardown()).resolves.toBeUndefined();

      // An un-attempted removal and a failed one look identical on disk; only the spy separates them.
      for (const dir of runs.flatMap(runTempRoots)) {
        expect(attemptedRemovals()).not.toContain(dir);
      }
      expect(close).toHaveBeenCalledTimes(1);
      expect(attemptedRemovals()).toContain(stale.path);
      expect(actualFs.existsSync(stale.path)).toBe(false);
    });

    it('does not suppress the removals this process allocated itself', async () => {
      // The manifest reader must absorb the failure, not the stage guard: aborting the whole stage
      // would silently strand every locally-allocated run alongside the unreadable manifest.
      const { manifestPath } = manifestOnlyRuns();
      actualFs.writeFileSync(manifestPath, '{"version":1,"runs":{', 'utf-8');
      const local = createRunTempDirs('local');
      orphans.push(...runTempRoots(local));

      await expect(globalTeardown()).resolves.toBeUndefined();

      for (const dir of runTempRoots(local)) {
        expect(actualFs.existsSync(dir)).toBe(false);
      }
    });
  });

  describe('stage independence', () => {
    it('a failing temp-dir enumeration neither fails teardown nor skips the manifest removals', async () => {
      const { runs } = manifestOnlyRuns();
      vi.mocked(readdirSync).mockImplementation((() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }) as never);

      await expect(globalTeardown()).resolves.toBeUndefined();

      for (const dir of runs.flatMap(runTempRoots)) {
        expect(actualFs.existsSync(dir)).toBe(false);
      }
    });

    it('a manifest-owned removal that throws does not prevent the sweep', async () => {
      const now = Date.now();
      const stale = agedTempDir(now, 25 * 60 * 60 * 1000);
      const { runs } = manifestOnlyRuns();
      const firstTarget = runTempRoots(runs[0]!)[0]!;
      vi.mocked(removeTreeSync).mockImplementation((target: string) => {
        if (target === firstTarget) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        actualRemoveTree.removeTreeSync(target);
      });

      await expect(globalTeardown()).resolves.toBeUndefined();

      expect(actualFs.existsSync(stale.path)).toBe(false);
    });
  });
});

describe('sweepStaleHarnessTempDirs', () => {
  beforeEach(() => {
    orphans.length = 0;
    vi.mocked(removeTreeSync).mockReset();
    vi.mocked(removeTreeSync).mockImplementation(actualRemoveTree.removeTreeSync);
    vi.mocked(readdirSync).mockReset();
    vi.mocked(statSync).mockReset();
    vi.mocked(readdirSync).mockImplementation(actualFs.readdirSync as never);
    vi.mocked(statSync).mockImplementation(actualFs.statSync as never);
  });

  afterEach(() => {
    for (const p of orphans) {
      try {
        actualFs.rmSync(p, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  });

  it('removes only entries strictly older than the 24h floor', () => {
    const seed = Date.now();
    const older = agedTempDir(seed, 25 * 60 * 60 * 1000);
    const atFloor = agedTempDir(seed, SWEEP_MAX_AGE_MS);
    const fresh = agedTempDir(seed, 60 * 1000);
    // Derived from what the filesystem actually stored, so a coarse mtime resolution cannot skew it.
    const now = atFloor.mtimeMs + SWEEP_MAX_AGE_MS;

    sweepStaleHarnessTempDirs(now);

    expect(actualFs.existsSync(older.path)).toBe(false);
    expect(actualFs.existsSync(atFloor.path)).toBe(true);
    expect(actualFs.existsSync(fresh.path)).toBe(true);
  });

  it('removes an entry one millisecond past the floor', () => {
    // Paired with the case above, this pins the predicate to `<` rather than `<=`.
    const justPast = agedTempDir(Date.now(), SWEEP_MAX_AGE_MS + 1);
    const now = justPast.mtimeMs + SWEEP_MAX_AGE_MS + 1;

    sweepStaleHarnessTempDirs(now);

    expect(actualFs.existsSync(justPast.path)).toBe(false);
  });

  it('leaves an aged non-matching directory and an aged matching file alone', () => {
    const seed = Date.now();
    const unrelated = agedTempDir(seed, 25 * 60 * 60 * 1000, 'something-else-');
    const filePath = join(tmpdir(), `${HARNESS_TEMP_PREFIX}stale-file-${process.pid}`);
    actualFs.writeFileSync(filePath, 'not a directory');
    orphans.push(filePath);
    const when = new Date(seed - 25 * 60 * 60 * 1000);
    actualFs.utimesSync(filePath, when, when);

    sweepStaleHarnessTempDirs(seed);

    expect(actualFs.existsSync(unrelated.path)).toBe(true);
    expect(actualFs.existsSync(filePath)).toBe(true);
    expect(attemptedRemovals()).not.toContain(unrelated.path);
    expect(attemptedRemovals()).not.toContain(filePath);
  });

  it('skips a candidate that vanishes between readdir and stat, and still evaluates the rest', () => {
    const seed = Date.now();
    const vanishing = agedTempDir(seed, 25 * 60 * 60 * 1000);
    const survivor = agedTempDir(seed, 25 * 60 * 60 * 1000);
    vi.mocked(statSync).mockImplementation(((target: string, options: never) => {
      if (target === vanishing.path) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return actualFs.statSync(target, options);
    }) as never);

    sweepStaleHarnessTempDirs(seed);

    expect(attemptedRemovals()).not.toContain(vanishing.path);
    expect(actualFs.existsSync(survivor.path)).toBe(false);
  });

  it('keeps sweeping after a removal that throws', () => {
    const seed = Date.now();
    const failing = agedTempDir(seed, 25 * 60 * 60 * 1000);
    const later = agedTempDir(seed, 25 * 60 * 60 * 1000);
    vi.mocked(removeTreeSync).mockImplementation((target: string) => {
      if (target === failing.path) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      actualRemoveTree.removeTreeSync(target);
    });

    expect(() => sweepStaleHarnessTempDirs(seed)).not.toThrow();

    expect(attemptedRemovals()).toContain(later.path);
    expect(actualFs.existsSync(later.path)).toBe(false);
  });
});

function attemptedRemovals(): string[] {
  return vi.mocked(removeTreeSync).mock.calls.map(([target]) => target);
}
