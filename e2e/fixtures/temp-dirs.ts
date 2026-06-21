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
 * Named key for the default (root) Playwright run — the existing `URL_BASE=/`
 * topology. `getCurrentRun()` resolves to this run, and the manual-import
 * `E2E_RUN_STATE_DIR` handoff stays pointed at its config path.
 */
export const ROOT_RUN = 'root';

/**
 * Module-level state for the Playwright run(s). Populated by createRunTempDirs()
 * at config-load time; consumed by globalTeardown() at run-end. Both execute in
 * the same Node process (Playwright invokes globalTeardown from the main process
 * that loaded the config), so module state is sufficient — no state file needed.
 *
 * Keyed by run name so multiple isolated servers (e.g. the root `URL_BASE=/`
 * server and a `URL_BASE=/narratorr` subpath server) can each own a distinct
 * temp-dir set without clobbering one another. Allocating a second named run
 * does not overwrite the root run, and teardown removes every recorded set.
 *
 * Keeping state in-memory also avoids the concurrent-run footgun a shared
 * state file creates: two `pnpm test:e2e` processes in the same workspace
 * now have fully isolated run state.
 */
const runs = new Map<string, RunTempDirs>();

/**
 * Creates five per-run temp directories (DB file, library root, config root,
 * downloads, source) and stores their paths in module-level state under the
 * given run name for globalTeardown to consume. Defaults to the root run; pass
 * a distinct name (e.g. `'subpath'`) to allocate an isolated set alongside it.
 */
export function createRunTempDirs(name: string = ROOT_RUN): RunTempDirs {
  const prefix = join(tmpdir(), 'narratorr-e2e-');
  const dbDir = mkdtempSync(prefix);
  const libraryPath = mkdtempSync(prefix);
  const configPath = mkdtempSync(prefix);
  const downloadsPath = mkdtempSync(prefix);
  const sourcePath = mkdtempSync(prefix);

  const dbPath = join(dbDir, 'narratorr.db');
  const run: RunTempDirs = { dbPath, libraryPath, configPath, downloadsPath, sourcePath };

  runs.set(name, run);
  return run;
}

/** Returns the root run's temp-dir state, or undefined if it was never created. */
export function getCurrentRun(): RunTempDirs | undefined {
  return runs.get(ROOT_RUN);
}

/** Returns the temp-dir state for a named run, or undefined. */
export function getRun(name: string): RunTempDirs | undefined {
  return runs.get(name);
}

/** Returns every recorded run's temp-dir state (for globalTeardown to clean). */
export function getAllRuns(): RunTempDirs[] {
  return [...runs.values()];
}

/** Resets module-level state — for tests only. */
export function _resetCurrentRunForTests(): void {
  runs.clear();
}
