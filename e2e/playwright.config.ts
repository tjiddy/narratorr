import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRunTempDirs } from './fixtures/temp-dirs.js';
import { serverEnv } from './fixtures/server-env.js';
import {
  ROOT_PORT,
  SUBPATH_PORT,
  SUBPATH_RUN,
  SUBPATH_BASE_URL,
  URL_BASE_SUBPATH,
} from './fixtures/subpath.js';
import {
  FORMS_PORT,
  FORMS_RUN,
  FORMS_BASE_URL,
  AUTH_FILE,
} from './fixtures/auth.js';

/**
 * Phase 1 E2E harness — see issue #612.
 *
 * Boots the built production bundle (`node ../dist/server/index.js`) with five
 * per-run temp directories (DB, library, config, downloads, source) and
 * AUTH_BYPASS=true so the smoke test doesn't need a login flow.
 *
 * Three servers boot in one run (#1556, #1555):
 *   - the root server at `URL_BASE=/` on port 3100 — the existing topology;
 *   - a subpath server at `URL_BASE=/narratorr` on port 3101 — assembled
 *     reverse-proxy coverage;
 *   - a forms-auth server at `URL_BASE=/` on port 3102 booted WITHOUT
 *     `AUTH_BYPASS` so the real login/session/redirect loop is exercised.
 *   Each owns an isolated temp-dir set + seeded DB so they never share mutable
 *   state.
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
const formsRun = createRunTempDirs(FORMS_RUN);

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

// Spec selection regex for the subpath suite — matches the `tests/subpath/`
// directory with either path separator so it works on Linux/CI and Windows.
const SUBPATH_SPECS = /[\\/]subpath[\\/].*\.spec\.ts$/;

// Spec selection regex for the forms-auth suite — matches `tests/auth/*.spec.ts`
// with either path separator. The root `chromium` project ignores this (its
// AUTH_BYPASS/no-storageState config would make the redirect/status assertions
// fail or vacuously pass); the forms project runs ONLY this.
const AUTH_SPECS = /[\\/]auth[\\/].*\.spec\.ts$/;

// The setup file lives in `tests/auth/` but is NOT a `.spec.ts`, so the top-level
// `testMatch` and AUTH_SPECS both skip it — only the `auth-setup` project, which
// targets this regex explicitly, runs it.
const AUTH_SETUP = /[\\/]auth[\\/]auth\.setup\.ts$/;

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
      // The root project runs every spec EXCEPT the subpath and forms-auth
      // suites — the mutation-heavy critical-path specs run once, against the
      // root server. The forms specs MUST be excluded here: this project boots
      // with AUTH_BYPASS=true and no storageState/setup dependency, so the
      // redirect/status assertions would fail or vacuously pass.
      testIgnore: [SUBPATH_SPECS, AUTH_SPECS],
    },
    {
      name: 'chromium-subpath',
      // Trailing-slash baseURL so relative navigation (`page.goto('library')`)
      // resolves under the `/narratorr` prefix; see fixtures/subpath.ts.
      use: { ...devices['Desktop Chrome'], baseURL: SUBPATH_BASE_URL },
      // This project runs ONLY the subpath suite.
      testMatch: SUBPATH_SPECS,
    },
    {
      // Bootstraps forms auth against the forms server (create user → flip mode
      // to forms → login) and persists the authenticated storageState. The
      // forms project depends on this, so it runs first. See tests/auth/auth.setup.ts.
      name: 'auth-setup',
      use: { ...devices['Desktop Chrome'], baseURL: FORMS_BASE_URL },
      testMatch: AUTH_SETUP,
    },
    {
      name: 'chromium-forms',
      // Reuse the authenticated storageState the setup project saved. The
      // redirect spec overrides to an empty context via `test.use(...)`.
      use: { ...devices['Desktop Chrome'], baseURL: FORMS_BASE_URL, storageState: AUTH_FILE },
      testMatch: AUTH_SPECS,
      dependencies: ['auth-setup'],
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
    {
      command: 'node ../dist/server/index.js',
      // Public health route works before any auth exists — the forms server
      // boots in the default `none` mode (no config row yet) and the setup
      // project flips it to `forms` once it's up.
      url: `http://localhost:${FORMS_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      // authBypass:false — forms enforcement must be genuinely active, or every
      // login/redirect/logout assertion goes vacuous (see fixtures/server-env.ts).
      env: serverEnv(formsRun, '/', FORMS_PORT, { authBypass: false }),
    },
  ],
});
