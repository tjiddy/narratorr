import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { BookService } from '../services/book.service.js';
import { MetadataService } from '../services/metadata.service.js';
import { AMBIGUOUS_WINDOW_HELD } from '../services/metadata-resolve-book.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { runEnrichment } from './enrichment.js';

const mockAudibleProvider = {
  name: 'Audible.com',
  type: 'audible',
  searchBooks: vi.fn(),
  searchSeries: vi.fn().mockResolvedValue([]),
  getBook: vi.fn().mockResolvedValue(null),
  getBookDetailed: vi.fn().mockResolvedValue({ kind: 'not_found' }),
  test: vi.fn().mockResolvedValue({ success: true }),
};

const mockAudnexus = {
  name: 'Audnexus',
  type: 'audnexus',
  getBook: vi.fn().mockResolvedValue(null),
  getBookDetailed: vi.fn().mockResolvedValue({ kind: 'not_found' }),
  getAuthor: vi.fn().mockResolvedValue(null),
  getChapterRuntime: vi.fn().mockResolvedValue({ kind: 'not_found' }),
};

vi.mock('@core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/index.js')>();
  return {
    ...actual,
    METADATA_SEARCH_PROVIDER_FACTORIES: {
      audible: vi.fn().mockImplementation(function () { return mockAudibleProvider; }),
    },
    AudnexusProvider: vi.fn().mockImplementation(function () { return mockAudnexus; }),
  };
});

// Real SQLite proves the durable disposition of a held window: the row must be indistinguishable
// from a no-match, and Fix Match must still be able to rescue it (#2202 AC10, AC14).
describe('scheduled enrichment over an ambiguous resolver window — integration (#2202)', () => {
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;
  let metadataService: MetadataService;

  beforeEach(async () => {
    mockAudibleProvider.searchBooks.mockReset();
    mockAudnexus.getBook.mockReset().mockResolvedValue(null);

    dir = mkdtempSync(join(tmpdir(), 'enrich-ambiguous-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    bookService = new BookService(db, inject<FastifyBaseLogger>(log));
    metadataService = new MetadataService(inject<FastifyBaseLogger>(log));
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep the file handle on Windows
    }
  });

  it('holds the ambiguous book as failed, still enriches its batch neighbour, and Fix Match resets it', async () => {
    const held = await bookService.create({
      title: 'Dune Chronicles Messiah',
      authors: [{ name: 'Frank Herbert' }],
    });
    const neighbour = await bookService.create({
      title: 'The Way of Kings',
      authors: [{ name: 'Brandon Sanderson' }],
    });

    mockAudibleProvider.searchBooks.mockImplementation((query: string) =>
      Promise.resolve(query.startsWith('Dune')
        ? {
          books: [
            { asin: 'B_DUNE', title: 'Dune', authors: [{ name: 'Frank Herbert' }] },
            { asin: 'B_MESSIAH', title: 'Dune Messiah', authors: [{ name: 'Frank Herbert' }] },
          ],
        }
        : {
          books: [
            { asin: 'B_KINGS', title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], duration: 2700 },
          ],
        }));

    await expect(
      runEnrichment(db, metadataService, bookService, inject<FastifyBaseLogger>(log)),
    ).resolves.not.toThrow();

    const [heldRow] = await db.select().from(books).where(eq(books.id, held.id));
    expect(heldRow!.enrichmentStatus).toBe('failed');
    expect(heldRow!.enrichmentAttempts).toBe(1);
    // A hold writes no metadata: the declined candidates must not reach the row.
    expect(heldRow!.asin).toBeNull();
    expect(heldRow!.title).toBe('Dune Chronicles Messiah');
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ passing: 2, window: 5 }),
      AMBIGUOUS_WINDOW_HELD,
    );

    // The hold is per-candidate; the rest of the batch still resolves.
    const [neighbourRow] = await db.select().from(books).where(eq(books.id, neighbour.id));
    expect(neighbourRow!.enrichmentStatus).toBe('enriched');
    expect(neighbourRow!.asin).toBe('B_KINGS');
    expect(neighbourRow!.duration).toBe(2700);

    // Fix Match does not route through resolveBook, so the operator override still lands.
    const fixed = await bookService.fixMatch(held.id, {
      asin: 'B_MESSIAH',
      title: 'Dune Messiah',
      authors: [{ name: 'Frank Herbert' }],
      narrators: ['Simon Vance'],
      duration: 1200,
    });
    expect(fixed).not.toBeNull();

    const [rescued] = await db.select().from(books).where(eq(books.id, held.id));
    expect(rescued!.asin).toBe('B_MESSIAH');
    expect(rescued!.title).toBe('Dune Messiah');
    expect(rescued!.enrichmentStatus).toBe('pending');
    expect(rescued!.enrichmentAttempts).toBe(0);
  });
});
