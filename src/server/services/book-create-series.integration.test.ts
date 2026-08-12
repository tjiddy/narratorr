import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, series, seriesMembers } from '@db/schema.js';
import { BookService } from './book.service.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

/**
 * #2224: the create chokepoint is the only thing standing between a blank provider series name and a
 * durable `series` row with `normalized_name = ''` — the row every other blank-named book collapses
 * into. Only a migrated DB can observe that collapse; the mocked suite observes the insert payload.
 */
describe('BookService.create — a blank series name seeds no series row (#2224)', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'book-create-series-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = inject<FastifyBaseLogger>(createMockLogger());
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libSQL may retain the file handle on Windows.
    }
  });

  it('two differently-blank names create no series rows at all — in particular none with normalized_name = ""', async () => {
    const svc = new BookService(db, log);

    const spaces = await svc.create({ title: 'Leviathan Wakes', authors: [{ name: 'James S. A. Corey' }], seriesName: '   ', seriesPosition: 1 });
    const tab = await svc.create({ title: 'Caliban’s War', authors: [{ name: 'James S. A. Corey' }], seriesName: '\t', seriesPosition: 2 });

    expect(await db.select().from(series)).toHaveLength(0);
    expect(await db.select().from(seriesMembers)).toHaveLength(0);

    for (const id of [spaces.id, tab.id]) {
      const [row] = await db.select().from(books).where(eq(books.id, id));
      expect(row!.seriesName).toBeNull();
      expect(row!.seriesPosition).toBeNull();
    }
  });

  it('a usable name still creates exactly one series row and one member row', async () => {
    const svc = new BookService(db, log);

    const created = await svc.create({ title: 'Abaddon’s Gate', authors: [{ name: 'James S. A. Corey' }], seriesName: 'The Expanse', seriesPosition: 3 });

    const seriesRows = await db.select().from(series);
    expect(seriesRows).toHaveLength(1);
    expect(seriesRows[0]!.normalizedName).toBe('the expanse');
    const members = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, created.id));
    expect(members).toHaveLength(1);

    const [row] = await db.select().from(books).where(eq(books.id, created.id));
    expect(row!.seriesName).toBe('The Expanse');
    expect(row!.seriesPosition).toBe(3);
  });

  it('a padded-but-usable name is persisted verbatim, untrimmed', async () => {
    const svc = new BookService(db, log);

    const created = await svc.create({ title: 'Cibola Burn', authors: [{ name: 'James S. A. Corey' }], seriesName: '  The Expanse  ', seriesPosition: 4 });

    const [row] = await db.select().from(books).where(eq(books.id, created.id));
    expect(row!.seriesName).toBe('  The Expanse  ');
    expect(row!.seriesPosition).toBe(4);
  });
});
