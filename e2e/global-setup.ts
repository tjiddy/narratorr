import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentRun } from './fixtures/temp-dirs.js';
import { registerFake } from './fixtures/run-state.js';
import { createMAMFake } from './fakes/mam.js';
import { createQBitFake } from './fakes/qbit.js';
import { seedE2ERun, SEED_SEARCH_QUERY } from './fixtures/seed.js';

/**
 * Playwright global setup — runs after playwright.config.ts has loaded (and
 * `createRunTempDirs()` has populated temp-dirs module state) but BEFORE the
 * webServer command starts.
 *
 * Responsibilities:
 *   1. Start the fake MAM + qBit servers on fixed ports (4100 / 4200)
 *   2. Pre-seed the MAM fake with the fixture the critical-path spec searches for
 *   3. Run Drizzle migrations and insert indexer/download-client/author/book rows
 *      into the per-run DB so Narratorr finds them at boot
 *   4. Register fake-server handles in run-state module state so globalTeardown
 *      can `await handle.close()` on each
 */

const DEFAULT_MAM_PORT = 4100;
const DEFAULT_QBIT_PORT = 4200;

/**
 * Resolve the port a fake server should listen on. Reads `env` first (for tests
 * that need unique ports under vitest parallelism), falls back to the fixed
 * default used by the real harness (which seed rows reference statically).
 */
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

  // Resolve the silent m4b fixture relative to this file so it works in both
  // dev (tsx) and compiled (tsc) invocations.
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
  });
  registerFake({ name: 'qbit', close: qbit.close });

  // Seed one default fixture matching the book title so the release-search
  // modal finds results without further spec-side setup.
  mam.seedResults(SEED_SEARCH_QUERY, [
    {
      id: 42,
      title: 'E2E Test Book [Unabridged]',
      author: 'E2E Test Author',
      narrator: 'E2E Test Narrator',
      // Must normalize to 'english' to pass the default metadata.languages filter.
      // `normalizeLanguage('en')` → 'english' via ISO_639_TO_NAME; bare numeric
      // codes like '1' fall through unnormalized and get filtered out.
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
  });

  // Also stash paths into the process env so specs can read them if they need
  // to (e.g. to assert on an imported file landing in libraryPath).
  process.env.E2E_DOWNLOADS_PATH = run.downloadsPath;
  process.env.E2E_LIBRARY_PATH = run.libraryPath;
  process.env.E2E_MAM_URL = mam.url;
  process.env.E2E_QBIT_URL = qbit.url;
}

/** Exported constants for spec files that need to construct control URLs. */
export const E2E_DEFAULT_PORTS = {
  mam: DEFAULT_MAM_PORT,
  qbit: DEFAULT_QBIT_PORT,
} as const;

/**
 * Helper for spec files — hits POST /__control/complete on the qBit fake.
 * Reads the qBit URL from the env var populated by globalSetup so the spec
 * doesn't hardcode the port twice.
 */
export function qbitControlUrl(path: string): string {
  const base = process.env.E2E_QBIT_URL ?? `http://localhost:${DEFAULT_QBIT_PORT}`;
  return `${base}${path}`;
}
