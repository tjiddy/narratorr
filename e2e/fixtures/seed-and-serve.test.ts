import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { runMigrations } from '../../src/db/migrate.js';
import { books, downloadClients, indexers, settings } from '../../src/db/schema.js';
import { HARNESS_TEMP_PREFIX } from './temp-dirs.js';
import { resolvePort, E2E_DEFAULT_PORTS } from './ports.js';

// Real by default so every case exercises the true seed; spied so the call-order recorder and the
// fail-closed cases can observe and replace it (see `fs-spy-over-importactual`).
const actualSeed = await vi.importActual<typeof import('./seed.js')>('./seed.js');

vi.mock('./seed.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  seedE2ERun: vi.fn(),
}));

import { seedE2ERun } from './seed.js';
import {
  readSeedInputs,
  seedAndServe,
  runSeedAndServeCli,
  SEED_LIBRARY_DIR_ENV,
} from './seed-and-serve.js';

const orphans: string[] = [];

// Fakes are reachable in unit scope; the real TCP waiter is covered in wait-for-ports.test.ts.
const fakesReady = async (): Promise<void> => { /* reachable */ };

function makeRunDirs(): { dbPath: string; libraryPath: string } {
  const dbDir = mkdtempSync(join(tmpdir(), HARNESS_TEMP_PREFIX));
  const libraryPath = mkdtempSync(join(tmpdir(), HARNESS_TEMP_PREFIX));
  orphans.push(dbDir, libraryPath);
  return { dbPath: join(dbDir, 'narratorr.db'), libraryPath };
}

async function readSeededRows(dbPath: string): Promise<{
  general: number;
  books: number;
  indexerBaseUrl: string | undefined;
  qbitPort: number | undefined;
}> {
  const client = createClient({ url: `file:${dbPath}` });
  const db = drizzle(client);
  try {
    const general = await db.select().from(settings).where(eq(settings.key, 'general'));
    const bookRows = await db.select().from(books);
    const [indexerRow] = await db.select().from(indexers);
    const [clientRow] = await db.select().from(downloadClients);
    return {
      general: general.length,
      books: bookRows.length,
      indexerBaseUrl: (indexerRow?.settings as { baseUrl?: string } | undefined)?.baseUrl,
      qbitPort: (clientRow?.settings as { port?: number } | undefined)?.port,
    };
  } finally {
    client.close();
  }
}

beforeEach(() => {
  orphans.length = 0;
  vi.mocked(seedE2ERun).mockReset();
  vi.mocked(seedE2ERun).mockImplementation(actualSeed.seedE2ERun);
});

afterEach(() => {
  for (const p of orphans) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // Windows keeps libSQL handles open; a leaked temp dir is cheaper than a red suite.
    }
  }
});

describe('readSeedInputs', () => {
  const base = { DATABASE_URL: '/tmp/db/narratorr.db', [SEED_LIBRARY_DIR_ENV]: '/tmp/library' };

  it('derives every seed input from its own env', () => {
    const inputs = readSeedInputs({ ...base, E2E_MAM_PORT: '5100', E2E_QBIT_PORT: '5200' });

    expect(inputs).toEqual({
      dbPath: '/tmp/db/narratorr.db',
      libraryPath: '/tmp/library',
      mamUrl: 'http://localhost:5100',
      qbitHost: 'localhost',
      qbitPort: 5200,
    });
  });

  it('falls back to the harness default ports when they are unset', () => {
    const inputs = readSeedInputs(base);

    expect(inputs.mamUrl).toBe(`http://localhost:${E2E_DEFAULT_PORTS.mam}`);
    expect(inputs.qbitPort).toBe(E2E_DEFAULT_PORTS.qbit);
  });

  it.each(['', 'abc', '0', '-1'])('falls back to the defaults for the unusable port value %o', (raw) => {
    const inputs = readSeedInputs({ ...base, E2E_MAM_PORT: raw, E2E_QBIT_PORT: raw });

    expect(inputs.mamUrl).toBe(`http://localhost:${E2E_DEFAULT_PORTS.mam}`);
    expect(inputs.qbitPort).toBe(E2E_DEFAULT_PORTS.qbit);
  });

  it.each([undefined, '', '   '])('rejects a DATABASE_URL of %o with a named error', (raw) => {
    const env = { ...base, DATABASE_URL: raw };

    expect(() => readSeedInputs(env)).toThrow(/DATABASE_URL/);
  });

  it.each([undefined, '', '   '])(`rejects a ${SEED_LIBRARY_DIR_ENV} of %o with a named error`, (raw) => {
    const env = { ...base, [SEED_LIBRARY_DIR_ENV]: raw };

    expect(() => readSeedInputs(env)).toThrow(new RegExp(SEED_LIBRARY_DIR_ENV));
  });

  it('agrees with globalSetup resolvePort for the same env, so the seeded URL names the bound port', () => {
    const env = { ...base, E2E_MAM_PORT: '4321', E2E_QBIT_PORT: '' };
    const inputs = readSeedInputs(env);

    expect(inputs.mamUrl).toBe(`http://localhost:${resolvePort('E2E_MAM_PORT', E2E_DEFAULT_PORTS.mam, env)}`);
    expect(inputs.qbitPort).toBe(resolvePort('E2E_QBIT_PORT', E2E_DEFAULT_PORTS.qbit, env));
  });
});

describe('seedAndServe', () => {
  it('starts the server exactly once, and only after the seed has committed', async () => {
    const { dbPath, libraryPath } = makeRunDirs();
    const order: string[] = [];
    vi.mocked(seedE2ERun).mockImplementation(async (options) => {
      const result = await actualSeed.seedE2ERun(options);
      order.push('seed');
      return result;
    });
    const startServer = vi.fn(async () => { order.push('start'); });
    const waitForFakes = vi.fn(async () => { order.push('fakes'); });
    const log = vi.fn((message: string) => { order.push(message.trim()); });

    await seedAndServe(
      readSeedInputs({ DATABASE_URL: dbPath, [SEED_LIBRARY_DIR_ENV]: libraryPath }),
      { startServer, waitForFakes, log },
    );

    // The logged lines are what the captured webServer stdout carries as the ordering evidence:
    // seed committed → verified fresh → fakes reachable → boot. Nothing may reorder.
    expect(order).toEqual([
      'seed',
      `[seed-and-serve] seed verified for ${dbPath}`,
      'fakes',
      '[seed-and-serve] fakes reachable; starting the server',
      'start',
    ]);
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it('leaves the marker rows readable through a connection that did not write them', async () => {
    // The original defect was invisible to a same-connection read; only a fresh client catches it.
    const { dbPath, libraryPath } = makeRunDirs();

    await seedAndServe(
      readSeedInputs({ DATABASE_URL: dbPath, [SEED_LIBRARY_DIR_ENV]: libraryPath }),
      { startServer: async () => { /* no server in unit scope */ }, waitForFakes: fakesReady },
    );

    // `readSeededRows` opens its own client, so this cannot observe the seed transaction's session.
    const rows = await readSeededRows(dbPath);
    expect(rows.general).toBe(1);
    expect(rows.books).toBe(1);
  });

  it('seeds the indexer baseUrl and download-client port the fakes will bind', async () => {
    const { dbPath, libraryPath } = makeRunDirs();

    await seedAndServe(
      readSeedInputs({
        DATABASE_URL: dbPath,
        [SEED_LIBRARY_DIR_ENV]: libraryPath,
        E2E_MAM_PORT: '4577',
        E2E_QBIT_PORT: '4578',
      }),
      { startServer: async () => { /* no server in unit scope */ }, waitForFakes: fakesReady },
    );

    const rows = await readSeededRows(dbPath);
    expect(rows.indexerBaseUrl).toBe('http://localhost:4577');
    expect(rows.qbitPort).toBe(4578);
  });

  it('falls back to the default ports in the seeded rows when the env values are unusable', async () => {
    const { dbPath, libraryPath } = makeRunDirs();

    await seedAndServe(
      readSeedInputs({
        DATABASE_URL: dbPath,
        [SEED_LIBRARY_DIR_ENV]: libraryPath,
        E2E_MAM_PORT: 'abc',
        E2E_QBIT_PORT: '0',
      }),
      { startServer: async () => { /* no server in unit scope */ }, waitForFakes: fakesReady },
    );

    const rows = await readSeededRows(dbPath);
    expect(rows.indexerBaseUrl).toBe(`http://localhost:${E2E_DEFAULT_PORTS.mam}`);
    expect(rows.qbitPort).toBe(E2E_DEFAULT_PORTS.qbit);
  });

  it('never starts the server when the seed rejects', async () => {
    const { dbPath, libraryPath } = makeRunDirs();
    vi.mocked(seedE2ERun).mockRejectedValueOnce(new Error('seed exploded'));
    const startServer = vi.fn(async () => { /* must not run */ });

    await expect(
      seedAndServe(readSeedInputs({ DATABASE_URL: dbPath, [SEED_LIBRARY_DIR_ENV]: libraryPath }), { startServer, waitForFakes: fakesReady }),
    ).rejects.toThrow(/seed exploded/);

    expect(startServer).not.toHaveBeenCalled();
  });

  it('never starts the server when the marker rows are missing from a migrated-but-unseeded DB', async () => {
    const { dbPath, libraryPath } = makeRunDirs();
    vi.mocked(seedE2ERun).mockImplementationOnce(async () => {
      await runMigrations(dbPath);
      return { indexerId: 1, downloadClientId: 1, authorId: 1, bookId: 1 };
    });
    const startServer = vi.fn(async () => { /* must not run */ });

    await expect(
      seedAndServe(readSeedInputs({ DATABASE_URL: dbPath, [SEED_LIBRARY_DIR_ENV]: libraryPath }), { startServer, waitForFakes: fakesReady }),
    ).rejects.toThrow(new RegExp(dbPath.split('\\').join('\\\\').replace(/[.*+?^${}()|[\]]/g, '\\$&')));

    expect(startServer).not.toHaveBeenCalled();
  });

  it('names the missing directory instead of crashing inside libSQL', async () => {
    const libraryPath = mkdtempSync(join(tmpdir(), HARNESS_TEMP_PREFIX));
    orphans.push(libraryPath);
    const dbPath = join(tmpdir(), `${HARNESS_TEMP_PREFIX}absent-parent`, 'narratorr.db');
    const startServer = vi.fn(async () => { /* must not run */ });

    await expect(
      seedAndServe(readSeedInputs({ DATABASE_URL: dbPath, [SEED_LIBRARY_DIR_ENV]: libraryPath }), { startServer, waitForFakes: fakesReady }),
    ).rejects.toThrow(/does not exist/);

    expect(startServer).not.toHaveBeenCalled();
  });

  it('refuses to start the server while the fakes stay unreachable (#2474)', async () => {
    // The structural pin: a server booting against an unbound fake port opens the indexer breaker
    // for ~60s and starves whichever spec searches inside the window.
    const { dbPath, libraryPath } = makeRunDirs();
    const startServer = vi.fn(async () => { /* must not run */ });
    const waitForFakes = vi.fn(async () => {
      throw new Error('waitForTcpPorts: not reachable on 127.0.0.1 within 30000ms: 4100');
    });

    await expect(
      seedAndServe(readSeedInputs({ DATABASE_URL: dbPath, [SEED_LIBRARY_DIR_ENV]: libraryPath }), { startServer, waitForFakes }),
    ).rejects.toThrow(/not reachable/);

    expect(waitForFakes).toHaveBeenCalledTimes(1);
    expect(startServer).not.toHaveBeenCalled();
  });

  it('rejects a second seed of the same DB rather than silently double-seeding', async () => {
    // Pinned so a retried webServer start has defined behaviour: the seed's inserts are not upserts,
    // so the second attempt dies on a duplicate row and the transaction rolls back.
    const { dbPath, libraryPath } = makeRunDirs();
    const inputs = readSeedInputs({ DATABASE_URL: dbPath, [SEED_LIBRARY_DIR_ENV]: libraryPath });
    const startServer = vi.fn(async () => { /* no server in unit scope */ });

    await seedAndServe(inputs, { startServer, waitForFakes: fakesReady });

    await expect(seedAndServe(inputs, { startServer, waitForFakes: fakesReady })).rejects.toThrow(/Failed query: insert/);
    expect(startServer).toHaveBeenCalledTimes(1);

    const rows = await readSeededRows(dbPath);
    expect(rows.books).toBe(1);
    expect(rows.general).toBe(1);
  });
});

describe('runSeedAndServeCli', () => {
  const cliEnv = (dbPath: string, libraryPath: string): NodeJS.ProcessEnv =>
    ({ DATABASE_URL: dbPath, [SEED_LIBRARY_DIR_ENV]: libraryPath });

  it('exits non-zero with a diagnostic naming the db path when the core rejects', async () => {
    const { dbPath, libraryPath } = makeRunDirs();
    vi.mocked(seedE2ERun).mockRejectedValueOnce(new Error('seed exploded'));
    const exit = vi.fn();
    const writeStderr = vi.fn();
    const writeStdout = vi.fn();
    const startServer = vi.fn(async () => { /* must not run */ });

    await runSeedAndServeCli({ env: cliEnv(dbPath, libraryPath), exit, writeStderr, writeStdout, startServer, waitForFakes: fakesReady });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(startServer).not.toHaveBeenCalled();
    expect(writeStdout).not.toHaveBeenCalled();
    const [message] = writeStderr.mock.calls.at(-1)!;
    expect(message).toContain(dbPath);
    expect(message).toContain('seed exploded');
  });

  it('exits non-zero and never boots when the fakes stay unreachable', async () => {
    const { dbPath, libraryPath } = makeRunDirs();
    const exit = vi.fn();
    const writeStderr = vi.fn();
    const startServer = vi.fn(async () => { /* must not run */ });
    const waitForFakes = vi.fn(async () => {
      throw new Error('waitForTcpPorts: not reachable on 127.0.0.1 within 30000ms: 4100, 4300');
    });

    await runSeedAndServeCli({ env: cliEnv(dbPath, libraryPath), exit, writeStderr, startServer, waitForFakes });

    expect(exit).toHaveBeenCalledWith(1);
    expect(startServer).not.toHaveBeenCalled();
    expect(writeStderr.mock.calls.at(-1)![0]).toContain('not reachable');
  });

  it('reports an unusable env without reaching libSQL', async () => {
    const exit = vi.fn();
    const writeStderr = vi.fn();
    const startServer = vi.fn(async () => { /* must not run */ });

    await runSeedAndServeCli({ env: { DATABASE_URL: '' }, exit, writeStderr, startServer, waitForFakes: fakesReady });

    expect(exit).toHaveBeenCalledWith(1);
    expect(startServer).not.toHaveBeenCalled();
    expect(writeStderr.mock.calls.at(-1)![0]).toContain('DATABASE_URL');
  });

  it('neither exits nor writes to stderr on the success path, and announces the verified seed', async () => {
    // The observation point that keeps the failure cases above non-vacuous.
    const { dbPath, libraryPath } = makeRunDirs();
    const exit = vi.fn();
    const writeStderr = vi.fn();
    const writeStdout = vi.fn();
    const startServer = vi.fn(async () => { /* no server in unit scope */ });

    await runSeedAndServeCli({ env: cliEnv(dbPath, libraryPath), exit, writeStderr, writeStdout, startServer, waitForFakes: fakesReady });

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(writeStderr).not.toHaveBeenCalled();
    const stdoutLines = writeStdout.mock.calls.map((c) => c[0] as string);
    expect(stdoutLines.some((line) => line.includes('seed verified'))).toBe(true);
    expect(stdoutLines.at(-1)).toContain('fakes reachable; starting the server');
  });
});
