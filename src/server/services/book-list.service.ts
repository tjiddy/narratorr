import { eq, and, like, desc, asc, sql, count as countFn, inArray, or, getTableColumns, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { books, authors, narrators, bookAuthors, bookNarrators, importLists } from '../../db/schema.js';
import type { BookSortField, BookSortDirection, BookStatus } from '../../shared/schemas/book.js';
import type { LibraryBookListItem } from '../../shared/schemas/library-book.js';
import { sortCollapsedRows, collapseRows, buildFallbackCompare } from './book-list-collapse.js';
import type { BookWithAuthor } from './book.service.js';
import type { BookRow } from './types.js';

/** Server-side row shape for the library list — same fields as the wire
 *  LibraryBookListItem but with Drizzle Date timestamps (Fastify serializes
 *  them to ISO strings on the way out). */
export type LibraryBookListItemRow = Omit<LibraryBookListItem, 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
};

export interface LibraryBookListResponseRow {
  data: LibraryBookListItemRow[];
  total: number;
}

type AuthorRow = typeof authors.$inferSelect;
type NarratorRow = typeof narrators.$inferSelect;

function getSlimBookColumns() {
  const { description: _description, genres: _genres, ...rest } = getTableColumns(books);
  return rest;
}

export interface BookListOptions {
  slim?: boolean;
  search?: string;
  author?: string;
  series?: string;
  narrator?: string;
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

/** Project options→filter shape with only defined values, so the helper
 *  in buildListWhere() doesn't see undefined keys (keeps cyclomatic
 *  complexity low at the call sites). */
function pickFilters(options?: { search?: string; author?: string; series?: string; narrator?: string }): { search?: string; author?: string; series?: string; narrator?: string } {
  const out: { search?: string; author?: string; series?: string; narrator?: string } = {};
  if (options?.search !== undefined) out.search = options.search;
  if (options?.author !== undefined) out.author = options.author;
  if (options?.series !== undefined) out.series = options.series;
  if (options?.narrator !== undefined) out.narrator = options.narrator;
  return out;
}

export class BookListService {
  constructor(
    private db: Db,
  ) {}

  /** Compose status + search + author/series/narrator WHERE filters shared by
   *  getAll() and getAllForLibrary(). Search semantics match #365:
   *  title/series/genres + author name subquery, no narrator subquery.
   *  Author/series/narrator filters (#1143) are case-insensitive exact matches
   *  pushed to the DB so pagination operates on the filtered set. */
  private buildListWhere(status?: BookStatus, filters?: { search?: string; author?: string; series?: string; narrator?: string }): SQL | undefined {
    const conditions: SQL[] = [];

    if (status) {
      const mapped = TAB_STATUS_MAP[status];
      if (mapped) {
        conditions.push(inArray(books.status, mapped));
      } else {
        conditions.push(eq(books.status, status));
      }
    }

    if (filters?.search) {
      const pattern = `%${filters.search}%`;
      conditions.push(or(
        like(books.title, pattern),
        like(books.seriesName, pattern),
        like(books.genres, pattern),
        sql`EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = ${books.id} AND a.name LIKE ${pattern})`,
      )!);
    }

    if (filters?.author) {
      conditions.push(sql`EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = ${books.id} AND lower(a.name) = lower(${filters.author}))`);
    }

    if (filters?.series) {
      conditions.push(sql`lower(${books.seriesName}) = lower(${filters.series})`);
    }

    if (filters?.narrator) {
      conditions.push(sql`EXISTS (SELECT 1 FROM book_narrators bn JOIN narrators n ON n.id = bn.narrator_id WHERE bn.book_id = ${books.id} AND lower(n.name) = lower(${filters.narrator}))`);
    }

    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  async getAll(
    status?: BookStatus,
    pagination?: { limit?: number; offset?: number },
    options?: BookListOptions,
  ): Promise<{ data: BookWithAuthor[]; total: number }> {
    const where = this.buildListWhere(status, pickFilters(options));

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

  async getAllForLibrary(
    status?: BookStatus,
    pagination?: { limit?: number; offset?: number },
    options?: { search?: string; author?: string; series?: string; narrator?: string; sortField?: BookSortField; sortDirection?: BookSortDirection; collapse?: boolean },
  ): Promise<LibraryBookListResponseRow> {
    const where = this.buildListWhere(status, pickFilters(options));
    const orderClauses = this.buildOrderBy(options?.sortField, options?.sortDirection);

    if (options?.collapse) {
      return this.getAllForLibraryCollapsed(where, orderClauses, pagination, options.sortField, options.sortDirection);
    }

    const [{ value: total } = { value: 0 }] = await this.db
      .select({ value: countFn() })
      .from(books)
      .where(where);

    const rows = await this.queryLibraryRows(where, orderClauses, pagination);
    if (rows.length === 0) return { data: [], total };
    return { data: await this.hydrateLibraryRows(rows), total };
  }

  private async getAllForLibraryCollapsed(
    where: SQL | undefined, orderClauses: SQL[],
    pagination?: { limit?: number; offset?: number },
    sortField?: BookSortField, sortDirection?: BookSortDirection,
  ): Promise<LibraryBookListResponseRow> {
    const allRows = await this.queryLibraryRows(where, orderClauses);
    if (allRows.length === 0) return { data: [], total: 0 };

    const { representativeIndices, collapsedCounts } = collapseRows(allRows, buildFallbackCompare(sortField, sortDirection));
    const hydrated = await this.hydrateLibraryRows(representativeIndices.map((i) => allRows[i]!));
    for (const row of hydrated) {
      const cc = collapsedCounts.get(row.id);
      if (cc !== undefined) row.collapsedCount = cc;
    }
    sortCollapsedRows(hydrated, sortField, sortDirection);

    const total = hydrated.length;
    const offset = pagination?.offset ?? 0;
    const limit = pagination?.limit;
    const page = limit !== undefined ? hydrated.slice(offset, offset + limit) : hydrated.slice(offset);
    return { data: page, total };
  }

  private async queryLibraryRows(where: SQL | undefined, orderClauses: SQL[], pagination?: { limit?: number; offset?: number }) {
    let query = this.db
      .select({
        id: books.id, title: books.title, coverUrl: books.coverUrl, status: books.status,
        seriesName: books.seriesName, seriesPosition: books.seriesPosition,
        audioTotalSize: books.audioTotalSize, size: books.size, audioFileFormat: books.audioFileFormat,
        audioDuration: books.audioDuration, duration: books.duration, path: books.path,
        audioFileCount: books.audioFileCount, lastGrabGuid: books.lastGrabGuid,
        lastGrabInfoHash: books.lastGrabInfoHash, createdAt: books.createdAt, updatedAt: books.updatedAt,
      })
      .from(books)
      .leftJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
      .leftJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(where)
      .orderBy(...orderClauses);
    if (pagination?.limit !== undefined) query = query.limit(pagination.limit) as typeof query;
    if (pagination?.offset !== undefined) query = query.offset(pagination.offset) as typeof query;
    return query;
  }

  private async hydrateLibraryRows(rows: Array<{
    id: number; title: string; coverUrl: string | null; status: string;
    seriesName: string | null; seriesPosition: number | null;
    audioTotalSize: number | null; size: number | null; audioFileFormat: string | null;
    audioDuration: number | null; duration: number | null; path: string | null;
    audioFileCount: number | null; lastGrabGuid: string | null; lastGrabInfoHash: string | null;
    createdAt: Date; updatedAt: Date;
  }>): Promise<LibraryBookListItemRow[]> {
    const bookIds = rows.map((r) => r.id);
    const [authorResults, narratorResults] = await Promise.all([
      this.db.select({ bookId: bookAuthors.bookId, name: authors.name, position: bookAuthors.position })
        .from(bookAuthors).innerJoin(authors, eq(bookAuthors.authorId, authors.id))
        .where(inArray(bookAuthors.bookId, bookIds)),
      this.db.select({ bookId: bookNarrators.bookId, name: narrators.name, position: bookNarrators.position })
        .from(bookNarrators).innerJoin(narrators, eq(bookNarrators.narratorId, narrators.id))
        .where(inArray(bookNarrators.bookId, bookIds)),
    ]);

    const authorsMap = new Map<number, Array<{ name: string; position: number }>>();
    for (const r of authorResults) {
      if (!authorsMap.has(r.bookId)) authorsMap.set(r.bookId, []);
      authorsMap.get(r.bookId)!.push({ name: r.name, position: r.position });
    }
    const narratorsMap = new Map<number, Array<{ name: string; position: number }>>();
    for (const r of narratorResults) {
      if (!narratorsMap.has(r.bookId)) narratorsMap.set(r.bookId, []);
      narratorsMap.get(r.bookId)!.push({ name: r.name, position: r.position });
    }

    return rows.map((r) => ({
      id: r.id, title: r.title, coverUrl: r.coverUrl, status: r.status as BookStatus,
      seriesName: r.seriesName, seriesPosition: r.seriesPosition,
      authors: (authorsMap.get(r.id) ?? []).sort((a, b) => a.position - b.position).map((a) => ({ name: a.name })),
      narrators: (narratorsMap.get(r.id) ?? []).sort((a, b) => a.position - b.position).map((n) => ({ name: n.name })),
      audioTotalSize: r.audioTotalSize, size: r.size, audioFileFormat: r.audioFileFormat,
      audioDuration: r.audioDuration, duration: r.duration, path: r.path,
      audioFileCount: r.audioFileCount, lastGrabGuid: r.lastGrabGuid,
      lastGrabInfoHash: r.lastGrabInfoHash, createdAt: r.createdAt, updatedAt: r.updatedAt,
    }));
  }

  private buildOrderBy(sortField?: BookSortField, sortDirection?: BookSortDirection): SQL[] {
    const dir = sortDirection === 'asc' ? asc : desc;
    switch (sortField) {
      case 'title':
        return [dir(sql`CASE WHEN LOWER(${books.title}) LIKE 'the %' THEN SUBSTR(${books.title}, 5) WHEN LOWER(${books.title}) LIKE 'a %' THEN SUBSTR(${books.title}, 3) WHEN LOWER(${books.title}) LIKE 'an %' THEN SUBSTR(${books.title}, 4) ELSE ${books.title} END`), dir(books.id)];
      case 'author':
        return [sql`CASE WHEN ${authors.name} IS NULL THEN 1 ELSE 0 END`, dir(authors.name), dir(books.id)];
      case 'narrator':
        return [sql`CASE WHEN (SELECT n.name FROM book_narrators bn JOIN narrators n ON n.id = bn.narrator_id WHERE bn.book_id = ${books.id} AND bn.position = 0 LIMIT 1) IS NULL THEN 1 ELSE 0 END`, dir(sql`(SELECT n.name FROM book_narrators bn JOIN narrators n ON n.id = bn.narrator_id WHERE bn.book_id = ${books.id} AND bn.position = 0 LIMIT 1)`), dir(books.id)];
      case 'series':
        return [sql`CASE WHEN ${books.seriesName} IS NULL THEN 1 ELSE 0 END`, dir(books.seriesName), sql`CASE WHEN ${books.seriesName} IS NULL THEN 0 WHEN ${books.seriesPosition} IS NULL THEN 1 ELSE 0 END`, asc(sql`CASE WHEN ${books.seriesName} IS NOT NULL THEN ${books.seriesPosition} ELSE NULL END`), dir(books.id)];
      case 'quality':
        return [sql`CASE WHEN COALESCE(${books.audioTotalSize}, ${books.size}) IS NULL OR COALESCE(${books.audioDuration}, ${books.duration}) IS NULL OR COALESCE(${books.audioDuration}, ${books.duration}) = 0 THEN 1 ELSE 0 END`, dir(sql`CAST(COALESCE(${books.audioTotalSize}, ${books.size}) AS REAL) / CAST(COALESCE(${books.audioDuration}, ${books.duration}) AS REAL)`), dir(books.id)];
      case 'size':
        return [sql`CASE WHEN COALESCE(${books.audioTotalSize}, ${books.size}) IS NULL THEN 1 ELSE 0 END`, dir(sql`COALESCE(${books.audioTotalSize}, ${books.size})`), dir(books.id)];
      case 'format':
        return [sql`CASE WHEN ${books.audioFileFormat} IS NULL THEN 1 ELSE 0 END`, dir(books.audioFileFormat), dir(books.id)];
      case 'createdAt':
      default:
        return [dir(books.createdAt), dir(books.id)];
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
