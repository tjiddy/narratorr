import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '../../db/index.js';
import { bookAuthors, authors as authorsTable, books, series, seriesMembers } from '../../db/schema.js';
import type { SeriesRow } from './types.js';
import type { SettingsService } from './settings.service.js';
import { HardcoverClient, type HardcoverSearchCandidate, type HardcoverSeriesData } from '../../core/metadata/hardcover.js';
import { resolveSeriesViaHardcover } from './hardcover-series-resolver.js';
import { findInLibraryMatch, normalizeMemberTitleForMatch, type LibraryBookSummary } from './series-title-match.js';
import { relinkBookToBoundSeries } from './book-series-link.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import { generatePublicId } from '../utils/public-id.js';
import { serializeError } from '../utils/serialize-error.js';

/** Scheduled sweep threshold — rows older than this are re-fetched. */
export const STALE_AFTER_DAYS = 7;

export interface BookSeriesMemberCard {
  hardcoverBookId: number | null;
  slug: string | null;
  title: string;
  position: number | null;
  imageUrl: string | null;
  inLibrary: boolean;
  libraryBookId: number | null;
}

export interface BookSeriesCardData {
  id: number | null;
  name: string;
  hardcoverSeriesId: number | null;
  seriesAuthor: string | null;
  lastFetchedAt: string | null;
  members: BookSeriesMemberCard[];
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
    const members = libraryBooks
      .map<BookSeriesMemberCard>((b) => ({
        hardcoverBookId: null,
        slug: null,
        title: b.title,
        position: b.seriesPosition,
        imageUrl: null,
        inLibrary: true,
        libraryBookId: b.id,
      }))
      .sort(compareLibraryMembers);
    return {
      id: null,
      name: seriesName,
      hardcoverSeriesId: null,
      seriesAuthor: null,
      lastFetchedAt: null,
      members,
    };
  }

  private async buildCardFromCache(row: SeriesRow, seriesName: string): Promise<BookSeriesCardData> {
    // SQLite's default ASC ordering puts NULL positions FIRST, but the
    // library-only path puts them LAST via `compareLibraryMembers`. Read the
    // rows unordered (the DB row id is not user-facing) and sort in JS so
    // both modes share a single ordering rule.
    const memberRows = await this.db
      .select()
      .from(seriesMembers)
      .where(eq(seriesMembers.seriesId, row.id));
    const libraryBooks = await this.loadLibraryBooksForSeries(seriesName);
    const sortedRows = [...memberRows].sort((a, b) =>
      compareByPositionThenTitle(a.position, a.title, b.position, b.title),
    );
    const matchedLibraryIds = new Set<number>();
    const members = sortedRows.map<BookSeriesMemberCard>((m) => {
      const match = findInLibraryMatch({ title: m.title, position: m.position }, libraryBooks, matchedLibraryIds);
      if (match) matchedLibraryIds.add(match.id);
      return {
        hardcoverBookId: m.hardcoverBookId,
        slug: m.slug,
        title: m.title,
        position: m.position,
        imageUrl: m.imageUrl,
        inLibrary: match !== null,
        libraryBookId: match?.id ?? null,
      };
    });
    return {
      id: row.id,
      name: row.name,
      hardcoverSeriesId: row.hardcoverSeriesId,
      seriesAuthor: row.authorName,
      lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
      members,
    };
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
   * back. Returns the rebuilt (id-sourced) card, or null when the book is
   * missing, no key is configured, or the fetch fails.
   */
  async bindHardcoverSeries(bookId: number, hardcoverSeriesId: number): Promise<BookSeriesCardData | null> {
    const book = await this.loadBook(bookId);
    if (!book) return null;

    const apiKey = await this.getApiKey();
    if (!apiKey) return null;

    const resolved = await this.fetchById(apiKey, hardcoverSeriesId);
    if (!resolved) return null;

    const priorSeriesName = book.seriesName;

    const persistedRow = await this.db.transaction(async (tx) => {
      // Match the whole series at once, including books still on the pre-bind
      // name, so siblings are matched and synced alongside the initiating book.
      const extraNames = priorSeriesName ? [priorSeriesName] : [];
      const { row, matches } = await this.persistMembers(tx, resolved, resolved.name, extraNames);

      const syncedIds = new Set<number>();
      for (const match of matches) {
        syncedIds.add(match.bookId);
        await tx
          .update(books)
          .set({ seriesName: resolved.name, seriesPosition: match.position, updatedAt: new Date() })
          .where(eq(books.id, match.bookId));
      }

      // The user explicitly bound THIS book: it always adopts the canonical
      // name even when it is not a member, preserving its existing position.
      if (!syncedIds.has(bookId)) {
        syncedIds.add(bookId);
        await tx
          .update(books)
          .set({ seriesName: resolved.name, seriesPosition: book.seriesPosition, updatedAt: new Date() })
          .where(eq(books.id, bookId));
      }

      for (const id of syncedIds) {
        await relinkBookToBoundSeries(tx, id, row.id);
      }
      return row;
    });

    this.log.info({ bookId, hardcoverSeriesId, seriesName: resolved.name }, 'Bound Hardcover series to book');
    return this.buildCardFromCache(persistedRow, resolved.name);
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
    const rows = await executor
      .select({ id: books.id, title: books.title, seriesPosition: books.seriesPosition })
      .from(books)
      .where(inArray(books.seriesName, unique));
    return rows;
  }
}

async function upsertHardcoverSeries(
  tx: DbOrTx,
  resolved: HardcoverSeriesData,
  normalized: string,
): Promise<SeriesRow> {
  const byHardcoverId = await tx
    .select()
    .from(series)
    .where(eq(series.hardcoverSeriesId, resolved.id))
    .limit(1);
  if (byHardcoverId.length > 0) {
    const existing = byHardcoverId[0]!;
    const updated = await tx
      .update(series)
      .set({
        name: resolved.name,
        normalizedName: normalized,
        authorName: resolved.authorName,
        lastFetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(series.id, existing.id))
      .returning();
    return updated[0]!;
  }
  const byName = await tx
    .select()
    .from(series)
    .where(eq(series.normalizedName, normalized))
    .limit(1);
  if (byName.length > 0) {
    const existing = byName[0]!;
    const updated = await tx
      .update(series)
      .set({
        hardcoverSeriesId: resolved.id,
        name: resolved.name,
        authorName: resolved.authorName,
        lastFetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(series.id, existing.id))
      .returning();
    return updated[0]!;
  }
  const inserted = await tx
    .insert(series)
    .values({
      publicId: generatePublicId('sr'),
      hardcoverSeriesId: resolved.id,
      name: resolved.name,
      normalizedName: normalized,
      authorName: resolved.authorName,
      lastFetchedAt: new Date(),
    })
    .returning();
  return inserted[0]!;
}

/**
 * Member ordering shared by the cache-driven and library-only paths: numeric
 * `series_position` ascending with NULL positions placed at the end. `title`
 * is the tie-breaker for stable order. SQLite's default ASC puts NULLs FIRST,
 * which is why the cache path can't lean on the DB's ORDER BY for parity.
 */
function compareByPositionThenTitle(aPos: number | null, aTitle: string, bPos: number | null, bTitle: string): number {
  if (aPos === null && bPos === null) return aTitle.localeCompare(bTitle);
  if (aPos === null) return 1;
  if (bPos === null) return -1;
  if (aPos !== bPos) return aPos - bPos;
  return aTitle.localeCompare(bTitle);
}

function compareLibraryMembers(a: BookSeriesMemberCard, b: BookSeriesMemberCard): number {
  return compareByPositionThenTitle(a.position, a.title, b.position, b.title);
}

