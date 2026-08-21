import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { BookService } from '../services/book.service.js';
import { generatePublicId } from '../utils/public-id.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { runGenreMarkerSweep } from './genre-marker-sweep.js';

/**
 * #2535. `books.genres` is a JSON-mode text column, so an append is only real once it has crossed
 * Drizzle's encode/decode boundary: a mocked handle records the array the sweep passed in and can
 * never tell an appended array from a re-serialized one, nor prove the second run is a genuine
 * no-op rather than a rewrite of the same values.
 */
describe('genre marker sweep against a migrated database (#2535)', () => {
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'genre-marker-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    bookService = new BookService(db, inject<FastifyBaseLogger>(log));
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  async function seedBook(overrides: Partial<typeof books.$inferInsert>): Promise<number> {
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title: 'Untitled', status: 'imported', ...overrides })
      .returning();
    return row!.id;
  }

  const readGenres = async (id: number) =>
    (await db.select({ genres: books.genres }).from(books).where(eq(books.id, id)))[0]!.genres;

  const sweep = () => runGenreMarkerSweep(db, bookService, inject<FastifyBaseLogger>(log));

  it('appends the inferred genre to the stored array and leaves the second run a no-op', async () => {
    const id = await seedBook({
      title: 'The Land: Founding',
      subtitle: 'A LitRPG Saga (Chaos Seeds, Book 1)',
      genres: ['Humor', 'Fantasy', 'Action & Adventure', 'Epic Fantasy', 'Satire'],
    });

    await sweep();

    expect(await readGenres(id)).toEqual([
      'Humor', 'Fantasy', 'Action & Adventure', 'Epic Fantasy', 'Satire', 'LitRPG',
    ]);

    log.debug.mockClear();
    log.info.mockClear();

    await sweep();

    expect(await readGenres(id)).toEqual([
      'Humor', 'Fantasy', 'Action & Adventure', 'Epic Fantasy', 'Satire', 'LitRPG',
    ]);
    // The converged row never reaches the lock loop, so the second run has no candidates at all —
    // a same-value rewrite would take the completion-log path instead.
    expect(log.debug).toHaveBeenCalledWith(expect.anything(), 'Genre marker sweep: no books need inferred genres');
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Genre marker sweep complete');
  });

  it('leaves an unmarked book\'s null genres untouched rather than writing an empty array', async () => {
    const id = await seedBook({ title: 'Dungeon Crawler Carl', genres: null });

    await sweep();

    expect(await readGenres(id)).toBeNull();
  });

  it('honours a persisted genres tombstone', async () => {
    const id = await seedBook({
      title: 'Mage Tank 2: A LitRPG Adventure',
      genres: ['Fantasy'],
      userClearedFields: '["genres"]',
    });

    await sweep();

    expect(await readGenres(id)).toEqual(['Fantasy']);
  });

  it('writes each marked book in a mixed library and skips the rest', async () => {
    const marked = await seedBook({ title: 'Chrysalis', seriesName: 'Chrysalis: A GameLit Saga', genres: ['Fantasy'] });
    const unmarked = await seedBook({ title: 'The Dungeon Corridor', genres: ['Fantasy'] });

    await sweep();

    expect(await readGenres(marked)).toEqual(['Fantasy', 'GameLit']);
    expect(await readGenres(unmarked)).toEqual(['Fantasy']);
  });
});
