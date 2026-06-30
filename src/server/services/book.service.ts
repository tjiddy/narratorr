import { cleanEmptyParents } from '../utils/paths.js';
import { deleteManagedBookFiles, type DeleteManagedFilesResult } from '../utils/delete-managed-files.js';
import { uploadBookCover, CoverUploadError } from './cover-upload.js';
import type { CoverWriteOutcome } from './cover-write.js';
import { SUPPORTED_COVER_MIMES } from '../utils/mime.js';
import { eq, and, sql, notExists, inArray } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, authors, narrators, bookAuthors, bookNarrators, unmatchedGenres, importLists } from '../../db/schema.js';
import { slugify, findUnmatchedGenres, normalizeGenres } from '../../core/index.js';
import { replaceSeriesLink, upsertSeriesLink, type ReplaceSeriesLinkArgs } from './book-series-link.js';
import { findOrCreateAuthor, findOrCreateNarrator } from '../utils/find-or-create-person.js';
import { generatePublicId } from '../utils/public-id.js';
import { type MetadataService } from './metadata.service.js';
import { serializeError } from '../utils/serialize-error.js';
import type { BookRow } from './types.js';
import { productionTypeSchema, type BookStatus, type ProductionType } from '../../shared/schemas/book.js';
import { normalizeTitleForDedup } from '../../shared/dedup.js';
import { resolveRecordingIdentity, type RecordingCandidate, type LibraryRecording, type RecordingVerdict } from '../../core/utils/recording-identity.js';
import { isUniqueViolation } from '../../shared/error-message.js';

// `books.asin` carries a partial unique index (`idx_books_asin_unique` on the
// non-null column). A create-time race (two writers inserting the same ASIN
// between the dedupe check and the insert) still throws a SQLite UNIQUE
// violation; detect it the way enrichment.ts/book-import.service.ts do — both
// the index-name and column-message forms, checking `error.cause?.message`
// first since Drizzle/libSQL nests the SQLite message under `.cause`.
const ASIN_UNIQUE_VIOLATION = /UNIQUE constraint failed.*(?:idx_books_asin_unique|books\.asin)/;

/**
 * Typed fail-closed error for a recording that is already owned (#1711). Mirrors
 * the `RenameError` idiom: a typed throw rather than a silent owner-return so an
 * unmapped caller surfaces a loud error instead of enqueuing import work against
 * an already-owned book. Carries the incumbent's id/title so route handlers can
 * build a 409 body and import callers can log/skip.
 */
export class OwnedRecordingError extends Error {
  readonly code = 'OWNED_RECORDING' as const;
  readonly existingBookId: number;
  readonly bookTitle: string;
  readonly reason: string;
  constructor(args: { existingBookId: number; title: string; reason: string }) {
    super(`Recording already owned by book #${args.existingBookId} (${args.reason})`);
    this.name = 'OwnedRecordingError';
    this.existingBookId = args.existingBookId;
    this.bookTitle = args.title;
    this.reason = args.reason;
  }
}

/** Candidate identity for the 3-way duplicate resolution (#1711). */
export interface DuplicateCandidate {
  title: string;
  authors?: { name: string; asin?: string | undefined }[] | undefined;
  asin?: string | undefined;
  narrators?: string[] | undefined;
  duration?: number | null | undefined;
}

export type DuplicateVerdict = RecordingVerdict;

/**
 * Three-way duplicate resolution (#1711). `book` is the owning incumbent for
 * `same-recording`, a representative review incumbent for `review`, or `null`
 * for `different-recording` (a genuinely new recording).
 */
export interface DuplicateResolution {
  verdict: DuplicateVerdict;
  book: BookWithAuthor | null;
}

/** Adapt a candidate identity into the core resolver's plain-primitive shape. */
function toRecordingCandidate(c: DuplicateCandidate): RecordingCandidate {
  return {
    title: c.title,
    authors: (c.authors ?? []).map((a) => a.name),
    narrators: c.narrators ?? [],
    asin: c.asin ?? null,
    duration: c.duration ?? null,
  };
}

/** Adapt a hydrated library row into the core resolver's library-recording shape. */
function toLibraryRecording(b: BookWithAuthor): LibraryRecording {
  return {
    title: b.title,
    primaryAuthorSlug: slugify(b.authors[0]?.name ?? ''),
    narrators: b.narrators.map((n) => n.name),
    asin: b.asin ?? null,
    duration: b.duration ?? null,
  };
}

export { CoverUploadError } from './cover-upload.js';

type NewBook = typeof books.$inferInsert;
type AuthorRow = typeof authors.$inferSelect;
type NarratorRow = typeof narrators.$inferSelect;

/**
 * Replacement metadata payload for `BookService.fixMatch`. Every optional
 * field that is undefined is persisted as NULL — the operation replaces the
 * book's bibliographic identity wholesale, it is not a partial update.
 */
export interface FixMatchReplacement {
  asin?: string | undefined;
  title: string;
  subtitle?: string | undefined;
  authors: { name: string; asin?: string | undefined }[];
  narrators?: string[] | undefined;
  description?: string | undefined;
  publisher?: string | undefined;
  coverUrl?: string | undefined;
  duration?: number | undefined;
  publishedDate?: string | undefined;
  seriesName?: string | undefined;
  seriesPosition?: number | undefined;
  seriesAsin?: string | undefined;
  genres?: string[] | undefined;
  isbn?: string | undefined;
  seriesProvider?: string | undefined;
}

function buildFixMatchScalarUpdates(r: FixMatchReplacement): Partial<typeof books.$inferInsert> {
  return {
    title: r.title,
    subtitle: r.subtitle ?? null,
    description: r.description ?? null,
    publisher: r.publisher ?? null,
    coverUrl: r.coverUrl ?? null,
    asin: r.asin ?? null,
    isbn: r.isbn ?? null,
    seriesName: r.seriesName ?? null,
    seriesPosition: r.seriesPosition ?? null,
    duration: r.duration ?? null,
    publishedDate: r.publishedDate ?? null,
    genres: r.genres ?? null,
    enrichmentStatus: 'pending',
    enrichmentAttempts: 0,
    updatedAt: new Date(),
  };
}

function buildReplaceSeriesLinkArgs(r: FixMatchReplacement): ReplaceSeriesLinkArgs | null {
  if (!r.seriesName) return null;
  return {
    name: r.seriesName,
    position: r.seriesPosition ?? null,
    title: r.title,
    authorName: r.authors[0]?.name ?? null,
  };
}

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
      ...bookResults[0]!.book,
      importListName: bookResults[0]!.importListName ?? null,
      authors: authorResults.sort((a, b) => a.position - b.position).map((r) => r.author),
      narrators: narratorResults.sort((a, b) => a.position - b.position).map((r) => r.narrator),
    };
  }

  /**
   * Gather the ids of every plausible incumbent in the bibliographic scope
   * (#1711). Multi-narration means a normalized title + primary-author slug can
   * legitimately match more than one row, so this returns ALL of them (no
   * `limit(1)`) — `findDuplicate` then runs the recording resolver over each and
   * applies multi-incumbent precedence. The three gathering branches mirror the
   * pre-#1711 ordered identity contract: (1) ASIN case-insensitive, (2)
   * normalized-title + position-0 author slug, (3) author-less exact title-only
   * with the #253 notExists guard.
   */
  private async gatherIncumbentIds(candidate: DuplicateCandidate): Promise<number[]> {
    const ids = new Set<number>();

    // (1) ASIN — case-insensitive, ALL hits (aligns with findLibraryStatusByAsins).
    if (candidate.asin) {
      const byAsin = await this.db
        .select({ id: books.id })
        .from(books)
        .where(eq(sql`lower(${books.asin})`, candidate.asin.toLowerCase()));
      for (const r of byAsin) ids.add(r.id);
    }

    // (2) normalized title + position-0 author slug — ALL hits. Title normalization
    // (subtitle/paren/series stripping) is not SQLite-expressible, so fetch by
    // author slug and compare titles in application code.
    const authorList = candidate.authors;
    if (authorList && authorList.length > 0) {
      const primarySlug = slugify(authorList[0]!.name);
      const byAuthor = await this.db
        .select({ id: books.id, title: books.title })
        .from(books)
        .innerJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
        .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
        .where(eq(authors.slug, primarySlug));
      const wanted = normalizeTitleForDedup(candidate.title);
      for (const row of byAuthor) {
        if (normalizeTitleForDedup(row.title) === wanted) ids.add(row.id);
      }
    }

    // (3) Author-less exact title-only when no authors and no ASIN (#246). Only
    // zero-author rows so authored "Shogun" doesn't block authorless "Shogun" (#253).
    if (!candidate.asin && (!authorList || authorList.length === 0)) {
      const byTitle = await this.db
        .select({ id: books.id })
        .from(books)
        .where(and(
          eq(books.title, candidate.title),
          notExists(
            this.db.select({ id: bookAuthors.bookId }).from(bookAuthors).where(eq(bookAuthors.bookId, books.id)),
          ),
        ));
      for (const r of byTitle) ids.add(r.id);
    }

    return [...ids];
  }

  /**
   * Three-way, multi-incumbent-aware duplicate resolution (#1711). Gathers every
   * plausible incumbent in the bibliographic scope, runs `resolveRecordingIdentity`
   * over each, and applies the precedence ladder: any `same-recording` ⇒ owned
   * (order-independent); else any `review`/no-signal ⇒ review; else all
   * `different-recording` ⇒ a genuinely new recording.
   */
  async findDuplicate(candidate: DuplicateCandidate): Promise<DuplicateResolution> {
    const ids = await this.gatherIncumbentIds(candidate);
    if (ids.length === 0) return { verdict: 'different-recording', book: null };

    const recordingCandidate = toRecordingCandidate(candidate);
    let reviewBook: BookWithAuthor | null = null;
    for (const id of ids) {
      const book = await this.getById(id);
      if (!book) continue;
      const verdict = resolveRecordingIdentity(recordingCandidate, toLibraryRecording(book));
      // any same-recording wins as owned, regardless of row order.
      if (verdict === 'same-recording') return { verdict: 'same-recording', book };
      if (verdict === 'review' && !reviewBook) reviewBook = book;
    }
    if (reviewBook) return { verdict: 'review', book: reviewBook };
    return { verdict: 'different-recording', book: null };
  }

  /**
   * Return EVERY library row whose stored `path` equals the given normalized path
   * (#1711). `books.path` is indexed but NOT unique, so the occupied-target
   * collision fence must branch on cardinality (0 / exactly-1 / 2+). Mirrors the
   * rename-service normalization (`normalize(resolve(path))`); the CALLER
   * normalizes before passing so this stays a pure lookup.
   */
  async findPathOwners(normalizedPath: string): Promise<BookWithAuthor[]> {
    const rows = await this.db
      .select({ id: books.id })
      .from(books)
      .where(eq(books.path, normalizedPath));
    const owners: BookWithAuthor[] = [];
    for (const r of rows) {
      const book = await this.getById(r.id);
      if (book) owners.push(book);
    }
    return owners;
  }

  /**
   * Batch ASIN → library-status lookup for the v1 metadata-search cross-reference
   * (#1537). Given the result ASINs of a metadata search, returns a Map keyed by
   * the UPPERCASED ASIN with `{ bookId: <bk_ publicId>, status }` for each owned
   * book — so the caller does a plain `.get(result.asin?.toUpperCase())`.
   *
   * Case-insensitive by design: ASINs are NOT globally normalized in narratorr
   * (the parser uppercases, but API validators only `.trim()` and add-by-ASIN
   * stores as-is), so an exact `IN` would silently miss a case-drifted stored
   * ASIN and wrongly show every such book as "not owned". We match on
   * `lower(asin)` (the `book-list.service` precedent) and uppercase both the keys
   * and the result rows. The query is bounded by the small search result set
   * (currently ≤10) over the partial unique `idx_books_asin_unique`, so no
   * chunking is needed — but guard the empty list so we never emit `IN ()`.
   *
   * Null-ASIN owned books cannot match (the unique index is partial,
   * `asin IS NOT NULL`); that limitation is accepted and documented in #1537.
   */
  async findLibraryStatusByAsins(asins: string[]): Promise<Map<string, { bookId: string; status: BookStatus }>> {
    const map = new Map<string, { bookId: string; status: BookStatus }>();
    if (asins.length === 0) return map;

    const lowered = asins.map((a) => a.toLowerCase());
    const rows = await this.db
      .select({ bookId: books.publicId, status: books.status, asin: books.asin })
      .from(books)
      .where(inArray(sql`lower(${books.asin})`, lowered));

    for (const row of rows) {
      if (row.asin == null) continue;
      map.set(row.asin.toUpperCase(), { bookId: row.bookId, status: row.status as BookStatus });
    }
    return map;
  }

  /**
   * Replace all author junction rows for a book with the given list.
   * Deduplicates by slug within the payload, find-or-creates each author.
   * Called by create() and update().
   */
  async syncAuthors(tx: DbOrTx, bookId: number, authorList: { name: string; asin?: string | undefined }[]): Promise<void> {
    await tx.delete(bookAuthors).where(eq(bookAuthors.bookId, bookId));

    const seenSlugs = new Set<string>();
    const uniqueAuthors: { name: string; asin?: string | undefined }[] = [];
    for (const a of authorList) {
      const slug = slugify(a.name);
      if (!seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        uniqueAuthors.push(a);
      }
    }

    for (let i = 0; i < uniqueAuthors.length; i++) {
      const authorId = await findOrCreateAuthor(tx, uniqueAuthors[i]!.name, uniqueAuthors[i]!.asin);
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
      const narratorId = await findOrCreateNarrator(tx, uniqueNarrators[i]!);
      await tx
        .insert(bookNarrators)
        .values({ bookId, narratorId, position: i });
    }
  }

  async create(data: {
    title: string;
    authors: { name: string; asin?: string | undefined }[];
    narrators?: string[] | undefined;
    subtitle?: string | undefined;
    description?: string | undefined;
    publisher?: string | undefined;
    coverUrl?: string | undefined;
    asin?: string | undefined;
    isbn?: string | undefined;
    seriesName?: string | undefined;
    seriesPosition?: number | undefined;
    seriesAsin?: string | undefined;
    seriesProvider?: string | undefined;
    duration?: number | undefined;
    publishedDate?: string | undefined;
    genres?: string[] | undefined;
    status?: BookRow['status'] | undefined;
    enrichmentStatus?: BookRow['enrichmentStatus'] | undefined;
    productionType?: ProductionType | undefined;
    providerId?: string | undefined;
    importListId?: number | undefined;
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
        this.log.warn({ error: serializeError(error), providerId: data.providerId }, 'ASIN enrichment failed');
      }
    }

    let bookId: number;
    try {
      bookId = await this.db.transaction(async (tx) => {
        const result = await tx
          .insert(books)
          .values({
            publicId: generatePublicId('bk'),
            title: data.title,
            subtitle: data.subtitle,
            description: data.description,
            publisher: data.publisher,
            coverUrl: data.coverUrl,
            asin: enrichedAsin,
            isbn: data.isbn,
            seriesName: data.seriesName,
            seriesPosition: data.seriesPosition,
            duration: data.duration,
            publishedDate: data.publishedDate,
            genres: data.genres,
            status: data.status || 'wanted',
            enrichmentStatus: data.enrichmentStatus,
            // SQLite text-enums emit no DB CHECK (drizzle-sqlite-text-enum-no-db-check),
            // so validate the value at the write boundary; absent → column default.
            productionType: productionTypeSchema.parse(data.productionType ?? 'unknown'),
            importListId: data.importListId,
          })
          .returning();

        const id = result[0]!.id;

        await this.syncAuthors(tx, id, data.authors);
        if (data.narrators && data.narrators.length > 0) {
          await this.syncNarrators(tx, id, data.narrators);
        }

        // Upsert series + local member row at create time so the Series card
        // can render immediately. The Hardcover lazy-populate flow at GET time
        // replaces this local row with canonical Hardcover members when a key
        // is configured.
        if (data.seriesName) {
          await upsertSeriesLink(tx, this.log, id, {
            name: data.seriesName,
            position: data.seriesPosition ?? null,
            title: data.title,
            authorName: data.authors[0]?.name ?? null,
          });
        }

        return id;
      });
    } catch (error: unknown) {
      // Same-ASIN create-time race against the partial unique index (#1711).
      // Two non-null equal ASINs are `same-recording` by the resolver contract,
      // so this is a deterministically-owned recording, not a candidate for
      // review: resolve the incumbent and throw a typed `OwnedRecordingError`
      // so each caller fail-closes (409 / owned skip, never enqueue).
      if (enrichedAsin && isUniqueViolation(error, ASIN_UNIQUE_VIOLATION)) {
        // sourceBookId sentinel (-1): the new row rolled back, so there is no
        // self-row to exclude — any match is the incumbent.
        const collision = await this.findAsinCollision(-1, enrichedAsin);
        if (collision) {
          throw new OwnedRecordingError({ existingBookId: collision.conflictBookId, title: collision.conflictTitle, reason: 'asin-owned' });
        }
      }
      throw error;
    }

    this.log.info({ title: data.title, authors: data.authors?.map(a => a.name), asin: data.asin }, 'Book added to library');
    this.trackUnmatchedGenres(data.genres).catch((error) => this.log.debug({ error: serializeError(error) }, 'Failed to track unmatched genres'));
    return this.getById(bookId) as Promise<BookWithAuthor>;
  }

  async update(id: number, data: { [K in keyof NewBook]?: NewBook[K] | undefined } & { narrators?: string[] | undefined; authors?: { name: string; asin?: string | undefined }[] | undefined }): Promise<BookWithAuthor | null> {
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

    if ('genres' in data && data.genres !== undefined) {
      this.trackUnmatchedGenres(data.genres ?? undefined).catch((error: unknown) => {
        this.log.debug({ error: serializeError(error) }, 'Failed to track unmatched genres');
      });
    }

    return this.getById(id);
  }

  /**
   * Detect ASIN collision with another book in the library. Returns the
   * conflicting book's id/title when present, or null when the ASIN is free.
   * Excludes the source book itself (a self-match is not a conflict).
   */
  async findAsinCollision(sourceBookId: number, asin: string): Promise<{ conflictBookId: number; conflictTitle: string } | null> {
    const rows = await this.db
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(eq(books.asin, asin))
      .limit(2);
    for (const r of rows) {
      if (r.id !== sourceBookId) return { conflictBookId: r.id, conflictTitle: r.title };
    }
    return null;
  }

  /**
   * Replace the book's bibliographic/provider identity with the given metadata
   * record. Authors, narrators, scalar fields, and series membership are
   * updated atomically; local state (path, size, status, audio fields, grab
   * identifiers, on-disk files) is preserved. `enrichmentStatus` is reset to
   * 'pending' so the next enrichment cycle re-runs against the new ASIN.
   *
   * The caller is expected to have already validated ASIN collision via
   * `findAsinCollision`. Any non-collision DB failure bubbles up and rolls
   * back the entire transaction.
   */
  async fixMatch(id: number, replacement: FixMatchReplacement): Promise<BookWithAuthor | null> {
    const scalarUpdates = buildFixMatchScalarUpdates(replacement);
    const seriesArgs = buildReplaceSeriesLinkArgs(replacement);

    const updated = await this.db.transaction(async (tx) => {
      const result = await tx.update(books).set(scalarUpdates).where(eq(books.id, id)).returning();
      if (result.length === 0) return false;
      await this.syncAuthors(tx, id, replacement.authors);
      await this.syncNarrators(tx, id, replacement.narrators ?? []);
      await replaceSeriesLink(tx, id, seriesArgs);
      return true;
    });

    if (!updated) return null;
    this.log.info({ id, asin: replacement.asin }, 'Book metadata identity replaced (Fix Match)');

    if (replacement.genres) {
      this.trackUnmatchedGenres(replacement.genres).catch((error: unknown) => {
        this.log.debug({ error: serializeError(error) }, 'Failed to track unmatched genres');
      });
    }
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
   * Delete a book's MANAGED files from disk (audio + the narratorr cover sidecar), preserving any
   * foreign files (e-books, PDFs, subtitles, user images) co-located in the folder (#1589), then
   * clean up empty parent directories. Throws {@link PathOutsideLibraryError} for a path outside
   * the library root. A per-file deletion failure does NOT throw — it is recorded in the returned
   * `failedManaged`; the caller decides fatality (manual delete aborts before its DB mutation).
   */
  async deleteBookFiles(bookPath: string, libraryRoot: string): Promise<DeleteManagedFilesResult> {
    const result = await deleteManagedBookFiles(bookPath, libraryRoot, this.log);
    this.log.info(
      { path: bookPath, deleted: result.deletedManaged.length, preserved: result.preservedForeign.length, failed: result.failedManaged.length },
      'Book managed files deleted from disk',
    );

    await cleanEmptyParents(bookPath, libraryRoot, this.log);
    return result;
  }

  /**
   * Upload a custom cover image for a book.
   * Validates book exists and has a path, then delegates to uploadBookCover utility.
   *
   * Returns the reloaded book PLUS the {@link CoverWriteOutcome} from the writer so the route can
   * fire a connector refresh keyed off whether the `cover.*` file actually materialized — including
   * the case where the post-rename DB `coverUrl` update threw (outcome stays `'written'`). Pre-rename
   * failures still reject through `uploadBookCover` (the route keeps its existing error response).
   */
  async uploadCover(
    bookId: number,
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ book: BookWithAuthor; coverOutcome: CoverWriteOutcome }> {
    if (!SUPPORTED_COVER_MIMES.has(mimeType)) {
      throw new CoverUploadError('Only JPG, PNG, and WebP images are supported', 'INVALID_MIME');
    }

    const book = await this.getById(bookId);
    if (!book) {
      throw new CoverUploadError('Book not found', 'NOT_FOUND');
    }
    if (!book.path) {
      throw new CoverUploadError('Book has no path on disk', 'NO_PATH');
    }

    const coverOutcome = await uploadBookCover(bookId, book.path, buffer, mimeType, this.db, this.log);
    const reloaded = await this.getById(bookId) as BookWithAuthor;
    return { book: reloaded, coverOutcome };
  }

  /** Fire-and-forget: track genres not in the synonym/known lists for future analysis */
  private async trackUnmatchedGenres(genres: string[] | undefined): Promise<void> {
    const unmatched = findUnmatchedGenres(normalizeGenres(genres));
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
