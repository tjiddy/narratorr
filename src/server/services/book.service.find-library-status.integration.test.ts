import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, companionEbooks } from '@db/schema.js';
import { sql } from 'drizzle-orm';
import { generatePublicId } from '../utils/public-id.js';
import { BookService } from './book.service.js';
import type { BookStatus } from '@shared/schemas/book.js';
import { COMPANION_EBOOK_STATUSES, type CompanionEbookStatus } from '@shared/schemas/companion-ebook.js';
import type { FastifyBaseLogger } from 'fastify';

// Mocks cannot validate SQL predicates; a real DB proves case folding and index use independently.

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
    // Rows are seeded directly; file-carrying statuses must satisfy the file-present CHECK.
    const carriesFile = observationStatus === 'available' || observationStatus === 'invalid' || observationStatus === 'drm_protected';
    await db.insert(companionEbooks).values({
      bookId: row!.id,
      status: observationStatus,
      filename: carriesFile ? 'companion.epub' : null,
      sizeBytes: carriesFile ? sizeBytes : null,
      mtimeMs: carriesFile ? 1 : null,
      ctimeMs: carriesFile ? 1 : null,
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

  /**
   * SQLite uses this partial index only when WHERE restates `asin IS NOT NULL`.
   * Keep this predicate synchronized with findLibraryStatusByAsins.
   */
  it('uses idx_books_asin_unique rather than scanning books', async () => {
    const plan = async (where: string) => {
      const rows = await db.all<{ detail: string }>(
        sql.raw(`EXPLAIN QUERY PLAN SELECT id FROM books WHERE ${where}`),
      );
      return rows.map((r) => r.detail).join(' | ');
    };

    expect(await plan(`upper(asin) IN ('B00AAA') AND asin IS NOT NULL`)).toContain(
      'USING INDEX idx_books_asin_unique',
    );

    expect(await plan(`upper(asin) IN ('B00AAA')`)).toContain('SCAN');
    expect(await plan(`lower(asin) IN ('b00aaa') AND asin IS NOT NULL`)).toContain('SCAN');
  });

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

    // Missing scans preserve path and companion rows, so status is the only stale-ebook guard.
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
