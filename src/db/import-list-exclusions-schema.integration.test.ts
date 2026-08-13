import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, sql } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from './index.js';
import { importListExclusions, importLists } from './schema.js';

// Real migrated libSQL: nullability, the DDL default, the FK action and the index set are the
// subject, and none of them are observable through the ORM alone.

async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (caught: unknown) {
    let current: unknown = caught;
    const parts: string[] = [];
    while (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the statement to reject');
}

describe('import_list_exclusions schema (DB-backed, #2305)', () => {
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'excl-schema-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql can retain Windows handles; cleanup is best-effort.
    }
  });

  async function seedList(name: string): Promise<number> {
    const [row] = await db
      .insert(importLists)
      .values({ name, type: 'nyt', settings: {} })
      .returning();
    return row!.id;
  }

  it('accepts a row with every nullable identity column null', async () => {
    const [row] = await db.insert(importListExclusions).values({ title: 'Bare' }).returning();

    expect(row!.asin).toBeNull();
    expect(row!.authorName).toBeNull();
    expect(row!.authorSlug).toBeNull();
    expect(row!.importListId).toBeNull();
    expect(row!.importListName).toBeNull();
  });

  it('rejects a row with no title', async () => {
    const message = await rejectionMessage(() =>
      db.run(sql`INSERT INTO import_list_exclusions (asin) VALUES ('B0ABC12345')`),
    );
    expect(message).toContain('NOT NULL constraint failed: import_list_exclusions.title');
  });

  it('applies the created_at DDL default when the column is never named', async () => {
    // Raw SQL rather than the ORM: Drizzle inlines schema defaults into the INSERT, so a typed
    // insert would satisfy this assertion without the migration carrying DEFAULT (unixepoch()).
    await db.run(sql`INSERT INTO import_list_exclusions (title) VALUES ('Defaulted')`);

    const [row] = await db.select().from(importListExclusions);
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.createdAt.getTime()).toBeGreaterThan(0);
  });

  it('set-nulls import_list_id when the originating list is deleted but keeps the name snapshot', async () => {
    const listId = await seedList('Bestsellers');
    await db
      .insert(importListExclusions)
      .values({ title: 'Kept', importListId: listId, importListName: 'Bestsellers' });

    await db.delete(importLists).where(eq(importLists.id, listId));

    const [row] = await db.select().from(importListExclusions);
    expect(row!.importListId).toBeNull();
    expect(row!.importListName).toBe('Bestsellers');
  });

  it('allows two rows with identical identity columns — convergence is the service transaction, not a constraint', async () => {
    const values = { title: 'Same', asin: 'B0ABC12345', authorSlug: 'jane-doe' };
    await db.insert(importListExclusions).values(values);
    await db.insert(importListExclusions).values(values);

    expect(await db.select().from(importListExclusions)).toHaveLength(2);
  });

  it('creates exactly the three named narrowing indexes and nothing else', async () => {
    const res = await db.run(sql`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'import_list_exclusions' AND name NOT LIKE 'sqlite_autoindex%'
      ORDER BY name
    `);
    expect(res.rows.map((r) => r[0] as string)).toEqual([
      'idx_import_list_exclusions_asin',
      'idx_import_list_exclusions_author_slug',
      'idx_import_list_exclusions_import_list_id',
    ]);
  });

  it('indexes the columns each narrowing arm reads', async () => {
    async function indexColumns(indexName: string): Promise<string[]> {
      const res = await db.run(sql`SELECT name FROM pragma_index_info(${indexName}) ORDER BY seqno`);
      return res.rows.map((r) => r[0] as string);
    }
    expect(await indexColumns('idx_import_list_exclusions_asin')).toEqual(['asin']);
    expect(await indexColumns('idx_import_list_exclusions_author_slug')).toEqual(['author_slug']);
    expect(await indexColumns('idx_import_list_exclusions_import_list_id')).toEqual(['import_list_id']);
  });
});
