import { eq, and, like, desc, asc, sql, count as countFn, inArray, or, getTableColumns, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { books, authors, importLists } from '../../db/schema.js';
import type { BookSortField, BookSortDirection } from '../../shared/schemas/book.js';
import type { BookWithAuthor } from './book.service.js';

type BookRow = typeof books.$inferSelect;

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

export class BookListService {
  constructor(
    private db: Db,
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
          book: getSlimBookColumns(),
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
}
