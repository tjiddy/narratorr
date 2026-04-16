import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { authors, bookAuthors, books, downloadClients, indexers } from '../../src/db/schema.js';
import { seedE2ERun, SEED_AUTHOR_NAME, SEED_BOOK_TITLE } from './seed.js';

describe('seedE2ERun', () => {
  let dbPath: string;
  let cleanupDir: string;

  beforeEach(() => {
    cleanupDir = mkdtempSync(join(tmpdir(), 'seed-test-'));
    dbPath = join(cleanupDir, 'test.db');
  });

  afterEach(() => {
    try { rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function openDb() {
    const client = createClient({ url: `file:${dbPath}` });
    return { client, db: drizzle(client) };
  }

  it('runs Drizzle migrations against the per-run DB path before inserting rows', async () => {
    // If migrations didn't run, the insert would throw `no such table: indexers`.
    await expect(seedE2ERun({
      dbPath, mamUrl: 'http://localhost:4100', qbitHost: 'localhost', qbitPort: 4200, libraryPath: '/tmp/library',
    })).resolves.toBeDefined();
  });

  it('inserts an indexers row with baseUrl and mamId in settings', async () => {
    const ids = await seedE2ERun({
      dbPath, mamUrl: 'http://localhost:4100', qbitHost: 'localhost', qbitPort: 4200, libraryPath: '/tmp/library',
    });

    const { client, db } = openDb();
    try {
      const row = (await db.select().from(indexers).where(eq(indexers.id, ids.indexerId)))[0];
      expect(row.type).toBe('myanonamouse');
      expect(row.enabled).toBe(true);
      const settings = row.settings as { baseUrl: string; mamId: string };
      expect(settings.baseUrl).toBe('http://localhost:4100');
      expect(settings.mamId).toBe('test-mam-id');
    } finally {
      client.close();
    }
  });

  it('inserts a download_clients row with qBit settings (no savePath field)', async () => {
    const ids = await seedE2ERun({
      dbPath, mamUrl: 'http://localhost:4100', qbitHost: 'localhost', qbitPort: 4200, libraryPath: '/tmp/library',
    });

    const { client, db } = openDb();
    try {
      const row = (await db.select().from(downloadClients).where(eq(downloadClients.id, ids.downloadClientId)))[0];
      expect(row.type).toBe('qbittorrent');
      const settings = row.settings as Record<string, unknown>;
      expect(settings.host).toBe('localhost');
      expect(settings.port).toBe(4200);
      expect(settings.useSsl).toBe(false);
      // qbittorrentSettingsSchema is .strict() — savePath is not a valid field.
      expect(settings.savePath).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it('inserts an author row with the seeded author name', async () => {
    const ids = await seedE2ERun({
      dbPath, mamUrl: 'http://localhost:4100', qbitHost: 'localhost', qbitPort: 4200, libraryPath: '/tmp/library',
    });

    const { client, db } = openDb();
    try {
      const row = (await db.select().from(authors).where(eq(authors.id, ids.authorId)))[0];
      expect(row.name).toBe(SEED_AUTHOR_NAME);
      expect(row.slug).toMatch(/^e2e-test-author$/);
    } finally {
      client.close();
    }
  });

  it('inserts a book row linked to the author with status=wanted', async () => {
    const ids = await seedE2ERun({
      dbPath, mamUrl: 'http://localhost:4100', qbitHost: 'localhost', qbitPort: 4200, libraryPath: '/tmp/library',
    });

    const { client, db } = openDb();
    try {
      const bookRow = (await db.select().from(books).where(eq(books.id, ids.bookId)))[0];
      expect(bookRow.title).toBe(SEED_BOOK_TITLE);
      expect(bookRow.status).toBe('wanted');

      const link = (await db.select().from(bookAuthors).where(eq(bookAuthors.bookId, ids.bookId)))[0];
      expect(link.authorId).toBe(ids.authorId);
      expect(link.position).toBe(0);
    } finally {
      client.close();
    }
  });

  it('returns the primary-key ids for all inserted rows', async () => {
    const ids = await seedE2ERun({
      dbPath, mamUrl: 'http://localhost:4100', qbitHost: 'localhost', qbitPort: 4200, libraryPath: '/tmp/library',
    });
    expect(ids.indexerId).toBeGreaterThan(0);
    expect(ids.downloadClientId).toBeGreaterThan(0);
    expect(ids.authorId).toBeGreaterThan(0);
    expect(ids.bookId).toBeGreaterThan(0);
  });
});
