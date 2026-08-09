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
 * Production-bundle harness with isolated root, subpath, and forms-auth servers.
 * Root/subpath bypass auth; forms exercises real sessions. Run `pnpm build` first.
 */

// Allocate once at config load so webServer env and teardown share each isolated run.
const rootRun = createRunTempDirs();
const subpathRun = createRunTempDirs(SUBPATH_RUN);
const formsRun = createRunTempDirs(FORMS_RUN);

// Config-time env reaches workers; globalSetup env does not. Keep this on the root manual-import run.
process.env.E2E_RUN_STATE_DIR = rootRun.configPath;

// Keep output paths stable regardless of the caller's cwd.
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));

// Suite selectors accept both Windows and POSIX path separators.
const SUBPATH_SPECS = /[\\/]subpath[\\/].*\.spec\.ts$/;

// Forms specs must run only with real auth; root bypass would make their assertions vacuous.
const AUTH_SPECS = /[\\/]auth[\\/].*\.spec\.ts$/;

// Top-level `testMatch` skips this non-spec file; only the auth-setup project selects it.
const AUTH_SETUP = /[\\/]auth[\\/]auth\.setup\.ts$/;

export default defineConfig({
  testDir: 'tests',
  // Loading Vitest harness tests in Playwright causes a matcher Symbol collision.
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
      // Mutation-heavy specs run only at root; subpath and forms use dedicated projects.
      testIgnore: [SUBPATH_SPECS, AUTH_SPECS],
    },
    {
      name: 'chromium-subpath',
      // The trailing slash keeps relative navigation under `/narratorr`.
      use: { ...devices['Desktop Chrome'], baseURL: SUBPATH_BASE_URL },
      testMatch: SUBPATH_SPECS,
    },
    {
      // Create the user, flip to forms mode, log in, and persist state before dependent specs.
      name: 'auth-setup',
      use: { ...devices['Desktop Chrome'], baseURL: FORMS_BASE_URL },
      testMatch: AUTH_SETUP,
    },
    {
      name: 'chromium-forms',
      // Redirect specs override this authenticated state with an empty context.
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
      // Unprefixed `/api/health` intentionally 404s on the subpath server.
      url: `http://localhost:${SUBPATH_PORT}${URL_BASE_SUBPATH}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: serverEnv(subpathRun, URL_BASE_SUBPATH, SUBPATH_PORT),
    },
    {
      command: 'node ../dist/server/index.js',
      // Health is public while the server boots in `none`; setup later flips it to `forms`.
      url: `http://localhost:${FORMS_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      // Must remain false or login/redirect/logout assertions become vacuous.
      env: serverEnv(formsRun, '/', FORMS_PORT, { authBypass: false }),
    },
  ],
});
