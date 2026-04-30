import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createClient, type Client } from '@libsql/client';

// ===== #747 — migration 0003 dedupe verification =====
//
// Verifies that the migration's dedupe pass handles pre-existing active
// duplicates correctly BEFORE the partial unique index is created. The
// dedupe scopes to non-null book_id (orphans untouched), keeps the most
// recent active row per book_id (highest created_at, tiebreak by id), and
// flips losers to status='failed' with an explanatory last_error.

interface ImportJobRow {
  id: number;
  book_id: number | null;
  status: string;
  type: string;
  created_at: number;
  last_error: string | null;
}

describe('migration 0003 — dedupe pass for #747', () => {
  let dir: string;
  let client: Client;

  /** Build a pre-migration schema (no unique index yet) and seed data. */
  async function setupPreMigrationDb(seed: Array<Partial<ImportJobRow> & { book_id: number | null; status: string }>) {
    dir = mkdtempSync(join(tmpdir(), 'mig-0003-'));
    const dbFile = join(dir, 'narratorr.db');
    client = createClient({ url: `file:${dbFile}` });

    // Apply migrations 0000..0002 by reading the journal in order. We replay
    // only the *prior* migrations so we can manually run 0003's dedupe SQL
    // ourselves (asserting on its output) and verify the unique-index
    // creation doesn't fail afterwards.
    const journal = JSON.parse(readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries.slice(0, 3)) {
      const sql = readFileSync(join(process.cwd(), `drizzle/${entry.tag}.sql`), 'utf8');
      const statements = sql.split('-->').map((s) => s.replace(/statement-breakpoint/g, '').trim()).filter(Boolean);
      for (const stmt of statements) {
        await client.execute(stmt);
      }
    }

    // Seed a books row for each non-null book_id we plan to insert (FK).
    const bookIds = new Set<number>();
    for (const row of seed) {
      if (row.book_id != null) bookIds.add(row.book_id);
    }
    for (const id of bookIds) {
      await client.execute({ sql: 'INSERT INTO books (id, title) VALUES (?, ?)', args: [id, `Book ${id}`] });
    }

    // Seed import_jobs rows.
    for (const row of seed) {
      await client.execute({
        sql: 'INSERT INTO import_jobs (book_id, type, status, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
        args: [row.book_id, row.type ?? 'auto', row.status, '{}', row.created_at ?? Math.floor(Date.now() / 1000)],
      });
    }
  }

  async function applyMigration0003() {
    const sql = readFileSync(join(process.cwd(), 'drizzle/0003_sweet_dorian_gray.sql'), 'utf8');
    const statements = sql.split('-->').map((s) => s.replace(/statement-breakpoint/g, '').trim()).filter(Boolean);
    for (const stmt of statements) {
      await client.execute(stmt);
    }
  }

  async function allActive(): Promise<ImportJobRow[]> {
    const result = await client.execute(`SELECT id, book_id, status, type, created_at, last_error FROM import_jobs WHERE status IN ('pending', 'processing') ORDER BY id`);
    return result.rows as unknown as ImportJobRow[];
  }

  async function allRows(): Promise<ImportJobRow[]> {
    const result = await client.execute(`SELECT id, book_id, status, type, created_at, last_error FROM import_jobs ORDER BY id`);
    return result.rows as unknown as ImportJobRow[];
  }

  afterEach(() => {
    try { client.close(); } catch { /* libsql may keep handle on Windows */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('dedupes 3 active rows for the same book_id, keeping the newest and marking losers failed', async () => {
    await setupPreMigrationDb([
      { book_id: 1, status: 'pending', created_at: 1000 },
      { book_id: 1, status: 'processing', created_at: 1500 },
      { book_id: 1, status: 'pending', created_at: 2000 }, // newest — survives
    ]);

    await applyMigration0003();

    const active = await allActive();
    expect(active).toHaveLength(1);
    expect(active[0].book_id).toBe(1);
    expect(active[0].created_at).toBe(2000);

    const all = await allRows();
    const losers = all.filter((r) => r.status === 'failed');
    expect(losers).toHaveLength(2);
    for (const l of losers) {
      expect(l.last_error).toContain('Superseded by newer active job');
    }
  });

  it('is a no-op for data when no duplicates exist (only adds the index)', async () => {
    await setupPreMigrationDb([
      { book_id: 1, status: 'pending', created_at: 1000 },
      { book_id: 2, status: 'processing', created_at: 1100 },
    ]);

    await applyMigration0003();

    const active = await allActive();
    expect(active).toHaveLength(2);
    const all = await allRows();
    expect(all.filter((r) => r.status === 'failed')).toHaveLength(0);
  });

  it('leaves NULL-bookId orphan active rows untouched (multiple permitted post-migration)', async () => {
    await setupPreMigrationDb([
      { book_id: null, status: 'pending', created_at: 1000 },
      { book_id: null, status: 'pending', created_at: 1100 },
      { book_id: null, status: 'processing', created_at: 1200 },
    ]);

    await applyMigration0003();

    const active = await allActive();
    expect(active).toHaveLength(3);
    expect(active.every((r) => r.book_id == null)).toBe(true);
    expect(active.every((r) => r.last_error == null)).toBe(true);
  });

  it('mixed seed: dedupes per-book groups, leaves orphans, leaves non-active rows alone', async () => {
    await setupPreMigrationDb([
      { book_id: 1, status: 'pending', created_at: 1000 },
      { book_id: 1, status: 'pending', created_at: 2000 }, // newest of book 1
      { book_id: 2, status: 'processing', created_at: 1500 }, // sole active for book 2
      { book_id: null, status: 'pending', created_at: 1600 }, // orphan
      { book_id: null, status: 'pending', created_at: 1700 }, // orphan
      { book_id: 1, status: 'completed', created_at: 500 }, // not active — untouched
      { book_id: 2, status: 'failed', created_at: 600 }, // not active — untouched
    ]);

    await applyMigration0003();

    const active = await allActive();
    // book 1 newest + book 2 sole + 2 orphans = 4
    expect(active).toHaveLength(4);

    const book1Active = active.filter((r) => r.book_id === 1);
    expect(book1Active).toHaveLength(1);
    expect(book1Active[0].created_at).toBe(2000);

    const book2Active = active.filter((r) => r.book_id === 2);
    expect(book2Active).toHaveLength(1);

    const orphans = active.filter((r) => r.book_id == null);
    expect(orphans).toHaveLength(2);

    const all = await allRows();
    // 1 loser from book 1 (the older pending) flipped to failed.
    const dedupeLosers = all.filter((r) => r.last_error?.includes('Superseded'));
    expect(dedupeLosers).toHaveLength(1);
    expect(dedupeLosers[0].book_id).toBe(1);
  });

  it('post-migration: unique index prevents new duplicate inserts for the same book_id', async () => {
    await setupPreMigrationDb([
      { book_id: 1, status: 'pending', created_at: 1000 },
    ]);

    await applyMigration0003();

    // Inserting another active row for book 1 must fail with UNIQUE constraint.
    let err: unknown;
    try {
      await client.execute({
        sql: 'INSERT INTO import_jobs (book_id, type, status, metadata) VALUES (?, ?, ?, ?)',
        args: [1, 'auto', 'pending', '{}'],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const message = (err as Error).message;
    expect(message).toMatch(/UNIQUE constraint/);
  });
});
