import { resolve, dirname, join } from 'node:path';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCurrentRun } from './fixtures/temp-dirs.js';
import { registerFake } from './fixtures/run-state.js';
import { createMAMFake } from './fakes/mam.js';
import { createQBitFake } from './fakes/qbit.js';
import { createAudibleFake } from './fakes/audible.js';
import { SEED_SEARCH_QUERY } from './fixtures/seed.js';
import { E2E_DEFAULT_PORTS, resolvePort } from './fixtures/ports.js';

/**
 * Starts/registers the fakes, stages the manual-import fixture tree, and publishes the worker
 * handoff. Seeding lives in the `seed-and-serve` wrapper instead: Playwright starts `webServer`
 * entries BEFORE globalSetup, so anything seeded here lands after the servers have already booted
 * against an empty DB (#2452).
 */

export const SEED_MANUAL_IMPORT_AUTHOR = 'E2E Manual Author';
export const SEED_MANUAL_IMPORT_TITLE = 'E2E Manual Import Book';
const MANUAL_IMPORT_FOLDER = `${SEED_MANUAL_IMPORT_AUTHOR} - ${SEED_MANUAL_IMPORT_TITLE}`;

// Re-exported so the seed wrapper and this file cannot disagree about which port a fake binds.
export { E2E_DEFAULT_PORTS, resolvePort };

export default async function globalSetup(): Promise<void> {
  const run = getCurrentRun();
  if (!run) {
    throw new Error(
      'globalSetup: temp-dir state not initialized. ' +
      'playwright.config.ts must call resolveRunTempDirs() at module load before registering globalSetup.',
    );
  }

  const mamPort = resolvePort('E2E_MAM_PORT', E2E_DEFAULT_PORTS.mam);
  const qbitPort = resolvePort('E2E_QBIT_PORT', E2E_DEFAULT_PORTS.qbit);
  const audiblePort = resolvePort('E2E_AUDIBLE_PORT', E2E_DEFAULT_PORTS.audible);

  // Module-relative resolution works for both tsx and compiled invocations.
  const fixturePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'assets',
    'silent.m4b',
  );

  const mam = await createMAMFake({
    port: mamPort,
    expectedCookie: 'test-mam-id',
    torrentFileName: 'e2e-test-book',
    torrentFileLength: 4297,
  });
  registerFake({ name: 'mam', close: mam.close });

  const qbit = await createQBitFake({
    port: qbitPort,
    downloadsPath: run.downloadsPath,
    fixturePath,
    // Keep the mutation pending long enough for React to render the disabled button.
    addLatencyMs: 150,
  });
  registerFake({ name: 'qbit', close: qbit.close });

  const audible = await createAudibleFake({ port: audiblePort });
  registerFake({ name: 'audible', close: audible.close });

  const bookFolder = join(run.sourcePath, MANUAL_IMPORT_FOLDER);
  mkdirSync(bookFolder, { recursive: true });
  copyFileSync(fixturePath, join(bookFolder, 'silent.m4b'));

  mam.seedResults(SEED_SEARCH_QUERY, [
    {
      id: 42,
      title: 'E2E Test Book [Unabridged]',
      author: 'E2E Test Author',
      narrator: 'E2E Test Narrator',
      // Use ISO `en`; numeric `1` is not normalized and fails default language filtering.
      langCode: 'en',
      size: '200.0 MiB',
      seeders: 15,
      leechers: 0,
      isFreeleech: true,
    },
  ]);

  // Global-setup env mutations are same-process only; workers need config-time env, static defaults, or a state file.
  process.env.E2E_DOWNLOADS_PATH = run.downloadsPath;
  process.env.E2E_LIBRARY_PATH = run.libraryPath;
  process.env.E2E_MAM_URL = mam.url;
  process.env.E2E_QBIT_URL = qbit.url;
  process.env.E2E_AUDIBLE_URL = audible.url;
  process.env.E2E_SOURCE_PATH = run.sourcePath;

  // Config-time `E2E_RUN_STATE_DIR` lets workers find this per-run handoff without cross-run collisions.
  writeFileSync(join(run.configPath, '.run-paths.json'), JSON.stringify({ sourcePath: run.sourcePath }), 'utf-8');
}

/** Workers use the fixed-port fallback because global-setup env mutations do not propagate. */
export function qbitControlUrl(path: string): string {
  const base = process.env.E2E_QBIT_URL ?? `http://localhost:${E2E_DEFAULT_PORTS.qbit}`;
  return `${base}${path}`;
}

const RUN_PATHS_FILENAME = '.run-paths.json';

// Workers use config-time state; same-process callers fall back to the current run.
function resolveRunPathsFile(): string | undefined {
  const dir = process.env.E2E_RUN_STATE_DIR;
  if (dir) return join(dir, RUN_PATHS_FILENAME);
  const run = getCurrentRun();
  if (run) return join(run.configPath, RUN_PATHS_FILENAME);
  return undefined;
}

/** Reads dynamic `sourcePath` from the per-run handoff when called in a worker. */
export function getE2ESourcePath(): string {
  const fromEnv = process.env.E2E_SOURCE_PATH;
  if (fromEnv) return fromEnv;
  const filePath = resolveRunPathsFile();
  if (filePath && existsSync(filePath)) {
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as { sourcePath: string };
    return data.sourcePath;
  }
  throw new Error(
    'sourcePath unavailable — E2E_SOURCE_PATH not set and .run-paths.json not found ' +
    `(looked in E2E_RUN_STATE_DIR=${process.env.E2E_RUN_STATE_DIR ?? '<unset>'})`,
  );
}

export function cleanupRunPathsFile(): void {
  const filePath = resolveRunPathsFile();
  if (!filePath) return;
  try {
    unlinkSync(filePath);
  } catch {
    // Setup may have failed before writing it; temp-dir cleanup is the backstop.
  }
}
