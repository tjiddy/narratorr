import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAllRuns } from './fixtures/temp-dirs.js';
import { getRegisteredFakes, clearRegisteredFakes } from './fixtures/run-state.js';
import { cleanupRunPathsFile } from './global-setup.js';

/** Best-effort closes registered fakes, then removes every recorded run's DB directory and temp roots. */
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
