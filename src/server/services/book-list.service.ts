import { eq, and, like, desc, asc, sql, count as countFn, inArray, or, getTableColumns, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { books, authors, narrators, bookAuthors, bookNarrators, importLists } from '../../db/schema.js';
import type { BookSortField, BookSortDirection, BookStatus } from '../../shared/schemas/book.js';
import type { BookWithAuthor } from './book.service.js';
import type { BookRow } from './types.js';

type AuthorRow = typeof authors.$inferSelect;
type NarratorRow = typeof narrators.$inferSelect;

/** Slim select: all book columns except heavy text fields excluded from list views. */
function getSlimBookColumns() {
  const { description: _description, genres: _genres, ...rest } = getTableColumns(books);
  return rest;
}

export interface BookListOptions {
  slim?: boolean;
  search?: string;
  sortField?: BookSortField;
  sortDirection?: BookSortDirection;
}

/** Tab-model status → actual DB status values */
const TAB_STATUS_MAP: Partial<Record<BookStatus, BookStatus[]>> = {
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

export class BookListService {
  constructor(
    private db: Db,
  ) {}

  // eslint-disable-next-line complexity -- batch-load pipeline for author/narrator/importList joins
  async getAll(
    status?: BookStatus,
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
        conditions.push(eq(books.status, status));
      }
    }

    // Search filter — SQL LIKE across title/series/genres + author name subquery
    if (options?.search) {
      const pattern = `%${options.search}%`;
      conditions.push(or(
        like(books.title, pattern),
        like(books.seriesName, pattern),
        like(books.genres, pattern),
        sql`EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = ${books.id} AND a.name LIKE ${pattern})`,
      )!);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count (filters only, no pagination)
    const [{ value: total } = { value: 0 }] = await this.db
      .select({ value: countFn() })
      .from(books)
      .where(where);

    // Build select — slim mode excludes description, genres for list views
    const bookFields = options?.slim ? getSlimBookColumns() : books;

    // Build ORDER BY — join position-0 author for author sort
    const orderClauses = this.buildOrderBy(options?.sortField, options?.sortDirection);

    let query = this.db
      .select({ book: bookFields, importListName: importLists.name, primaryAuthorName: authors.name })
      .from(books)
      .leftJoin(importLists, eq(books.importListId, importLists.id))
      .leftJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
      .leftJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(where)
      .orderBy(...orderClauses);

    if (pagination?.limit !== undefined) {
      query = query.limit(pagination.limit) as typeof query;
    }
    if (pagination?.offset !== undefined) {
      query = query.offset(pagination.offset) as typeof query;
    }

    const results = await query;

    if (results.length === 0) {
      return { data: [], total };
    }

    const bookIds = results.map((r) => (r.book as BookRow).id);

    // Batch-load authors for this page
    const authorResults = await this.db
      .select({ bookId: bookAuthors.bookId, author: authors, position: bookAuthors.position })
      .from(bookAuthors)
      .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(inArray(bookAuthors.bookId, bookIds));

    // Batch-load narrators for this page
    const narratorResults = await this.db
      .select({ bookId: bookNarrators.bookId, narrator: narrators, position: bookNarrators.position })
      .from(bookNarrators)
      .innerJoin(narrators, eq(bookNarrators.narratorId, narrators.id))
      .where(inArray(bookNarrators.bookId, bookIds));

    // Build lookup maps
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

    const data = results.map((r) => {
      const bookId = (r.book as BookRow).id;
      const sortedAuthors = (authorsMap.get(bookId) ?? [])
        .sort((a, b) => a.position - b.position)
        .map((a) => a.author);
      const sortedNarrators = (narratorsMap.get(bookId) ?? [])
        .sort((a, b) => a.position - b.position)
        .map((n) => n.narrator);

      return {
        ...r.book,
        importListName: r.importListName ?? null,
        authors: sortedAuthors,
        narrators: sortedNarrators,
      };
    }) as BookWithAuthor[];

    return { data, total };
  }

  private buildOrderBy(sortField?: BookSortField, sortDirection?: BookSortDirection): SQL[] {
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
        // Sort by position-0 author (joined in main query)
        return [
          sql`CASE WHEN ${authors.name} IS NULL THEN 1 ELSE 0 END`,
          dir(authors.name),
          secondaryDir(books.id),
        ];
      case 'narrator':
        // Sort by position-0 narrator name via subquery
        return [
          sql`CASE WHEN (SELECT n.name FROM book_narrators bn JOIN narrators n ON n.id = bn.narrator_id WHERE bn.book_id = ${books.id} AND bn.position = 0 LIMIT 1) IS NULL THEN 1 ELSE 0 END`,
          dir(sql`(SELECT n.name FROM book_narrators bn JOIN narrators n ON n.id = bn.narrator_id WHERE bn.book_id = ${books.id} AND bn.position = 0 LIMIT 1)`),
          secondaryDir(books.id),
        ];
      case 'series':
        return [
          sql`CASE WHEN ${books.seriesName} IS NULL THEN 1 ELSE 0 END`,
          dir(books.seriesName),
          sql`CASE WHEN ${books.seriesName} IS NULL THEN 0 WHEN ${books.seriesPosition} IS NULL THEN 1 ELSE 0 END`,
          asc(sql`CASE WHEN ${books.seriesName} IS NOT NULL THEN ${books.seriesPosition} ELSE NULL END`),
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
  async getIdentifiers(): Promise<{ asin: string | null; title: string; authorName: string | null; authorSlug: string | null }[]> {
    const results = await this.db
      .select({
        asin: books.asin,
        title: books.title,
        authorName: authors.name,
        authorSlug: authors.slug,
      })
      .from(books)
      .leftJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
      .leftJoin(authors, eq(bookAuthors.authorId, authors.id));

    return results;
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
        .innerJoin(bookAuthors, eq(bookAuthors.authorId, authors.id))
        .groupBy(authors.name)
        .orderBy(asc(authors.name)),
      this.db
        .select({ seriesName: books.seriesName })
        .from(books)
        .where(sql`${books.seriesName} IS NOT NULL AND ${books.seriesName} != ''`)
        .groupBy(books.seriesName)
        .orderBy(asc(books.seriesName)),
      this.db
        .select({ name: narrators.name })
        .from(narrators)
        .innerJoin(bookNarrators, eq(bookNarrators.narratorId, narrators.id))
        .groupBy(narrators.name)
        .orderBy(asc(narrators.name)),
    ]);

    return {
      counts,
      authors: authorRows.map((r) => r.name),
      series: seriesRows.map((r) => r.seriesName!),
      narrators: narratorRows.map((r) => r.name),
    };
  }
}
