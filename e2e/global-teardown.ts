import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { runStateFilePath, type RunState } from './fixtures/temp-dirs.js';

/**
 * Playwright global teardown — removes per-run temp directories recorded
 * by fixtures/temp-dirs.ts. Removes the libSQL DB file plus its -wal / -shm
 * sidecars, and the enclosing directory, plus the library and config dirs.
 *
 * Best-effort: swallows ENOENT so a partial-success run still cleans what it can.
 */
export default async function globalTeardown(): Promise<void> {
  let state: RunState;
  try {
    state = JSON.parse(readFileSync(runStateFilePath(), 'utf8')) as RunState;
  } catch {
    // No state file — nothing to clean. Either createRunTempDirs never ran,
    // or a previous teardown already deleted it.
    return;
  }

  const dbDir = dirname(state.dbPath);
  for (const target of [dbDir, state.libraryPath, state.configPath]) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  try {
    rmSync(runStateFilePath(), { force: true });
  } catch {
    // Best-effort.
  }
}
