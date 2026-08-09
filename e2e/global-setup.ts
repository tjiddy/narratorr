import { resolve, dirname, join } from 'node:path';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCurrentRun, getRun } from './fixtures/temp-dirs.js';
import { SUBPATH_RUN } from './fixtures/subpath.js';
import { FORMS_RUN } from './fixtures/auth.js';
import { registerFake } from './fixtures/run-state.js';
import { createMAMFake } from './fakes/mam.js';
import { createQBitFake } from './fakes/qbit.js';
import { createAudibleFake } from './fakes/audible.js';
import { seedE2ERun, SEED_SEARCH_QUERY } from './fixtures/seed.js';

/** Runs before web-server boot: starts/registers fakes, stages fixtures, and seeds each run's DB. */

const DEFAULT_MAM_PORT = 4100;
const DEFAULT_QBIT_PORT = 4200;
const DEFAULT_AUDIBLE_PORT = 4300;

export const SEED_MANUAL_IMPORT_AUTHOR = 'E2E Manual Author';
export const SEED_MANUAL_IMPORT_TITLE = 'E2E Manual Import Book';
const MANUAL_IMPORT_FOLDER = `${SEED_MANUAL_IMPORT_AUTHOR} - ${SEED_MANUAL_IMPORT_TITLE}`;

// Env overrides give parallel unit tests unique ports; the harness uses fixed defaults referenced by its seed.
function resolvePort(envVar: string, defaultValue: number): number {
  const raw = process.env[envVar];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export default async function globalSetup(): Promise<void> {
  const run = getCurrentRun();
  if (!run) {
    throw new Error(
      'globalSetup: temp-dir state not initialized. ' +
      'playwright.config.ts must call createRunTempDirs() at module load before registering globalSetup.',
    );
  }

  const mamPort = resolvePort('E2E_MAM_PORT', DEFAULT_MAM_PORT);
  const qbitPort = resolvePort('E2E_QBIT_PORT', DEFAULT_QBIT_PORT);
  const audiblePort = resolvePort('E2E_AUDIBLE_PORT', DEFAULT_AUDIBLE_PORT);

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

  await seedE2ERun({
    dbPath: run.dbPath,
    mamUrl: mam.url,
    qbitHost: 'localhost',
    qbitPort: qbitPort,
    libraryPath: run.libraryPath,
  });

  // Seed the isolated subpath DB; its read-only smoke can share fake services.
  const subpathRun = getRun(SUBPATH_RUN);
  if (subpathRun) {
    await seedE2ERun({
      dbPath: subpathRun.dbPath,
      mamUrl: mam.url,
      qbitHost: 'localhost',
      qbitPort: qbitPort,
      libraryPath: subpathRun.libraryPath,
    });
  }

  // Forms boots in `none`; auth setup creates the user and flips the seeded DB to `forms`.
  const formsRun = getRun(FORMS_RUN);
  if (formsRun) {
    await seedE2ERun({
      dbPath: formsRun.dbPath,
      mamUrl: mam.url,
      qbitHost: 'localhost',
      qbitPort: qbitPort,
      libraryPath: formsRun.libraryPath,
    });
  }

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

export const E2E_DEFAULT_PORTS = {
  mam: DEFAULT_MAM_PORT,
  qbit: DEFAULT_QBIT_PORT,
  audible: DEFAULT_AUDIBLE_PORT,
} as const;

/** Workers use the fixed-port fallback because global-setup env mutations do not propagate. */
export function qbitControlUrl(path: string): string {
  const base = process.env.E2E_QBIT_URL ?? `http://localhost:${DEFAULT_QBIT_PORT}`;
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
