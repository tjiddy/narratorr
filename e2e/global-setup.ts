import { resolve, dirname, join } from 'node:path';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCurrentRun } from './fixtures/temp-dirs.js';
import { registerFake } from './fixtures/run-state.js';
import { createMAMFake } from './fakes/mam.js';
import { createQBitFake } from './fakes/qbit.js';
import { createAudibleFake } from './fakes/audible.js';
import { seedE2ERun, SEED_SEARCH_QUERY } from './fixtures/seed.js';

/**
 * Playwright global setup — runs after playwright.config.ts has loaded (and
 * `createRunTempDirs()` has populated temp-dirs module state) but BEFORE the
 * webServer command starts.
 *
 * Responsibilities:
 *   1. Start the fake MAM + qBit + Audible servers on fixed ports (4100 / 4200 / 4300)
 *   2. Pre-seed the MAM fake with the fixture the critical-path spec searches for
 *   3. Pre-populate sourcePath with an author-title subfolder for manual-import
 *   4. Run Drizzle migrations and insert indexer/download-client/author/book rows
 *      into the per-run DB so Narratorr finds them at boot
 *   5. Register fake-server handles in run-state module state so globalTeardown
 *      can `await handle.close()` on each
 */

const DEFAULT_MAM_PORT = 4100;
const DEFAULT_QBIT_PORT = 4200;
const DEFAULT_AUDIBLE_PORT = 4300;

/** Manual-import fixture constants — folder name parsed by scanDirectory. */
export const SEED_MANUAL_IMPORT_AUTHOR = 'E2E Manual Author';
export const SEED_MANUAL_IMPORT_TITLE = 'E2E Manual Import Book';
const MANUAL_IMPORT_FOLDER = `${SEED_MANUAL_IMPORT_AUTHOR} - ${SEED_MANUAL_IMPORT_TITLE}`;

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
  const audiblePort = resolvePort('E2E_AUDIBLE_PORT', DEFAULT_AUDIBLE_PORT);

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
    // Inject a small latency on torrent add so Playwright can observe the grab
    // button's pending state before the mutation resolves. Without this the
    // hermetic fake completes faster than React can re-render the disabled
    // attribute, making `toBeDisabled()` flake.
    addLatencyMs: 150,
  });
  registerFake({ name: 'qbit', close: qbit.close });

  const audible = await createAudibleFake({ port: audiblePort });
  registerFake({ name: 'audible', close: audible.close });

  // Pre-populate sourcePath with the manual-import fixture folder so the
  // scan endpoint discovers an audiobook during the manual-import spec.
  const bookFolder = join(run.sourcePath, MANUAL_IMPORT_FOLDER);
  mkdirSync(bookFolder, { recursive: true });
  copyFileSync(fixturePath, join(bookFolder, 'silent.m4b'));

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
    libraryPath: run.libraryPath,
  });

  // Stash paths into the setup-process env so same-process tooling (this
  // function's callers, globalTeardown, helper functions invoked from the
  // config module) can read them.
  //
  // IMPORTANT: Playwright runs `globalSetup` in the config process, NOT in the
  // test worker processes. `process.env` mutations made here DO NOT reach tests
  // at runtime. If a spec needs one of these values, import a helper from this
  // module (e.g. `qbitControlUrl`) that falls back to a known static default,
  // or wire the value statically through `playwright.config.ts`'s
  // `webServer.env` / `use.env`. Reading `process.env.E2E_*` directly from a
  // spec will get `undefined`.
  process.env.E2E_DOWNLOADS_PATH = run.downloadsPath;
  process.env.E2E_LIBRARY_PATH = run.libraryPath;
  process.env.E2E_MAM_URL = mam.url;
  process.env.E2E_QBIT_URL = qbit.url;
  process.env.E2E_AUDIBLE_URL = audible.url;
  process.env.E2E_SOURCE_PATH = run.sourcePath;

  // Write sourcePath to a per-run state file inside configPath. Workers read
  // this via getE2ESourcePath(). The file lives inside the per-run temp dir
  // (not a repo-global path) so concurrent E2E runs stay isolated — each run
  // discovers its own configPath via E2E_RUN_STATE_DIR, set at config-load
  // time in playwright.config.ts (config-time env vars propagate to workers).
  writeFileSync(join(run.configPath, '.run-paths.json'), JSON.stringify({ sourcePath: run.sourcePath }), 'utf-8');
}

/** Exported constants for spec files that need to construct control URLs. */
export const E2E_DEFAULT_PORTS = {
  mam: DEFAULT_MAM_PORT,
  qbit: DEFAULT_QBIT_PORT,
  audible: DEFAULT_AUDIBLE_PORT,
} as const;

/**
 * Helper for spec files — builds a qBit fake control URL (e.g.
 * `/__control/complete-latest`). Specs MUST import this rather than reading
 * `process.env.E2E_QBIT_URL` directly: Playwright runs `globalSetup` in the
 * config process, so env mutations there do not propagate to test worker
 * processes. The fallback path (`http://localhost:${DEFAULT_QBIT_PORT}`) is
 * what actually runs in specs; the `process.env` branch only matters when
 * same-process tooling calls this helper with a non-default port.
 */
export function qbitControlUrl(path: string): string {
  const base = process.env.E2E_QBIT_URL ?? `http://localhost:${DEFAULT_QBIT_PORT}`;
  return `${base}${path}`;
}

/** State file name — lives inside the per-run configPath directory. */
const RUN_PATHS_FILENAME = '.run-paths.json';

/**
 * Resolves the per-run state file path. Uses E2E_RUN_STATE_DIR (set at
 * config-load time in playwright.config.ts and inherited by workers) or
 * falls back to getCurrentRun().configPath for same-process callers.
 */
function resolveRunPathsFile(): string | undefined {
  const dir = process.env.E2E_RUN_STATE_DIR;
  if (dir) return join(dir, RUN_PATHS_FILENAME);
  const run = getCurrentRun();
  if (run) return join(run.configPath, RUN_PATHS_FILENAME);
  return undefined;
}

/**
 * Helper for spec files — returns the per-run sourcePath for manual-import
 * fixtures. Unlike fixed-port fakes, sourcePath is a dynamic temp dir that
 * changes every run, so this reads from a per-run state file.
 *
 * The file lives inside the per-run configPath directory (not a repo-global
 * path) so concurrent E2E runs stay isolated. Workers discover the directory
 * via E2E_RUN_STATE_DIR, set at config-load time in playwright.config.ts
 * (config-time env vars propagate to workers, unlike globalSetup mutations).
 */
export function getE2ESourcePath(): string {
  // Same-process fast path (globalSetup, same-process tooling).
  const fromEnv = process.env.E2E_SOURCE_PATH;
  if (fromEnv) return fromEnv;
  // Worker path — read from per-run state file.
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

/** Clean up the per-run state file — called from globalTeardown. */
export function cleanupRunPathsFile(): void {
  const filePath = resolveRunPathsFile();
  if (!filePath) return;
  try {
    unlinkSync(filePath);
  } catch {
    // Best-effort — file may not exist if globalSetup failed.
    // Also cleaned up when configPath is removed by teardown.
  }
}
