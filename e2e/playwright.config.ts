import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRunTempDirs, type RunTempDirs } from './fixtures/temp-dirs.js';
import {
  ROOT_PORT,
  SUBPATH_PORT,
  SUBPATH_RUN,
  SUBPATH_BASE_URL,
  URL_BASE_SUBPATH,
} from './fixtures/subpath.js';

/**
 * Phase 1 E2E harness — see issue #612.
 *
 * Boots the built production bundle (`node ../dist/server/index.js`) with five
 * per-run temp directories (DB, library, config, downloads, source) and
 * AUTH_BYPASS=true so the smoke test doesn't need a login flow.
 *
 * Two servers boot in one run (#1556):
 *   - the root server at `URL_BASE=/` on port 3100 — the existing topology;
 *   - a subpath server at `URL_BASE=/narratorr` on port 3101 — assembled
 *     reverse-proxy coverage. Each owns an isolated temp-dir set + seeded DB so
 *     they never share mutable state.
 *
 * Caller MUST have run `pnpm build` before `pnpm test:e2e`. The webServer
 * command will fail with a clear error if `dist/server/index.js` is missing.
 */

// Compute temp dirs once at config load — one isolated set per server. The
// paths flow into each webServer's env and are recorded in temp-dirs module
// state so global teardown can remove BOTH sets after the run. The subpath run
// is allocated under a distinct name so it does not clobber the root run.
const rootRun = createRunTempDirs();
const subpathRun = createRunTempDirs(SUBPATH_RUN);

// Expose the ROOT run's configPath as an env var at config-load time so test
// workers inherit it (workers fork from this process AFTER config loads).
// Unlike webServer.env (server-only) or globalSetup mutations (too late),
// config-load-time env vars DO propagate to Playwright worker processes.
// Used by getE2ESourcePath() to locate the per-run .run-paths.json file —
// this MUST stay pointed at the root run, where the manual-import fixture lives.
process.env.E2E_RUN_STATE_DIR = rootRun.configPath;

// Resolve output paths relative to this config file, not the caller's cwd —
// otherwise Playwright dumps test-results/ at wherever pnpm was invoked from.
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Build the production-bundle env for one server. The two servers differ only
 * in their isolated temp-dir set, port, and URL_BASE; everything else (fakes,
 * monitor cadence, auth bypass) is shared.
 */
function serverEnv(run: RunTempDirs, urlBase: string, port: number): Record<string, string> {
  return {
    NODE_ENV: 'production',
    PORT: String(port),
    DATABASE_URL: run.dbPath,
    CONFIG_PATH: run.configPath,
    AUTH_BYPASS: 'true',
    URL_BASE: urlBase,
    // Poll every 2 seconds instead of the default 30 so the spec doesn't wait a
    // full minute for the monitor to notice the fake qBit's "complete" flip.
    MONITOR_INTERVAL_CRON: '*/2 * * * * *',
    // Surface the per-run downloads path for spec-side forensics/assertions.
    // Not consumed by app code — the fake qBit already knows the path from
    // its constructor in global-setup.ts.
    E2E_DOWNLOADS_PATH: run.downloadsPath,
    // Override the Audible API base URL so AudibleProvider sends requests to
    // the E2E fake instead of the real Audible API. The fake returns empty
    // products, making the match job resolve to confidence 'none'.
    AUDIBLE_BASE_URL: 'http://localhost:4300',
    // Surface the per-run source path for the manual-import spec. The spec
    // enters this path in the scan input so Narratorr discovers the seeded
    // audiobook folder.
    E2E_SOURCE_PATH: run.sourcePath,
  };
}

// Spec selection regex for the subpath suite — matches the `tests/subpath/`
// directory with either path separator so it works on Linux/CI and Windows.
const SUBPATH_SPECS = /[\\/]subpath[\\/].*\.spec\.ts$/;

export default defineConfig({
  testDir: 'tests',
  // Harness-helper *.test.ts files (e2e/fakes/, e2e/fixtures/) run under vitest
  // and import '@vitest/expect'. Playwright's default testMatch includes
  // '*.test.ts', and its TS transform collides on the jest-matchers-object
  // Symbol if it ever loads one. Restrict to '.spec.ts' so only actual
  // Playwright specs under tests/ are picked up.
  testMatch: /.*\.spec\.ts/,
  outputDir: join(CONFIG_DIR, 'test-results'),
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI
    ? [['html', { outputFolder: join(CONFIG_DIR, 'playwright-report'), open: 'never' }]]
    : 'list',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',

  use: {
    baseURL: `http://localhost:${ROOT_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // The root project runs every spec EXCEPT the subpath suite — the
      // mutation-heavy critical-path specs run once, against the root server.
      testIgnore: SUBPATH_SPECS,
    },
    {
      name: 'chromium-subpath',
      // Trailing-slash baseURL so relative navigation (`page.goto('library')`)
      // resolves under the `/narratorr` prefix; see fixtures/subpath.ts.
      use: { ...devices['Desktop Chrome'], baseURL: SUBPATH_BASE_URL },
      // This project runs ONLY the subpath suite.
      testMatch: SUBPATH_SPECS,
    },
  ],

  webServer: [
    {
      command: 'node ../dist/server/index.js',
      url: `http://localhost:${ROOT_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: serverEnv(rootRun, '/', ROOT_PORT),
    },
    {
      command: 'node ../dist/server/index.js',
      // API routes mount under the prefix, so health lives at the prefixed path
      // (`/api/health` 404s on this server).
      url: `http://localhost:${SUBPATH_PORT}${URL_BASE_SUBPATH}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: serverEnv(subpathRun, URL_BASE_SUBPATH, SUBPATH_PORT),
    },
  ],
});
