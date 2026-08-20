import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { bookNarrators, books, narrators } from '@db/schema.js';
import { BookService } from '../services/book.service.js';
import type { MetadataService } from '../services/metadata.service.js';
import { generatePublicId } from '../utils/public-id.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { runEnrichment } from './enrichment.js';

// Parkable/failable per narrator so the error-isolation arm can inject a rejection without
// issuing a failing SQL statement inside the transaction.
vi.mock('../utils/find-or-create-person.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  findOrCreateNarrator: vi.fn(),
}));

import { findOrCreateNarrator } from '../utils/find-or-create-person.js';

const actualPerson = await vi.importActual<typeof import('../utils/find-or-create-person.js')>(
  '../utils/find-or-create-person.js',
);

/**
 * #2479. The narrator junction inserts used to run on the root handle BEFORE the writeback opened
 * its guarded transaction, so a lost ASIN race rolled the scalar update back and left the junctions
 * committed — and fill-empty semantics then refused to ever fill again. Only a real migrated libSQL
 * database can observe that: `createMockDb().transaction` hands the callback the same `db` object,
 * so a mocked assertion cannot tell a rolled-back insert from a committed one.
 *
 * `resolveBook` is stubbed rather than driven through provider factories: these cases are about what
 * the writeback persists for a GIVEN resolved result, and the stub is the only way to pin narrator
 * lists, blank names and duplicate slugs exactly.
 */
describe('enrichment narrator writes are atomic with the scalar write (#2479)', () => {
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;

  /** Resolve by candidate title; anything unlisted is a no-match. */
  function resolverFor(byTitle: Record<string, Record<string, unknown>>): MetadataService {
    return inject<MetadataService>({
      resolveBook: vi.fn(({ title }: { title: string }) => Promise.resolve(byTitle[title] ?? null)),
    });
  }

  const sweep = (metadata: MetadataService) =>
    runEnrichment(db, metadata, bookService, inject<FastifyBaseLogger>(log));

  const junctionsFor = (bookId: number) =>
    db
      .select({ narratorId: bookNarrators.narratorId, position: bookNarrators.position, name: narrators.name })
      .from(bookNarrators)
      .innerJoin(narrators, eq(narrators.id, bookNarrators.narratorId))
      .where(eq(bookNarrators.bookId, bookId))
      .orderBy(asc(bookNarrators.position));

  const rowFor = async (bookId: number) => (await db.select().from(books).where(eq(books.id, bookId)))[0]!;

  const batchLog = (fields: Record<string, unknown>) =>
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining(fields), 'Enrichment batch completed');

  const NARRATOR_WARN = 'Failed to resolve narrator during enrichment';
  const narratorWarnings = () =>
    (log.warn as Mock).mock.calls.filter((args: unknown[]) => args[1] === NARRATOR_WARN);

  /** Insert a bare row that owns `asin`, so the losing candidate's guarded UPDATE violates the index. */
  const seedAsinOwner = (asin: string) =>
    db.insert(books).values({ publicId: generatePublicId('bk'), title: `Owner of ${asin}`, asin });

  beforeEach(async () => {
    vi.mocked(findOrCreateNarrator).mockReset().mockImplementation(actualPerson.findOrCreateNarrator);

    dir = mkdtempSync(join(tmpdir(), 'enrich-narrator-atomicity-'));
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
      // libsql may keep the file handle on Windows
    }
  });

  // ── Rollback atomicity ───────────────────────────────────────────────────────────────────────

  describe('a lost ASIN race leaves no narrator residue', () => {
    it('rolls back the junctions AND the narrator rows the pass created', async () => {
      const losing = await bookService.create({ title: 'Losing Book', authors: [{ name: 'Brandon Sanderson' }] });

      // Defeat the precheck rather than racing it: the conflicting row appears between the check
      // and the guarded UPDATE, so the UPDATE itself is the statement that violates the index.
      vi.spyOn(bookService, 'findAsinCollision').mockImplementation(async () => {
        await seedAsinOwner('B_TAKEN');
        return null;
      });

      await sweep(resolverFor({
        'Losing Book': {
          asin: 'B_TAKEN', title: 'Losing Book', authors: [{ name: 'Brandon Sanderson' }],
          narrators: ['Michael Kramer', 'Kate Reading'], duration: 500, description: 'Provider description',
        },
      }));

      expect(await junctionsFor(losing.id)).toEqual([]);
      // The person rows are created inside the same transaction, so they roll back with it.
      const stranded = await db
        .select({ name: narrators.name })
        .from(narrators)
        .where(inArray(narrators.name, ['Michael Kramer', 'Kate Reading']));
      expect(stranded).toEqual([]);

      const row = await rowFor(losing.id);
      expect(row.enrichmentStatus).toBe('failed');
      expect(row.enrichmentAttempts).toBe(1);
      expect(row.asin).toBeNull();
      expect(row.description).toBeNull();

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: losing.id, resolvedAsin: 'B_TAKEN' }),
        'Resolved ASIN hit a unique-constraint race — marking failed',
      );
      batchLog({ enrichedCount: 0, filledNarrators: 0 });
    });

    it('leaves no residue and opens no transaction when the precheck itself catches the collision', async () => {
      await seedAsinOwner('B_OWNED');
      const losing = await bookService.create({ title: 'Precheck Loser', authors: [{ name: 'Frank Herbert' }] });

      // Installed here so the seeding transactions above are not counted.
      const txSpy = vi.spyOn(db, 'transaction');

      await sweep(resolverFor({
        'Precheck Loser': {
          asin: 'B_OWNED', title: 'Precheck Loser', authors: [{ name: 'Frank Herbert' }],
          narrators: ['Simon Vance'], duration: 900,
        },
      }));

      expect(txSpy).toHaveBeenCalledTimes(0);
      expect(await junctionsFor(losing.id)).toEqual([]);
      const row = await rowFor(losing.id);
      expect(row.enrichmentStatus).toBe('failed');
      expect(row.duration).toBeNull();
    });
  });

  // ── The uncontended fill ─────────────────────────────────────────────────────────────────────

  describe('the uncontended path still fills', () => {
    it('writes every provider narrator in provider order alongside the scalar fields', async () => {
      const book = await bookService.create({ title: 'Bear Head', authors: [{ name: 'Adrian Tchaikovsky' }] });

      const provided = ['Sophie Aldred', 'Mark Elstob', 'Ben Allen'];
      await sweep(resolverFor({
        'Bear Head': {
          title: 'Bear Head', authors: [{ name: 'Adrian Tchaikovsky' }],
          narrators: provided, duration: 777, description: 'A pig on Mars',
        },
      }));

      expect(await junctionsFor(book.id)).toEqual(provided.map((name, position) => ({
        name, position, narratorId: expect.any(Number),
      })));

      const row = await rowFor(book.id);
      expect(row.enrichmentStatus).toBe('enriched');
      expect(row.duration).toBe(777);
      expect(row.description).toBe('A pig on Mars');
      batchLog({ filledNarrators: 1 });
    });

    it('never replaces an existing narrator list, while the scalar and genre writes still land', async () => {
      const book = await bookService.create({
        title: 'Already Narrated', authors: [{ name: 'Andy Weir' }], narrators: ['Ray Porter'],
      });

      await sweep(resolverFor({
        'Already Narrated': {
          title: 'Already Narrated', authors: [{ name: 'Andy Weir' }],
          narrators: ['Michael Kramer', 'Kate Reading'], genres: ['Science Fiction'], description: 'Rocky',
        },
      }));

      expect((await junctionsFor(book.id)).map((j) => j.name)).toEqual(['Ray Porter']);
      const row = await rowFor(book.id);
      expect(row.description).toBe('Rocky');
      expect(row.genres).toEqual(['Science Fiction']);
      batchLog({ filledNarrators: 0, filledGenres: 1 });
    });

    it('points two books in one batch at the SAME narrator row when they share a name', async () => {
      const first = await bookService.create({ title: 'Shared One', authors: [{ name: 'A' }] });
      const second = await bookService.create({ title: 'Shared Two', authors: [{ name: 'B' }] });

      await sweep(resolverFor({
        'Shared One': { title: 'Shared One', authors: [{ name: 'A' }], narrators: ['Simon Vance'], duration: 100 },
        'Shared Two': { title: 'Shared Two', authors: [{ name: 'B' }], narrators: ['Simon Vance'], duration: 200 },
      }));

      const [firstJunction] = await junctionsFor(first.id);
      const [secondJunction] = await junctionsFor(second.id);
      expect(firstJunction!.narratorId).toBe(secondJunction!.narratorId);
      expect((await rowFor(first.id)).duration).toBe(100);
      expect((await rowFor(second.id)).duration).toBe(200);
      batchLog({ enrichedCount: 2, filledNarrators: 2 });
    });

    it('absorbs a duplicate slug inside one provider list into a single junction row', async () => {
      const book = await bookService.create({ title: 'Doubled', authors: [{ name: 'J. K. Rowling' }] });

      await sweep(resolverFor({
        Doubled: { title: 'Doubled', authors: [{ name: 'J. K. Rowling' }], narrators: ['Jim Dale', 'Jim  Dale'] },
      }));

      expect(await junctionsFor(book.id)).toEqual([
        { name: 'Jim Dale', position: 0, narratorId: expect.any(Number) },
      ]);
      batchLog({ filledNarrators: 1 });
    });

    it('fills narrators for a book whose operator cleared genres — narrators are not a tombstone domain', async () => {
      const book = await bookService.create({ title: 'Tombstoned', authors: [{ name: 'Adrian Tchaikovsky' }] });
      await db.update(books).set({ userClearedFields: '["genres"]' }).where(eq(books.id, book.id));
      const telemetry = vi.spyOn(bookService, 'trackUnmatchedGenres');

      await sweep(resolverFor({
        Tombstoned: {
          title: 'Tombstoned', authors: [{ name: 'Adrian Tchaikovsky' }],
          narrators: ['Mel Hudson'], genres: ['Fantasy'], duration: 42,
        },
      }));

      expect((await junctionsFor(book.id)).map((j) => j.name)).toEqual(['Mel Hudson']);
      const row = await rowFor(book.id);
      expect(row.genres).toBeNull();
      expect(row.duration).toBe(42);
      expect(telemetry).not.toHaveBeenCalled();
      batchLog({ filledNarrators: 1, filledGenres: 0 });
    });
  });

  // ── Error isolation and honest accounting ────────────────────────────────────────────────────

  describe('a per-narrator failure is isolated and honestly counted', () => {
    it('keeps the remaining narrator, the scalar write and the rest of the batch (#482)', async () => {
      const failing = await bookService.create({ title: 'Half Bad', authors: [{ name: 'A' }] });
      const neighbour = await bookService.create({ title: 'Neighbour', authors: [{ name: 'B' }] });

      vi.mocked(findOrCreateNarrator).mockImplementationOnce(() =>
        Promise.reject(new Error('narrator lookup exploded')));

      await sweep(resolverFor({
        'Half Bad': {
          title: 'Half Bad', authors: [{ name: 'A' }],
          narrators: ['Failing Narrator', 'Good Narrator'], duration: 300,
        },
        Neighbour: { title: 'Neighbour', authors: [{ name: 'B' }], duration: 400 },
      }));

      expect(await junctionsFor(failing.id)).toEqual([
        { name: 'Good Narrator', position: 1, narratorId: expect.any(Number) },
      ]);
      expect((await rowFor(failing.id)).enrichmentStatus).toBe('enriched');
      expect((await rowFor(failing.id)).duration).toBe(300);
      expect((await rowFor(neighbour.id)).duration).toBe(400);
      batchLog({ enrichedCount: 2, filledNarrators: 1 });
    });

    it('warns with a SERIALIZED error rather than swallowing the rejection (#2372)', async () => {
      const book = await bookService.create({ title: 'Warned', authors: [{ name: 'A' }] });
      vi.mocked(findOrCreateNarrator).mockImplementation(() =>
        Promise.reject(new Error('narrator lookup exploded')));

      await sweep(resolverFor({
        Warned: { title: 'Warned', authors: [{ name: 'A' }], narrators: ['Broken Narrator'] },
      }));

      const [call] = narratorWarnings();
      expect(call).toBeDefined();
      const record = call![0] as { bookId: number; narrator: string; error: unknown };
      expect(record.bookId).toBe(book.id);
      expect(record.narrator).toBe('Broken Narrator');
      // `objectContaining({ message })` reads through Error.prototype and stays green without
      // serializeError; `type` is a property only the serialized form owns.
      expect(record.error).not.toBeInstanceOf(Error);
      expect(record.error).toMatchObject({ type: 'Error', message: 'narrator lookup exploded' });
    });

    it('counts 0 — not 1 — when every narrator rejects, and still commits the scalar write', async () => {
      const book = await bookService.create({ title: 'All Broken', authors: [{ name: 'A' }] });
      vi.mocked(findOrCreateNarrator).mockImplementation(() => Promise.reject(new Error('boom')));

      await sweep(resolverFor({
        'All Broken': {
          title: 'All Broken', authors: [{ name: 'A' }], narrators: ['One', 'Two'], duration: 60,
        },
      }));

      expect(await junctionsFor(book.id)).toEqual([]);
      const row = await rowFor(book.id);
      expect(row.enrichmentStatus).toBe('enriched');
      expect(row.duration).toBe(60);
      expect(narratorWarnings()).toHaveLength(2);
      batchLog({ enrichedCount: 1, filledNarrators: 0 });
    });

    it('counts 0 and warns about nothing when every provider name is blank', async () => {
      const book = await bookService.create({ title: 'Blank Names', authors: [{ name: 'A' }] });

      await sweep(resolverFor({
        'Blank Names': { title: 'Blank Names', authors: [{ name: 'A' }], narrators: ['   ', ''], duration: 70 },
      }));

      expect(await junctionsFor(book.id)).toEqual([]);
      expect((await rowFor(book.id)).duration).toBe(70);
      expect(findOrCreateNarrator).not.toHaveBeenCalled();
      // A blank name is a skip, not a failure.
      expect(narratorWarnings()).toEqual([]);
      batchLog({ enrichedCount: 1, filledNarrators: 0 });
    });

    it('keeps the provider index for the surviving name when a blank precedes it', async () => {
      const book = await bookService.create({ title: 'Blank Then Good', authors: [{ name: 'A' }] });

      await sweep(resolverFor({
        'Blank Then Good': { title: 'Blank Then Good', authors: [{ name: 'A' }], narrators: ['', 'Jim Dale'] },
      }));

      // The loop indexes the provider array, so the survivor keeps index 1.
      expect(await junctionsFor(book.id)).toEqual([
        { name: 'Jim Dale', position: 1, narratorId: expect.any(Number) },
      ]);
      batchLog({ filledNarrators: 1 });
    });

    it.each([
      ['undefined', undefined],
      ['an empty array', []],
    ])('issues no narrator statement and counts 0 when the provider list is %s', async (_label, narratorList) => {
      const book = await bookService.create({ title: 'No Narrators', authors: [{ name: 'A' }] });

      await sweep(resolverFor({
        'No Narrators': {
          title: 'No Narrators', authors: [{ name: 'A' }], narrators: narratorList, duration: 80,
        },
      }));

      expect(await junctionsFor(book.id)).toEqual([]);
      expect(findOrCreateNarrator).not.toHaveBeenCalled();
      expect((await rowFor(book.id)).duration).toBe(80);
      batchLog({ enrichedCount: 1, filledNarrators: 0 });
    });
  });
});
