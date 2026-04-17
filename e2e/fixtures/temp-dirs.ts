import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunTempDirs {
  dbPath: string;
  libraryPath: string;
  configPath: string;
  /**
   * Per-run save path used by the fake qBit server. The fake is constructed with this
   * path at globalSetup time and uses it as its default `save_path` for every
   * `POST /api/v2/torrents/add` that omits one — which is all of them, today, because
   * `DownloadService.sendToClient` only forwards `category`.
   */
  downloadsPath: string;
  /**
   * Per-run source directory for manual-import E2E tests. globalSetup populates
   * it with an `<author> - <title>` subfolder containing a copy of `silent.m4b`
   * so the scan endpoint discovers audiobook files during the critical-path spec.
   */
  sourcePath: string;
}

/**
 * Module-level state for the current Playwright run. Populated by
 * createRunTempDirs() at config-load time; consumed by globalTeardown()
 * at run-end. Both execute in the same Node process (Playwright invokes
 * globalTeardown from the main process that loaded the config), so module
 * state is sufficient — no state file needed.
 *
 * Keeping state in-memory also avoids the concurrent-run footgun a shared
 * state file creates: two `pnpm test:e2e` processes in the same workspace
 * now have fully isolated run state.
 */
let currentRun: RunTempDirs | undefined;

/**
 * Creates three per-run temp directories (DB file, library root, config root)
 * and stores their paths in module-level state for globalTeardown to consume.
 */
export function createRunTempDirs(): RunTempDirs {
  const prefix = join(tmpdir(), 'narratorr-e2e-');
  const dbDir = mkdtempSync(prefix);
  const libraryPath = mkdtempSync(prefix);
  const configPath = mkdtempSync(prefix);
  const downloadsPath = mkdtempSync(prefix);
  const sourcePath = mkdtempSync(prefix);

  const dbPath = join(dbDir, 'narratorr.db');
  const run: RunTempDirs = { dbPath, libraryPath, configPath, downloadsPath, sourcePath };

  currentRun = run;
  return run;
}

/** Returns the temp-dir state created by this process's run, or undefined. */
export function getCurrentRun(): RunTempDirs | undefined {
  return currentRun;
}

/** Resets module-level state — for tests only. */
export function _resetCurrentRunForTests(): void {
  currentRun = undefined;
}
