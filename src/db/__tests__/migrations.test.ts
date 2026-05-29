import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// Resolve the production drizzle/ folder from this test file's URL.
// __dirname for tests run via vitest points at src/db/__tests__/, so go up
// two levels to reach the repo root then into drizzle/.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROD_DRIZZLE = join(__dirname, '..', '..', '..', 'drizzle');

// Tables the application depends on existing after the baseline migration.
// Not exhaustive (the schema grows); this is a representative core set that
// must always be present, plus the migrator bookkeeping table.
const CORE_TABLES = [
  'authors',
  'books',
  'book_authors',
  'book_events',
  'downloads',
  'indexers',
  'download_clients',
  'notifiers',
  'import_lists',
  'series',
  'series_members',
  'settings',
  'users',
];

async function tableNames(dbPath: string): Promise<Set<string>> {
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    return new Set(result.rows.map((r) => r.name as string));
  } finally {
    client.close();
  }
}

describe('drizzle baseline migration', () => {
  let tmpDir: string;

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows: libsql file handles may linger briefly after close()
    }
  });

  it('applies cleanly to an empty database and creates the expected tables', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'narratorr-baseline-test-'));
    const dbPath = join(tmpDir, 'test.db');

    const client = createClient({ url: `file:${dbPath}` });
    try {
      await migrate(drizzle(client), { migrationsFolder: PROD_DRIZZLE });
    } finally {
      client.close();
    }

    const names = await tableNames(dbPath);
    for (const t of CORE_TABLES) {
      expect(names.has(t), `expected table "${t}" to exist after baseline migration`).toBe(true);
    }
    // The migrator records what it applied; the baseline must be present.
    expect(names.has('__drizzle_migrations')).toBe(true);
  });

  it('is idempotent — re-running the migrator is a no-op', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'narratorr-baseline-test-'));
    const dbPath = join(tmpDir, 'test.db');

    const run = async () => {
      const client = createClient({ url: `file:${dbPath}` });
      try {
        await migrate(drizzle(client), { migrationsFolder: PROD_DRIZZLE });
      } finally {
        client.close();
      }
    };

    await run();
    // Second invocation must not throw or re-apply.
    await expect(run()).resolves.not.toThrow();

    // Exactly one migration recorded — proves the baseline stays flat and the
    // second run was a genuine no-op (not a duplicate application).
    const client = createClient({ url: `file:${dbPath}` });
    try {
      const applied = await client.execute('SELECT COUNT(*) as count FROM __drizzle_migrations');
      expect(Number(applied.rows[0]!.count)).toBe(1);
    } finally {
      client.close();
    }
  });
});
