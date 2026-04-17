import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { _resetCurrentRunForTests, createRunTempDirs, getCurrentRun } from './fixtures/temp-dirs.js';
import { _resetRegisteredFakesForTests, getRegisteredFakes } from './fixtures/run-state.js';
import { authors, books, downloadClients, indexers } from '../src/db/schema.js';
import globalSetup from './global-setup.js';

/**
 * globalSetup runs real Fastify servers on fixed ports 4100/4200. These tests
 * start and stop the full orchestration to verify the wiring — they are slower
 * than pure-unit tests but still under 1s each.
 */
// Allocate a unique port pair per test so vitest ordering + kernel TIME_WAIT
// don't collide on 4100/4200. Production runs still use the fixed defaults
// because env vars aren't set.
let nextPortBase = 15100;
function allocatePortPair(): { mam: number; qbit: number; audible: number } {
  const mam = nextPortBase++;
  const qbit = nextPortBase++;
  const audible = nextPortBase++;
  return { mam, qbit, audible };
}

describe('globalSetup', () => {
  const orphans: string[] = [];

  beforeEach(() => {
    _resetCurrentRunForTests();
    _resetRegisteredFakesForTests();
    orphans.length = 0;
    const { mam, qbit, audible } = allocatePortPair();
    process.env.E2E_MAM_PORT = String(mam);
    process.env.E2E_QBIT_PORT = String(qbit);
    process.env.E2E_AUDIBLE_PORT = String(audible);
  });

  afterEach(async () => {
    for (const fake of getRegisteredFakes()) {
      try { await fake.close(); } catch { /* best-effort */ }
    }
    _resetRegisteredFakesForTests();
    for (const p of orphans) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    delete process.env.E2E_MAM_PORT;
    delete process.env.E2E_QBIT_PORT;
    delete process.env.E2E_AUDIBLE_PORT;
    delete process.env.E2E_AUDIBLE_URL;
  });

  it('throws a clear error if createRunTempDirs has not been called', async () => {
    // playwright.config.ts is supposed to call createRunTempDirs at module load
    // so webServer.env can reference paths — globalSetup should fail loud if that
    // didn't happen.
    await expect(globalSetup()).rejects.toThrow(/temp-dir state not initialized/);
  });

  it('starts the MAM fake and the qBit fake on the configured ports', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    await globalSetup();

    const names = getRegisteredFakes().map((f) => f.name);
    expect(names).toContain('mam');
    expect(names).toContain('qbit');

    const mamRes = await fetch(`${process.env.E2E_MAM_URL}/jsonLoad.php`, {
      headers: { Cookie: 'mam_id=test-mam-id' },
    });
    expect(mamRes.status).toBe(200);

    const qbitRes = await fetch(`${process.env.E2E_QBIT_URL}/api/v2/app/version`);
    expect(qbitRes.status).toBe(200);
  });

  it('seeds the indexer/download-client/author/book rows into the per-run DB', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    await globalSetup();

    const client = createClient({ url: `file:${run.dbPath}` });
    const db = drizzle(client);
    try {
      expect((await db.select().from(indexers)).length).toBe(1);
      expect((await db.select().from(downloadClients)).length).toBe(1);
      expect((await db.select().from(authors)).length).toBe(1);
      expect((await db.select().from(books)).length).toBe(1);
    } finally {
      client.close();
    }
  });

  it('pre-seeds MAM with a fixture matching the seeded book title', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    await globalSetup();

    const res = await fetch(
      `${process.env.E2E_MAM_URL}/tor/js/loadSearchJSONbasic.php?tor%5Btext%5D=E2E+Test+Book`,
      { headers: { Cookie: 'mam_id=test-mam-id' } },
    );
    const body = await res.json() as { data?: Array<{ title: string }> };
    expect(body.data).toBeDefined();
    expect(body.data!.length).toBeGreaterThan(0);
    expect(body.data![0].title).toMatch(/E2E Test Book/);
  });

  it('starts the Audible fake on a configured port and registers it for teardown', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    await globalSetup();

    const names = getRegisteredFakes().map((f) => f.name);
    expect(names).toContain('audible');

    // The fake should respond to Audible API catalog requests with empty products.
    const audibleRes = await fetch(`${process.env.E2E_AUDIBLE_URL}/1.0/catalog/products?title=test`);
    expect(audibleRes.status).toBe(200);
    const body = await audibleRes.json() as { products: unknown[]; total_results: number };
    expect(body.products).toEqual([]);
    expect(body.total_results).toBe(0);
  });

  it('pre-populates sourcePath with an author-title subfolder containing silent.m4b', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    await globalSetup();

    const { existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    // Should have exactly one subfolder matching the expected name.
    const entries = readdirSync(run.sourcePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe('E2E Manual Author - E2E Manual Import Book');

    // The subfolder should contain the silent.m4b fixture.
    const bookDir = join(run.sourcePath, entries[0]);
    const files = readdirSync(bookDir);
    expect(files).toContain('silent.m4b');
    expect(existsSync(join(bookDir, 'silent.m4b'))).toBe(true);
  });

  it('exposes fake URLs and paths on process.env for spec files', async () => {
    const run = createRunTempDirs();
    orphans.push(dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath);

    await globalSetup();

    expect(process.env.E2E_MAM_URL).toMatch(/^http:\/\/localhost:\d+$/);
    expect(process.env.E2E_QBIT_URL).toMatch(/^http:\/\/localhost:\d+$/);
    expect(process.env.E2E_DOWNLOADS_PATH).toBe(run.downloadsPath);
    expect(process.env.E2E_LIBRARY_PATH).toBe(run.libraryPath);

    // Sanity — getCurrentRun is still populated and consistent with env.
    expect(getCurrentRun()?.downloadsPath).toBe(run.downloadsPath);
  });
});
