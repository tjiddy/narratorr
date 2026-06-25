import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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

async function columnNames(dbPath: string, table: string): Promise<Set<string>> {
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const result = await client.execute(`SELECT name FROM pragma_table_info('${table}')`);
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

    // The flattened baseline never creates `suggestions.snooze_until` (a dead
    // column that pre-flatten history added then dropped). Pin its absence so a
    // schema regression that re-adds it fails this suite. A survivor column
    // (`dismissed_at`) anchors the assertion so a typo'd table name can't make
    // it pass vacuously.
    const suggestionColumns = await columnNames(dbPath, 'suggestions');
    expect(suggestionColumns.has('snooze_until'), 'suggestions.snooze_until must not exist in the baseline schema').toBe(false);
    expect(suggestionColumns.has('dismissed_at'), 'expected survivor column suggestions.dismissed_at').toBe(true);

    // The flattened baseline must fold in columns that shipped as ADD COLUMN
    // migrations before each re-flatten: subtitle/publisher (#1614) and
    // enrichment_attempts (#1630). Pin their presence so a future re-flatten that
    // drops any of them fails here.
    const bookColumns = await columnNames(dbPath, 'books');
    expect(bookColumns.has('subtitle'), 'expected books.subtitle in the baseline schema').toBe(true);
    expect(bookColumns.has('publisher'), 'expected books.publisher in the baseline schema').toBe(true);
    expect(bookColumns.has('enrichment_attempts'), 'expected books.enrichment_attempts in the baseline schema').toBe(true);
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

    // The migrator must record exactly one row per migration in the journal —
    // no more (a duplicate application) and no fewer (a skipped migration).
    // Deriving the expectation from the journal keeps this test correct as new
    // migrations are added rather than hardcoding the count.
    const journal = JSON.parse(readFileSync(join(PROD_DRIZZLE, 'meta', '_journal.json'), 'utf-8')) as {
      entries: unknown[];
    };
    const client = createClient({ url: `file:${dbPath}` });
    try {
      const applied = await client.execute('SELECT COUNT(*) as count FROM __drizzle_migrations');
      expect(Number(applied.rows[0]!.count)).toBe(journal.entries.length);
    } finally {
      client.close();
    }
  });
});
