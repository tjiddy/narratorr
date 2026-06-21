import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAllRuns } from './fixtures/temp-dirs.js';
import { getRegisteredFakes, clearRegisteredFakes } from './fixtures/run-state.js';
import { cleanupRunPathsFile } from './global-setup.js';

/**
 * Playwright global teardown — closes fake servers registered in module state
 * by global-setup, then removes per-run temp directories recorded by
 * fixtures/temp-dirs.ts. For EVERY recorded run (root and any subpath server),
 * removes the enclosing DB directory (containing the libSQL file plus
 * -wal / -shm sidecars) plus the library, config, and downloads directories.
 *
 * Best-effort: swallows filesystem errors so a partial-success run still
 * cleans what it can. Fake-server close() failures are also swallowed — a
 * dangling listener is cheaper than failing the whole run.
 */
export default async function globalTeardown(): Promise<void> {
  for (const fake of getRegisteredFakes()) {
    try {
      await fake.close();
    } catch {
      // Best-effort — a dangling listener is better than a failed teardown.
    }
  }
  clearRegisteredFakes();
  cleanupRunPathsFile();

  // Clean every recorded run (root + any subpath server). When no run was
  // created (e.g. a misconfigured project) getAllRuns() is empty — a no-op.
  for (const state of getAllRuns()) {
    const dbDir = dirname(state.dbPath);
    for (const target of [dbDir, state.libraryPath, state.configPath, state.downloadsPath, state.sourcePath]) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}
