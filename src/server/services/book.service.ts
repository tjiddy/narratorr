/* eslint-disable max-lines -- single-responsibility service with server-side search/sort/filter + stats */
import { rm } from 'node:fs/promises';
import { cleanEmptyParents } from '../utils/paths.js';
import { eq, and, like, desc, asc, sql, count as countFn, inArray, or, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, authors, unmatchedGenres, importLists } from '../../db/schema.js';
import { slugify, findUnmatchedGenres } from '../../core/index.js';
import { type MetadataService } from './metadata.service.js';

type BookRow = typeof books.$inferSelect;
type NewBook = typeof books.$inferInsert;
type AuthorRow = typeof authors.$inferSelect;

export interface BookWithAuthor extends BookRow {
  author?: AuthorRow;
  importListName?: string | null;
}

type SortField = 'createdAt' | 'title' | 'author' | 'narrator' | 'series' | 'quality' | 'size' | 'format';
type SortDirection = 'asc' | 'desc';

export interface BookListOptions {
  slim?: boolean;
  search?: string;
  sortField?: SortField;
  sortDirection?: SortDirection;
}

/** Tab-model status → actual DB status values */
const TAB_STATUS_MAP: Record<string, BookRow['status'][]> = {
  downloading: ['searching', 'downloading'],
  imported: ['importing', 'imported'],
};

export interface BookStats {
  counts: {
    wanted: number;
    downloading: number;
    imported: number;
    failed: number;
    missing: number;
  };
  authors: string[];
  series: string[];
  narrators: string[];
}

export class BookService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private metadataService?: MetadataService,
  ) {}

  async getAll(
    status?: string,
    pagination?: { limit?: number; offset?: number },
    options?: BookListOptions,
  ): Promise<{ data: BookWithAuthor[]; total: number }> {
    // Build where conditions
    const conditions: SQL[] = [];

    // Status filter with tab-model mapping
    if (status) {
      const mapped = TAB_STATUS_MAP[status];
      if (mapped) {
        conditions.push(inArray(books.status, mapped));
      } else {
        conditions.push(eq(books.status, status as BookRow['status']));
      }
    }

    // Search filter — SQL LIKE across multiple fields
    if (options?.search) {
      const pattern = `%${options.search}%`;
      conditions.push(or(
        like(books.title, pattern),
        like(books.narrator, pattern),
        like(books.seriesName, pattern),
        like(books.genres, pattern),
        like(authors.name, pattern),
      )!);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count (with filters, before pagination)
    const [{ value: total }] = await this.db
      .select({ value: countFn() })
      .from(books)
      .leftJoin(authors, eq(books.authorId, authors.id))
      .where(where);

    // Build select — slim mode excludes description, genres for list views
    const selectFields = options?.slim
      ? {
          book: {
            id: books.id,
            title: books.title,
            authorId: books.authorId,
            status: books.status,
            path: books.path,
            coverUrl: books.coverUrl,
            goodreadsId: books.goodreadsId,
            audibleId: books.audibleId,
            asin: books.asin,
            isbn: books.isbn,
            narrator: books.narrator,
            seriesName: books.seriesName,
            seriesPosition: books.seriesPosition,
            duration: books.duration,
            publishedDate: books.publishedDate,
            size: books.size,
            audioCodec: books.audioCodec,
            audioBitrate: books.audioBitrate,
            audioSampleRate: books.audioSampleRate,
            audioChannels: books.audioChannels,
            audioBitrateMode: books.audioBitrateMode,
            audioFileFormat: books.audioFileFormat,
            audioFileCount: books.audioFileCount,
            audioTotalSize: books.audioTotalSize,
            audioDuration: books.audioDuration,
            monitorForUpgrades: books.monitorForUpgrades,
            importListId: books.importListId,
            enrichmentStatus: books.enrichmentStatus,
            createdAt: books.createdAt,
            updatedAt: books.updatedAt,
          },
          author: authors,
          importListName: importLists.name,
        }
      : {
          book: books,
          author: authors,
          importListName: importLists.name,
        };

    // Build ORDER BY
    const orderClauses = this.buildOrderBy(options?.sortField, options?.sortDirection);

    let query = this.db
      .select(selectFields)
      .from(books)
      .leftJoin(authors, eq(books.authorId, authors.id))
      .leftJoin(importLists, eq(books.importListId, importLists.id))
      .where(where)
      .orderBy(...orderClauses);

    if (pagination?.limit !== undefined) {
      query = query.limit(pagination.limit) as typeof query;
    }
    if (pagination?.offset !== undefined) {
      query = query.offset(pagination.offset) as typeof query;
    }

    const results = await query;

    const data = results.map((r) => ({
      ...r.book,
      author: r.author || undefined,
      importListName: r.importListName ?? null,
    })) as BookWithAuthor[];

    return { data, total };
  }

  private buildOrderBy(sortField?: SortField, sortDirection?: SortDirection): SQL[] {
    const dir = sortDirection === 'asc' ? asc : desc;
    const secondaryDir = sortDirection === 'asc' ? asc : desc;

    switch (sortField) {
      case 'title':
        // Strip leading articles (The/A/An) for sort — only at start of title
        return [
          dir(sql`CASE
            WHEN LOWER(${books.title}) LIKE 'the %' THEN SUBSTR(${books.title}, 5)
            WHEN LOWER(${books.title}) LIKE 'a %' THEN SUBSTR(${books.title}, 3)
            WHEN LOWER(${books.title}) LIKE 'an %' THEN SUBSTR(${books.title}, 4)
            ELSE ${books.title}
          END`),
          secondaryDir(books.id),
        ];
      case 'author':
        return [
          sql`CASE WHEN ${authors.name} IS NULL THEN 1 ELSE 0 END`,
          dir(authors.name),
          secondaryDir(books.id),
        ];
      case 'narrator':
        return [
          sql`CASE WHEN ${books.narrator} IS NULL THEN 1 ELSE 0 END`,
          dir(books.narrator),
          secondaryDir(books.id),
        ];
      case 'series':
        return [
          sql`CASE WHEN ${books.seriesName} IS NULL THEN 1 ELSE 0 END`,
          dir(books.seriesName),
          secondaryDir(books.id),
        ];
      case 'quality':
        // MB/hr = (audioTotalSize ?? size) / (audioDuration ?? duration) * 3600 / 1048576
        return [
          sql`CASE WHEN COALESCE(${books.audioTotalSize}, ${books.size}) IS NULL OR COALESCE(${books.audioDuration}, ${books.duration}) IS NULL OR COALESCE(${books.audioDuration}, ${books.duration}) = 0 THEN 1 ELSE 0 END`,
          dir(sql`CAST(COALESCE(${books.audioTotalSize}, ${books.size}) AS REAL) / CAST(COALESCE(${books.audioDuration}, ${books.duration}) AS REAL)`),
          secondaryDir(books.id),
        ];
      case 'size':
        return [
          sql`CASE WHEN COALESCE(${books.audioTotalSize}, ${books.size}) IS NULL THEN 1 ELSE 0 END`,
          dir(sql`COALESCE(${books.audioTotalSize}, ${books.size})`),
          secondaryDir(books.id),
        ];
      case 'format':
        return [
          sql`CASE WHEN ${books.audioFileFormat} IS NULL THEN 1 ELSE 0 END`,
          dir(books.audioFileFormat),
          secondaryDir(books.id),
        ];
      case 'createdAt':
      default:
        return [dir(books.createdAt), secondaryDir(books.id)];
    }
  }

  /** Lightweight list of all book identifiers for duplicate detection (no pagination). */
  async getIdentifiers(): Promise<{ asin: string | null; title: string; authorName: string | null }[]> {
    const results = await this.db
      .select({
        asin: books.asin,
        title: books.title,
        authorName: authors.name,
      })
      .from(books)
      .leftJoin(authors, eq(books.authorId, authors.id));

    return results;
  }

  async getById(id: number): Promise<BookWithAuthor | null> {
    const results = await this.db
      .select({
        book: books,
        author: authors,
        importListName: importLists.name,
      })
      .from(books)
      .leftJoin(authors, eq(books.authorId, authors.id))
      .leftJoin(importLists, eq(books.importListId, importLists.id))
      .where(eq(books.id, id))
      .limit(1);

    if (results.length === 0) return null;

    return {
      ...results[0].book,
      author: results[0].author || undefined,
      importListName: results[0].importListName ?? null,
    };
  }

  async findDuplicate(title: string, authorName?: string, asin?: string): Promise<BookWithAuthor | null> {
    // Check by ASIN first if available (opportunistic)
    if (asin) {
      const byAsin = await this.db
        .select({ book: books, author: authors })
        .from(books)
        .leftJoin(authors, eq(books.authorId, authors.id))
        .where(eq(books.asin, asin))
        .limit(1);

      if (byAsin.length > 0) {
        return { ...byAsin[0].book, author: byAsin[0].author || undefined };
      }
    }

    // Check by title + author slug
    if (authorName) {
      const authorSlug = slugify(authorName);
      const byTitleAuthor = await this.db
        .select({ book: books, author: authors })
        .from(books)
        .leftJoin(authors, eq(books.authorId, authors.id))
        .where(and(eq(books.title, title), eq(authors.slug, authorSlug)))
        .limit(1);

      if (byTitleAuthor.length > 0) {
        return { ...byTitleAuthor[0].book, author: byTitleAuthor[0].author || undefined };
      }
    }

    return null;
  }

  async create(data: {
    title: string;
    authorName?: string;
    authorAsin?: string;
    narrator?: string;
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
      } catch (error) {
        this.log.warn({ error, providerId: data.providerId }, 'ASIN enrichment failed');
      }
    }

    let authorId: number | undefined;

    if (data.authorName) {
      // Find or create author (upsert to avoid TOCTOU race on unique slug)
      const slug = slugify(data.authorName);
      const existingAuthor = await this.db
        .select()
        .from(authors)
        .where(eq(authors.slug, slug))
        .limit(1);

      if (existingAuthor.length > 0) {
        authorId = existingAuthor[0].id;
      } else {
        try {
          const newAuthor = await this.db
            .insert(authors)
            .values({ name: data.authorName, slug, asin: data.authorAsin })
            .returning();
          authorId = newAuthor[0].id;
        } catch {
          // Unique constraint violation — another request created the author concurrently
          const retryAuthor = await this.db
            .select()
            .from(authors)
            .where(eq(authors.slug, slug))
            .limit(1);
          if (retryAuthor.length > 0) {
            authorId = retryAuthor[0].id;
          } else {
            throw new Error(`Failed to find or create author: ${data.authorName}`);
          }
        }
      }
    }

    const result = await this.db
      .insert(books)
      .values({
        title: data.title,
        authorId,
        narrator: data.narrator,
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

    this.log.info({ title: data.title }, 'Book added to library');
    this.trackUnmatchedGenres(data.genres).catch((error) => {
      this.log.debug({ error }, 'Failed to track unmatched genres');
    });
    return this.getById(result[0].id) as Promise<BookWithAuthor>;
  }

  async update(id: number, data: Partial<NewBook>): Promise<BookWithAuthor | null> {
    const result = await this.db
      .update(books)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(books.id, id))
      .returning();

    if (result.length === 0) return null;

    this.log.info({ id }, 'Book updated');
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
    this.log.info({ id }, 'Book removed');
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
    const results = await this.db
      .select({ book: books, author: authors })
      .from(books)
      .leftJoin(authors, eq(books.authorId, authors.id))
      .where(and(eq(books.monitorForUpgrades, true), eq(books.status, 'imported')));

    return results.map((r) => ({
      ...r.book,
      author: r.author || undefined,
    }));
  }

  async search(query: string): Promise<BookWithAuthor[]> {
    const results = await this.db
      .select({
        book: books,
        author: authors,
      })
      .from(books)
      .leftJoin(authors, eq(books.authorId, authors.id))
      .where(like(books.title, `%${query}%`))
      .orderBy(desc(books.createdAt))
      .limit(50);

    return results.map((r) => ({
      ...r.book,
      author: r.author || undefined,
    }));
  }

  async getStats(): Promise<BookStats> {
    // Get per-status counts
    const statusRows = await this.db
      .select({ status: books.status, count: countFn() })
      .from(books)
      .groupBy(books.status);

    const statusMap = new Map(statusRows.map((r) => [r.status, Number(r.count)]));

    const counts = {
      wanted: statusMap.get('wanted') ?? 0,
      downloading: (statusMap.get('searching') ?? 0) + (statusMap.get('downloading') ?? 0),
      imported: (statusMap.get('importing') ?? 0) + (statusMap.get('imported') ?? 0),
      failed: statusMap.get('failed') ?? 0,
      missing: statusMap.get('missing') ?? 0,
    };

    // Get unique filter values
    const [authorRows, seriesRows, narratorRows] = await Promise.all([
      this.db
        .select({ name: authors.name })
        .from(authors)
        .where(sql`${authors.id} IN (SELECT DISTINCT ${books.authorId} FROM ${books} WHERE ${books.authorId} IS NOT NULL)`)
        .orderBy(asc(authors.name)),
      this.db
        .select({ seriesName: books.seriesName })
        .from(books)
        .where(sql`${books.seriesName} IS NOT NULL AND ${books.seriesName} != ''`)
        .groupBy(books.seriesName)
        .orderBy(asc(books.seriesName)),
      this.db
        .select({ narrator: books.narrator })
        .from(books)
        .where(sql`${books.narrator} IS NOT NULL AND ${books.narrator} != ''`)
        .groupBy(books.narrator)
        .orderBy(asc(books.narrator)),
    ]);

    return {
      counts,
      authors: authorRows.map((r) => r.name),
      series: seriesRows.map((r) => r.seriesName!),
      narrators: narratorRows.map((r) => r.narrator!),
    };
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
