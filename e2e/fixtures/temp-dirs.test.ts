import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRunTempDirs, getCurrentRun, _resetCurrentRunForTests } from './temp-dirs.js';

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

  it('creates three distinct temp directories on disk', () => {
    const run = createRunTempDirs();
    createdPaths.push(dirname(run.dbPath), run.libraryPath, run.configPath);

    expect(statSync(dirname(run.dbPath)).isDirectory()).toBe(true);
    expect(statSync(run.libraryPath).isDirectory()).toBe(true);
    expect(statSync(run.configPath).isDirectory()).toBe(true);

    // All three must be distinct — sharing a path would collapse the
    // hermetic scopes the harness promises.
    const paths = new Set([dirname(run.dbPath), run.libraryPath, run.configPath]);
    expect(paths.size).toBe(3);
  });

  it('returns a dbPath that sits inside a dedicated enclosing directory', () => {
    // The DB path is not the temp dir itself — it's a file named
    // `narratorr.db` inside a temp dir. This lets teardown remove the
    // directory and sweep up libSQL's -wal / -shm sidecars in one shot.
    const run = createRunTempDirs();
    createdPaths.push(dirname(run.dbPath), run.libraryPath, run.configPath);

    expect(run.dbPath.endsWith('narratorr.db')).toBe(true);
    expect(statSync(dirname(run.dbPath)).isDirectory()).toBe(true);
    // The DB file itself doesn't exist yet — the server creates it on boot.
    expect(existsSync(run.dbPath)).toBe(false);
  });

  it('stores the run in module state for globalTeardown to consume', () => {
    expect(getCurrentRun()).toBeUndefined();

    const run = createRunTempDirs();
    createdPaths.push(dirname(run.dbPath), run.libraryPath, run.configPath);

    expect(getCurrentRun()).toEqual(run);
  });

  it('returns a fresh set of directories on each call', () => {
    const first = createRunTempDirs();
    const second = createRunTempDirs();
    createdPaths.push(
      dirname(first.dbPath), first.libraryPath, first.configPath,
      dirname(second.dbPath), second.libraryPath, second.configPath,
    );

    expect(first.dbPath).not.toBe(second.dbPath);
    expect(first.libraryPath).not.toBe(second.libraryPath);
    expect(first.configPath).not.toBe(second.configPath);
  });
});
