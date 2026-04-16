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

// Resolve output paths relative to this config file, not the caller's cwd —
// otherwise Playwright dumps test-results/ at wherever pnpm was invoked from.
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));

const PORT = 3100;

export default defineConfig({
  testDir: 'tests',
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
    },
  },
});
