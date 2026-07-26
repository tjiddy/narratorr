import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, companionEbooks } from '../../db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import { BookService } from './book.service.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import { COMPANION_EBOOK_STATUSES, type CompanionEbookStatus } from '../../shared/schemas/companion-ebook.js';
import type { FastifyBaseLogger } from 'fastify';

// DB-backed coverage for the case-insensitive ASIN predicate (#1537, PR-review F1).
// A mock-based test cannot prove case-insensitivity — `mockDbChain` returns its
// preloaded row regardless of the WHERE clause, so it would still pass if
// `findLibraryStatusByAsins` regressed to an exact `inArray(books.asin, asins)`
// match. This seeds a REAL libsql DB with a case-drifted asin and queries with the
// opposite casing; it FAILS under an exact predicate and passes only with the
// case-insensitive `lower(asin)` condition.

const noopLog = {
  info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {},
  child() { return noopLog; }, level: 'info', silent() {},
} as unknown as FastifyBaseLogger;

describe('BookService.findLibraryStatusByAsins — case-insensitive ASIN predicate (DB-backed, #1537)', () => {
  let dir: string;
  let db: Db;
  let service: BookService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'book-svc-asin-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    service = new BookService(db, noopLog);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep handles on Windows — best effort
    }
  });

  async function seed(asin: string | null, status: BookStatus = 'imported'): Promise<string> {
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title: `Book ${asin ?? 'no-asin'}`, asin, status })
      .returning();
    return row!.publicId;
  }

  /** Seed a book AND its companion observation, returning the numeric + public id. */
  async function seedWithCompanion(
    asin: string,
    bookStatus: BookStatus,
    observationStatus: CompanionEbookStatus,
    sizeBytes: number | null = 4096,
  ): Promise<{ id: number; publicId: string }> {
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title: `Book ${asin}`, asin, status: bookStatus })
      .returning();
    // Rows are seeded directly: nothing in this issue WRITES a companion row (the
    // reconciler is #1959). `available` carries the filename/size the
    // `ck_companion_ebooks_file_present` CHECK requires.
    const carriesFile = observationStatus === 'available' || observationStatus === 'invalid' || observationStatus === 'drm_protected';
    await db.insert(companionEbooks).values({
      bookId: row!.id,
      status: observationStatus,
      filename: carriesFile ? 'companion.epub' : null,
      sizeBytes: carriesFile ? sizeBytes : null,
      mtimeMs: carriesFile ? 1 : null,
      ctimeMs: carriesFile ? 1 : null,
      // `ck_companion_ebooks_candidate_count`: `none` must be 0, `ambiguous` >= 2,
      // and the three file-carrying statuses >= 1.
      candidateCount: observationStatus === 'ambiguous' ? 2 : carriesFile ? 1 : 0,
      selectedFilename: observationStatus === 'available' ? 'companion.epub' : null,
      validationCode: observationStatus === 'invalid' ? 'not_a_zip' : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { id: row!.id, publicId: row!.publicId };
  }

  const enabled = { companionEnabled: true };
  const disabled = { companionEnabled: false };

  it('matches a stored LOWERCASE asin for an UPPERCASE query (fails under an exact predicate)', async () => {
    const publicId = await seed('b00asin');

    const map = await service.findLibraryStatusByAsins(['B00ASIN'], disabled);

    expect(map.get('B00ASIN')).toEqual({ bookId: publicId, status: 'imported', companionEbook: null });
  });

  it('matches a stored UPPERCASE asin for a LOWERCASE query (predicate symmetry)', async () => {
    const publicId = await seed('B00UPPER', 'downloading');

    const map = await service.findLibraryStatusByAsins(['b00upper'], disabled);

    // Map is keyed by the uppercased asin regardless of input casing.
    expect(map.get('B00UPPER')).toEqual({ bookId: publicId, status: 'downloading', companionEbook: null });
  });

  it('does not match a different asin', async () => {
    await seed('B00AAA');

    const map = await service.findLibraryStatusByAsins(['B00BBB'], disabled);

    expect(map.size).toBe(0);
  });

  it('skips a null-asin owned book (partial unique index excludes null asins)', async () => {
    await seed(null);

    const map = await service.findLibraryStatusByAsins(['B00AAA'], disabled);

    expect(map.size).toBe(0);
  });

  it('resolves multiple case-drifted asins in one batch lookup', async () => {
    const idA = await seed('b00aaa', 'imported');
    const idB = await seed('B00bBb', 'wanted');

    const map = await service.findLibraryStatusByAsins(['B00AAA', 'B00BBB'], disabled);

    expect(map.get('B00AAA')).toEqual({ bookId: idA, status: 'imported', companionEbook: null });
    expect(map.get('B00BBB')).toEqual({ bookId: idB, status: 'wanted', companionEbook: null });
  });

  // #1961 — the companion annotation against a REAL libSQL DB, so the numeric
  // `books.id` projection, the FK join, and the query COUNT are all behavioral.
  describe('companion ebooks (#1961)', () => {
    it('carries { format, sizeBytes } for an imported book with an available companion', async () => {
      const { publicId } = await seedWithCompanion('B00HAVE', 'imported', 'available', 8192);

      const map = await service.findLibraryStatusByAsins(['B00HAVE'], enabled);

      expect(map.get('B00HAVE')).toEqual({
        bookId: publicId,
        status: 'imported',
        companionEbook: { format: 'epub', sizeBytes: 8192 },
      });
    });

    it('carries companionEbook: null for the same row when the feature is disabled', async () => {
      await seedWithCompanion('B00HAVE', 'imported', 'available', 8192);

      const map = await service.findLibraryStatusByAsins(['B00HAVE'], disabled);

      expect(map.get('B00HAVE')!.companionEbook).toBeNull();
    });

    it.each(COMPANION_EBOOK_STATUSES.filter((s) => s !== 'available'))(
      'yields null for an imported book whose observation is %s',
      async (observationStatus) => {
        await seedWithCompanion('B00OBS', 'imported', observationStatus);

        const map = await service.findLibraryStatusByAsins(['B00OBS'], enabled);

        expect(map.get('B00OBS')!.companionEbook).toBeNull();
      },
    );

    // The `imported` term is the only thing stopping a book deleted off disk from
    // advertising an ebook forever: the library scan flips imported -> missing
    // without clearing `books.path` and without touching the companion row.
    it.each(['missing', 'wanted', 'downloading'] as const)(
      'yields null for a %s book carrying an available companion (AC 22)',
      async (bookStatus) => {
        await seedWithCompanion('B00STALE', bookStatus, 'available');

        const map = await service.findLibraryStatusByAsins(['B00STALE'], enabled);

        expect(map.get('B00STALE')!.companionEbook).toBeNull();
      },
    );

    it('yields companionEbook: null with the key PRESENT for a book with no companion row', async () => {
      const publicId = await seed('B00BARE', 'imported');

      const map = await service.findLibraryStatusByAsins(['B00BARE'], enabled);

      expect(map.get('B00BARE')).toEqual({ bookId: publicId, status: 'imported', companionEbook: null });
      expect(map.get('B00BARE')!.companionEbook).not.toBeUndefined();
    });

    it('round-trips sizeBytes: 0 as 0, not null (AC 28)', async () => {
      await seedWithCompanion('B00ZERO', 'imported', 'available', 0);

      const map = await service.findLibraryStatusByAsins(['B00ZERO'], enabled);

      expect(map.get('B00ZERO')!.companionEbook).toEqual({ format: 'epub', sizeBytes: 0 });
    });

    it('does not N+1: 25 books with companions cost exactly 2 selects (books + one 480-chunk)', async () => {
      const asins: string[] = [];
      for (let i = 0; i < 25; i++) {
        const asin = `B00N${String(i).padStart(4, '0')}`;
        await seedWithCompanion(asin, 'imported', 'available');
        asins.push(asin);
      }
      const selectSpy = vi.spyOn(db, 'select');

      const map = await service.findLibraryStatusByAsins(asins, enabled);

      expect(map.size).toBe(25);
      // One books select + ceil(25 / 480) = 1 companion select. Never one per book.
      expect(selectSpy).toHaveBeenCalledTimes(2);
      selectSpy.mockRestore();
    });

    it('issues NO companion query when disabled: the same 25-book seed costs 1 select', async () => {
      const asins: string[] = [];
      for (let i = 0; i < 25; i++) {
        const asin = `B00N${String(i).padStart(4, '0')}`;
        await seedWithCompanion(asin, 'imported', 'available');
        asins.push(asin);
      }
      const selectSpy = vi.spyOn(db, 'select');

      await service.findLibraryStatusByAsins(asins, disabled);

      expect(selectSpy).toHaveBeenCalledTimes(1);
      selectSpy.mockRestore();
    });

    it('issues ZERO queries for an empty ASIN list even when enabled', async () => {
      const selectSpy = vi.spyOn(db, 'select');

      const map = await service.findLibraryStatusByAsins([], enabled);

      expect(map.size).toBe(0);
      expect(selectSpy).not.toHaveBeenCalled();
      selectSpy.mockRestore();
    });
  });
});
