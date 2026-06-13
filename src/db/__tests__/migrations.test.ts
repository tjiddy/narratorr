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

    // Migration 0001 (#1303) drops the dead `suggestions.snooze_until` column.
    // Pin the drop: assert the column is absent after running the production
    // drizzle/ folder so a re-add (or a snapshot regression that regenerates it)
    // fails this suite. A survivor column (`dismissed_at`) anchors the assertion
    // so a typo'd table name can't make it pass vacuously.
    const suggestionColumns = await columnNames(dbPath, 'suggestions');
    expect(suggestionColumns.has('snooze_until'), 'suggestions.snooze_until must stay dropped by migration 0001').toBe(false);
    expect(suggestionColumns.has('dismissed_at'), 'expected survivor column suggestions.dismissed_at').toBe(true);
  });

  // #1445 — the backfill (migration 0003) must reproduce the exact inverse of
  // deriveDisplayStatus for every legacy `status` value. Drive the real backfill
  // SQL against a seeded post-0002 table shape and assert the resulting tuple.
  it('0003 backfill maps every legacy status to the correct (client_status, pipeline_stage) tuple', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'narratorr-backfill-test-'));
    const dbPath = join(tmpDir, 'test.db');

    // The AC mapping table — hardcoded here so it is an independent regression
    // guard, not a re-derivation of the production helper.
    const EXPECTED: Record<string, { client: string; pipeline: string }> = {
      queued: { client: 'queued', pipeline: 'idle' },
      downloading: { client: 'downloading', pipeline: 'idle' },
      paused: { client: 'paused', pipeline: 'idle' },
      completed: { client: 'completed', pipeline: 'idle' },
      failed: { client: 'failed', pipeline: 'idle' },
      checking: { client: 'completed', pipeline: 'checking' },
      pending_review: { client: 'completed', pipeline: 'pending_review' },
      importing: { client: 'completed', pipeline: 'importing' },
      imported: { client: 'completed', pipeline: 'imported' },
    };

    const client = createClient({ url: `file:${dbPath}` });
    try {
      // Reproduce the post-0002 table shape: legacy `status` plus the two new
      // axis columns with their migration-0002 defaults.
      await client.execute(
        `CREATE TABLE downloads (
           id INTEGER PRIMARY KEY,
           status TEXT NOT NULL,
           client_status TEXT NOT NULL DEFAULT 'queued',
           pipeline_stage TEXT NOT NULL DEFAULT 'idle'
         )`,
      );
      const legacyValues = Object.keys(EXPECTED);
      for (let i = 0; i < legacyValues.length; i++) {
        await client.execute({
          sql: 'INSERT INTO downloads (id, status) VALUES (?, ?)',
          args: [i + 1, legacyValues[i]!],
        });
      }

      // Execute the real backfill SQL, statement by statement.
      const sql = readFileSync(join(PROD_DRIZZLE, '0003_backfill_download_status_axes.sql'), 'utf-8');
      for (const stmt of sql.split('--> statement-breakpoint')) {
        const trimmed = stmt.replace(/^\s*--.*$/gm, '').trim();
        if (trimmed) await client.execute(trimmed);
      }

      const rows = await client.execute('SELECT status, client_status, pipeline_stage FROM downloads');
      for (const row of rows.rows) {
        const legacy = row.status as string;
        expect({ client: row.client_status, pipeline: row.pipeline_stage }).toEqual(EXPECTED[legacy]);
      }
    } finally {
      client.close();
    }
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
