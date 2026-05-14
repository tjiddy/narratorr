import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';

// Resolve the production drizzle/ folder from this test file's URL.
// __dirname for tests run via vitest points at src/db/__tests__/, so go up
// two levels to reach the repo root then into drizzle/.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROD_DRIZZLE = join(__dirname, '..', '..', '..', 'drizzle');
const NEW_MIGRATION_TAG = '0004_colossal_george_stacy';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}
interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

function readJournal(path: string): Journal {
  return JSON.parse(readFileSync(path, 'utf8')) as Journal;
}

function writeJournal(path: string, j: Journal) {
  writeFileSync(path, JSON.stringify(j, null, 2) + '\n', 'utf8');
}

/**
 * Build a temporary drizzle migration folder containing only migrations
 * 0000..0003 (i.e. the pre-#1103 schema, with monitor_for_upgrades + 'upgraded'
 * event-type + 'on_upgrade' notifier-event). The new 0004 SQL file and its
 * journal entry / snapshot are withheld so they can be applied in a second
 * pass after pre-migration rows are seeded.
 */
function setupSplitMigrationsFolder(): {
  tmpDir: string;
  migrationsFolder: string;
  applyNewMigration: () => Promise<void>;
  dbPath: string;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), 'narratorr-migration-test-'));
  const migrationsFolder = join(tmpDir, 'drizzle');
  mkdirSync(migrationsFolder, { recursive: true });
  mkdirSync(join(migrationsFolder, 'meta'), { recursive: true });

  // Copy all SQL files EXCEPT the new migration. Copy all snapshot files.
  const files = readdirSync(PROD_DRIZZLE);
  for (const file of files) {
    if (file === 'meta') continue;
    if (file.startsWith(NEW_MIGRATION_TAG)) continue;
    copyFileSync(join(PROD_DRIZZLE, file), join(migrationsFolder, file));
  }
  const metaFiles = readdirSync(join(PROD_DRIZZLE, 'meta'));
  for (const file of metaFiles) {
    if (file === '_journal.json') continue;
    // Skip the new migration's snapshot file (it's the highest-numbered one).
    // Drizzle snapshots are named "<idx>_snapshot.json" — the new one is 0004_snapshot.json.
    if (file.startsWith('0004_')) continue;
    copyFileSync(join(PROD_DRIZZLE, 'meta', file), join(migrationsFolder, 'meta', file));
  }

  // Write a truncated journal that omits the new migration's entry.
  const realJournal = readJournal(join(PROD_DRIZZLE, 'meta', '_journal.json'));
  const truncatedJournal: Journal = {
    ...realJournal,
    entries: realJournal.entries.filter((e) => e.tag !== NEW_MIGRATION_TAG),
  };
  writeJournal(join(migrationsFolder, 'meta', '_journal.json'), truncatedJournal);

  const dbPath = join(tmpDir, 'test.db');

  async function applyNewMigration() {
    // Stage 2: restore the new migration SQL and append its journal entry, then
    // re-run the migrator. Because the journal is checksum-tracked by Drizzle,
    // only the new entry will run.
    copyFileSync(join(PROD_DRIZZLE, `${NEW_MIGRATION_TAG}.sql`), join(migrationsFolder, `${NEW_MIGRATION_TAG}.sql`));
    const snapshotFile = readdirSync(join(PROD_DRIZZLE, 'meta')).find((f) => f.startsWith('0004_'));
    if (snapshotFile) {
      copyFileSync(join(PROD_DRIZZLE, 'meta', snapshotFile), join(migrationsFolder, 'meta', snapshotFile));
    }
    const newEntry = realJournal.entries.find((e) => e.tag === NEW_MIGRATION_TAG);
    if (!newEntry) throw new Error(`Could not locate journal entry for ${NEW_MIGRATION_TAG} in production journal`);
    const fullJournal: Journal = { ...realJournal, entries: [...truncatedJournal.entries, newEntry] };
    writeJournal(join(migrationsFolder, 'meta', '_journal.json'), fullJournal);

    const client = createClient({ url: `file:${dbPath}` });
    const db = drizzle(client);
    try {
      await migrate(db, { migrationsFolder });
    } finally {
      client.close();
    }
  }

  return { tmpDir, migrationsFolder, applyNewMigration, dbPath };
}

async function applyPreMigration(migrationsFolder: string, dbPath: string): Promise<void> {
  const client = createClient({ url: `file:${dbPath}` });
  const db = drizzle(client);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    client.close();
  }
}

describe('#1103 migration 0004 — data transformations', () => {
  let ctx: ReturnType<typeof setupSplitMigrationsFolder>;

  beforeEach(async () => {
    ctx = setupSplitMigrationsFolder();
    await applyPreMigration(ctx.migrationsFolder, ctx.dbPath);
  });

  afterEach(() => {
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  it('drops books.monitor_for_upgrades column and remaps upgraded → imported and scrubs on_upgrade', async () => {
    // ── Seed pre-migration rows (pre-state has monitor_for_upgrades column, 'upgraded' event type, on_upgrade events) ──
    const seedClient = createClient({ url: `file:${ctx.dbPath}` });
    try {
      // books with monitor_for_upgrades flag
      await seedClient.execute({
        sql: `INSERT INTO books (id, title, monitor_for_upgrades, status, enrichment_status) VALUES (?, ?, ?, ?, ?)`,
        args: [1, 'Monitored Book', 1, 'imported', 'enriched'],
      });
      await seedClient.execute({
        sql: `INSERT INTO books (id, title, monitor_for_upgrades, status, enrichment_status) VALUES (?, ?, ?, ?, ?)`,
        args: [2, 'Unmonitored Book', 0, 'wanted', 'pending'],
      });

      // book_events including the 'upgraded' type
      await seedClient.execute({
        sql: `INSERT INTO book_events (book_id, book_title, event_type, source) VALUES (?, ?, ?, ?)`,
        args: [1, 'Monitored Book', 'upgraded', 'auto'],
      });
      await seedClient.execute({
        sql: `INSERT INTO book_events (book_id, book_title, event_type, source) VALUES (?, ?, ?, ?)`,
        args: [1, 'Monitored Book', 'imported', 'auto'],
      });
      await seedClient.execute({
        sql: `INSERT INTO book_events (book_id, book_title, event_type, source) VALUES (?, ?, ?, ?)`,
        args: [2, 'Unmonitored Book', 'merged', 'manual'],
      });

      // notifiers with events arrays that include on_upgrade
      await seedClient.execute({
        sql: `INSERT INTO notifiers (id, name, type, enabled, events, settings) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [1, 'Mixed Notifier', 'discord', 1, JSON.stringify(['on_upgrade', 'on_grab']), '{}'],
      });
      await seedClient.execute({
        sql: `INSERT INTO notifiers (id, name, type, enabled, events, settings) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [2, 'Upgrade-only Notifier', 'discord', 1, JSON.stringify(['on_upgrade']), '{}'],
      });
      await seedClient.execute({
        sql: `INSERT INTO notifiers (id, name, type, enabled, events, settings) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [3, 'Untouched Notifier', 'discord', 1, JSON.stringify(['on_grab']), '{}'],
      });
    } finally {
      seedClient.close();
    }

    // ── Apply the 0004 migration via the actual Drizzle migrator ──
    await ctx.applyNewMigration();

    // ── Assert post-state ──
    const verifyClient = createClient({ url: `file:${ctx.dbPath}` });
    try {
      // books table: monitor_for_upgrades column is gone
      const cols = await verifyClient.execute('PRAGMA table_info(books)');
      const colNames = cols.rows.map((r) => (r as Record<string, unknown>).name);
      expect(colNames).not.toContain('monitor_for_upgrades');

      // book_events: 'upgraded' rows remapped to 'imported'; existing 'imported' + 'merged' untouched
      const events = await verifyClient.execute('SELECT book_title, event_type FROM book_events ORDER BY id');
      expect(events.rows).toHaveLength(3);
      expect(events.rows[0]!.event_type).toBe('imported'); // was 'upgraded' → remapped
      expect(events.rows[1]!.event_type).toBe('imported');
      expect(events.rows[2]!.event_type).toBe('merged');

      // notifiers: scrub + disable
      const notifiers = await verifyClient.execute('SELECT id, name, enabled, events FROM notifiers ORDER BY id');
      expect(notifiers.rows).toHaveLength(3);
      const parseEvents = (row: Record<string, unknown>) => JSON.parse(row.events as string) as string[];
      // Mixed Notifier: ['on_upgrade', 'on_grab'] → ['on_grab'], enabled stays 1
      expect(parseEvents(notifiers.rows[0]!)).toEqual(['on_grab']);
      expect(notifiers.rows[0]!.enabled).toBe(1);
      // Upgrade-only Notifier: ['on_upgrade'] → [], enabled flipped to 0
      expect(parseEvents(notifiers.rows[1]!)).toEqual([]);
      expect(notifiers.rows[1]!.enabled).toBe(0);
      // Untouched Notifier: ['on_grab'] → ['on_grab'], enabled stays 1
      expect(parseEvents(notifiers.rows[2]!)).toEqual(['on_grab']);
      expect(notifiers.rows[2]!.enabled).toBe(1);
    } finally {
      verifyClient.close();
    }
  });

  it('is idempotent — re-running the migrator after applying 0004 is a no-op', async () => {
    // Seed minimal data, apply migration, then apply again — should not error
    const seedClient = createClient({ url: `file:${ctx.dbPath}` });
    try {
      await seedClient.execute({
        sql: `INSERT INTO notifiers (name, type, enabled, events, settings) VALUES (?, ?, ?, ?, ?)`,
        args: ['Test', 'discord', 1, JSON.stringify(['on_grab']), '{}'],
      });
    } finally {
      seedClient.close();
    }

    await ctx.applyNewMigration();
    // Second invocation — should not throw or re-apply
    await ctx.applyNewMigration();

    const verifyClient = createClient({ url: `file:${ctx.dbPath}` });
    try {
      const rows = await verifyClient.execute('SELECT enabled FROM notifiers');
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.enabled).toBe(1);
    } finally {
      verifyClient.close();
    }
  });
});
