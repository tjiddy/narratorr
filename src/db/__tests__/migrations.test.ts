import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
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
    // enrichment_attempts (#1630), production_type (#1717 story 1,
    // drizzle/0001_melted_human_robot.sql) and edition_label (#1717 this story,
    // drizzle/0002_futuristic_fat_cobra.sql). Pin their presence so a future
    // re-flatten that drops any of them fails here. Both production_type (edition
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

describe('0003 ASIN case-insensitive migration (#1733)', () => {
  let tmpDir: string;

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows: libsql file handles may linger briefly after close()
    }
  });

  // Read the production journal once so the test stays correct if the migration
  // is renamed/re-flattened: the pre-0003 schema is built from the entries with
  // idx < 3, and the 0003 SQL is located by the idx === 3 tag.
  const journal = JSON.parse(readFileSync(join(PROD_DRIZZLE, 'meta', '_journal.json'), 'utf-8')) as {
    entries: { idx: number; tag: string }[];
  };

  /** Build a migrations folder containing only the pre-0003 entries and apply it. */
  async function applyPre0003(dbPath: string): Promise<void> {
    const preFolder = join(tmpDir, 'pre-0003');
    mkdirSync(join(preFolder, 'meta'), { recursive: true });
    const preEntries = journal.entries.filter((e) => e.idx < 3);
    for (const e of preEntries) {
      copyFileSync(join(PROD_DRIZZLE, `${e.tag}.sql`), join(preFolder, `${e.tag}.sql`));
    }
    writeFileSync(join(preFolder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: preEntries }));
    const client = createClient({ url: `file:${dbPath}` });
    try {
      await migrate(drizzle(client), { migrationsFolder: preFolder });
    } finally {
      client.close();
    }
  }

  it('completes on case-drifted fixture data: canonicalizes survivors, quarantines collisions, installs the upper(asin) unique index', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'narratorr-asin-mig-test-'));
    const dbPath = join(tmpDir, 'test.db');

    await applyPre0003(dbPath);

    const client = createClient({ url: `file:${dbPath}` });
    try {
      // (a) a normal lowercase ASIN row, and (b) two rows whose ASINs differ only
      // by case. These coexist under the OLD case-sensitive index.
      await client.execute("INSERT INTO books (public_id, title, asin) VALUES ('bk_a', 'Normal', 'b0normal')");
      await client.execute("INSERT INTO books (public_id, title, asin) VALUES ('bk_b1', 'Dup Upper', 'B0DUP')");
      await client.execute("INSERT INTO books (public_id, title, asin) VALUES ('bk_b2', 'Dup Lower', 'b0dup')");

      // Apply the 0003 migration statement-by-statement. It MUST complete.
      const tag0003 = journal.entries.find((e) => e.idx === 3)!.tag;
      const migrationSql = readFileSync(join(PROD_DRIZZLE, `${tag0003}.sql`), 'utf-8');
      for (const stmt of migrationSql.split('--> statement-breakpoint')) {
        const trimmed = stmt.trim();
        if (trimmed) {
          await expect(client.execute(trimmed)).resolves.toBeDefined();
        }
      }

      const rows = await client.execute('SELECT public_id, asin FROM books ORDER BY id');
      const byPublicId = new Map(rows.rows.map((r) => [r.public_id as string, r.asin as string | null]));
      // (a) the normal row is uppercased.
      expect(byPublicId.get('bk_a')).toBe('B0NORMAL');
      // (b) the lower-id row keeps the uppercased ASIN; the higher-id row is quarantined to NULL.
      expect(byPublicId.get('bk_b1')).toBe('B0DUP');
      expect(byPublicId.get('bk_b2')).toBeNull();

      // The new unique index exists and is on upper(asin).
      const idx = await client.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_books_asin_unique'",
      );
      expect((idx.rows[0]!.sql as string).toLowerCase()).toContain('upper');

      // It rejects a fresh case-drifted duplicate of a surviving ASIN...
      await expect(
        client.execute("INSERT INTO books (public_id, title, asin) VALUES ('bk_c', 'Case Drift', 'b0normal')"),
      ).rejects.toThrow(/UNIQUE constraint failed/);

      // ...while a freed (quarantined) ASIN value can be re-claimed, and NULL rows still coexist.
      await expect(
        client.execute("INSERT INTO books (public_id, title, asin) VALUES ('bk_d', 'Null One', NULL)"),
      ).resolves.toBeDefined();
      await expect(
        client.execute("INSERT INTO books (public_id, title, asin) VALUES ('bk_e', 'Null Two', NULL)"),
      ).resolves.toBeDefined();
    } finally {
      client.close();
    }
  });
});
