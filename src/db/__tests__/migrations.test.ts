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
    // migrations before each re-flatten: subtitle/publisher (#1614),
    // enrichment_attempts (#1630), production_type (#1710, story 1) and
    // edition_label (#1711/#1712). Those incremental migrations were collapsed into
    // the single 0000_baseline. Pin their presence so a future re-flatten that
    // drops any of them fails here. Both production_type (edition
    // discriminator) and edition_label (persisted folder suffix) are load-bearing
    // for the keep-both edition-safe ingest path. These pins guard column
    // PRESENCE only, not enum-value integrity — production_type is a
    // text(..., { enum }) column with no DB-level CHECK ([[drizzle-sqlite-text-enum-no-db-check]]).
    const bookColumns = await columnNames(dbPath, 'books');
    expect(bookColumns.has('subtitle'), 'expected books.subtitle in the baseline schema').toBe(true);
    expect(bookColumns.has('publisher'), 'expected books.publisher in the baseline schema').toBe(true);
    expect(bookColumns.has('enrichment_attempts'), 'expected books.enrichment_attempts in the baseline schema').toBe(true);
    expect(bookColumns.has('production_type'), 'expected books.production_type in the baseline schema').toBe(true);
    expect(bookColumns.has('edition_label'), 'expected books.edition_label in the baseline schema').toBe(true);
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

describe('baseline upper(asin) unique index (#1733, folded into the flattened baseline)', () => {
  let tmpDir: string;

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows: libsql file handles may linger briefly after close()
    }
  });

  // The #1733 data-migration (quarantine case-drifted duplicate ASINs, uppercase survivors) can no
  // longer occur on a from-scratch baseline — there is no legacy data to fix — so its upgrade-
  // transition test was dropped when 0003 was collapsed into 0000_baseline. What stays load-bearing
  // is the STRUCTURAL guarantee that migration installed: the flattened baseline's
  // `idx_books_asin_unique` is on `upper(asin)` (partial, WHERE asin IS NOT NULL), so case-drifted
  // ASINs collide while NULLs still coexist. Pin that against the real baseline.
  it('enforces case-insensitive ASIN uniqueness and still allows multiple NULLs', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'narratorr-asin-idx-test-'));
    const dbPath = join(tmpDir, 'test.db');

    const client = createClient({ url: `file:${dbPath}` });
    try {
      await migrate(drizzle(client), { migrationsFolder: PROD_DRIZZLE });

      // The unique index exists and is on upper(asin) — not the raw column.
      const idx = await client.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_books_asin_unique'",
      );
      expect((idx.rows[0]!.sql as string).toLowerCase()).toContain('upper');

      // A case-drifted duplicate of an existing ASIN is rejected...
      await client.execute("INSERT INTO books (public_id, title, asin) VALUES ('bk_a', 'Upper', 'B0ABC')");
      await expect(
        client.execute("INSERT INTO books (public_id, title, asin) VALUES ('bk_b', 'Lower', 'b0abc')"),
      ).rejects.toThrow(/UNIQUE constraint failed/);

      // ...while multiple NULL-ASIN rows still coexist (partial index on asin IS NOT NULL).
      await expect(
        client.execute("INSERT INTO books (public_id, title, asin) VALUES ('bk_c', 'Null One', NULL)"),
      ).resolves.toBeDefined();
      await expect(
        client.execute("INSERT INTO books (public_id, title, asin) VALUES ('bk_d', 'Null Two', NULL)"),
      ).resolves.toBeDefined();
    } finally {
      client.close();
    }
  });
});
