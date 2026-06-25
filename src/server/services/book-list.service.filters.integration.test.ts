import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePublicId } from '../utils/public-id.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, bookAuthors, bookNarrators, authors, narrators } from '../../db/schema.js';
import { BookListService } from './book-list.service.js';
import type { BookStatus } from '../../shared/schemas/book.js';

// #1143 follow-up — behavior-level coverage for server-side author/series/narrator filters.
// Asserts returned IDs/totals (not just SQL fragments) against a real libsql DB.

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function seedBook(db: Db, opts: {
  title: string;
  status?: BookStatus;
  seriesName?: string | null;
  authorNames?: string[];
  narratorNames?: string[];
}): Promise<number> {
  const [book] = await db.insert(books).values({ publicId: generatePublicId('bk'),
    title: opts.title,
    status: opts.status ?? 'imported',
    seriesName: opts.seriesName ?? null,
  }).returning();
  const bookId = book!.id;

  if (opts.authorNames?.length) {
    for (let i = 0; i < opts.authorNames.length; i++) {
      const name = opts.authorNames[i]!;
      const slug = slugify(name);
      const existing = await db.select().from(authors).where(eq(authors.slug, slug)).limit(1);
      const authorId = existing[0]?.id ?? (await db.insert(authors).values({ publicId: generatePublicId('au'), name, slug }).returning())[0]!.id;
      await db.insert(bookAuthors).values({ bookId, authorId, position: i });
    }
  }

  if (opts.narratorNames?.length) {
    for (let i = 0; i < opts.narratorNames.length; i++) {
      const name = opts.narratorNames[i]!;
      const slug = slugify(name);
      const existing = await db.select().from(narrators).where(eq(narrators.slug, slug)).limit(1);
      const narratorId = existing[0]?.id ?? (await db.insert(narrators).values({ publicId: generatePublicId('nr'), name, slug }).returning())[0]!.id;
      await db.insert(bookNarrators).values({ bookId, narratorId, position: i });
    }
  }

  return bookId;
}

describe('BookListService — server-side author/series/narrator filter behavior (#1143)', () => {
  let dir: string;
  let db: Db;
  let service: BookListService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'book-list-filters-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    service = new BookListService(db);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep handles on Windows — best effort
    }
  });

  describe('getAllForLibrary — author filter', () => {
    it('returns every book by the author regardless of pagination window', async () => {
      // Three Sanderson books interleaved with non-Sanderson books — proves the
      // filter is applied at the DB layer, not over the current page slice.
      const s1 = await seedBook(db, { title: 'The Way of Kings', authorNames: ['Brandon Sanderson'] });
      await seedBook(db, { title: 'Dune', authorNames: ['Frank Herbert'] });
      const s2 = await seedBook(db, { title: 'Mistborn', authorNames: ['Brandon Sanderson'] });
      await seedBook(db, { title: 'Recursion', authorNames: ['Blake Crouch'] });
      const s3 = await seedBook(db, { title: 'Words of Radiance', authorNames: ['Brandon Sanderson'] });

      const result = await service.getAllForLibrary(undefined, { limit: 2, offset: 0 }, { author: 'Brandon Sanderson' });

      expect(result.total).toBe(3);
      expect(result.data).toHaveLength(2);
      const ids = result.data.map((r) => r.id);
      expect(new Set(ids).size).toBe(2);
      const allIds = new Set([s1, s2, s3]);
      for (const id of ids) expect(allIds.has(id)).toBe(true);

      // Second page returns the remaining Sanderson book — proves filter reaches
      // both page and count queries identically.
      const page2 = await service.getAllForLibrary(undefined, { limit: 2, offset: 2 }, { author: 'Brandon Sanderson' });
      expect(page2.total).toBe(3);
      expect(page2.data).toHaveLength(1);
      expect(allIds.has(page2.data[0]!.id)).toBe(true);
    });

    it('case-insensitive matching: lowercase param matches canonical-case fixture', async () => {
      await seedBook(db, { title: 'The Way of Kings', authorNames: ['Brandon Sanderson'] });
      await seedBook(db, { title: 'Dune', authorNames: ['Frank Herbert'] });

      const result = await service.getAllForLibrary(undefined, undefined, { author: 'brandon sanderson' });
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.title).toBe('The Way of Kings');
    });

    it('multi-author book appears exactly once when filtering by one of its authors', async () => {
      const id = await seedBook(db, {
        title: 'The Wheel of Time: A Memory of Light',
        authorNames: ['Robert Jordan', 'Brandon Sanderson'],
      });

      const result = await service.getAllForLibrary(undefined, undefined, { author: 'Brandon Sanderson' });
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.id).toBe(id);
      // Authors array preserves the metadata order — both names present, no row dup.
      expect(result.data[0]!.authors.map((a) => a.name)).toEqual(['Robert Jordan', 'Brandon Sanderson']);
    });

    it('non-matching author returns { data: [], total: 0 }', async () => {
      await seedBook(db, { title: 'Dune', authorNames: ['Frank Herbert'] });

      const result = await service.getAllForLibrary(undefined, undefined, { author: 'Nobody' });
      expect(result).toEqual({ data: [], total: 0 });
    });
  });

  describe('getAllForLibrary — series filter', () => {
    it('returns every book in the series and excludes books with NULL series_name', async () => {
      const stormlight1 = await seedBook(db, { title: 'The Way of Kings', seriesName: 'The Stormlight Archive', authorNames: ['Brandon Sanderson'] });
      const stormlight2 = await seedBook(db, { title: 'Words of Radiance', seriesName: 'The Stormlight Archive', authorNames: ['Brandon Sanderson'] });
      await seedBook(db, { title: 'Standalone', seriesName: null, authorNames: ['Brandon Sanderson'] });
      await seedBook(db, { title: 'Mistborn', seriesName: 'Mistborn Era One', authorNames: ['Brandon Sanderson'] });

      const result = await service.getAllForLibrary(undefined, undefined, { series: 'The Stormlight Archive' });
      expect(result.total).toBe(2);
      expect(result.data.map((r) => r.id).sort()).toEqual([stormlight1, stormlight2].sort());
    });

    it('case-insensitive series match', async () => {
      await seedBook(db, { title: 'The Way of Kings', seriesName: 'The Stormlight Archive' });

      const result = await service.getAllForLibrary(undefined, undefined, { series: 'the stormlight archive' });
      expect(result.total).toBe(1);
      expect(result.data[0]!.seriesName).toBe('The Stormlight Archive');
    });

    it('series filter does not match books with NULL series_name (SQL NULL semantics)', async () => {
      await seedBook(db, { title: 'Standalone A', seriesName: null });
      await seedBook(db, { title: 'Standalone B', seriesName: null });

      const result = await service.getAllForLibrary(undefined, undefined, { series: 'Anything' });
      expect(result).toEqual({ data: [], total: 0 });
    });
  });

  describe('getAllForLibrary — narrator filter', () => {
    it('returns every book featuring the narrator including multi-narrator books, no duplicates', async () => {
      const kramerOnly = await seedBook(db, { title: 'The Way of Kings', narratorNames: ['Michael Kramer'] });
      const kramerAndReading = await seedBook(db, { title: 'Words of Radiance', narratorNames: ['Michael Kramer', 'Kate Reading'] });
      await seedBook(db, { title: 'Recursion', narratorNames: ['Jon Lindstrom'] });

      const result = await service.getAllForLibrary(undefined, undefined, { narrator: 'Michael Kramer' });
      expect(result.total).toBe(2);
      const ids = result.data.map((r) => r.id);
      // Each filtered book appears once even though the joined fixture has two narrator rows.
      expect(new Set(ids).size).toBe(2);
      expect(ids.sort()).toEqual([kramerOnly, kramerAndReading].sort());
    });

    it('case-insensitive narrator match', async () => {
      await seedBook(db, { title: 'Mistborn', narratorNames: ['Michael Kramer'] });

      const result = await service.getAllForLibrary(undefined, undefined, { narrator: 'MICHAEL KRAMER' });
      expect(result.total).toBe(1);
      expect(result.data[0]!.narrators.map((n) => n.name)).toEqual(['Michael Kramer']);
    });
  });

  describe('getAllForLibrary — composed filters (AND semantics)', () => {
    it('author + series narrows to the intersection', async () => {
      const target = await seedBook(db, { title: 'The Way of Kings', seriesName: 'The Stormlight Archive', authorNames: ['Brandon Sanderson'] });
      await seedBook(db, { title: 'Mistborn', seriesName: 'Mistborn Era One', authorNames: ['Brandon Sanderson'] });
      await seedBook(db, { title: 'Other Book', seriesName: 'The Stormlight Archive', authorNames: ['Someone Else'] });

      const result = await service.getAllForLibrary(undefined, undefined, {
        author: 'Brandon Sanderson', series: 'The Stormlight Archive',
      });
      expect(result.total).toBe(1);
      expect(result.data[0]!.id).toBe(target);
    });

    it('status + author + search compose with AND', async () => {
      // status=imported AND author=Sanderson AND search matches Kings only
      const target = await seedBook(db, { title: 'The Way of Kings', status: 'imported', authorNames: ['Brandon Sanderson'] });
      await seedBook(db, { title: 'Mistborn', status: 'imported', authorNames: ['Brandon Sanderson'] });
      await seedBook(db, { title: 'The Way of Kings (Reread)', status: 'wanted', authorNames: ['Brandon Sanderson'] });
      await seedBook(db, { title: 'Kings of the Wyld', status: 'imported', authorNames: ['Nicholas Eames'] });

      const result = await service.getAllForLibrary('imported', undefined, {
        author: 'Brandon Sanderson', search: 'Kings',
      });
      expect(result.total).toBe(1);
      expect(result.data[0]!.id).toBe(target);
    });
  });

  describe('getAllForLibrary — filtered total contract', () => {
    it('total reflects filtered count, not library-wide count, and matches data.length for a single page', async () => {
      // 5 books total, 2 by target author. Single page big enough to fit both.
      await seedBook(db, { title: 'A', authorNames: ['Target Author'] });
      await seedBook(db, { title: 'B', authorNames: ['Other Author'] });
      await seedBook(db, { title: 'C', authorNames: ['Target Author'] });
      await seedBook(db, { title: 'D', authorNames: ['Other Author'] });
      await seedBook(db, { title: 'E', authorNames: ['Yet Another'] });

      const result = await service.getAllForLibrary(undefined, { limit: 100 }, { author: 'Target Author' });
      expect(result.total).toBe(2);
      expect(result.data).toHaveLength(2);
      // Sanity: an empty-filter call still sees all 5.
      const all = await service.getAllForLibrary(undefined, { limit: 100 });
      expect(all.total).toBe(5);
    });
  });
});

describe('BookListService.getAll — scope-expansion parity check (#1143)', () => {
  // /api/books shares buildListWhere with /api/library/books. The parity tests
  // below prove the new filters reach getAll() too — not just getAllForLibrary().
  let dir: string;
  let db: Db;
  let service: BookListService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'book-list-filters-getall-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    service = new BookListService(db);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('author filter narrows getAll() results to matching books', async () => {
    const target = await seedBook(db, { title: 'The Way of Kings', authorNames: ['Brandon Sanderson'] });
    await seedBook(db, { title: 'Dune', authorNames: ['Frank Herbert'] });

    const result = await service.getAll(undefined, undefined, { author: 'Brandon Sanderson' });
    expect(result.total).toBe(1);
    expect(result.data[0]!.id).toBe(target);
  });

  it('series filter narrows getAll() results', async () => {
    const target = await seedBook(db, { title: 'The Way of Kings', seriesName: 'The Stormlight Archive' });
    await seedBook(db, { title: 'Mistborn', seriesName: 'Mistborn Era One' });

    const result = await service.getAll(undefined, undefined, { series: 'The Stormlight Archive' });
    expect(result.total).toBe(1);
    expect(result.data[0]!.id).toBe(target);
  });

  it('narrator filter narrows getAll() results', async () => {
    const target = await seedBook(db, { title: 'The Way of Kings', narratorNames: ['Michael Kramer'] });
    await seedBook(db, { title: 'Recursion', narratorNames: ['Jon Lindstrom'] });

    const result = await service.getAll(undefined, undefined, { narrator: 'Michael Kramer' });
    expect(result.total).toBe(1);
    expect(result.data[0]!.id).toBe(target);
  });
});
