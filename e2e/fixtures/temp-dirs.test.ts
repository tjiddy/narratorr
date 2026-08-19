import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Real by default, spied so the rollback cases can inject `mkdtempSync` / publication failures.
// Every fixture and existence assertion goes through `actualFs` so it cannot consume a
// `mockImplementationOnce` armed for the code under test (see `fs-spy-over-importactual`).
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  mkdtempSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import {
  createRunTempDirs,
  resolveRunTempDirs,
  getCurrentRun,
  getRun,
  getAllRuns,
  runTempRoots,
  isHarnessTempRoot,
  readManifestRunsForCleanup,
  ROOT_RUN,
  HARNESS_TEMP_PREFIX,
  SWEEP_MAX_AGE_MS,
  RUN_MANIFEST_ENV,
  RUN_MANIFEST_FILENAME,
  _resetCurrentRunForTests,
  type RunTempDirs,
} from './temp-dirs.js';

const SUBPATH = 'subpath';
const FORMS = 'forms';
const ALL_RUNS = [ROOT_RUN, SUBPATH, FORMS];

/** For expected values only — `path.join` emits `\` on Windows, `canonicalPath` never does. */
const toPosix = (p: string): string => p.split('\\').join('/');

/** Every path `mkdtempSync` actually handed back — the ownership ledger the rollback cases assert on. */
function allocatedPaths(): string[] {
  return vi.mocked(mkdtempSync).mock.results
    .filter((r) => r.type === 'return')
    .map((r) => r.value as string);
}

function writeManifest(dir: string, runs: Record<string, RunTempDirs>): string {
  const file = join(dir, RUN_MANIFEST_FILENAME);
  actualFs.writeFileSync(file, JSON.stringify({ version: 1, runs }), 'utf-8');
  return file;
}

describe('createRunTempDirs', () => {
  const createdPaths: string[] = [];

  beforeEach(() => {
    _resetCurrentRunForTests();
    delete process.env[RUN_MANIFEST_ENV];
    createdPaths.length = 0;
    vi.mocked(mkdtempSync).mockReset();
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(renameSync).mockReset();
    vi.mocked(rmSync).mockReset();
    vi.mocked(mkdtempSync).mockImplementation(actualFs.mkdtempSync as never);
    vi.mocked(writeFileSync).mockImplementation(actualFs.writeFileSync as never);
    vi.mocked(renameSync).mockImplementation(actualFs.renameSync as never);
    vi.mocked(rmSync).mockImplementation(actualFs.rmSync as never);
  });

  afterEach(() => {
    delete process.env[RUN_MANIFEST_ENV];
    for (const p of [...createdPaths, ...allocatedPaths()]) {
      try {
        actualFs.rmSync(p, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  });

  it('creates five distinct temp directories on disk', () => {
    const run = createRunTempDirs();
    createdPaths.push(...runTempRoots(run));

    for (const dir of runTempRoots(run)) {
      expect(actualFs.statSync(dir).isDirectory()).toBe(true);
    }

    expect(new Set(runTempRoots(run)).size).toBe(5);
  });

  it('returns a dbPath that sits inside a dedicated enclosing directory', () => {
    // A dedicated directory lets teardown remove libSQL's `-wal`/`-shm` sidecars with the DB.
    const run = createRunTempDirs();
    createdPaths.push(...runTempRoots(run));

    expect(run.dbPath.endsWith('narratorr.db')).toBe(true);
    expect(actualFs.statSync(dirname(run.dbPath)).isDirectory()).toBe(true);
    expect(actualFs.existsSync(run.dbPath)).toBe(false);
  });

  it('stores the run in module state for globalTeardown to consume', () => {
    expect(getCurrentRun()).toBeUndefined();

    const run = createRunTempDirs();
    createdPaths.push(...runTempRoots(run));

    expect(getCurrentRun()).toEqual(run);
  });

  it('provisions downloadsPath as a fourth distinct temp directory', () => {
    // qBit completion needs this directory before global setup starts the fake.
    const run = createRunTempDirs();
    createdPaths.push(...runTempRoots(run));

    expect(actualFs.statSync(run.downloadsPath).isDirectory()).toBe(true);
    expect(run.downloadsPath).not.toBe(dirname(run.dbPath));
    expect(run.downloadsPath).not.toBe(run.libraryPath);
    expect(run.downloadsPath).not.toBe(run.configPath);
  });

  it('returns a fresh set of directories on each call', () => {
    const first = createRunTempDirs();
    const second = createRunTempDirs(SUBPATH);
    createdPaths.push(...runTempRoots(first), ...runTempRoots(second));

    expect(first.dbPath).not.toBe(second.dbPath);
    expect(first.libraryPath).not.toBe(second.libraryPath);
    expect(first.configPath).not.toBe(second.configPath);
    expect(first.downloadsPath).not.toBe(second.downloadsPath);
    expect(first.sourcePath).not.toBe(second.sourcePath);
  });

  it('provisions sourcePath as a fifth distinct temp directory', () => {
    const run = createRunTempDirs();
    createdPaths.push(...runTempRoots(run));

    expect(actualFs.statSync(run.sourcePath).isDirectory()).toBe(true);
    expect(run.sourcePath).not.toBe(dirname(run.dbPath));
    expect(run.sourcePath).not.toBe(run.libraryPath);
    expect(run.sourcePath).not.toBe(run.configPath);
    expect(run.sourcePath).not.toBe(run.downloadsPath);
  });

  it('stores a named run without clobbering the root run', () => {
    const root = createRunTempDirs();
    const subpath = createRunTempDirs(SUBPATH);
    createdPaths.push(...runTempRoots(root), ...runTempRoots(subpath));

    expect(getCurrentRun()).toEqual(root);
    expect(getRun(ROOT_RUN)).toEqual(root);
    expect(getRun(SUBPATH)).toEqual(subpath);
    expect(subpath.dbPath).not.toBe(root.dbPath);
    expect(subpath.libraryPath).not.toBe(root.libraryPath);
    expect(subpath.configPath).not.toBe(root.configPath);
  });

  it('getAllRuns returns every recorded run for teardown', () => {
    const root = createRunTempDirs();
    const subpath = createRunTempDirs(SUBPATH);
    createdPaths.push(...runTempRoots(root), ...runTempRoots(subpath));

    const all = getAllRuns();
    expect(all).toHaveLength(2);
    expect(all).toContainEqual(root);
    expect(all).toContainEqual(subpath);
  });

  it('getRun returns undefined for an unknown run name', () => {
    expect(getRun('nope')).toBeUndefined();
  });
});

describe('isHarnessTempRoot', () => {
  it('accepts a directory directly under the OS temp dir carrying the harness prefix', () => {
    expect(isHarnessTempRoot(join(tmpdir(), `${HARNESS_TEMP_PREFIX}abc123`))).toBe(true);
  });

  it('is lexical: a conforming path that does not exist still passes', () => {
    // Teardown re-checks already-removed targets; a stat-based predicate would reject them.
    const gone = join(tmpdir(), `${HARNESS_TEMP_PREFIX}never-created-xyz`);
    expect(actualFs.existsSync(gone)).toBe(false);
    expect(isHarnessTempRoot(gone)).toBe(true);
  });

  it('rejects a path outside the OS temp namespace', () => {
    expect(isHarnessTempRoot(join(homedir(), `${HARNESS_TEMP_PREFIX}abc123`))).toBe(false);
  });

  it('rejects a correct-parent path whose basename lacks the harness prefix', () => {
    expect(isHarnessTempRoot(join(tmpdir(), 'something-else-abc123'))).toBe(false);
  });

  it('resolves a run to the directory identities that were validated, not the raw spellings', () => {
    // What `runTempRoots` returns is what teardown deletes, so it must yield the same identity the
    // confinement predicate approved — otherwise a validated alias names a different pathname.
    const real = join(tmpdir(), `${HARNESS_TEMP_PREFIX}identity`);
    // Built by concatenation, not `join`: on Windows `join` would normalize the `\.` away before
    // the function under test ever sees it, and the alias is the whole point of the fixture.
    const roots = runTempRoots({
      dbPath: `${real}-db\\./narratorr.db`,
      libraryPath: `${real}-lib/.`,
      configPath: `${real}-cfg/../${HARNESS_TEMP_PREFIX}identity-cfg`,
      downloadsPath: `${real}-dl`,
      sourcePath: `${real}-src`,
    });

    // `canonicalPath` folds separators last, so its output is POSIX-spelled on every platform
    // while `real` carries `\` on Windows. Normalize the expected side, never the actual.
    expect(roots).toEqual([
      `${real}-db`, `${real}-lib`, `${real}-cfg`, `${real}-dl`, `${real}-src`,
    ].map(toPosix));
  });

  it('rejects a prefix-matching path nested one level deeper than the temp dir', () => {
    // Only the allocator's own roots are removable; descendants must be reached through them.
    expect(isHarnessTempRoot(join(tmpdir(), `${HARNESS_TEMP_PREFIX}abc123`, 'inner'))).toBe(false);
  });

  it('rejects the OS temp dir itself', () => {
    expect(isHarnessTempRoot(tmpdir())).toBe(false);
  });
});

describe('resolveRunTempDirs', () => {
  const createdPaths: string[] = [];

  beforeEach(() => {
    _resetCurrentRunForTests();
    delete process.env[RUN_MANIFEST_ENV];
    createdPaths.length = 0;
    vi.mocked(mkdtempSync).mockReset();
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(renameSync).mockReset();
    vi.mocked(rmSync).mockReset();
    vi.mocked(mkdtempSync).mockImplementation(actualFs.mkdtempSync as never);
    vi.mocked(writeFileSync).mockImplementation(actualFs.writeFileSync as never);
    vi.mocked(renameSync).mockImplementation(actualFs.renameSync as never);
    vi.mocked(rmSync).mockImplementation(actualFs.rmSync as never);
  });

  afterEach(() => {
    delete process.env[RUN_MANIFEST_ENV];
    for (const p of [...createdPaths, ...allocatedPaths()]) {
      try {
        actualFs.rmSync(p, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  });

  it('allocates five distinct existing directories per run on the first load', () => {
    const runs = resolveRunTempDirs(ALL_RUNS);
    createdPaths.push(...runs.flatMap(runTempRoots));

    expect(runs).toHaveLength(3);
    const roots = runs.flatMap(runTempRoots);
    expect(new Set(roots).size).toBe(15);
    for (const dir of roots) {
      expect(actualFs.statSync(dir).isDirectory()).toBe(true);
      expect(isHarnessTempRoot(dir)).toBe(true);
    }
  });

  it('publishes a manifest inside the root run configPath and exports its location', () => {
    const [root] = resolveRunTempDirs(ALL_RUNS);
    createdPaths.push(...getAllRuns().flatMap(runTempRoots));

    const manifestPath = process.env[RUN_MANIFEST_ENV];
    expect(manifestPath).toBe(join(root!.configPath, RUN_MANIFEST_FILENAME));
    expect(actualFs.existsSync(manifestPath!)).toBe(true);
  });

  it('allocates nothing on a second load once the manifest env var is published', () => {
    const first = resolveRunTempDirs(ALL_RUNS);
    createdPaths.push(...first.flatMap(runTempRoots));

    // A namespace count would race sibling harness suites under `maxWorkers: 8`; the spy cannot.
    vi.mocked(mkdtempSync).mockClear();
    _resetCurrentRunForTests();

    const second = resolveRunTempDirs(ALL_RUNS);

    expect(mkdtempSync).toHaveBeenCalledTimes(0);
    expect(second).toEqual(first);
    expect(getAllRuns()).toEqual(first);
  });

  it('keeps getCurrentRun/getRun resolving to the manifest-owned paths after a reload', () => {
    const [root, subpath, forms] = resolveRunTempDirs(ALL_RUNS);
    createdPaths.push(...getAllRuns().flatMap(runTempRoots));

    _resetCurrentRunForTests();
    resolveRunTempDirs(ALL_RUNS);

    expect(getCurrentRun()).toEqual(root);
    expect(getRun(SUBPATH)).toEqual(subpath);
    expect(getRun(FORMS)).toEqual(forms);
  });

  it('publishes the manifest through a temporary sibling so no reader sees a torn file', () => {
    resolveRunTempDirs(ALL_RUNS);
    createdPaths.push(...getAllRuns().flatMap(runTempRoots));

    const finalPath = process.env[RUN_MANIFEST_ENV]!;
    const [writtenPath] = vi.mocked(writeFileSync).mock.calls.at(-1)!;
    const [renameFrom, renameTo] = vi.mocked(renameSync).mock.calls.at(-1)!;

    expect(writtenPath).not.toBe(finalPath);
    expect(renameFrom).toBe(writtenPath);
    expect(renameTo).toBe(finalPath);
  });

  it('throws a named error when the manifest env var points at a missing file', () => {
    const stray = join(tmpdir(), `${HARNESS_TEMP_PREFIX}absent`, RUN_MANIFEST_FILENAME);
    process.env[RUN_MANIFEST_ENV] = stray;

    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(new RegExp(escapeRegExp(stray)));
    expect(getAllRuns()).toEqual([]);
  });

  it('fails loudly on a truncated manifest without half-populating the run map', () => {
    const holder = createRunTempDirs('manifest-holder');
    createdPaths.push(...runTempRoots(holder));
    const manifestPath = join(holder.configPath, RUN_MANIFEST_FILENAME);
    actualFs.writeFileSync(manifestPath, '{"version":1,"runs":{', 'utf-8');
    _resetCurrentRunForTests();
    process.env[RUN_MANIFEST_ENV] = manifestPath;

    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(new RegExp(escapeRegExp(manifestPath)));
    expect(getAllRuns()).toEqual([]);
  });

  it('fails loudly on a manifest whose run entry has the wrong shape', () => {
    const holder = createRunTempDirs('manifest-holder');
    createdPaths.push(...runTempRoots(holder));
    const manifestPath = join(holder.configPath, RUN_MANIFEST_FILENAME);
    actualFs.writeFileSync(
      manifestPath,
      JSON.stringify({ version: 1, runs: { [ROOT_RUN]: { dbPath: holder.dbPath } } }),
      'utf-8',
    );
    _resetCurrentRunForTests();
    process.env[RUN_MANIFEST_ENV] = manifestPath;

    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(new RegExp(escapeRegExp(manifestPath)));
    expect(getAllRuns()).toEqual([]);
  });

  it('fails loudly when the manifest is missing one of the requested runs', () => {
    const root = createRunTempDirs();
    const subpath = createRunTempDirs(SUBPATH);
    createdPaths.push(...runTempRoots(root), ...runTempRoots(subpath));
    const manifestPath = writeManifest(root.configPath, { [ROOT_RUN]: root, [SUBPATH]: subpath });
    _resetCurrentRunForTests();
    process.env[RUN_MANIFEST_ENV] = manifestPath;

    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(/forms/);
    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(new RegExp(escapeRegExp(manifestPath)));
    expect(getAllRuns()).toEqual([]);
  });

  it('rejects a well-shaped manifest naming a path outside the temp namespace', () => {
    const { manifestPath } = hostileManifest(createdPaths, (run) => ({
      ...run,
      libraryPath: join(homedir(), `${HARNESS_TEMP_PREFIX}not-really-temp`),
    }));

    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(new RegExp(escapeRegExp(manifestPath)));
    expect(getAllRuns()).toEqual([]);
  });

  it('rejects a well-shaped manifest naming a temp path without the harness prefix', () => {
    const { manifestPath } = hostileManifest(createdPaths, (run) => ({
      ...run,
      downloadsPath: join(tmpdir(), 'something-else-abc123'),
    }));

    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(new RegExp(escapeRegExp(manifestPath)));
    expect(getAllRuns()).toEqual([]);
  });

  it('rejects a manifest read from a directory other than the root run configPath', () => {
    const root = createRunTempDirs();
    const subpath = createRunTempDirs(SUBPATH);
    const forms = createRunTempDirs(FORMS);
    const elsewhere = createRunTempDirs('elsewhere');
    createdPaths.push(
      ...runTempRoots(root), ...runTempRoots(subpath), ...runTempRoots(forms), ...runTempRoots(elsewhere),
    );
    const manifestPath = writeManifest(elsewhere.configPath, {
      [ROOT_RUN]: root, [SUBPATH]: subpath, [FORMS]: forms,
    });
    _resetCurrentRunForTests();
    process.env[RUN_MANIFEST_ENV] = manifestPath;

    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(new RegExp(escapeRegExp(manifestPath)));
    expect(getAllRuns()).toEqual([]);
  });

  it('rejects a manifest whose runs share a directory', () => {
    const root = createRunTempDirs();
    const subpath = createRunTempDirs(SUBPATH);
    const forms = createRunTempDirs(FORMS);
    createdPaths.push(...runTempRoots(root), ...runTempRoots(subpath), ...runTempRoots(forms));
    const manifestPath = writeManifest(root.configPath, {
      [ROOT_RUN]: root,
      [SUBPATH]: { ...subpath, sourcePath: root.sourcePath },
      [FORMS]: forms,
    });
    _resetCurrentRunForTests();
    process.env[RUN_MANIFEST_ENV] = manifestPath;

    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(new RegExp(escapeRegExp(manifestPath)));
    expect(getAllRuns()).toEqual([]);
  });

  // Byte-distinct but canonically identical: each passes confinement on its own, so only a
  // canonical distinctness key catches the collision. `/.` and the `..` round-trip are the POSIX
  // spellings; the backslash form is the one `canonicalPath`'s fold-before-resolve exists for.
  it.each([
    ['a trailing "/." segment', (p: string) => `${p}/.`],
    ['a backslash-spelled "." segment', (p: string) => `${p}\\.`],
    ['a parent round-trip', (p: string) => `${p}/../${p.split(/[\\/]/).at(-1)!}`],
  ])('rejects a manifest that aliases one directory through %s', (_label, alias) => {
    const root = createRunTempDirs();
    const subpath = createRunTempDirs(SUBPATH);
    const forms = createRunTempDirs(FORMS);
    createdPaths.push(...runTempRoots(root), ...runTempRoots(subpath), ...runTempRoots(forms));
    const aliased = alias(root.sourcePath);

    // Non-vacuity: the alias is a different string that the confinement gate accepts on its own,
    // so the byte-identical case above cannot stand in for this one.
    expect(aliased).not.toBe(root.sourcePath);
    expect(isHarnessTempRoot(aliased)).toBe(true);

    const manifestPath = writeManifest(root.configPath, {
      [ROOT_RUN]: root,
      [SUBPATH]: { ...subpath, sourcePath: aliased },
      [FORMS]: forms,
    });
    _resetCurrentRunForTests();
    process.env[RUN_MANIFEST_ENV] = manifestPath;

    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(new RegExp(escapeRegExp(manifestPath)));
    expect(getAllRuns()).toEqual([]);
  });

  it('keeps two independent manifests disjoint', () => {
    const first = resolveRunTempDirs(ALL_RUNS);
    const firstManifest = process.env[RUN_MANIFEST_ENV]!;
    createdPaths.push(...first.flatMap(runTempRoots));

    _resetCurrentRunForTests();
    delete process.env[RUN_MANIFEST_ENV];
    const second = resolveRunTempDirs(ALL_RUNS);
    createdPaths.push(...second.flatMap(runTempRoots));

    expect(process.env[RUN_MANIFEST_ENV]).not.toBe(firstManifest);
    const firstRoots = new Set(first.flatMap(runTempRoots));
    for (const dir of second.flatMap(runTempRoots)) {
      expect(firstRoots.has(dir)).toBe(false);
    }
    expect(readManifestRunsForCleanup(firstManifest)).toEqual(first);
  });
});

describe('resolveRunTempDirs rollback', () => {
  beforeEach(() => {
    _resetCurrentRunForTests();
    delete process.env[RUN_MANIFEST_ENV];
    vi.mocked(mkdtempSync).mockReset();
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(renameSync).mockReset();
    vi.mocked(rmSync).mockReset();
    vi.mocked(mkdtempSync).mockImplementation(actualFs.mkdtempSync as never);
    vi.mocked(writeFileSync).mockImplementation(actualFs.writeFileSync as never);
    vi.mocked(renameSync).mockImplementation(actualFs.renameSync as never);
    vi.mocked(rmSync).mockImplementation(actualFs.rmSync as never);
  });

  afterEach(() => {
    delete process.env[RUN_MANIFEST_ENV];
    for (const p of allocatedPaths()) {
      try {
        actualFs.rmSync(p, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  });

  it('removes every directory allocated so far when an allocation fails mid-batch', () => {
    // The 8th call, not the 1st or 15th: only a partial set proves the unwind walks the ledger.
    let calls = 0;
    vi.mocked(mkdtempSync).mockImplementation(((prefix: string) => {
      calls += 1;
      if (calls === 8) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return actualFs.mkdtempSync(prefix);
    }) as never);

    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(/ENOSPC/);

    const recorded = allocatedPaths();
    expect(recorded).toHaveLength(7);
    for (const dir of recorded) {
      expect(actualFs.existsSync(dir)).toBe(false);
    }
    expect(process.env[RUN_MANIFEST_ENV]).toBeUndefined();
    expect(getAllRuns()).toEqual([]);
  });

  it('removes all fifteen directories when the manifest publication fails', () => {
    // The opposite side of the last `mkdtempSync`: a fix for the mid-batch window misses this one.
    vi.mocked(renameSync).mockImplementation((() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    }) as never);

    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(/EACCES/);

    const recorded = allocatedPaths();
    expect(recorded).toHaveLength(15);
    for (const dir of recorded) {
      expect(actualFs.existsSync(dir)).toBe(false);
    }
    expect(process.env[RUN_MANIFEST_ENV]).toBeUndefined();
    expect(getAllRuns()).toEqual([]);
  });

  it('preserves the original error and keeps unwinding when a rollback removal fails', () => {
    let calls = 0;
    vi.mocked(mkdtempSync).mockImplementation(((prefix: string) => {
      calls += 1;
      if (calls === 8) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return actualFs.mkdtempSync(prefix);
    }) as never);

    const recordedSoFar: string[] = [];
    vi.mocked(rmSync).mockImplementation(((target: string, options: never) => {
      recordedSoFar.push(target);
      if (recordedSoFar.length === 1) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return actualFs.rmSync(target, options);
    }) as never);

    expect(() => resolveRunTempDirs(ALL_RUNS)).toThrow(/ENOSPC/);

    // All seven are still attempted even though the first removal threw.
    expect(recordedSoFar).toEqual(allocatedPaths());
    expect(recordedSoFar).toHaveLength(7);
    expect(process.env[RUN_MANIFEST_ENV]).toBeUndefined();
  });
});

describe('readManifestRunsForCleanup', () => {
  const createdPaths: string[] = [];

  beforeEach(() => {
    _resetCurrentRunForTests();
    delete process.env[RUN_MANIFEST_ENV];
    createdPaths.length = 0;
    vi.mocked(mkdtempSync).mockReset();
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(renameSync).mockReset();
    vi.mocked(rmSync).mockReset();
    vi.mocked(mkdtempSync).mockImplementation(actualFs.mkdtempSync as never);
    vi.mocked(writeFileSync).mockImplementation(actualFs.writeFileSync as never);
    vi.mocked(renameSync).mockImplementation(actualFs.renameSync as never);
    vi.mocked(rmSync).mockImplementation(actualFs.rmSync as never);
  });

  afterEach(() => {
    delete process.env[RUN_MANIFEST_ENV];
    for (const p of [...createdPaths, ...allocatedPaths()]) {
      try {
        actualFs.rmSync(p, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  });

  it('returns every run when the manifest is valid', () => {
    const runs = resolveRunTempDirs(ALL_RUNS);
    createdPaths.push(...runs.flatMap(runTempRoots));

    expect(readManifestRunsForCleanup(process.env[RUN_MANIFEST_ENV])).toEqual(runs);
  });

  it('returns nothing rather than throwing when no manifest path is known', () => {
    expect(readManifestRunsForCleanup(undefined)).toEqual([]);
    expect(readManifestRunsForCleanup('')).toEqual([]);
  });

  it('returns nothing for a missing, truncated, or wrong-shaped manifest', () => {
    const holder = createRunTempDirs('manifest-holder');
    createdPaths.push(...runTempRoots(holder));

    const missing = join(holder.configPath, RUN_MANIFEST_FILENAME);
    expect(readManifestRunsForCleanup(missing)).toEqual([]);

    actualFs.writeFileSync(missing, '{"version":1,"runs":{', 'utf-8');
    expect(readManifestRunsForCleanup(missing)).toEqual([]);

    actualFs.writeFileSync(missing, JSON.stringify({ version: 1, runs: { [ROOT_RUN]: 7 } }), 'utf-8');
    expect(readManifestRunsForCleanup(missing)).toEqual([]);
  });

  it('returns nothing when any manifest path escapes the harness temp namespace', () => {
    const { manifestPath } = hostileManifest(createdPaths, (run) => ({
      ...run,
      libraryPath: join(homedir(), 'real-data'),
    }));

    expect(readManifestRunsForCleanup(manifestPath)).toEqual([]);
  });

  it('returns nothing when two runs alias one directory through different spellings', () => {
    // Teardown is the consumer where an accepted alias does the damage the config load prevents:
    // removing a shared root on behalf of one run would take the other run's state with it.
    const { manifestPath } = hostileManifest(createdPaths, (run) => ({
      ...run,
      sourcePath: `${run.libraryPath}/.`,
    }));

    expect(readManifestRunsForCleanup(manifestPath)).toEqual([]);
  });
});

describe('sweep constants', () => {
  it('pins the age floor at 24 hours', () => {
    expect(SWEEP_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('shares the allocator prefix so the sweep glob and the allocator cannot drift', () => {
    const run = createRunTempDirs('prefix-probe');
    try {
      for (const dir of runTempRoots(run)) {
        expect(dir.split('\\').join('/').split('/').at(-1)!.startsWith(HARNESS_TEMP_PREFIX)).toBe(true);
      }
    } finally {
      for (const dir of runTempRoots(run)) {
        try { actualFs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      _resetCurrentRunForTests();
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Three real runs plus one field rewritten to a non-conforming path, published as a valid manifest. */
function hostileManifest(
  createdPaths: string[],
  corrupt: (run: RunTempDirs) => RunTempDirs,
): { manifestPath: string } {
  const root = createRunTempDirs();
  const subpath = createRunTempDirs(SUBPATH);
  const forms = createRunTempDirs(FORMS);
  createdPaths.push(...runTempRoots(root), ...runTempRoots(subpath), ...runTempRoots(forms));

  // The hostile entry comes last, so an implementation that removes earlier targets first is observable.
  const manifestPath = writeManifest(root.configPath, {
    [ROOT_RUN]: root, [SUBPATH]: subpath, [FORMS]: corrupt(forms),
  });
  _resetCurrentRunForTests();
  process.env[RUN_MANIFEST_ENV] = manifestPath;
  return { manifestPath };
}
