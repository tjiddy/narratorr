/**
 * Lighthouse scan orchestrator.
 * Builds the app, starts a production server, seeds data, runs LHCI, aggregates results, cleans up.
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupAuth } from '../auth/setup.ts';
import { seedData, writeSeedResults } from '../seed/seed.ts';
import { aggregate } from './aggregate.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'lighthouse-reports');
const LHCI_OUTPUT_DIR = join(REPORTS_DIR, 'lhci');
const PORT = process.env.LIGHTHOUSE_PORT || '3199';
const DB_PATH = join(ROOT, 'lighthouse-test.db');
const BASE_URL = `http://localhost:${PORT}`;

let serverProcess: ChildProcess | null = null;

function getUrls(bookId: number): string[] {
  return [
    `${BASE_URL}/login`,
    `${BASE_URL}/library`,
    `${BASE_URL}/search`,
    `${BASE_URL}/books/${bookId}`,
    `${BASE_URL}/authors/B000TESTAU`,
    `${BASE_URL}/import`,
    `${BASE_URL}/activity`,
    `${BASE_URL}/settings`,
    `${BASE_URL}/settings/indexers`,
    `${BASE_URL}/settings/download-clients`,
    `${BASE_URL}/settings/notifications`,
    `${BASE_URL}/settings/blacklist`,
    `${BASE_URL}/settings/security`,
  ];
}

function writeLhciConfig(bookId: number): string {
  const configPath = join(ROOT, '.lighthouserc.json');
  const config = {
    ci: {
      collect: {
        url: getUrls(bookId),
        puppeteerScript: join(__dirname, 'puppeteer-script.js'),
        puppeteerLaunchOptions: {
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
        settings: {
          onlyCategories: ['accessibility', 'performance', 'best-practices', 'seo'],
          formFactor: 'desktop',
          screenEmulation: { disabled: true },
          throttling: { cpuSlowdownMultiplier: 1 },
        },
        numberOfRuns: 1,
      },
      upload: {
        target: 'filesystem',
        outputDir: LHCI_OUTPUT_DIR,
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

async function main(): Promise<void> {
  let configPath = '';
  try {
    // Clean up from previous runs
    if (existsSync(REPORTS_DIR)) rmSync(REPORTS_DIR, { recursive: true });
    mkdirSync(REPORTS_DIR, { recursive: true });
    mkdirSync(LHCI_OUTPUT_DIR, { recursive: true });
    if (existsSync(DB_PATH)) rmSync(DB_PATH);
    if (existsSync(`${DB_PATH}-journal`)) rmSync(`${DB_PATH}-journal`);

    // 1. Build
    console.log('Building app...');
    execSync('pnpm build', { cwd: ROOT, stdio: 'inherit' });

    // 2. Start server
    console.log(`Starting production server on port ${PORT}...`);
    serverProcess = spawn('node', ['apps/narratorr/dist/server/index.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: `file:${DB_PATH}`,
        PORT,
        NODE_ENV: 'production',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`  [server] ${line}`);
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.error(`  [server] ${line}`);
    });

    // Wait for health check
    await waitForServer(BASE_URL, 30);
    console.log('Server is ready.');

    // 3. Auth setup
    console.log('Setting up auth...');
    const sessionCookie = await setupAuth(BASE_URL);
    writeFileSync(join(REPORTS_DIR, 'session-cookie.txt'), sessionCookie);
    console.log('Auth setup complete.');

    // 4. Seed data
    console.log('Seeding test data...');
    const seedResults = await seedData(BASE_URL, sessionCookie);
    writeSeedResults(REPORTS_DIR, seedResults);
    console.log(`Seed complete. Book ID: ${seedResults.bookId}`);

    // 5. Write LHCI config (JSON — safe with cosmiconfig)
    configPath = writeLhciConfig(seedResults.bookId);

    // 6. Run LHCI (collect runs audits, upload copies results to our output dir)
    console.log('Running Lighthouse audits (13 routes)...');
    execSync('npx lhci collect', { cwd: ROOT, stdio: 'inherit' });
    execSync('npx lhci upload', { cwd: ROOT, stdio: 'inherit' });
    console.log('Lighthouse audits complete.');

    // 7. Copy HTML reports to reports dir
    copyHtmlReports(LHCI_OUTPUT_DIR, REPORTS_DIR);

    // 8. Aggregate results
    console.log('Aggregating results...');
    aggregate(LHCI_OUTPUT_DIR, REPORTS_DIR);
    console.log(`\nReports saved to ${REPORTS_DIR}/`);
  } finally {
    cleanup(configPath);
  }
}

async function waitForServer(baseUrl: string, maxSeconds: number): Promise<void> {
  for (let i = 0; i < maxSeconds; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server failed to start within ${maxSeconds}s`);
}

function copyHtmlReports(lhciDir: string, reportsDir: string): void {
  if (!existsSync(lhciDir)) return;
  const htmlFiles = readdirSync(lhciDir).filter((f) => f.endsWith('.html'));
  for (const file of htmlFiles) {
    copyFileSync(join(lhciDir, file), join(reportsDir, file));
  }
}

function cleanup(configPath?: string): void {
  if (serverProcess) {
    console.log('Stopping server...');
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
  // Clean up temp LHCI config
  if (configPath && existsSync(configPath)) {
    try { rmSync(configPath); } catch { /* ignore */ }
  }
  // Clean up DB
  if (existsSync(DB_PATH)) {
    try { rmSync(DB_PATH); } catch { /* ignore */ }
  }
  if (existsSync(`${DB_PATH}-journal`)) {
    try { rmSync(`${DB_PATH}-journal`); } catch { /* ignore */ }
  }
  // Clean up .lighthouseci/ default output dir
  const lhciDefaultDir = join(ROOT, '.lighthouseci');
  if (existsSync(lhciDefaultDir)) {
    try { rmSync(lhciDefaultDir, { recursive: true }); } catch { /* ignore */ }
  }
  // Clean up temp files in reports dir
  for (const tmpFile of ['session-cookie.txt', 'seed-results.json']) {
    const p = join(REPORTS_DIR, tmpFile);
    if (existsSync(p)) {
      try { rmSync(p); } catch { /* ignore */ }
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => { cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });

main().catch((err) => {
  console.error('Lighthouse scan failed:', err);
  cleanup();
  process.exit(1);
});
