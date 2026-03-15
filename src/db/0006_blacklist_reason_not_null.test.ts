import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Migration integration test for 0006_blacklist_reason_not_null.sql.
 * Seeds a pre-migration blacklist table with NULL reason rows,
 * runs the migration, and verifies backfill + NOT NULL constraint.
 */

const migrationSql = readFileSync(
  resolve(__dirname, '../../drizzle/0006_blacklist_reason_not_null.sql'),
  'utf-8',
);

// Pre-migration schema (columns in order from 0000 + 0001 migrations)
// books table stub required for FK reference
const PRE_MIGRATION_SCHEMA = `
  CREATE TABLE \`books\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL
  );
  CREATE TABLE \`blacklist\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`book_id\` integer,
    \`info_hash\` text NOT NULL,
    \`title\` text NOT NULL,
    \`reason\` text,
    \`note\` text,
    \`blacklisted_at\` integer DEFAULT (unixepoch()) NOT NULL,
    \`blacklist_type\` text DEFAULT 'permanent' NOT NULL,
    \`expires_at\` integer
  );
  CREATE INDEX \`idx_blacklist_info_hash\` ON \`blacklist\` (\`info_hash\`);
  CREATE INDEX \`idx_blacklist_book_id\` ON \`blacklist\` (\`book_id\`);
`;

describe('migration 0006_blacklist_reason_not_null', () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ':memory:' });
    // Create pre-migration schema
    for (const stmt of PRE_MIGRATION_SCHEMA.split(';').filter((s) => s.trim())) {
      await client.execute(stmt);
    }
  });

  afterEach(() => {
    client.close();
  });

  it('backfills NULL reasons to "other" and applies NOT NULL constraint', async () => {
    // Seed rows: one with NULL reason, one with existing reason
    await client.execute({
      sql: `INSERT INTO blacklist (info_hash, title, reason, blacklist_type) VALUES (?, ?, ?, ?)`,
      args: ['hash1', 'Null Reason Entry', null, 'permanent'],
    });
    await client.execute({
      sql: `INSERT INTO blacklist (info_hash, title, reason, blacklist_type) VALUES (?, ?, ?, ?)`,
      args: ['hash2', 'Has Reason Entry', 'bad_quality', 'temporary'],
    });

    // Run migration statements (split on --> statement-breakpoint)
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await client.execute(stmt);
    }

    // Verify backfill: NULL reason → 'other'
    const rows = await client.execute('SELECT id, info_hash, title, reason, blacklist_type FROM blacklist ORDER BY id');
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      info_hash: 'hash1',
      title: 'Null Reason Entry',
      reason: 'other',
    });
    // Existing reason preserved
    expect(rows.rows[1]).toMatchObject({
      info_hash: 'hash2',
      title: 'Has Reason Entry',
      reason: 'bad_quality',
    });

    // Verify NOT NULL constraint: inserting with NULL reason should fail
    await expect(
      client.execute({
        sql: `INSERT INTO blacklist (info_hash, title, reason, blacklist_type) VALUES (?, ?, ?, ?)`,
        args: ['hash3', 'Should Fail', null, 'permanent'],
      }),
    ).rejects.toThrow();
  });

  it('preserves indexes after table rebuild', async () => {
    // Run migration on empty table
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await client.execute(stmt);
    }

    // Check indexes exist
    const indexes = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='blacklist' ORDER BY name`,
    );
    const indexNames = indexes.rows.map((r) => r.name);
    expect(indexNames).toContain('idx_blacklist_book_id');
    expect(indexNames).toContain('idx_blacklist_info_hash');
  });
});
