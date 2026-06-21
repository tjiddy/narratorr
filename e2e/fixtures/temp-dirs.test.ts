import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRunTempDirs, getCurrentRun, getRun, getAllRuns, ROOT_RUN, _resetCurrentRunForTests } from './temp-dirs.js';

describe('createRunTempDirs', () => {
  const createdPaths: string[] = [];

  beforeEach(() => {
    _resetCurrentRunForTests();
    createdPaths.length = 0;
  });

  afterEach(() => {
    // Clean up anything this test created so the harness's own tests
    // don't leak temp dirs into os.tmpdir().
    for (const p of createdPaths) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  });

  it('creates five distinct temp directories on disk', () => {
    const run = createRunTempDirs();
    createdPaths.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    expect(statSync(dirname(run.dbPath)).isDirectory()).toBe(true);
    expect(statSync(run.libraryPath).isDirectory()).toBe(true);
    expect(statSync(run.configPath).isDirectory()).toBe(true);
    expect(statSync(run.downloadsPath).isDirectory()).toBe(true);
    expect(statSync(run.sourcePath).isDirectory()).toBe(true);

    // All five must be distinct — sharing a path would collapse the
    // hermetic scopes the harness promises.
    const paths = new Set([dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath]);
    expect(paths.size).toBe(5);
  });

  it('returns a dbPath that sits inside a dedicated enclosing directory', () => {
    // The DB path is not the temp dir itself — it's a file named
    // `narratorr.db` inside a temp dir. This lets teardown remove the
    // directory and sweep up libSQL's -wal / -shm sidecars in one shot.
    const run = createRunTempDirs();
    createdPaths.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    expect(run.dbPath.endsWith('narratorr.db')).toBe(true);
    expect(statSync(dirname(run.dbPath)).isDirectory()).toBe(true);
    // The DB file itself doesn't exist yet — the server creates it on boot.
    expect(existsSync(run.dbPath)).toBe(false);
  });

  it('stores the run in module state for globalTeardown to consume', () => {
    expect(getCurrentRun()).toBeUndefined();

    const run = createRunTempDirs();
    createdPaths.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    expect(getCurrentRun()).toEqual(run);
  });

  it('provisions downloadsPath as a fourth distinct temp directory', () => {
    // The fake qBit server writes completed torrent payloads here. Must exist
    // on disk before globalSetup starts the fake, so import can read from it.
    const run = createRunTempDirs();
    createdPaths.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    expect(statSync(run.downloadsPath).isDirectory()).toBe(true);
    expect(run.downloadsPath).not.toBe(dirname(run.dbPath));
    expect(run.downloadsPath).not.toBe(run.libraryPath);
    expect(run.downloadsPath).not.toBe(run.configPath);
  });

  it('returns a fresh downloadsPath on each call', () => {
    const first = createRunTempDirs();
    const second = createRunTempDirs();
    createdPaths.push(
      dirname(first.dbPath), first.libraryPath, first.configPath, first.downloadsPath, first.sourcePath,
      dirname(second.dbPath), second.libraryPath, second.configPath, second.downloadsPath, second.sourcePath,
    );

    expect(first.downloadsPath).not.toBe(second.downloadsPath);
  });

  it('returns a fresh set of directories on each call', () => {
    const first = createRunTempDirs();
    const second = createRunTempDirs();
    createdPaths.push(
      dirname(first.dbPath), first.libraryPath, first.configPath, first.downloadsPath, first.sourcePath,
      dirname(second.dbPath), second.libraryPath, second.configPath, second.downloadsPath, second.sourcePath,
    );

    expect(first.dbPath).not.toBe(second.dbPath);
    expect(first.libraryPath).not.toBe(second.libraryPath);
    expect(first.configPath).not.toBe(second.configPath);
  });

  it('provisions sourcePath as a fifth distinct temp directory', () => {
    const run = createRunTempDirs();
    createdPaths.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    expect(statSync(run.sourcePath).isDirectory()).toBe(true);
    expect(run.sourcePath).not.toBe(dirname(run.dbPath));
    expect(run.sourcePath).not.toBe(run.libraryPath);
    expect(run.sourcePath).not.toBe(run.configPath);
    expect(run.sourcePath).not.toBe(run.downloadsPath);
  });

  it('returns a fresh sourcePath on each call', () => {
    const first = createRunTempDirs();
    const second = createRunTempDirs();
    createdPaths.push(
      dirname(first.dbPath), first.libraryPath, first.configPath, first.downloadsPath, first.sourcePath,
      dirname(second.dbPath), second.libraryPath, second.configPath, second.downloadsPath, second.sourcePath,
    );

    expect(first.sourcePath).not.toBe(second.sourcePath);
  });

  it('stores a named run without clobbering the root run', () => {
    // The subpath server (#1556) allocates a second named run. Allocating it
    // must NOT overwrite the root run's handoff — getCurrentRun() still resolves
    // to the root run, while getRun(name) reaches the isolated subpath set.
    const root = createRunTempDirs();
    const subpath = createRunTempDirs('subpath');
    createdPaths.push(
      dirname(root.dbPath), root.libraryPath, root.configPath, root.downloadsPath, root.sourcePath,
      dirname(subpath.dbPath), subpath.libraryPath, subpath.configPath, subpath.downloadsPath, subpath.sourcePath,
    );

    expect(getCurrentRun()).toEqual(root);
    expect(getRun(ROOT_RUN)).toEqual(root);
    expect(getRun('subpath')).toEqual(subpath);
    // The two runs are fully isolated — no shared DB/library/config/etc.
    expect(subpath.dbPath).not.toBe(root.dbPath);
    expect(subpath.libraryPath).not.toBe(root.libraryPath);
    expect(subpath.configPath).not.toBe(root.configPath);
  });

  it('getAllRuns returns every recorded run for teardown', () => {
    const root = createRunTempDirs();
    const subpath = createRunTempDirs('subpath');
    createdPaths.push(
      dirname(root.dbPath), root.libraryPath, root.configPath, root.downloadsPath, root.sourcePath,
      dirname(subpath.dbPath), subpath.libraryPath, subpath.configPath, subpath.downloadsPath, subpath.sourcePath,
    );

    const all = getAllRuns();
    expect(all).toHaveLength(2);
    expect(all).toContainEqual(root);
    expect(all).toContainEqual(subpath);
  });

  it('getRun returns undefined for an unknown run name', () => {
    expect(getRun('nope')).toBeUndefined();
  });
});
