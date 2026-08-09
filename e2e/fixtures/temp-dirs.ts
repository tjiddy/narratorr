import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunTempDirs {
  dbPath: string;
  libraryPath: string;
  configPath: string;
  /** Per-run qBit save path; torrent adds omit `savepath` and use this default. */
  downloadsPath: string;
  /** Manual-import source populated with a discoverable `silent.m4b` fixture. */
  sourcePath: string;
}

export const ROOT_RUN = 'root';

/**
 * Config loading and teardown share a process, so an in-memory map suffices. Named runs
 * isolate server topologies, and process-local state avoids collisions between E2E commands.
 */
const runs = new Map<string, RunTempDirs>();

/** Allocates five isolated temp roots and records them for teardown. */
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

export function getCurrentRun(): RunTempDirs | undefined {
  return runs.get(ROOT_RUN);
}

export function getRun(name: string): RunTempDirs | undefined {
  return runs.get(name);
}

export function getAllRuns(): RunTempDirs[] {
  return [...runs.values()];
}

export function _resetCurrentRunForTests(): void {
  runs.clear();
}
