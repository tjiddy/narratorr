import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRunTempDirs } from './fixtures/temp-dirs.js';

/**
 * Phase 1 E2E harness — see issue #612.
 *
 * Boots the built production bundle (`node ../dist/server/index.js`) with three
 * per-run temp directories (DB, library, config) and AUTH_BYPASS=true so the
 * smoke test doesn't need a login flow.
 *
 * Caller MUST have run `pnpm build` before `pnpm test:e2e`. The webServer
 * command will fail with a clear error if `dist/server/index.js` is missing.
 */

// Compute temp dirs once at config load. The paths flow into webServer.env
// AND are persisted by createRunTempDirs to e2e/.run-state.json so global
// teardown can remove them after the run.
const tempDirs = createRunTempDirs();

// Expose the per-run configPath as an env var at config-load time so test
// workers inherit it (workers fork from this process AFTER config loads).
// Unlike webServer.env (server-only) or globalSetup mutations (too late),
// config-load-time env vars DO propagate to Playwright worker processes.
// Used by getE2ESourcePath() to locate the per-run .run-paths.json file.
process.env.E2E_RUN_STATE_DIR = tempDirs.configPath;

// Resolve output paths relative to this config file, not the caller's cwd —
// otherwise Playwright dumps test-results/ at wherever pnpm was invoked from.
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));

const PORT = 3100;

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
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'node ../dist/server/index.js',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'production',
      PORT: String(PORT),
      DATABASE_URL: tempDirs.dbPath,
      LIBRARY_PATH: tempDirs.libraryPath,
      CONFIG_PATH: tempDirs.configPath,
      AUTH_BYPASS: 'true',
      URL_BASE: '/',
      // Poll every 2 seconds instead of the default 30 so the spec doesn't wait a
      // full minute for the monitor to notice the fake qBit's "complete" flip.
      MONITOR_INTERVAL_CRON: '*/2 * * * * *',
      // Surface the per-run downloads path for spec-side forensics/assertions.
      // Not consumed by app code — the fake qBit already knows the path from
      // its constructor in global-setup.ts.
      E2E_DOWNLOADS_PATH: tempDirs.downloadsPath,
      // Override the Audible API base URL so AudibleProvider sends requests to
      // the E2E fake instead of the real Audible API. The fake returns empty
      // products, making the match job resolve to confidence 'none'.
      AUDIBLE_BASE_URL: 'http://localhost:4300',
      // Surface the per-run source path for the manual-import spec. The spec
      // enters this path in the scan input so Narratorr discovers the seeded
      // audiobook folder.
      E2E_SOURCE_PATH: tempDirs.sourcePath,
    },
  },
});
