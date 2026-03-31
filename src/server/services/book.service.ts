import { rm } from 'node:fs/promises';
import { cleanEmptyParents } from '../utils/paths.js';
import { eq, and, sql, inArray } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, authors, narrators, bookAuthors, bookNarrators, unmatchedGenres, importLists } from '../../db/schema.js';
import { slugify, findUnmatchedGenres } from '../../core/index.js';
import { type MetadataService } from './metadata.service.js';

type BookRow = typeof books.$inferSelect;
type NewBook = typeof books.$inferInsert;
type AuthorRow = typeof authors.$inferSelect;
type NarratorRow = typeof narrators.$inferSelect;

export interface BookWithAuthor extends BookRow {
  authors: AuthorRow[];
  narrators: NarratorRow[];
  importListName?: string | null;
}

export class BookService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private metadataService?: MetadataService,
  ) {}

  async getById(id: number): Promise<BookWithAuthor | null> {
    const bookResults = await this.db
      .select({ book: books, importListName: importLists.name })
      .from(books)
      .leftJoin(importLists, eq(books.importListId, importLists.id))
      .where(eq(books.id, id))
      .limit(1);

    if (bookResults.length === 0) return null;

    const authorResults = await this.db
      .select({ author: authors, position: bookAuthors.position })
      .from(bookAuthors)
      .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(eq(bookAuthors.bookId, id))
      .orderBy(bookAuthors.position);

    const narratorResults = await this.db
      .select({ narrator: narrators, position: bookNarrators.position })
      .from(bookNarrators)
      .innerJoin(narrators, eq(bookNarrators.narratorId, narrators.id))
      .where(eq(bookNarrators.bookId, id))
      .orderBy(bookNarrators.position);

    return {
      ...bookResults[0].book,
      importListName: bookResults[0].importListName ?? null,
      authors: authorResults.sort((a, b) => a.position - b.position).map((r) => r.author),
      narrators: narratorResults.sort((a, b) => a.position - b.position).map((r) => r.narrator),
    };
  }

  async findDuplicate(
    title: string,
    authorList?: { name: string; asin?: string }[],
    asin?: string,
  ): Promise<BookWithAuthor | null> {
    // Check by ASIN first if available (opportunistic)
    if (asin) {
      const byAsin = await this.db
        .select({ id: books.id })
        .from(books)
        .where(eq(books.asin, asin))
        .limit(1);

      if (byAsin.length > 0) {
        return this.getById(byAsin[0].id);
      }
    }

    // Check by title + position-0 author slug
    if (authorList && authorList.length > 0) {
      const primarySlug = slugify(authorList[0].name);
      const byTitleAuthor = await this.db
        .select({ id: books.id })
        .from(books)
        .innerJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
        .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
        .where(and(eq(books.title, title), eq(authors.slug, primarySlug)))
        .limit(1);

      if (byTitleAuthor.length > 0) {
        return this.getById(byTitleAuthor[0].id);
      }
    }

    return null;
  }

  /**
   * Replace all author junction rows for a book with the given list.
   * Deduplicates by slug within the payload, find-or-creates each author.
   * Called by create() and update().
   */
  async syncAuthors(tx: DbOrTx, bookId: number, authorList: { name: string; asin?: string }[]): Promise<void> {
    await tx.delete(bookAuthors).where(eq(bookAuthors.bookId, bookId));

    const seenSlugs = new Set<string>();
    const uniqueAuthors: { name: string; asin?: string }[] = [];
    for (const a of authorList) {
      const slug = slugify(a.name);
      if (!seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        uniqueAuthors.push(a);
      }
    }

    for (let i = 0; i < uniqueAuthors.length; i++) {
      const authorId = await this.findOrCreateAuthor(tx, uniqueAuthors[i].name, uniqueAuthors[i].asin);
      await tx
        .insert(bookAuthors)
        .values({ bookId, authorId, position: i });
    }
  }

  /**
   * Replace all narrator junction rows for a book with the given list.
   * Deduplicates by slug within the payload, find-or-creates each narrator.
   * Called by create() and update().
   */
  async syncNarrators(tx: DbOrTx, bookId: number, narratorNames: string[]): Promise<void> {
    await tx.delete(bookNarrators).where(eq(bookNarrators.bookId, bookId));

    const seenSlugs = new Set<string>();
    const uniqueNarrators: string[] = [];
    for (const name of narratorNames) {
      const slug = slugify(name);
      if (!seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        uniqueNarrators.push(name);
      }
    }

    for (let i = 0; i < uniqueNarrators.length; i++) {
      const narratorId = await this.findOrCreateNarrator(tx, uniqueNarrators[i]);
      await tx
        .insert(bookNarrators)
        .values({ bookId, narratorId, position: i });
    }
  }

  async create(data: {
    title: string;
    authors: { name: string; asin?: string }[];
    narrators?: string[];
    description?: string;
    coverUrl?: string;
    asin?: string;
    isbn?: string;
    seriesName?: string;
    seriesPosition?: number;
    duration?: number;
    publishedDate?: string;
    genres?: string[];
    status?: BookRow['status'];
    providerId?: string;
    monitorForUpgrades?: boolean;
  }): Promise<BookWithAuthor> {
    // Enrich with ASIN from metadata provider if missing
    let enrichedAsin = data.asin;
    if (!enrichedAsin && data.providerId && this.metadataService) {
      try {
        const detail = await this.metadataService.getBook(data.providerId);
        if (detail?.asin) {
          enrichedAsin = detail.asin;
          this.log.info({ title: data.title, providerId: data.providerId, asin: enrichedAsin }, 'Enriched book with ASIN from provider');
        }
      } catch (error: unknown) {
        this.log.warn({ error, providerId: data.providerId }, 'ASIN enrichment failed');
      }
    }

    const bookId = await this.db.transaction(async (tx) => {
      const result = await tx
        .insert(books)
        .values({
          title: data.title,
          description: data.description,
          coverUrl: data.coverUrl,
          asin: enrichedAsin,
          isbn: data.isbn,
          seriesName: data.seriesName,
          seriesPosition: data.seriesPosition,
          duration: data.duration,
          publishedDate: data.publishedDate,
          genres: data.genres,
          status: data.status || 'wanted',
          monitorForUpgrades: data.monitorForUpgrades ?? false,
        })
        .returning();

      const id = result[0].id;

      await this.syncAuthors(tx, id, data.authors);
      if (data.narrators && data.narrators.length > 0) {
        await this.syncNarrators(tx, id, data.narrators);
      }

      return id;
    });

    this.log.info({ title: data.title, authors: data.authors?.map(a => a.name), asin: data.asin }, 'Book added to library');
    this.trackUnmatchedGenres(data.genres).catch((error) => {
      this.log.debug({ error }, 'Failed to track unmatched genres');
    });
    return this.getById(bookId) as Promise<BookWithAuthor>;
  }

  async update(id: number, data: Partial<NewBook> & { narrators?: string[]; authors?: { name: string; asin?: string }[] }): Promise<BookWithAuthor | null> {
    const { narrators: narratorNames, authors: authorList, ...bookData } = data;

    const updated = await this.db.transaction(async (tx) => {
      const result = await tx
        .update(books)
        .set({ ...bookData, updatedAt: new Date() })
        .where(eq(books.id, id))
        .returning();

      if (result.length === 0) return false;

      if (narratorNames !== undefined) {
        await this.syncNarrators(tx, id, narratorNames);
      }

      if (authorList !== undefined) {
        await this.syncAuthors(tx, id, authorList);
      }

      return true;
    });

    if (!updated) return null;

    const changedFields = Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined);
    this.log.info({ id, changedFields }, 'Book updated');
    return this.getById(id);
  }

  async updateStatus(id: number, status: BookRow['status']): Promise<BookWithAuthor | null> {
    this.log.info({ id, status }, 'Book status changed');
    return this.update(id, { status });
  }

  async deleteByStatus(status: BookRow['status']): Promise<number> {
    const result = await this.db.delete(books).where(eq(books.status, status)).returning();
    this.log.info({ status, count: result.length }, 'Deleted books by status');
    return result.length;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(books).where(eq(books.id, id));
    this.log.info({ id, title: existing.title }, 'Book removed');
    return true;
  }

  /**
   * Delete a book's files from disk and clean up empty parent directories.
   * Throws on failure so the caller can abort the deletion flow.
   */
  async deleteBookFiles(bookPath: string, libraryRoot: string): Promise<void> {
    await rm(bookPath, { recursive: true, force: true });
    this.log.info({ path: bookPath }, 'Book files deleted from disk');

    await cleanEmptyParents(bookPath, libraryRoot, this.log);
  }

  async getMonitoredBooks(): Promise<BookWithAuthor[]> {
    const rows = await this.db
      .select()
      .from(books)
      .where(and(eq(books.monitorForUpgrades, true), eq(books.status, 'imported')));

    return this.batchLoadAuthorsNarrators(rows);
  }

  /** Batch-load authors and narrators for a list of book rows (3 queries total regardless of row count). */
  private async batchLoadAuthorsNarrators(bookRows: BookRow[]): Promise<BookWithAuthor[]> {
    if (bookRows.length === 0) return [];

    const bookIds = bookRows.map((r) => r.id);

    const authorResults = await this.db
      .select({ bookId: bookAuthors.bookId, author: authors, position: bookAuthors.position })
      .from(bookAuthors)
      .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(inArray(bookAuthors.bookId, bookIds));

    const narratorResults = await this.db
      .select({ bookId: bookNarrators.bookId, narrator: narrators, position: bookNarrators.position })
      .from(bookNarrators)
      .innerJoin(narrators, eq(bookNarrators.narratorId, narrators.id))
      .where(inArray(bookNarrators.bookId, bookIds));

    const authorsMap = new Map<number, Array<{ author: AuthorRow; position: number }>>();
    for (const r of authorResults) {
      if (!authorsMap.has(r.bookId)) authorsMap.set(r.bookId, []);
      authorsMap.get(r.bookId)!.push({ author: r.author, position: r.position });
    }

    const narratorsMap = new Map<number, Array<{ narrator: NarratorRow; position: number }>>();
    for (const r of narratorResults) {
      if (!narratorsMap.has(r.bookId)) narratorsMap.set(r.bookId, []);
      narratorsMap.get(r.bookId)!.push({ narrator: r.narrator, position: r.position });
    }

    return bookRows.map((book) => ({
      ...book,
      importListName: null,
      authors: (authorsMap.get(book.id) ?? [])
        .sort((a, b) => a.position - b.position)
        .map((r) => r.author),
      narrators: (narratorsMap.get(book.id) ?? [])
        .sort((a, b) => a.position - b.position)
        .map((r) => r.narrator),
    }));
  }

  private async findOrCreateAuthor(tx: DbOrTx, name: string, asin?: string): Promise<number> {
    const slug = slugify(name);
    const existing = await tx
      .select()
      .from(authors)
      .where(eq(authors.slug, slug))
      .limit(1);

    if (existing.length > 0) {
      return existing[0].id;
    }

    try {
      const newAuthor = await tx
        .insert(authors)
        .values({ name, slug, asin })
        .returning();
      return newAuthor[0].id;
    } catch {
      // Unique constraint violation — concurrent creation
      const retryAuthor = await tx
        .select()
        .from(authors)
        .where(eq(authors.slug, slug))
        .limit(1);
      if (retryAuthor.length > 0) {
        return retryAuthor[0].id;
      }
      throw new Error(`Failed to find or create author: ${name}`);
    }
  }

  private async findOrCreateNarrator(tx: DbOrTx, name: string): Promise<number> {
    const slug = slugify(name);
    const existing = await tx
      .select()
      .from(narrators)
      .where(eq(narrators.slug, slug))
      .limit(1);

    if (existing.length > 0) {
      return existing[0].id;
    }

    try {
      const newNarrator = await tx
        .insert(narrators)
        .values({ name, slug })
        .returning();
      return newNarrator[0].id;
    } catch {
      // Unique constraint violation — concurrent creation
      const retryNarrator = await tx
        .select()
        .from(narrators)
        .where(eq(narrators.slug, slug))
        .limit(1);
      if (retryNarrator.length > 0) {
        return retryNarrator[0].id;
      }
      throw new Error(`Failed to find or create narrator: ${name}`);
    }
  }

  /** Fire-and-forget: track genres not in the synonym/known lists for future analysis */
  private async trackUnmatchedGenres(genres: string[] | undefined): Promise<void> {
    const unmatched = findUnmatchedGenres(genres, genres);
    if (unmatched.length === 0) return;

    for (const genre of unmatched) {
      await this.db
        .insert(unmatchedGenres)
        .values({ genre, count: 1 })
        .onConflictDoUpdate({
          target: unmatchedGenres.genre,
          set: {
            count: sql`${unmatchedGenres.count} + 1`,
            lastSeen: sql`(unixepoch())`,
          },
        });
    }
    this.log.debug({ genres: unmatched }, 'Tracked unmatched genres');
  }
}
