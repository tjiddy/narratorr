import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROD_DRIZZLE = join(__dirname, '..', '..', '..', 'drizzle');

// Representative application tables, not an exhaustive schema snapshot.
const CORE_TABLES = [
  'authors',
  'books',
  'book_authors',
  'book_events',
  'companion_ebooks',
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
      // libSQL file handles may linger on Windows.
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
    expect(names.has('__drizzle_migrations')).toBe(true);

    // Pair absence pins with a survivor so a bad table name cannot pass vacuously.
    const suggestionColumns = await columnNames(dbPath, 'suggestions');
    expect(suggestionColumns.has('snooze_until'), 'suggestions.snooze_until must not exist in the baseline schema').toBe(false);
    expect(suggestionColumns.has('dismissed_at'), 'expected survivor column suggestions.dismissed_at').toBe(true);

    const bookColumns = await columnNames(dbPath, 'books');
    expect(bookColumns.has('subtitle'), 'expected books.subtitle in the baseline schema').toBe(true);
    expect(bookColumns.has('publisher'), 'expected books.publisher in the baseline schema').toBe(true);
    expect(bookColumns.has('enrichment_attempts'), 'expected books.enrichment_attempts in the baseline schema').toBe(true);
    expect(bookColumns.has('production_type'), 'expected books.production_type in the baseline schema').toBe(true);
    expect(bookColumns.has('edition_label'), 'expected books.edition_label in the baseline schema').toBe(true);

    const seriesMemberColumns = await columnNames(dbPath, 'series_members');
    expect(seriesMemberColumns.has('last_seen_at'), 'series_members.last_seen_at must not exist in the baseline schema').toBe(false);
    expect(seriesMemberColumns.has('source'), 'expected survivor column series_members.source').toBe(true);

    const unmatchedGenreColumns = await columnNames(dbPath, 'unmatched_genres');
    expect(unmatchedGenreColumns.has('first_seen'), 'unmatched_genres.first_seen must not exist in the baseline schema').toBe(false);
    expect(unmatchedGenreColumns.has('genre'), 'expected survivor column unmatched_genres.genre').toBe(true);
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
    await expect(run()).resolves.not.toThrow();

    // Derive the expected count so adding migrations does not stale the test.
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
      // libSQL file handles may linger on Windows.
    }
  });

  // Pin the flattened baseline's expression/partial index, not canonicalization code.
  it('enforces case-insensitive ASIN uniqueness and still allows multiple NULLs', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'narratorr-asin-idx-test-'));
    const dbPath = join(tmpDir, 'test.db');

    const client = createClient({ url: `file:${dbPath}` });
    try {
      await migrate(drizzle(client), { migrationsFolder: PROD_DRIZZLE });

      const idx = await client.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_books_asin_unique'",
      );
      expect((idx.rows[0]!.sql as string).toLowerCase()).toContain('upper');

      await client.execute("INSERT INTO books (public_id, title, asin) VALUES ('bk_a', 'Upper', 'B0ABC')");
      await expect(
        client.execute("INSERT INTO books (public_id, title, asin) VALUES ('bk_b', 'Lower', 'b0abc')"),
      ).rejects.toThrow(/UNIQUE constraint failed/);

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
