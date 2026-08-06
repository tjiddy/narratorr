import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '@db/index.js';
import { bookAuthors, authors as authorsTable, books, series, seriesMembers } from '@db/schema.js';
import type { SeriesRow } from './types.js';
import type { SettingsService } from './settings.service.js';
import { HardcoverClient, type HardcoverSearchCandidate, type HardcoverSeriesData } from '@core/metadata/hardcover.js';
import { resolveSeriesViaHardcover } from './hardcover-series-resolver.js';
import { findInLibraryMatch, normalizeMemberTitleForMatch, type LibraryBookSummary } from './series-title-match.js';
import {
  buildMembersFromState,
  compareLibraryMembers,
  libraryMemberCard,
  type BookSeriesMemberCard,
  type MemberState,
} from './series-card-members.js';
import { relinkBookToBoundSeries, removeSeriesNameTombstone, seedLocalMembersForUnclaimedBooks } from './book-series-link.js';
import { upsertHardcoverSeries } from './hardcover-series-upsert.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * The card's member-entry shape. Declared beside the assembly rule that produces
 * it in `series-card-members.ts` and re-exported here, because this module is the
 * import site every consumer (the services barrel, the routes) already uses.
 */
export type { BookSeriesMemberCard };

/** Scheduled sweep threshold — rows older than this are re-fetched. */
export const STALE_AFTER_DAYS = 7;

export interface BookSeriesCardData {
  id: number | null;
  name: string;
  hardcoverSeriesId: number | null;
  seriesAuthor: string | null;
  lastFetchedAt: string | null;
  members: BookSeriesMemberCard[];
}

/**
 * What a successful {@link SeriesCardService.bindHardcoverSeries} hands back (#2098).
 *
 * The card is what the route responds with; `syncedIds` is what the route's
 * post-commit pass iterates to refresh each rewritten book's `metadata.opf` and
 * embedded tags. It carries EXACTLY the ids the transaction issued an
 * `UPDATE books SET series_name/series_position` for — every member-matched
 * library book, plus the initiating book when it matched no member — with no
 * duplicates, and is never empty on a non-null return.
 */
export interface BindHardcoverSeriesResult {
  card: BookSeriesCardData;
  syncedIds: number[];
}

export interface BookForSeriesCard {
  id: number;
  title: string;
  seriesName: string | null;
  seriesPosition: number | null;
}

/** A library book paired to its matched Hardcover member's position. */
interface MatchedLibraryBook { bookId: number; position: number | null }

export class SeriesCardService {
  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Get the series card for a book.
   *
   * Key configured + cache hit: returns the persisted Hardcover-shaped data.
   * Key configured + cache miss: resolves via Hardcover, persists the result,
   *   returns the populated card. On any Hardcover failure, degrades silently
   *   to the no-key (library-only) view and does NOT persist a partial row.
   * No key configured: bypasses `series_members` entirely and builds members
   *   from the `books` table.
   */
  async getSeriesForBook(bookId: number): Promise<BookSeriesCardData | null> {
    const book = await this.loadBook(bookId);
    if (!book) return null;
    if (!book.seriesName) return null;

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return this.buildLibraryOnlyCard(book.seriesName);
    }

    const cached = await this.findCachedSeries(book.seriesName);
    if (cached && cached.hardcoverSeriesId !== null) {
      return this.buildCardFromCache(cached, book.seriesName);
    }

    // Cache miss — resolve via Hardcover. On any failure we degrade to
    // library-only and DO NOT persist anything (otherwise a transient API
    // failure could overwrite cached state on the next attempt).
    const resolved = await this.resolveViaHardcover(apiKey, book);
    if (!resolved) return this.buildLibraryOnlyCard(book.seriesName);

    return this.persistAndBuildCard(resolved, book.seriesName);
  }

  /**
   * Manual refresh: with a key configured, always re-fetches Hardcover (via
   * cached `hardcover_series_id` when present, otherwise via the resolver).
   * Without a key, returns the library-only view; no 4xx.
   */
  async refreshSeriesForBook(bookId: number): Promise<BookSeriesCardData | null> {
    const book = await this.loadBook(bookId);
    if (!book) return null;
    if (!book.seriesName) return null;

    const apiKey = await this.getApiKey();
    if (!apiKey) return this.buildLibraryOnlyCard(book.seriesName);

    const cached = await this.findCachedSeries(book.seriesName);
    const resolved = cached?.hardcoverSeriesId
      ? await this.fetchById(apiKey, cached.hardcoverSeriesId)
      : await this.resolveViaHardcover(apiKey, book);

    if (!resolved) return this.buildLibraryOnlyCard(book.seriesName);

    return this.persistAndBuildCard(resolved, book.seriesName);
  }

  /**
   * Scheduled sweep: re-fetches Hardcover for stale `series` rows. Skipped
   * entirely when no Hardcover key is configured. For each stale row:
   *
   *   - `hardcover_series_id` present → call `GetSeriesMembersById`; on
   *     success, replace `series_members` transactionally and update
   *     `series.author_name` from the response.
   *   - `hardcover_series_id` NULL → pick the lowest-`books.id` linked book
   *     that has a `seriesName` and at least one author; run the resolver
   *     using that book as input.
   *   - `hardcover_series_id` NULL and no qualifying linked book → log + skip;
   *     do not modify the row.
   *
   * Per-row TTL / backoff / `nextFetchAfter` logic is gone — failures are
   * silent for a row but do not advance the timestamp, so the row is picked
   * up on the next sweep.
   */
  async runScheduledRefresh(): Promise<{ refreshed: number; skipped: number }> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      this.log.info('Series scheduled refresh skipped — no Hardcover API key configured');
      return { refreshed: 0, skipped: 0 };
    }

    const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000);
    const stale = await this.db
      .select()
      .from(series)
      .where(lt(series.lastFetchedAt, cutoff));

    let refreshed = 0;
    let skipped = 0;
    for (const row of stale) {
      try {
        const ok = row.hardcoverSeriesId !== null
          ? await this.refreshById(apiKey, row)
          : await this.refreshByLinkedBook(apiKey, row);
        if (ok) refreshed++; else skipped++;
      } catch (error: unknown) {
        this.log.warn({ seriesId: row.id, error: serializeError(error) }, 'Scheduled series refresh failed for row');
        skipped++;
      }
    }
    return { refreshed, skipped };
  }

  private async refreshById(apiKey: string, row: SeriesRow): Promise<boolean> {
    const resolved = await this.fetchById(apiKey, row.hardcoverSeriesId!);
    if (!resolved) return false;
    await this.persistAndBuildCard(resolved, row.name);
    return true;
  }

  private async refreshByLinkedBook(apiKey: string, row: SeriesRow): Promise<boolean> {
    const linked = await this.db
      .select({
        id: books.id,
        title: books.title,
        seriesName: books.seriesName,
        seriesPosition: books.seriesPosition,
      })
      .from(seriesMembers)
      .innerJoin(books, eq(seriesMembers.bookId, books.id))
      .where(and(eq(seriesMembers.seriesId, row.id), isNotNull(books.seriesName)))
      .orderBy(asc(books.id));
    for (const candidate of linked) {
      const hasAuthor = await this.findPrimaryAuthorName(candidate.id);
      if (hasAuthor) {
        const resolved = await this.resolveViaHardcover(apiKey, candidate as BookForSeriesCard);
        if (!resolved) return false;
        await this.persistAndBuildCard(resolved, candidate.seriesName!);
        return true;
      }
    }
    this.log.info({ seriesId: row.id, name: row.name }, 'Skipping stale series row: no linked book with author available for re-resolution');
    return false;
  }

  private async getApiKey(): Promise<string | null> {
    const metadata = await this.settingsService.get('metadata');
    const key = (metadata.hardcoverApiKey ?? '').trim();
    return key.length === 0 ? null : key;
  }

  private async loadBook(bookId: number): Promise<BookForSeriesCard | null> {
    const rows = await this.db
      .select({
        id: books.id,
        title: books.title,
        seriesName: books.seriesName,
        seriesPosition: books.seriesPosition,
      })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async findCachedSeries(seriesName: string): Promise<SeriesRow | null> {
    const normalized = normalizeSeriesName(seriesName);
    const rows = await this.db
      .select()
      .from(series)
      .where(eq(series.normalizedName, normalized))
      .limit(1);
    return rows[0] ?? null;
  }

  private async resolveViaHardcover(apiKey: string, book: BookForSeriesCard): Promise<HardcoverSeriesData | null> {
    if (!book.seriesName) return null;
    const primaryAuthor = await this.findPrimaryAuthorName(book.id);
    if (!primaryAuthor) {
      this.log.debug({ bookId: book.id, seriesName: book.seriesName }, 'Series card: no primary author — cannot resolve via Hardcover');
      return null;
    }
    try {
      const client = new HardcoverClient(apiKey);
      return await resolveSeriesViaHardcover(client, {
        seriesName: book.seriesName,
        author: primaryAuthor,
      });
    } catch (error: unknown) {
      this.log.warn({ bookId: book.id, seriesName: book.seriesName, error: serializeError(error) }, 'Series card: Hardcover resolve failed — degrading to library-only');
      return null;
    }
  }

  private async fetchById(apiKey: string, hardcoverSeriesId: number): Promise<HardcoverSeriesData | null> {
    try {
      const client = new HardcoverClient(apiKey);
      return await client.getSeriesMembersById(hardcoverSeriesId);
    } catch (error: unknown) {
      this.log.warn({ hardcoverSeriesId, error: serializeError(error) }, 'Series card: Hardcover by-id fetch failed — degrading to library-only');
      return null;
    }
  }

  private async findPrimaryAuthorName(bookId: number): Promise<string | null> {
    const rows = await this.db
      .select({ name: authorsTable.name })
      .from(bookAuthors)
      .innerJoin(authorsTable, eq(bookAuthors.authorId, authorsTable.id))
      .where(eq(bookAuthors.bookId, bookId))
      .orderBy(asc(bookAuthors.position))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  private async buildLibraryOnlyCard(seriesName: string): Promise<BookSeriesCardData> {
    const libraryBooks = await this.loadLibraryBooksForSeries(seriesName);
    const members = libraryBooks.map(libraryMemberCard).sort(compareLibraryMembers);
    return {
      id: null,
      name: seriesName,
      hardcoverSeriesId: null,
      seriesAuthor: null,
      lastFetchedAt: null,
      members,
    };
  }

  /**
   * The card's two inputs, read together off ONE handle: the series' member rows
   * and its library pool. Taken on `this.db` for the snapshot and re-taken on the
   * transaction handle inside the reconcile — which is the whole point of having
   * it as one function. A guarded write must re-read its preconditions INSIDE the
   * transaction (`src/db/serial-transactions.ts`), and a second reader written
   * separately is a second reader that can drift from the first.
   */
  private async readMemberState(executor: DbOrTx, seriesId: number, seriesName: string): Promise<MemberState> {
    // SQLite's default ASC ordering puts NULL positions FIRST, but the
    // library-only path puts them LAST via `compareLibraryMembers`. Read the
    // rows unordered (the DB row id is not user-facing) and sort in JS so
    // both modes share a single ordering rule.
    const rows = await executor
      .select()
      .from(seriesMembers)
      .where(eq(seriesMembers.seriesId, seriesId));
    const pool = await this.loadLibraryBooksForSeries(seriesName, executor);
    return { rows, pool };
  }

  private async buildCardFromCache(row: SeriesRow, seriesName: string): Promise<BookSeriesCardData> {
    const snapshot = buildMembersFromState(await this.readMemberState(this.db, row.id, seriesName));
    // FAST PATH — every owned book is already represented. The common case, and
    // it includes every card built immediately after `persistMembers` seeded: no
    // transaction is opened and no write is issued, so the reconcile does not tax
    // the ordinary GET.
    const members = snapshot.unclaimed.length === 0
      ? snapshot.members
      : await this.reconcileUnclaimedMembers(row.id, seriesName, snapshot.members);
    return {
      id: row.id,
      name: row.name,
      hardcoverSeriesId: row.hardcoverSeriesId,
      seriesAuthor: row.authorName,
      lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
      members,
    };
  }

  /**
   * Persist the local rows the snapshot found missing, GUARDED and best-effort
   * (#2144 AC10).
   *
   * The snapshot read is not a safe basis for an insert: a refresh or a bind can
   * delete-and-rebuild the series in between and pair that book to a
   * newly-available Hardcover member, after which an unguarded insert resurrects
   * a superseded local row — and the two partial unique indexes are disjoint, so
   * the DB would happily let it coexist with the canonical one. The single
   * transaction therefore RE-READS both the member rows and the pool inside
   * itself, recomputes the unclaimed set from those fresh reads, and inserts only
   * what is still unclaimed. A book claimed in the meantime, removed from the
   * pool, or deleted outright is simply absent from the recomputed set — which is
   * also what keeps the FK from rejecting an insert naming a since-deleted book
   * ([[libsql-foreign-keys-on-by-default]]).
   *
   * The transaction returns the member rows it LEAVES BEHIND, and the card is
   * assembled from those, never from the pre-write snapshot — so the response
   * cannot advertise a row the guard declined to write
   * ([[caller-owned-tx-drops-post-commit-effects]]).
   *
   * Best-effort by design: any failure, including a partial-unique-index
   * collision as the last-resort backstop, is caught and logged, and the card
   * falls back to the pre-write snapshot's entries. `getSeriesForBook` /
   * `refreshSeriesForBook` still resolve; no rejection escapes.
   *
   * NEVER nested: this is opened only from the card build, and every caller
   * (`persistAndBuildCard`, `bindHardcoverSeries`) invokes that build AFTER its
   * own transaction has resolved. `db-write-lane.ts` is deliberately not used —
   * its own docblock scopes it to a compound sequence needing atomicity against
   * another compound sequence, and notes a single guarded transaction does not.
   */
  private async reconcileUnclaimedMembers(
    seriesId: number,
    seriesName: string,
    fallback: BookSeriesMemberCard[],
  ): Promise<BookSeriesMemberCard[]> {
    try {
      const committed = await this.db.transaction(async (tx) => {
        const fresh = await this.readMemberState(tx, seriesId, seriesName);
        const { unclaimed } = buildMembersFromState(fresh);
        if (unclaimed.length === 0) return fresh;
        await seedLocalMembersForUnclaimedBooks(tx, seriesId, unclaimed);
        return this.readMemberState(tx, seriesId, seriesName);
      });
      return buildMembersFromState(committed).members;
    } catch (error: unknown) {
      this.log.warn(
        { seriesId, seriesName, error: serializeError(error) },
        'Series card: seeding owned members left unclaimed by Hardcover failed — rendering the pre-write snapshot',
      );
      return fallback;
    }
  }

  private async persistAndBuildCard(resolved: HardcoverSeriesData, seriesName: string): Promise<BookSeriesCardData> {
    const { row } = await this.db.transaction((tx) => this.persistMembers(tx, resolved, seriesName));
    return this.buildCardFromCache(row, seriesName);
  }

  /**
   * Id-first upsert of the canonical `series` row + full rebuild of its
   * Hardcover member set, matching each member to a library book via
   * `findInLibraryMatch`. Runs inside the caller's transaction; errors
   * propagate. Shared by the lazy/refresh paths and the manual bind path
   * (#1228). The candidate library pool is scoped to `seriesName` plus any
   * `extraSeriesNames` — the bind path passes the pre-bind (Audnexus) name so
   * sibling books still carrying the old name are matched here too, letting
   * the bind caller sync EVERY matched member, not just the initiating book.
   * Returns the upserted row alongside the (bookId, position) pairs it matched.
   *
   * After the Hardcover inserts, every owned book the members left UNCLAIMED gets
   * a `source: 'local'` row (#2144). That seed reads the PRIMARY name's pool only,
   * never `extraSeriesNames`: on the bind path a sibling still carrying the
   * pre-bind (Audnexus) name that matched no member is not a member of the
   * canonical series and must get no row. Because this method deletes every row
   * of the series before rebuilding, a later refresh whose payload finally
   * carries the real Hardcover member supersedes the seeded row for free — one
   * canonical row, no local row, and no separate "upgrade" path.
   */
  private async persistMembers(tx: DbOrTx, resolved: HardcoverSeriesData, seriesName: string, extraSeriesNames: string[] = []): Promise<{ row: SeriesRow; matches: MatchedLibraryBook[] }> {
    const normalized = normalizeSeriesName(seriesName);
    const libraryBooks = await this.loadLibraryBooksForSeriesNames([seriesName, ...extraSeriesNames], tx);
    const upserted = await upsertHardcoverSeries(tx, resolved, normalized);
    await tx.delete(seriesMembers).where(eq(seriesMembers.seriesId, upserted.id));
    const matchedLibraryIds = new Set<number>();
    const matches: MatchedLibraryBook[] = [];
    for (const member of resolved.members) {
      const match = findInLibraryMatch({ title: member.title, position: member.position }, libraryBooks, matchedLibraryIds);
      if (match) {
        matchedLibraryIds.add(match.id);
        matches.push({ bookId: match.id, position: member.position });
      }
      await tx.insert(seriesMembers).values({
        seriesId: upserted.id,
        bookId: match?.id ?? null,
        hardcoverBookId: member.hardcoverBookId,
        slug: member.slug,
        imageUrl: member.imageUrl,
        title: member.title,
        normalizedTitle: normalizeMemberTitleForMatch(member.title),
        authorName: resolved.authorName,
        position: member.position,
        source: 'hardcover',
      });
    }
    const primaryPool = extraSeriesNames.length === 0
      ? libraryBooks
      : await this.loadLibraryBooksForSeries(seriesName, tx);
    await seedLocalMembersForUnclaimedBooks(
      tx,
      upserted.id,
      primaryPool.filter((book) => !matchedLibraryIds.has(book.id)),
    );
    return { row: upserted, matches };
  }

  /**
   * Manual override (#1228): bind a chosen Hardcover series id onto the book's
   * series so the card and book detail never diverge. A bind is *series-level*,
   * so in a SINGLE transaction it: (1) id-first upserts the canonical `series`
   * row (no unique-index collision) and rebuilds its member set, matching
   * library books across both the pre-bind and canonical names; (2) syncs
   * `books.series_name`/`series_position` for EVERY matched member — not just
   * the initiating book, else siblings keep the stale name and the series
   * splits in the Library view — to the canonical name + its own matched
   * position (0 is valid). The initiating book always adopts the canonical name
   * even when unmatched, keeping its position; (3) re-links every synced book
   * off old series rows and deletes any left empty. Any failure rolls all of it
   * back. Returns the rebuilt (id-sourced) card **alongside the ids the
   * transaction actually rewrote**, or null when the book is missing, no key is
   * configured, or the fetch fails.
   *
   * `syncedIds` is returned OUT of the transaction callback rather than
   * accumulated in an outer variable (#2098 AC2): a rolled-back bind must be
   * structurally incapable of reporting ids for writes that never landed, and
   * the route's post-commit sidecar/tag pass reads only what the resolved
   * transaction handed back. Order is matched-member order, followed by the
   * initiating book when that book was unmatched.
   */
  async bindHardcoverSeries(bookId: number, hardcoverSeriesId: number): Promise<BindHardcoverSeriesResult | null> {
    const book = await this.loadBook(bookId);
    if (!book) return null;

    const apiKey = await this.getApiKey();
    if (!apiKey) return null;

    const resolved = await this.fetchById(apiKey, hardcoverSeriesId);
    if (!resolved) return null;

    const priorSeriesName = book.seriesName;

    const committed = await this.db.transaction(async (tx) => {
      // Binding is a deliberate operator assertion that THIS book belongs to that
      // series, so it removes the initiating book's `seriesName` tombstone (#2069
      // AC24) — otherwise a stored series would coexist with a live tombstone,
      // the exact divergence AC7 exists to prevent. Only that one entry is
      // removed: binding asserts nothing about subtitle/description/publisher/
      // publishedDate/genres, so those tombstones survive.
      //
      // The set is re-read INSIDE this transaction, never carried from the
      // pre-fetch `loadBook` above: `fetchById` is a network round-trip, so a PUT
      // can add an unrelated tombstone while it is in flight, and writing back a
      // pre-fetch snapshot would silently erase that concurrent clear
      // (`src/db/serial-transactions.ts` — re-read preconditions inside the
      // transaction). Matched SIBLINGS are never un-tombstoned, and need no guard:
      // `loadLibraryBooksForSeriesNames` selects `WHERE series_name IN (…)` and a
      // `seriesName`-tombstoned book has `series_name = NULL`, which SQL `IN` never
      // matches — such a book is structurally absent from the sibling pool.
      const boundClearedFields = await removeSeriesNameTombstone(tx, this.log, bookId);

      // Match the whole series at once, including books still on the pre-bind
      // name, so siblings are matched and synced alongside the initiating book.
      const extraNames = priorSeriesName ? [priorSeriesName] : [];
      const { row, matches } = await this.persistMembers(tx, resolved, resolved.name, extraNames);

      const syncedIds = new Set<number>();
      for (const match of matches) {
        syncedIds.add(match.bookId);
        await tx
          .update(books)
          .set({
            seriesName: resolved.name,
            seriesPosition: match.position,
            ...(match.bookId === bookId ? { userClearedFields: boundClearedFields } : {}),
            updatedAt: new Date(),
          })
          .where(eq(books.id, match.bookId));
      }

      // The user explicitly bound THIS book: it always adopts the canonical
      // name even when it is not a member, preserving its existing position.
      if (!syncedIds.has(bookId)) {
        syncedIds.add(bookId);
        await tx
          .update(books)
          .set({ seriesName: resolved.name, seriesPosition: book.seriesPosition, userClearedFields: boundClearedFields, updatedAt: new Date() })
          .where(eq(books.id, bookId));
      }

      for (const id of syncedIds) {
        await relinkBookToBoundSeries(tx, id, row.id);
      }
      // The id list crosses the boundary INSIDE the transaction's resolved
      // value — never via an outer `let` — so a rollback yields no ids at all.
      return { row, syncedIds: [...syncedIds] };
    });

    this.log.info({ bookId, hardcoverSeriesId, seriesName: resolved.name }, 'Bound Hardcover series to book');
    return { card: await this.buildCardFromCache(committed.row, resolved.name), syncedIds: committed.syncedIds };
  }

  /**
   * Surface Hardcover series search candidates for the manual picker (#1228).
   * Degrades to an empty list when no key is configured (mirrors the keyless
   * card behaviour) so the route never throws on an unconfigured instance.
   */
  async searchSeriesCandidates(query: string): Promise<HardcoverSearchCandidate[]> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return [];
    const client = new HardcoverClient(apiKey);
    // Display cap for the picker: the adapter returns the full popularity-ranked
    // pool (consumed unsliced by the automatic resolver, #1239); the ≤10 limit
    // is a picker-display concern enforced here, not in the adapter.
    return (await client.searchSeries(query)).slice(0, 10);
  }

  private async loadLibraryBooksForSeries(seriesName: string, executor: DbOrTx = this.db): Promise<LibraryBookSummary[]> {
    return this.loadLibraryBooksForSeriesNames([seriesName], executor);
  }

  private async loadLibraryBooksForSeriesNames(seriesNames: string[], executor: DbOrTx = this.db): Promise<LibraryBookSummary[]> {
    const unique = [...new Set(seriesNames)];
    if (unique.length === 0) return [];
    // `ORDER BY books.id` is a MATCHER CONTRACT, not cosmetic (#2108).
    // `findInLibraryMatch` is greedy and first-claim-wins WITHIN a match-quality
    // tier, so the sequence these rows arrive in decides which book a member
    // claims whenever two candidates pair on the same tier. Unordered, that
    // sequence is a query-planner accident: today the planner emits `SCAN books`
    // and rowid order happens to fall out, but adding an index on
    // `books.series_name` flips it to `SEARCH … USING COVERING INDEX` and the
    // rows come back in series_name order — silently changing which book each
    // member claims, and on the bind path durably rewriting the wrong book's
    // series_name/series_position. Pinning it here makes such an index safe to
    // add later. Both callers inherit this: `buildCardFromCache` via
    // `loadLibraryBooksForSeries` (the render path) and `persistMembers` (the
    // bind path), so the two present candidates in the same sequence.
    const rows = await executor
      .select({ id: books.id, title: books.title, seriesPosition: books.seriesPosition })
      .from(books)
      .where(inArray(books.seriesName, unique))
      .orderBy(asc(books.id));
    return rows;
  }
}
