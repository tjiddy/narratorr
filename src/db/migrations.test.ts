import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('migration 0002_dizzy_captain_cross — drop unused authors columns', () => {
  let dir: string;
  let dbFile: string;
  let client: ReturnType<typeof createClient>;

  async function applyMigrationFile(relPath: string) {
    const sql = readFileSync(join(process.cwd(), relPath), 'utf-8')
      .replace(/-->\s*statement-breakpoint/g, '');
    await client.executeMultiple(sql);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'authors-migration-'));
    dbFile = join(dir, 'narratorr.db');
    client = createClient({ url: `file:${dbFile}` });
  });

  afterEach(() => {
    client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep file handles on Windows
    }
  });

  it('drops image_url/bio/monitored/last_checked_at while preserving surviving rows', async () => {
    await applyMigrationFile('drizzle/0000_slimy_johnny_storm.sql');
    await applyMigrationFile('drizzle/0001_flashy_doctor_strange.sql');

    await client.execute({
      sql: 'INSERT INTO authors (id, name, slug, asin, image_url, bio, monitored, last_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [1, 'Brandon Sanderson', 'brandon-sanderson', 'B000APZOQA', 'https://img/sanderson.jpg', 'Epic fantasy author', 1, 1700000000],
    });
    await client.execute({
      sql: 'INSERT INTO authors (id, name, slug, asin, image_url, bio, monitored, last_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [2, 'Patrick Rothfuss', 'patrick-rothfuss', 'B001H6GVSE', 'https://img/rothfuss.jpg', 'Author of Kingkiller', 0, 1700000001],
    });

    await applyMigrationFile('drizzle/0002_dizzy_captain_cross.sql');

    const cols = await client.execute(`PRAGMA table_info(authors)`);
    const colNames = cols.rows.map((r) => r.name as string);
    expect(colNames).not.toContain('image_url');
    expect(colNames).not.toContain('bio');
    expect(colNames).not.toContain('monitored');
    expect(colNames).not.toContain('last_checked_at');
    expect(colNames).toEqual(expect.arrayContaining(['id', 'name', 'slug', 'asin', 'created_at', 'updated_at']));

    const rows = await client.execute('SELECT id, name, slug, asin FROM authors ORDER BY id');
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson', asin: 'B000APZOQA' });
    expect(rows.rows[1]).toMatchObject({ id: 2, name: 'Patrick Rothfuss', slug: 'patrick-rothfuss', asin: 'B001H6GVSE' });
  });
});
