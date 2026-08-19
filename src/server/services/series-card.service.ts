import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '@db/index.js';
import { bookAuthors, authors as authorsTable, books, series, seriesMembers } from '@db/schema.js';
import type { SeriesRow } from './types.js';
import type { SettingsService } from './settings.service.js';
import { HardcoverClient, type HardcoverSearchCandidate, type HardcoverSeriesData } from '@core/metadata/hardcover.js';
import { resolveSeriesViaHardcover } from './hardcover-series-resolver.js';
import { findInLibraryMatch, normalizeMemberTitleForMatch } from './series-title-match.js';
import { loadLibraryBooksForSeriesNames, narrowPoolToSeriesName, type LibraryPool, type PoolBook } from './series-library-pool.js';
import {
  buildMembersFromState,
  compareLibraryMembers,
  libraryMemberCard,
  type BookSeriesMemberCard,
  type MemberState,
} from './series-card-members.js';
import { readPositionClearedBookIds, relinkBookToBoundSeries, removeSeriesNameTombstone, seedLocalMembersForUnclaimedBooks } from './book-series-link.js';
import { upsertHardcoverSeries } from './hardcover-series-upsert.js';
import { withValidatedBindSet } from './series-bind-admission.js';
import { usefulString } from './metadata-recording-collapse.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import { serializeError } from '../utils/serialize-error.js';

export type { BookSeriesMemberCard };

export const STALE_AFTER_DAYS = 7;

export interface BookSeriesCardData {
  id: number | null;
  name: string;
  hardcoverSeriesId: number | null;
  seriesAuthor: string | null;
  lastFetchedAt: string | null;
  members: BookSeriesMemberCard[];
}

/** `syncedIds` is the committed matched-member set, plus an unmatched initiator, for post-commit sidecar/tag refresh. */
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

interface MatchedLibraryBook { bookId: number; position: number | null }

/**
 * The bind's authoritative snapshot S, taken under the admission locks. Everything the bind writes
 * is derived from this object; nothing re-reads the pool inside the transaction (#2447 AC3).
 */
interface BindSnapshot {
  /** Null when the initiator row vanished under the Hardcover fetch. */
  initiator: BookForSeriesCard | null;
  extraSeriesNames: string[];
  pool: readonly PoolBook[];
  /** ids(S): every book this snapshot could cause a write to. */
  lockIds: number[];
}

export class SeriesCardService {
  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Returns cached Hardcover data or resolves and persists it. Missing keys and
   * Hardcover failures degrade to a library-only card without persisting partial state.
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

    const resolved = await this.resolveViaHardcover(apiKey, book);
    if (!resolved) return this.buildLibraryOnlyCard(book.seriesName);

    return this.persistAndBuildCard(resolved, book.seriesName);
  }

  /** Refreshes by cached Hardcover id when possible; keyless or failed refreshes fall back to library-only. */
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
   * Re-fetches stale rows by Hardcover id or the first linked authored book.
   * Failures leave the timestamp untouched so the next sweep retries them.
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
      // authorId makes shared positions deterministic instead of relying on incidental PK order.
      .orderBy(asc(bookAuthors.position), asc(bookAuthors.authorId))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  private async buildLibraryOnlyCard(seriesName: string): Promise<BookSeriesCardData> {
    // Library-only cards read series_position directly; an in-app clear has already stored NULL.
    const { books: libraryBooks } = await this.loadPool([seriesName]);
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

  // Read both inputs from one handle so reconciliation can recheck them inside its transaction.
  private async readMemberState(executor: DbOrTx, seriesId: number, seriesName: string): Promise<MemberState> {
    // Do not order here: SQLite puts NULL first, while the shared JS ordering puts it last.
    const rows = await executor
      .select()
      .from(seriesMembers)
      .where(eq(seriesMembers.seriesId, seriesId));
    const { books: pool, positionClearedIds } = await this.loadPool([seriesName], executor);
    return { rows, pool, positionClearedIds };
  }

  private async buildCardFromCache(row: SeriesRow, seriesName: string): Promise<BookSeriesCardData> {
    const snapshot = buildMembersFromState(await this.readMemberState(this.db, row.id, seriesName));
    // Avoid a transaction when every owned book is already represented.
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
   * Best-effort guarded seeding for locally owned books absent from cached members.
   * Re-read inside one transaction: refresh or bind may have rebuilt the snapshot,
   * and stale inserts can coexist across the disjoint partial unique indexes.
   * Render the returned committed state; on failure, log and render the snapshot.
   * Call only after any caller transaction resolves because this opens its own.
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
   * Upserts the canonical series before rebuilding its members in the caller's transaction.
   * `extraSeriesNames` broadens Hardcover matching for pre-bind siblings, but local
   * seeds come only from the canonical-name pool so unmatched old-name books stay out.
   *
   * **Supplying `lockedPool` asserts the caller holds the admission lock for every id in it**, and
   * makes that pool the sole matcher input — the bind path relies on this to keep its writes inside
   * the set it locked (#2447 AC3a). Every other caller omits it and loads on `tx` exactly as before.
   */
  private async persistMembers(
    tx: DbOrTx,
    resolved: HardcoverSeriesData,
    seriesName: string,
    extraSeriesNames: string[] = [],
    options: { lockedPool?: readonly PoolBook[] } = {},
  ): Promise<{ row: SeriesRow; matches: MatchedLibraryBook[] }> {
    const normalized = normalizeSeriesName(seriesName);
    const libraryBooks = options.lockedPool
      ?? (await this.loadPool([seriesName, ...extraSeriesNames], tx)).books;
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
    // Derived, not re-queried: buildSeriesNameTargets unions its inputs, so the combined pool
    // already contains every canonical-only match, and re-applying the loader's own rule with
    // canonical-only targets reproduces that narrower pool in the loader's id order.
    // Equivalent because the pool is fixed for the whole call: on the bind path it is the caller's
    // in-lock snapshot, and on the refresh path nothing between the load above and here writes books
    // — the member delete/insert loop touches series/series_members alone.
    const primaryPool = extraSeriesNames.length === 0
      ? libraryBooks
      : narrowPoolToSeriesName(libraryBooks, seriesName);
    await seedLocalMembersForUnclaimedBooks(
      tx,
      upserted.id,
      primaryPool.filter((book) => !matchedLibraryIds.has(book.id)),
    );
    return { row: upserted, matches };
  }

  /**
   * Reads the initiator row and the candidate pool in one pass. Used twice per bind attempt: once
   * pre-lock to decide which locks to take, then again under them as the authoritative S.
   */
  private async snapshotBindSet(bookId: number, canonicalName: string): Promise<BindSnapshot> {
    const initiator = await this.loadBook(bookId);
    const extraSeriesNames = initiator?.seriesName ? [initiator.seriesName] : [];
    const { books: pool } = await this.loadPool([canonicalName, ...extraSeriesNames]);
    return { initiator, extraSeriesNames, pool, lockIds: [...new Set([bookId, ...pool.map((book) => book.id)])] };
  }

  /**
   * The bind's transaction. Runs with the admission lock held for every id in `snapshot.lockIds`,
   * and matches against `snapshot.pool` rather than loading one — re-deriving a pool here would
   * reopen the unlocked gap the protocol exists to close (see `series-bind-admission.ts`).
   */
  private async commitBind(
    bookId: number,
    resolved: HardcoverSeriesData,
    snapshot: BindSnapshot,
  ): Promise<{ row: SeriesRow; syncedIds: number[] } | null> {
    const initiator = snapshot.initiator;
    // The row vanished under the Hardcover fetch: take the existing null arm (route 502) rather
    // than writing a resurrected identity.
    if (!initiator) return null;

    return this.db.transaction(async (tx) => {
      // Binding reasserts only this book's seriesName; re-read tombstones inside the
      // transaction because fetchById leaves a window for concurrent unrelated clears.
      // Tombstoned siblings have series_name = NULL and never enter the candidate pool.
      const boundClearedFields = await removeSeriesNameTombstone(tx, this.log, bookId);

      const { row, matches } = await this.persistMembers(
        tx, resolved, resolved.name, snapshot.extraSeriesNames, { lockedPool: snapshot.pool },
      );

      // A name bind must not undo an independent position clear: omit the column
      // entirely for tombstoned books, preserving even out-of-band stale values.
      const positionCleared = await readPositionClearedBookIds(
        tx,
        this.log,
        [...matches.map((match) => match.bookId), bookId],
      );

      const syncedIds = new Set<number>();
      for (const match of matches) {
        syncedIds.add(match.bookId);
        await tx
          .update(books)
          .set({
            seriesName: resolved.name,
            ...(positionCleared.has(match.bookId) ? {} : { seriesPosition: match.position }),
            ...(match.bookId === bookId ? { userClearedFields: boundClearedFields } : {}),
            updatedAt: new Date(),
          })
          .where(eq(books.id, match.bookId));
      }

      // An explicitly bound initiator adopts the canonical name even when unmatched.
      if (!syncedIds.has(bookId)) {
        syncedIds.add(bookId);
        await tx
          .update(books)
          .set({
            seriesName: resolved.name,
            ...(positionCleared.has(bookId) ? {} : { seriesPosition: initiator.seriesPosition }),
            userClearedFields: boundClearedFields,
            updatedAt: new Date(),
          })
          .where(eq(books.id, bookId));
      }

      for (const id of syncedIds) {
        await relinkBookToBoundSeries(tx, id, row.id);
      }
      return { row, syncedIds: [...syncedIds] };
    });
  }

  /**
   * Atomically binds the canonical series, matches across canonical and pre-bind
   * names, syncs every match, and relinks old rows. Position tombstones suppress
   * position writes; an unmatched initiator still adopts the canonical name.
   * Returning syncedIds from the transaction prevents rolled-back writes from
   * leaking into post-commit refresh work.
   *
   * **This is the only method in this file that writes the `books` table, and therefore the only
   * one enrolled in the admission protocol** (#2447 AC11) — the read and refresh paths touch
   * `series` / `series_members` alone. A `books` write added to a sibling method is a protocol
   * change, not a local edit.
   *
   * Ordering is load-bearing: the provider fetch completes BEFORE the first acquisition, so no
   * network call happens inside a held span, and the card render happens AFTER release, because the
   * admission lock is not re-entrant and the post-bind retag/OPF work acquires it per book.
   */
  async bindHardcoverSeries(bookId: number, hardcoverSeriesId: number): Promise<BindHardcoverSeriesResult | null> {
    const book = await this.loadBook(bookId);
    if (!book) return null;

    const apiKey = await this.getApiKey();
    if (!apiKey) return null;

    const resolved = await this.fetchById(apiKey, hardcoverSeriesId);
    if (!resolved) return null;
    // Before the transaction: inside it, persistMembers would still seed a normalized_name = '' row
    // and removeSeriesNameTombstone would still fire. Reuses the unresolvable-bind null → 502 (#2224).
    if (!usefulString(resolved.name)) return null;

    const committed = await withValidatedBindSet({
      enumerate: async () => (await this.snapshotBindSet(bookId, resolved.name)).lockIds,
      snapshot: () => this.snapshotBindSet(bookId, resolved.name),
      idsOf: (snapshot: BindSnapshot) => snapshot.lockIds,
      act: (snapshot: BindSnapshot) => this.commitBind(bookId, resolved, snapshot),
    });
    if (!committed) return null;

    this.log.info({ bookId, hardcoverSeriesId, seriesName: resolved.name }, 'Bound Hardcover series to book');
    return { card: await this.buildCardFromCache(committed.row, resolved.name), syncedIds: committed.syncedIds };
  }

  async searchSeriesCandidates(query: string): Promise<HardcoverSearchCandidate[]> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return [];
    const client = new HardcoverClient(apiKey);
    // Cap only the picker; automatic resolution consumes the adapter's full ranked pool.
    return (await client.searchSeries(query)).slice(0, 10);
  }

  private loadPool(seriesNames: readonly string[], executor: DbOrTx = this.db): Promise<LibraryPool> {
    return loadLibraryBooksForSeriesNames(executor, seriesNames, this.log);
  }
}
