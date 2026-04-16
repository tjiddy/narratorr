import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const STATE_FILE_NAME = '.run-state.json';

export interface RunTempDirs {
  dbPath: string;
  libraryPath: string;
  configPath: string;
}

export interface RunState extends RunTempDirs {
  pid: number;
  createdAt: string;
}

/**
 * Creates three per-run temp directories (DB file, library root, config root)
 * and writes their paths to e2e/.run-state.json so globalTeardown can clean them up.
 *
 * Called at Playwright config load time — the paths returned populate webServer.env.
 */
export function createRunTempDirs(): RunTempDirs {
  const prefix = join(tmpdir(), 'narratorr-e2e-');
  const dbDir = mkdtempSync(prefix);
  const libraryPath = mkdtempSync(prefix);
  const configPath = mkdtempSync(prefix);

  const dbPath = join(dbDir, 'narratorr.db');

  const state: RunState = {
    dbPath,
    libraryPath,
    configPath,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };

  writeFileSync(runStateFilePath(), JSON.stringify(state, null, 2));

  return { dbPath, libraryPath, configPath };
}

export function runStateFilePath(): string {
  // Resolve relative to this file so it works regardless of cwd.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', STATE_FILE_NAME);
}
