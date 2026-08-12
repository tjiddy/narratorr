import { cleanEmptyParents } from '../utils/paths.js';
import { deleteManagedBookFiles, type DeleteManagedFilesResult } from '../utils/delete-managed-files.js';
import { uploadBookCover, CoverUploadError } from './cover-upload.js';
import type { CoverWriteOutcome } from './cover-write.js';
import { SUPPORTED_COVER_MIMES } from '../utils/mime.js';
import { eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, authors, narrators, bookAuthors, bookNarrators, importLists } from '@db/schema.js';
import { slugify } from '@core/index.js';
import { replaceSeriesLink, upsertSeriesLink, detachBookFromSeriesMembers } from './book-series-link.js';
import { findOrCreateAuthor, findOrCreateNarrator } from '../utils/find-or-create-person.js';
import { type MetadataService } from './metadata.service.js';
import { serializeError } from '../utils/serialize-error.js';
import type { BookRow, BookRowPublic } from './types.js';
import { productionTypeSchema, type BookStatus, type ClearableBookField } from '@shared/schemas/book.js';
import {
  parseClearedFields,
  serializeClearedFields,
  normalizeClearedFieldsColumn,
  recomputeClearedFields,
} from '../utils/cleared-fields.js';
import type { CompanionEbookV1 } from '@shared/schemas/v1/companion-ebook.js';
import { findLibraryStatusByAsins } from './book-library-status.js';
import { trackUnmatchedGenres } from './unmatched-genres.js';
import { buildNewBookValues, type CreateBookInput, type ResolvedBookCreateInput } from './book-create.js';
import { buildFixMatchScalarUpdates, buildReplaceSeriesLinkArgs, type FixMatchReplacement } from './book-fix-match.js';
import { usefulString } from './metadata-recording-collapse.js';
import { canonicalizeAsin } from '@shared/asin.js';
import { isUniqueViolation } from '@shared/error-message.js';
import {
  OwnedRecordingError,
  ASIN_UNIQUE_VIOLATION,
  resolveDuplicate,
  findPathOwners,
  type DuplicateCandidate,
  type DuplicateResolution,
} from './book-dedup.js';

// Re-export the dedup primitives so callers keep importing them from this service.
export {
  OwnedRecordingError,
  buildForcedImportRefusedReason,
  type DuplicateCandidate,
  type DuplicateResolution,
  type DuplicateVerdict,
} from './book-dedup.js';

export { CoverUploadError } from './cover-upload.js';

export type { CreateBookInput, ResolvedBookCreateInput } from './book-create.js';

export type { FixMatchReplacement } from './book-fix-match.js';

type NewBook = typeof books.$inferInsert;
type AuthorRow = typeof authors.$inferSelect;
type NarratorRow = typeof narrators.$inferSelect;

/** List shape deliberately excludes the raw tombstone column. */
export interface BookWithAuthor extends BookRowPublic {
  authors: AuthorRow[];
  narrators: NarratorRow[];
  importListName?: string | null;
}

/** Detail shape exposes parsed tombstones; corrupt stored JSON degrades to an empty set. */
export interface BookDetail extends BookWithAuthor {
  userClearedFields: ClearableBookField[];
}

/** Explicit opt-ins; update never infers operator intent from supplied nulls. */
export interface BookUpdateOptions {
  /** Operator assertion: recompute the tombstone set and reconcile `series_members` when `seriesName` is blanked. */
  userAsserted?: boolean;
  /** Caller-owned transaction; no nesting or post-commit effects. The returned detail reflects
   * pre-commit state on this handle and may never exist if the caller rolls back. */
  tx?: DbOrTx;
}

export interface LibraryStatusByAsin {
  bookId: string;
  status: BookStatus;
  companionEbook: CompanionEbookV1 | null;
}

export class BookService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private metadataService?: MetadataService,
  ) {}

  /** Use the caller's transaction handle to observe uncommitted writes; always replace the raw
   * tombstone column with its parsed representation. */
  async getById(id: number, executor: DbOrTx = this.db): Promise<BookDetail | null> {
    const bookResults = await executor
      .select({ book: books, importListName: importLists.name })
      .from(books)
      .leftJoin(importLists, eq(books.importListId, importLists.id))
      .where(eq(books.id, id))
      .limit(1);

    if (bookResults.length === 0) return null;

    const authorResults = await executor
      .select({ author: authors, position: bookAuthors.position })
      .from(bookAuthors)
      .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(eq(bookAuthors.bookId, id))
      .orderBy(bookAuthors.position);

    const narratorResults = await executor
      .select({ narrator: narrators, position: bookNarrators.position })
      .from(bookNarrators)
      .innerJoin(narrators, eq(bookNarrators.narratorId, narrators.id))
      .where(eq(bookNarrators.bookId, id))
      .orderBy(bookNarrators.position);

    return {
      ...bookResults[0]!.book,
      userClearedFields: parseClearedFields(bookResults[0]!.book.userClearedFields, this.log, id),
      importListName: bookResults[0]!.importListName ?? null,
      authors: authorResults.sort((a, b) => a.position - b.position).map((r) => r.author),
      narrators: narratorResults.sort((a, b) => a.position - b.position).map((r) => r.narrator),
    };
  }

  async findDuplicate(candidate: DuplicateCandidate): Promise<DuplicateResolution> {
    return resolveDuplicate(this.db, (id) => this.getById(id), candidate);
  }

  /** Returns every exact path owner; the caller must normalize the path first. */
  async findPathOwners(normalizedPath: string): Promise<BookWithAuthor[]> {
    return findPathOwners(this.db, (id) => this.getById(id), normalizedPath);
  }

  async findLibraryStatusByAsins(
    asins: string[],
    options: { companionEnabled: boolean },
  ): Promise<Map<string, LibraryStatusByAsin>> {
    return findLibraryStatusByAsins(this.db, asins, options);
  }

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

  /** Resolve provider data before the transaction, then log, emit telemetry, and hydrate after commit. */
  async create(data: CreateBookInput): Promise<BookDetail> {
    const resolved = await this.resolveCreateInput(data);
    const bookId = await this.createResolved(resolved);

    this.log.info({ title: data.title, authors: data.authors?.map(a => a.name), asin: canonicalizeAsin(resolved.asin) }, 'Book added to library');
    this.trackUnmatchedGenres(data.genres).catch((error) => this.log.debug({ error: serializeError(error) }, 'Failed to track unmatched genres'));
    return this.getById(bookId) as Promise<BookDetail>;
  }

  /** Resolve provider ASIN before opening a transaction; the returned input omits `providerId`. */
  async resolveCreateInput(data: CreateBookInput): Promise<ResolvedBookCreateInput> {
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

    const { providerId: _providerId, ...rest } = data;
    return { ...rest, asin: enrichedAsin };
  }

  /** Pre-resolved insert primitive with no provider I/O, hydration, or post-commit effects.
   * Caller-owned transactions receive raw unique errors; self-owned transactions map ASIN races. */
  async createResolved(data: ResolvedBookCreateInput, tx?: DbOrTx): Promise<number> {
    const canonicalAsin = canonicalizeAsin(data.asin);

    if (tx) return this.runResolvedInsert(tx, data, canonicalAsin);

    try {
      return await this.db.transaction((inner) => this.runResolvedInsert(inner, data, canonicalAsin));
    } catch (error: unknown) {
      // After rollback, sentinel -1 finds the incumbent without excluding any real book.
      if (canonicalAsin && isUniqueViolation(error, ASIN_UNIQUE_VIOLATION)) {
        const collision = await this.findAsinCollision(-1, canonicalAsin);
        if (collision) {
          throw new OwnedRecordingError({ existingBookId: collision.conflictBookId, title: collision.conflictTitle, reason: 'asin-owned' });
        }
      }
      throw error;
    }
  }

  private async runResolvedInsert(tx: DbOrTx, data: ResolvedBookCreateInput, canonicalAsin: string | null): Promise<number> {
    const result = await tx.insert(books).values(buildNewBookValues(data, canonicalAsin)).returning();
    const id = result[0]!.id;

    await this.syncAuthors(tx, id, data.authors);
    if (data.narrators && data.narrators.length > 0) {
      await this.syncNarrators(tx, id, data.narrators);
    }

    // Seed a local member immediately; Hardcover hydration may replace it with canonical members.
    // A blank name would normalize to '' and collapse every blank-named book into one junk row (#2224).
    // usefulString is a plain boolean, so the presence check carries the narrowing.
    if (data.seriesName !== undefined && usefulString(data.seriesName)) {
      await upsertSeriesLink(tx, this.log, id, {
        name: data.seriesName,
        position: data.seriesPosition ?? null,
        title: data.title,
        authorName: data.authors[0]?.name ?? null,
      });
    }

    return id;
  }

  async update(
    id: number,
    data: { [K in keyof NewBook]?: NewBook[K] | undefined } & { narrators?: string[] | undefined; authors?: { name: string; asin?: string | undefined }[] | undefined },
    options?: BookUpdateOptions,
  ): Promise<BookDetail | null> {
    const { narrators: narratorNames, authors: authorList, ...bookData } = data;

    if ('asin' in bookData) {
      bookData.asin = canonicalizeAsin(bookData.asin as string | null | undefined);
    }

    // SQLite has no enum CHECK; validate only present keys so omitted partial updates stay untouched.
    if ('productionType' in bookData) {
      bookData.productionType = productionTypeSchema.parse(bookData.productionType);
    }

    // Validate raw tombstones before opening a transaction; SQLite cannot enforce their field names.
    if ('userClearedFields' in bookData) {
      bookData.userClearedFields = normalizeClearedFieldsColumn(bookData.userClearedFields as string | null | undefined);
    }

    if (options?.tx) {
      const applied = await this.runUpdate(options.tx, id, bookData, narratorNames, authorList, options);
      return applied ? this.getById(id, options.tx) : null;
    }

    const updated = await this.db.transaction((tx) =>
      this.runUpdate(tx, id, bookData, narratorNames, authorList, options),
    );

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

  /** Keep the operator tombstone read-modify-write on this transaction; a pre-transaction read
   * can lose a concurrent edit. */
  private async runUpdate(
    tx: DbOrTx,
    id: number,
    bookData: Record<string, unknown>,
    narratorNames: string[] | undefined,
    authorList: { name: string; asin?: string | undefined }[] | undefined,
    options: BookUpdateOptions | undefined,
  ): Promise<boolean> {
    const setValues: Record<string, unknown> = { ...bookData };
    let blankedSeriesName = false;

    if (options?.userAsserted) {
      const existing = await tx
        .select({ userClearedFields: books.userClearedFields })
        .from(books)
        .where(eq(books.id, id))
        .limit(1);
      if (existing.length === 0) return false;

      const current = parseClearedFields(existing[0]!.userClearedFields, this.log, id);
      const { cleared, normalized, blanked } = recomputeClearedFields(current, bookData);
      Object.assign(setValues, normalized);
      setValues.userClearedFields = serializeClearedFields(cleared);
      blankedSeriesName = blanked.includes('seriesName');
    }

    const result = await tx
      .update(books)
      .set({ ...setValues, updatedAt: new Date() })
      .where(eq(books.id, id))
      .returning();

    if (result.length === 0) return false;

    if (narratorNames !== undefined) {
      await this.syncNarrators(tx, id, narratorNames);
    }

    if (authorList !== undefined) {
      await this.syncAuthors(tx, id, authorList);
    }

    // Detach in the same transaction so failure cannot leave stale series membership.
    if (blankedSeriesName) {
      await detachBookFromSeriesMembers(tx, id);
    }

    return true;
  }

  async findAsinCollision(sourceBookId: number, asin: string): Promise<{ conflictBookId: number; conflictTitle: string } | null> {
    // Match the `upper(asin)` expression index so legacy case drift still collides.
    const canonical = canonicalizeAsin(asin);
    if (!canonical) return null;
    const rows = await this.db
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(eq(sql`upper(${books.asin})`, canonical))
      .limit(2);
    for (const r of rows) {
      if (r.id !== sourceBookId) return { conflictBookId: r.id, conflictTitle: r.title };
    }
    return null;
  }

  /** Atomically replace bibliographic identity while preserving local/audio state. The caller must
   * preflight ASIN collisions; enrichment resets to pending for the new identity. */
  async fixMatch(id: number, replacement: FixMatchReplacement): Promise<BookDetail | null> {
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

  async updateStatus(id: number, status: BookRow['status']): Promise<BookDetail | null> {
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

  /** Delete managed audio/cover files while preserving foreign neighbors. Per-file failures are
   * returned in `failedManaged`; callers decide whether they are fatal. */
  async deleteBookFiles(bookPath: string, libraryRoot: string): Promise<DeleteManagedFilesResult> {
    const result = await deleteManagedBookFiles(bookPath, libraryRoot, this.log);
    this.log.info(
      { path: bookPath, deleted: result.deletedManaged.length, preserved: result.preservedForeign.length, failed: result.failedManaged.length },
      'Book managed files deleted from disk',
    );

    await cleanEmptyParents(bookPath, libraryRoot, this.log);
    return result;
  }

  /** Return the writer outcome even if its post-rename DB update failed, so the route can refresh
   * connectors whenever the cover file actually materialized. */
  async uploadCover(
    bookId: number,
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ book: BookDetail; coverOutcome: CoverWriteOutcome }> {
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
    // A reload failure must not suppress refresh after the file was written.
    const reloaded = await this.getById(bookId).catch(() => book) as BookDetail;
    return { book: reloaded, coverOutcome };
  }

  async trackUnmatchedGenres(genres: string[] | undefined): Promise<void> {
    return trackUnmatchedGenres(this.db, this.log, genres);
  }
}
