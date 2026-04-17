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

  it('creates four distinct temp directories on disk', () => {
    const run = createRunTempDirs();
    createdPaths.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath);

    expect(statSync(dirname(run.dbPath)).isDirectory()).toBe(true);
    expect(statSync(run.libraryPath).isDirectory()).toBe(true);
    expect(statSync(run.configPath).isDirectory()).toBe(true);
    expect(statSync(run.downloadsPath).isDirectory()).toBe(true);

    // All four must be distinct — sharing a path would collapse the
    // hermetic scopes the harness promises.
    const paths = new Set([dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath]);
    expect(paths.size).toBe(4);
  });

  it('returns a dbPath that sits inside a dedicated enclosing directory', () => {
    // The DB path is not the temp dir itself — it's a file named
    // `narratorr.db` inside a temp dir. This lets teardown remove the
    // directory and sweep up libSQL's -wal / -shm sidecars in one shot.
    const run = createRunTempDirs();
    createdPaths.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath);

    expect(run.dbPath.endsWith('narratorr.db')).toBe(true);
    expect(statSync(dirname(run.dbPath)).isDirectory()).toBe(true);
    // The DB file itself doesn't exist yet — the server creates it on boot.
    expect(existsSync(run.dbPath)).toBe(false);
  });

  it('stores the run in module state for globalTeardown to consume', () => {
    expect(getCurrentRun()).toBeUndefined();

    const run = createRunTempDirs();
    createdPaths.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath);

    expect(getCurrentRun()).toEqual(run);
  });

  it('provisions downloadsPath as a fourth distinct temp directory', () => {
    // The fake qBit server writes completed torrent payloads here. Must exist
    // on disk before globalSetup starts the fake, so import can read from it.
    const run = createRunTempDirs();
    createdPaths.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath);

    expect(statSync(run.downloadsPath).isDirectory()).toBe(true);
    expect(run.downloadsPath).not.toBe(dirname(run.dbPath));
    expect(run.downloadsPath).not.toBe(run.libraryPath);
    expect(run.downloadsPath).not.toBe(run.configPath);
  });

  it('returns a fresh downloadsPath on each call', () => {
    const first = createRunTempDirs();
    const second = createRunTempDirs();
    createdPaths.push(
      dirname(first.dbPath), first.libraryPath, first.configPath, first.downloadsPath,
      dirname(second.dbPath), second.libraryPath, second.configPath, second.downloadsPath,
    );

    expect(first.downloadsPath).not.toBe(second.downloadsPath);
  });

  it('returns a fresh set of directories on each call', () => {
    const first = createRunTempDirs();
    const second = createRunTempDirs();
    createdPaths.push(
      dirname(first.dbPath), first.libraryPath, first.configPath, first.downloadsPath,
      dirname(second.dbPath), second.libraryPath, second.configPath, second.downloadsPath,
    );

    expect(first.dbPath).not.toBe(second.dbPath);
    expect(first.libraryPath).not.toBe(second.libraryPath);
    expect(first.configPath).not.toBe(second.configPath);
  });

  it.todo('provisions sourcePath as a fifth distinct temp directory');
  it.todo('returns a fresh sourcePath on each call');
});
