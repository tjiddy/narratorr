import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCurrentRun } from './fixtures/temp-dirs.js';

/**
 * Playwright global teardown — removes per-run temp directories recorded
 * in module state by fixtures/temp-dirs.ts. Removes the enclosing DB
 * directory (which contains the libSQL file plus -wal / -shm sidecars)
 * plus the library and config directories.
 *
 * Best-effort: swallows filesystem errors so a partial-success run still
 * cleans what it can.
 */
export default async function globalTeardown(): Promise<void> {
  const state = getCurrentRun();
  if (!state) {
    // createRunTempDirs never ran in this process — nothing to clean.
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
}
