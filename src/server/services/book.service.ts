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
import { replaceSeriesLink, upsertSeriesLink, detachBookFromSeriesMembers, type ReplaceSeriesLinkArgs } from './book-series-link.js';
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
  genres?: string[] | undefined;
  isbn?: string | undefined;
}

function buildFixMatchScalarUpdates(r: FixMatchReplacement): Partial<typeof books.$inferInsert> {
  return {
    title: r.title,
    subtitle: r.subtitle ?? null,
    description: r.description ?? null,
    publisher: r.publisher ?? null,
    coverUrl: r.coverUrl ?? null,
    // Canonicalize the replacement ASIN at this write boundary (#1733).
    asin: canonicalizeAsin(r.asin),
    isbn: r.isbn ?? null,
    seriesName: r.seriesName ?? null,
    seriesPosition: r.seriesPosition ?? null,
    duration: r.duration ?? null,
    publishedDate: r.publishedDate ?? null,
    genres: r.genres ?? null,
    // Re-identifying a book is a NEW operator assertion (#2069 AC13): the prior
    // clears described the old record, so the whole tombstone set is reset rather
    // than honored. Written in the same transaction as the scalar replacement.
    userClearedFields: null,
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

/**
 * A hydrated book row for LIST responses. Extends `BookRowPublic`, not `BookRow`,
 * so the raw `user_cleared_fields` text cannot ride along into `GET /api/books`
 * (#2069 AC16) — the list has no consumer for tombstones.
 */
export interface BookWithAuthor extends BookRowPublic {
  authors: AuthorRow[];
  narrators: NarratorRow[];
  importListName?: string | null;
}

/**
 * The hydrated DETAIL shape (#2069 AC16) — what `getById`, `update`, `fixMatch`,
 * and the create paths return, and therefore what `GET /api/books/:id` serializes.
 *
 * `userClearedFields` is the PARSED set (`parseClearedFields` output), never the
 * raw column string: a corrupt row degrades to `[]` instead of failing the request.
 * No consumer may assume the field is parsed unless it came from here.
 */
export interface BookDetail extends BookWithAuthor {
  userClearedFields: ClearableBookField[];
}

/**
 * Options for {@link BookService.update} (#2069).
 *
 * Both flags are explicit OPT-INS — `update()` never infers operator intent from
 * the values it is handed. The internal callers (`refresh-scan`, `rename`,
 * scheduled enrichment, `enrichment-utils`, post-import enrichment) all pass
 * `null`s of their own and must neither create nor remove a tombstone.
 */
export interface BookUpdateOptions {
  /**
   * The write is an operator assertion (`PUT /api/books/:id`): recompute the
   * tombstone set from the body and normalize blank clearable values to NULL
   * (AC5/AC6/AC7). Also reconciles `series_members` when `seriesName` is blanked
   * (AC14), in the same transaction.
   */
  userAsserted?: boolean;
  /**
   * Caller-owned transaction handle (AC11). Every write runs on it and NO
   * transaction is opened — `db.transaction` is serialized per connection and
   * nesting throws `NestedTransactionError`.
   *
   * **Pre-commit return contract.** On this arm the returned `BookDetail` is read
   * on the caller's handle and therefore describes the state INSIDE their still-open
   * transaction; if the owner rolls back, that state never existed. The arm is also
   * deliberately side-effect-free — no success log, no unmatched-genre telemetry —
   * so a rollback cannot strand bookkeeping for data that never committed (the same
   * split `create`/`createResolved` already makes).
   */
  tx?: DbOrTx;
}

/** One entry of `findLibraryStatusByAsins`'s map — the v1 metadata-search
 *  `library` annotation, ready to assign onto a result. */
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

  /**
   * Hydrate one book into the DETAIL shape.
   *
   * `executor` defaults to `this.db`; a caller that owns a transaction passes its
   * handle so the read stays ON that handle and observes its own uncommitted
   * writes (#2069 AC11) — a `this.db` read cannot see them.
   *
   * The spread's raw `userClearedFields` string is OVERRIDDEN with the parsed set
   * (AC16), so the raw column never leaves this service.
   */
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

  /**
   * Three-way, multi-incumbent-aware duplicate resolution (#1711) — delegates to
   * the free function in `book-dedup.ts` (keeps this file under the line cap).
   */
  async findDuplicate(candidate: DuplicateCandidate): Promise<DuplicateResolution> {
    return resolveDuplicate(this.db, (id) => this.getById(id), candidate);
  }

  /**
   * Return EVERY library row whose stored `path` equals the given normalized path
   * (#1711) — the cardinality input for the occupied-target collision fence. The
   * CALLER normalizes before passing so this stays a pure lookup.
   */
  async findPathOwners(normalizedPath: string): Promise<BookWithAuthor[]> {
    return findPathOwners(this.db, (id) => this.getById(id), normalizedPath);
  }

  /**
   * Batch ASIN → library-status lookup for the v1 metadata-search cross-reference
   * (#1537). Delegates to the free function in `book-library-status.ts` (keeps this
   * file under the line cap); see there for the index-usage and companion notes.
   */
  async findLibraryStatusByAsins(
    asins: string[],
    options: { companionEnabled: boolean },
  ): Promise<Map<string, LibraryStatusByAsin>> {
    return findLibraryStatusByAsins(this.db, asins, options);
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

  /**
   * Enrichment WRAPPER (#1892). Preserves the pre-split public contract for
   * every current caller: performs the ASIN enrichment provider round-trip,
   * delegates the durable write to the tx-scoped `createResolved` primitive with
   * NO outer transaction, then — after that self-managed transaction commits —
   * emits the success log, fires the fire-and-forget genre telemetry, and
   * hydrates to a `BookWithAuthor`. The post-commit side effects live here (not
   * in the primitive) so a future caller-owned-tx rollback can never strand them.
   */
  async create(data: CreateBookInput): Promise<BookDetail> {
    const resolved = await this.resolveCreateInput(data);
    const bookId = await this.createResolved(resolved);

    // Report the ASIN the row was actually persisted with (#1898): read it off
    // `resolved` so the enrich branch isn't logged as `undefined`, and run it
    // through the same write-boundary canonicalization `createResolved` applied,
    // so the line greps against the stored `books.asin` value. A miss logs an
    // explicit `null` rather than a leftover input string.
    this.log.info({ title: data.title, authors: data.authors?.map(a => a.name), asin: canonicalizeAsin(resolved.asin) }, 'Book added to library');
    this.trackUnmatchedGenres(data.genres).catch((error) => this.log.debug({ error: serializeError(error) }, 'Failed to track unmatched genres'));
    return this.getById(bookId) as Promise<BookDetail>;
  }

  /**
   * Provider-ASIN enrichment, extracted from `create()` (#1893). Fetches provider
   * detail when `asin` is absent but `providerId` present, carries the resolved
   * ASIN, drops the enrichment-only `providerId`, and returns a providerId-free
   * `ResolvedBookCreateInput`. This is the ONLY provider I/O on the create path —
   * call it BEFORE opening a transaction so `createResolved` does zero I/O inside
   * the tx. `create()` delegates here (its pinned enrichment tests still pass);
   * the staged-import runner calls it pre-transaction, then hands the result to
   * `createResolved(resolved, tx)`.
   */
  async resolveCreateInput(data: CreateBookInput): Promise<ResolvedBookCreateInput> {
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

    // Drop the enrichment-only `providerId` and carry the resolved ASIN into the
    // primitive — enrichment is now done, so `createResolved` does zero I/O.
    const { providerId: _providerId, ...rest } = data;
    return { ...rest, asin: enrichedAsin };
  }

  /**
   * Tx-scoped insert PRIMITIVE (#1892). Accepts PRE-RESOLVED metadata (`asin`
   * already decided) and an optional outer transaction; performs ZERO provider
   * I/O and NO post-commit side effects (no success log, no genre telemetry, no
   * hydration). Returns the inserted numeric `bookId` — the wrapper hydrates it
   * after its own commit; the staged-import worker uses it for enqueue/outcome
   * writes.
   *
   * Modeled on `BookImportService.enqueue`: with `tx` it runs every write on the
   * caller's handle and PROPAGATES a same-ASIN unique violation RAW (the staged
   * orchestrator owns the post-rollback incumbent lookup — a `this.db` read
   * cannot observe an uncommitted caller tx). Without `tx` it opens its own
   * transaction and, after that rolls back, maps the same-ASIN unique violation
   * to `OwnedRecordingError` (#1711) — identical to the pre-split behavior for
   * every current caller.
   */
  async createResolved(data: ResolvedBookCreateInput, tx?: DbOrTx): Promise<number> {
    // Canonicalize at the write boundary (#1733) so the stored value, the
    // create-time race guard, and the durable `upper(asin)` unique index all
    // agree on a single (UPPERCASE) canonical form.
    const canonicalAsin = canonicalizeAsin(data.asin);

    // Caller owns the transaction: run the writes on their handle and let any
    // unique violation surface raw — no off-handle incumbent lookup here.
    if (tx) return this.runResolvedInsert(tx, data, canonicalAsin);

    try {
      return await this.db.transaction((inner) => this.runResolvedInsert(inner, data, canonicalAsin));
    } catch (error: unknown) {
      // Same-ASIN create-time race against the partial unique index (#1711).
      // The failed insert has rolled back, so `findAsinCollision(-1, …)` reads a
      // clean `this.db` and any match is the incumbent (sentinel -1: no self-row
      // to exclude). Two non-null equal ASINs are a deterministically-owned
      // recording → typed `OwnedRecordingError` so each caller fail-closes.
      if (canonicalAsin && isUniqueViolation(error, ASIN_UNIQUE_VIOLATION)) {
        const collision = await this.findAsinCollision(-1, canonicalAsin);
        if (collision) {
          throw new OwnedRecordingError({ existingBookId: collision.conflictBookId, title: collision.conflictTitle, reason: 'asin-owned' });
        }
      }
      throw error;
    }
  }

  /**
   * The in-transaction write sequence shared by both `createResolved` branches
   * (mirrors `BookImportService.runEnqueue`): book insert, author/narrator
   * junctions, and the create-time series link — all on the supplied handle.
   */
  private async runResolvedInsert(tx: DbOrTx, data: ResolvedBookCreateInput, canonicalAsin: string | null): Promise<number> {
    const result = await tx.insert(books).values(buildNewBookValues(data, canonicalAsin)).returning();
    const id = result[0]!.id;

    await this.syncAuthors(tx, id, data.authors);
    if (data.narrators && data.narrators.length > 0) {
      await this.syncNarrators(tx, id, data.narrators);
    }

    // Upsert series + local member row at create time so the Series card can
    // render immediately. The Hardcover lazy-populate flow at GET time replaces
    // this local row with canonical Hardcover members when a key is configured.
    if (data.seriesName) {
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

    // Canonicalize the ASIN at this service-internal write boundary (#1733). The
    // HTTP `updateBookBodySchema` is `.strict()` and carries no `asin` key, so
    // this only fires for internal callers (enrichment writeback, Fix Match
    // prep, tests) — but they must store the same canonical form as `create`.
    if ('asin' in bookData) {
      bookData.asin = canonicalizeAsin(bookData.asin as string | null | undefined);
    }

    // Validate the production_type enum at this write boundary, parity with
    // create() (drizzle-sqlite-text-enum-no-db-check: SQLite text-enums emit no
    // DB CHECK). Gate on key *presence*, not truthiness — a partial update that
    // omits productionType must leave the existing value untouched, so unlike
    // create() there is no `?? 'unknown'` default-fill. A present-but-invalid
    // value parses to a throw, rejecting before the transaction/write.
    if ('productionType' in bookData) {
      bookData.productionType = productionTypeSchema.parse(bookData.productionType);
    }

    // Same write-boundary rule for the tombstone column (#2069 AC2) — SQLite text
    // columns emit no DB CHECK either. A supplied raw value carrying an unknown
    // field name throws HERE, before any transaction opens, so no `.set(...)` is
    // ever issued for it.
    if ('userClearedFields' in bookData) {
      bookData.userClearedFields = normalizeClearedFieldsColumn(bookData.userClearedFields as string | null | undefined);
    }

    // Caller owns the transaction: run every write on their handle, open none,
    // and skip the post-commit side effects entirely (they'd be stranded by a
    // rollback the owner may still perform). The hydration reads their handle so
    // it observes the writes just made — see `BookUpdateOptions.tx`.
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

  /**
   * The in-transaction write sequence shared by both `update()` arms. Returns
   * whether a row matched.
   *
   * On the `userAsserted` path the tombstone read-modify-write happens HERE, on
   * the same handle as the scalar UPDATE (#2069 AC8): re-reading the stored set
   * inside the transaction is what keeps two concurrent edits from interleaving
   * into a stale set — an implementation that reads it before the transaction
   * opens can silently drop the other edit's tombstone.
   */
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

    // Series membership residue (#2069 AC14). Same transaction as the scalar
    // write, so a reconcile failure rolls the clear back too rather than leaving
    // exactly the stale residue this exists to remove.
    if (blankedSeriesName) {
      await detachBookFromSeriesMembers(tx, id);
    }

    return true;
  }

  /**
   * Detect ASIN collision with another book in the library. Returns the
   * conflicting book's id/title when present, or null when the ASIN is free.
   * Excludes the source book itself (a self-match is not a conflict).
   */
  async findAsinCollision(sourceBookId: number, asin: string): Promise<{ conflictBookId: number; conflictTitle: string } | null> {
    // Case-insensitive collision check (#1733): canonicalize the argument and
    // compare against `upper(books.asin)` so a case-drifted incumbent is found
    // (this was the codebase's only case-sensitive ASIN comparison). Matching on
    // the `upper(asin)` expression also lets the query use the new expression
    // unique index. A null/empty argument canonicalizes to null → no collision.
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
    // Fall back to the pre-write `book` if the post-write reload throws, so the route always receives
    // usable state and still fires its `'metadata'` refresh. `finalizeCoverWrite` deliberately keeps
    // `coverOutcome === 'written'` on a post-rename DB failure *so the refresh fires* — re-throwing
    // here on a reload miss would re-introduce the very failure point it avoids.
    const reloaded = await this.getById(bookId).catch(() => book) as BookDetail;
    return { book: reloaded, coverOutcome };
  }

  /** Fire-and-forget: track genres not in the synonym/known lists for future analysis */
  async trackUnmatchedGenres(genres: string[] | undefined): Promise<void> {
    return trackUnmatchedGenres(this.db, this.log, genres);
  }
}
