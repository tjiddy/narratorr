import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _resetCurrentRunForTests,
  createRunTempDirs,
  getCurrentRun,
  runTempRoots,
  ROOT_RUN,
  RUN_MANIFEST_ENV,
  RUN_MANIFEST_FILENAME,
  type RunTempDirs,
} from './fixtures/temp-dirs.js';
import { SUBPATH_RUN } from './fixtures/subpath.js';
import { FORMS_RUN } from './fixtures/auth.js';
import { SEED_LIBRARY_DIR_ENV } from './fixtures/server-env.js';
import { E2E_DEFAULT_PORTS } from './fixtures/ports.js';
import globalSetup, { getE2ESourcePath, cleanupRunPathsFile } from './global-setup.js';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));

// globalSetup binds nothing anymore (the fakes host owns the listeners — see fakes/host.test.ts),
// but distinct port values keep the published-URL assertions meaningful.
let nextPortBase = 15100;
function allocatePortPair(): { mam: number; qbit: number; audible: number } {
  const mam = nextPortBase++;
  const qbit = nextPortBase++;
  const audible = nextPortBase++;
  return { mam, qbit, audible };
}

describe('globalSetup', () => {
  const orphans: string[] = [];
  let ports: { mam: number; qbit: number; audible: number };

  beforeEach(() => {
    _resetCurrentRunForTests();
    orphans.length = 0;
    ports = allocatePortPair();
    process.env.E2E_MAM_PORT = String(ports.mam);
    process.env.E2E_QBIT_PORT = String(ports.qbit);
    process.env.E2E_AUDIBLE_PORT = String(ports.audible);
  });

  afterEach(() => {
    for (const p of orphans) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    delete process.env.E2E_MAM_PORT;
    delete process.env.E2E_QBIT_PORT;
    delete process.env.E2E_AUDIBLE_PORT;
    delete process.env.E2E_AUDIBLE_URL;
    delete process.env.E2E_RUN_STATE_DIR;
  });

  it('throws a clear error if createRunTempDirs has not been called', async () => {
    await expect(globalSetup()).rejects.toThrow(/temp-dir state not initialized/);
  });

  it('binds no listeners and registers no fakes — the fakes host owns them (#2474)', async () => {
    // A fake started here loses the race against the app servers' boot-time cron ticks; the
    // source sentinel below plus this behavioural pin keep that responsibility out of this file.
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    await globalSetup();

    // The published URLs name ports nothing in this process has bound.
    await expect(fetch(`${process.env.E2E_MAM_URL}/jsonLoad.php`)).rejects.toThrow();
  });

  it('leaves fake startup out of this file at the source level', () => {
    const content = readFileSync(join(E2E_DIR, 'global-setup.ts'), 'utf-8');
    expect(content).not.toContain('createMAMFake');
    expect(content).not.toContain('createQBitFake');
    expect(content).not.toContain('createAudibleFake');
    expect(content).not.toContain('registerFake');
  });

  it('touches no run DB — seeding belongs to the seed wrapper, which runs before each server boots', async () => {
    // Playwright starts `webServer` before globalSetup, so anything seeded here lands too late.
    // Coverage for the seeded rows themselves lives in `fixtures/seed-and-serve.test.ts`.
    const run = createRunTempDirs();
    const subpath = createRunTempDirs(SUBPATH_RUN);
    orphans.push(
      dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath,
      dirname(subpath.dbPath), subpath.libraryPath, subpath.configPath, subpath.downloadsPath, subpath.sourcePath,
    );

    await globalSetup();

    expect(existsSync(run.dbPath)).toBe(false);
    expect(existsSync(subpath.dbPath)).toBe(false);
  });

  it('pre-populates sourcePath with an author-title subfolder containing silent.m4b', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    await globalSetup();

    const { existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    const entries = readdirSync(run.sourcePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe('E2E Manual Author - E2E Manual Import Book');

    const bookDir = join(run.sourcePath, entries[0]!);
    const files = readdirSync(bookDir);
    expect(files).toContain('silent.m4b');
    expect(existsSync(join(bookDir, 'silent.m4b'))).toBe(true);
  });

  it('exposes fake URLs and paths on process.env for spec files', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    await globalSetup();

    // Exactly the ports the fakes host resolves from the same env — the shared contract in
    // fixtures/ports.ts is what keeps these two processes agreeing.
    expect(process.env.E2E_MAM_URL).toBe(`http://localhost:${ports.mam}`);
    expect(process.env.E2E_QBIT_URL).toBe(`http://localhost:${ports.qbit}`);
    expect(process.env.E2E_AUDIBLE_URL).toBe(`http://localhost:${ports.audible}`);
    expect(process.env.E2E_DOWNLOADS_PATH).toBe(run.downloadsPath);
    expect(process.env.E2E_LIBRARY_PATH).toBe(run.libraryPath);

    expect(getCurrentRun()?.downloadsPath).toBe(run.downloadsPath);
  });

  it('writes .run-paths.json to configPath with the current sourcePath', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    await globalSetup();

    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const stateFile = join(run.configPath, '.run-paths.json');
    expect(existsSync(stateFile)).toBe(true);

    const data = JSON.parse(readFileSync(stateFile, 'utf-8')) as { sourcePath: string };
    expect(data.sourcePath).toBe(run.sourcePath);
  });

  it('getE2ESourcePath reads from the state file when E2E_SOURCE_PATH is unset', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    process.env.E2E_RUN_STATE_DIR = run.configPath;

    await globalSetup();

    const saved = process.env.E2E_SOURCE_PATH;
    delete process.env.E2E_SOURCE_PATH;
    try {
      const result = getE2ESourcePath();
      expect(result).toBe(run.sourcePath);
    } finally {
      process.env.E2E_SOURCE_PATH = saved;
      delete process.env.E2E_RUN_STATE_DIR;
    }
  });

  it('cleanupRunPathsFile removes the per-run state file', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    process.env.E2E_RUN_STATE_DIR = run.configPath;

    await globalSetup();

    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    expect(existsSync(join(run.configPath, '.run-paths.json'))).toBe(true);

    cleanupRunPathsFile();

    expect(existsSync(join(run.configPath, '.run-paths.json'))).toBe(false);
    delete process.env.E2E_RUN_STATE_DIR;
  });
});

describe('playwright.config.ts webServer contract', () => {
  const orphans: string[] = [];
  let manifestRuns: Record<string, RunTempDirs>;
  let config: import('@playwright/test').PlaywrightTestConfig;

  beforeAll(async () => {
    // Pre-publishing a manifest is what lets this suite import the real config: the guarded
    // allocator adopts it and allocates nothing, so the import has no filesystem side effects.
    _resetCurrentRunForTests();
    const root = createRunTempDirs();
    const subpath = createRunTempDirs(SUBPATH_RUN);
    const forms = createRunTempDirs(FORMS_RUN);
    manifestRuns = { [ROOT_RUN]: root, [SUBPATH_RUN]: subpath, [FORMS_RUN]: forms };
    orphans.push(...Object.values(manifestRuns).flatMap(runTempRoots));

    const manifestPath = join(root.configPath, RUN_MANIFEST_FILENAME);
    writeFileSync(manifestPath, JSON.stringify({ version: 1, runs: manifestRuns }), 'utf-8');
    process.env[RUN_MANIFEST_ENV] = manifestPath;

    config = (await import('./playwright.config.js')).default;
  });

  afterAll(() => {
    delete process.env[RUN_MANIFEST_ENV];
    delete process.env.E2E_RUN_STATE_DIR;
    for (const p of orphans) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    _resetCurrentRunForTests();
  });

  it('starts the fakes host first, before any app server, with port readiness on MAM (#2474)', () => {
    // Playwright sets webServer entries up sequentially, so first-in-array means bound-before-boot.
    const servers = config.webServer as Array<{ command: string; port?: number; env?: Record<string, string> }>;

    expect(servers[0]!.command).toContain('fakes/host');
    expect(servers[0]!.command).not.toContain('seed-and-serve');
    // MAM is the host's last bind, so its port implies all three fakes are up.
    expect(servers[0]!.port).toBe(E2E_DEFAULT_PORTS.mam);
    // The qBit fake stages its completed download into the ROOT run's downloads dir.
    expect(servers[0]!.env?.E2E_DOWNLOADS_PATH).toBe(manifestRuns[ROOT_RUN]!.downloadsPath);
  });

  it('routes every app server through the seed wrapper instead of the production bundle', () => {
    // The sentinel that reds if a `command` is reverted to `node ../dist/server/index.js`.
    const commands = (config.webServer as Array<{ command: string }>).map((entry) => entry.command);

    expect(commands).toHaveLength(4);
    for (const command of commands.slice(1)) {
      expect(command).toContain('seed-and-serve');
      expect(command).not.toContain('dist/server/index.js');
    }
  });

  it('hands each wrapper the DB and library of the run the manifest owns', () => {
    const appServers = (config.webServer as Array<{ env: Record<string, string> }>).slice(1);

    expect(appServers.map((s) => s.env.DATABASE_URL)).toEqual([
      manifestRuns[ROOT_RUN]!.dbPath, manifestRuns[SUBPATH_RUN]!.dbPath, manifestRuns[FORMS_RUN]!.dbPath,
    ]);
    expect(appServers.map((s) => s.env[SEED_LIBRARY_DIR_ENV])).toEqual([
      manifestRuns[ROOT_RUN]!.libraryPath,
      manifestRuns[SUBPATH_RUN]!.libraryPath,
      manifestRuns[FORMS_RUN]!.libraryPath,
    ]);
  });

  it('keeps the forms server free of AUTH_BYPASS while root and subpath keep it', () => {
    const appServers = (config.webServer as Array<{ env: Record<string, string> }>).slice(1);

    expect(appServers[0]!.env.AUTH_BYPASS).toBe('true');
    expect(appServers[1]!.env.AUTH_BYPASS).toBe('true');
    expect('AUTH_BYPASS' in appServers[2]!.env).toBe(false);
  });

  it('does not pass LIBRARY_PATH to the server process', () => {
    const content = readFileSync(join(E2E_DIR, 'playwright.config.ts'), 'utf-8');
    expect(content).not.toContain('LIBRARY_PATH');
  });

  it('allocates no temp dirs unconditionally at module scope', () => {
    // Guards the wiring, not only the behaviour: an unguarded call leaks a batch per config load.
    const content = readFileSync(join(E2E_DIR, 'playwright.config.ts'), 'utf-8');
    expect(content).not.toContain('createRunTempDirs(');
  });

  it('leaves globalSetup with no seeding responsibility', () => {
    const content = readFileSync(join(E2E_DIR, 'global-setup.ts'), 'utf-8');
    expect(content).not.toContain('seedE2ERun');
  });
});
