import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { serializeError } from '../utils/serialize-error.js';
import { normalizeSeriesName as sharedNormalizeSeriesName } from '../utils/series-normalize.js';
import { RateLimitError } from '../../core/metadata/errors.js';
import type { MetadataService } from './metadata.service.js';
import type { BookService } from './book.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { SeriesRow } from './types.js';
import {
  AUDIBLE_PROVIDER,
  applyFailureOutcome,
  applyRateLimitOutcome,
  applySuccessOutcome,
  errorMessage,
  findExistingSeriesRow,
  selectScheduledCandidates,
  type BookSeriesCardData,
} from './series-refresh.helpers.js';
import {
  buildCardData,
  buildCardFromRow,
  readSeriesRow,
  synthesizeCurrentMemberIfEmpty,
} from './series-refresh.card-builder.js';

export type { BookSeriesCardData, SeriesMemberCard } from './series-refresh.helpers.js';

export type RefreshStatus = 'refreshed' | 'queued' | 'rate_limited' | 'failed';

export interface RefreshResponse {
  status: RefreshStatus;
  series: BookSeriesCardData | null;
  nextFetchAfter?: string;
  error?: string;
}

export interface TriggerInput {
  seriesId?: number | null;
  provider?: string;
  providerSeriesId?: string | null;
  normalizedName?: string | null;
  seedAsin?: string | null;
}

export const normalizeSeriesName = sharedNormalizeSeriesName;

/**
 * Compute the queue-identity key for a refresh trigger.
 * Returns null when the trigger is invalid (caller should drop+log).
 */
export function computeQueueIdentity(input: TriggerInput): string | null {
  if (input.seriesId != null) return `series:${input.seriesId}`;
  const provider = input.provider ?? AUDIBLE_PROVIDER;
  if (input.providerSeriesId) return `${provider}:${input.providerSeriesId}`;
  if (input.normalizedName && input.seedAsin) {
    return `${provider}:${input.normalizedName}:${input.seedAsin}`;
  }
  return null;
}

interface ReconcileOpts {
  manual?: boolean;
  bookId?: number;
  seriesName?: string | null;
  providerSeriesId?: string | null;
  /** Book title — plumbed from manual refresh route so the refresh response can
   *  synthesize the current book as a member when the matched row is empty. */
  bookTitle?: string;
  /** Book's series position — same purpose as `bookTitle`. */
  seriesPosition?: number | null;
}

export class SeriesRefreshService {
  /** Tracks in-flight reconcile() calls so duplicate triggers collapse. */
  private inFlight = new Map<string, Promise<RefreshResponse>>();

  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private metadataService: MetadataService,
    private bookService: BookService,
  ) {}

  /**
   * Reconcile a series cache row from a book ASIN seed.
   * - Idempotent (same ASIN twice → identical DB state, no extra rows).
   * - Honors `nextFetchAfter`; bypasses 7-day freshness when called manually.
   */
  async reconcileFromBookAsin(bookAsin: string, opts: ReconcileOpts = {}): Promise<RefreshResponse> {
    // Look up the existing series row BEFORE computing the queue key so any
    // caller hitting the same persisted series collapses to one in-flight
    // fetch — Add Book (providerSeriesId) + manual refresh (seriesName +
    // seedAsin) would otherwise hash to different keys. (F6)
    const existingRow = await findExistingSeriesRow(this.db, {
      providerSeriesId: opts.providerSeriesId ?? null,
      seriesName: opts.seriesName ?? null,
      seedAsin: bookAsin,
    });
    const key = this.queueKeyFor(existingRow, opts, bookAsin);

    const inFlight = this.inFlight.get(key);
    if (inFlight) {
      // Pass current-book identity so the snapshot's member.isCurrent flags
      // are preserved when the client caches this response. (F10)
      const current = await readSeriesRow(this.db, { ...opts, seedAsin: bookAsin }, currentBookCtx(opts, bookAsin));
      return { status: 'queued', series: current };
    }

    const promise = this.doReconcile(bookAsin, opts, existingRow).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Pick the in-flight dedupe key per the spec's identity precedence:
   * 1. series.id when a row already exists in scope
   * 2. provider:providerSeriesId when known
   * 3. provider:normalizedName:seedAsin as last resort
   * Invalid triggers fall back to a seed-anchored key so the in-flight map
   * still dedupes by seed ASIN rather than collapsing globally.
   */
  private queueKeyFor(existingRow: SeriesRow | null, opts: ReconcileOpts, bookAsin: string): string {
    if (existingRow) return `series:${existingRow.id}`;
    const hint: TriggerInput = {
      provider: AUDIBLE_PROVIDER,
      ...(opts.providerSeriesId !== undefined && opts.providerSeriesId !== null ? { providerSeriesId: opts.providerSeriesId } : {}),
      ...(opts.seriesName ? { normalizedName: normalizeSeriesName(opts.seriesName) } : {}),
      seedAsin: bookAsin,
    };
    return computeQueueIdentity(hint) ?? `${AUDIBLE_PROVIDER}:seed:${bookAsin}`;
  }

  /** Enqueue an async refresh — used by import/add-book hot paths. */
  enqueueRefresh(bookAsin: string, opts: Omit<ReconcileOpts, 'manual'> = {}): void {
    this.reconcileFromBookAsin(bookAsin, opts).catch((error: unknown) => {
      this.log.warn({ error: serializeError(error), bookAsin }, 'Async series refresh failed');
    });
  }

  async getSeriesForBook(bookId: number): Promise<BookSeriesCardData | null> {
    const book = await this.bookService.getById(bookId);
    if (!book) return null;
    return buildCardData(this.db, book);
  }

  /** Validate a trigger; log + drop invalid ones. */
  validateTrigger(input: TriggerInput): boolean {
    const id = computeQueueIdentity(input);
    if (!id) {
      this.log.warn({ trigger: input }, 'Series refresh trigger dropped — invalid identity');
      return false;
    }
    return true;
  }

  /** Scheduled job: pick stale series, refresh one at a time with jitter delay. */
  async runScheduledRefresh(opts: { sleepMs?: (min: number, max: number) => Promise<void> } = {}): Promise<{ refreshed: number; skipped: number }> {
    const candidates = await selectScheduledCandidates(this.db);
    let refreshed = 0;
    let skipped = 0;
    const sleep = opts.sleepMs ?? sleepWithJitter;

    for (const candidate of candidates) {
      try {
        await this.reconcileFromBookAsin(candidate.seedAsin, {
          seriesName: candidate.seriesName,
          ...(candidate.providerSeriesId !== null && { providerSeriesId: candidate.providerSeriesId }),
        });
        refreshed++;
      } catch (error: unknown) {
        this.log.warn({ error: serializeError(error), seriesId: candidate.id }, 'Scheduled series refresh failed');
        skipped++;
      }
      await sleep(30_000, 90_000);
    }
    return { refreshed, skipped };
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private async doReconcile(bookAsin: string, opts: ReconcileOpts, existing: SeriesRow | null): Promise<RefreshResponse> {
    const currentBook = currentBookCtx(opts, bookAsin);
    const bookForSynth = bookForSynthesis(opts, bookAsin);

    // Honor backoff lock from nextFetchAfter
    if (existing?.nextFetchAfter && existing.nextFetchAfter.getTime() > Date.now()) {
      const card = await buildCardFromRow(this.db, existing, currentBook);
      synthesizeCurrentMemberIfEmpty(card, existing, bookForSynth);
      return {
        status: 'rate_limited',
        series: card,
        nextFetchAfter: existing.nextFetchAfter.toISOString(),
      };
    }

    let products: BookMetadata[];
    try {
      products = await this.metadataService.getSameSeriesBooks(bookAsin);
    } catch (error: unknown) {
      return this.handleFetchError(error, existing, opts, bookAsin);
    }

    const upserted = await applySuccessOutcome(this.db, this.log, existing, products, bookAsin, opts);
    // F10: pass currentBook so member.isCurrent survives into the response that
    // the client caches via setQueryData on `refreshed`.
    // F1 (PR #1076 review): an empty provider response for a historical
    // zero-member row leaves `upserted` with no members; without the
    // synthesizer the client would re-cache "No members known yet" on refresh.
    const card = upserted
      ? await buildCardFromRow(this.db, upserted, currentBook)
      : await readSeriesRow(this.db, { ...opts, seedAsin: bookAsin }, currentBook);
    if (card && upserted) synthesizeCurrentMemberIfEmpty(card, upserted, bookForSynth);
    return { status: 'refreshed', series: card };
  }

  private async handleFetchError(error: unknown, existing: SeriesRow | null, opts: ReconcileOpts, bookAsin: string): Promise<RefreshResponse> {
    const currentBook = currentBookCtx(opts, bookAsin);
    const bookForSynth = bookForSynthesis(opts, bookAsin);
    if (error instanceof RateLimitError) {
      const updated = await applyRateLimitOutcome(this.db, existing, error.retryAfterMs, error.message, opts);
      const card = updated
        ? await buildCardFromRow(this.db, updated, currentBook)
        : await readSeriesRow(this.db, { ...opts, seedAsin: bookAsin }, currentBook);
      if (card && updated) synthesizeCurrentMemberIfEmpty(card, updated, bookForSynth);
      return {
        status: 'rate_limited',
        series: card,
        ...(updated?.nextFetchAfter && { nextFetchAfter: updated.nextFetchAfter.toISOString() }),
      };
    }
    const updated = await applyFailureOutcome(this.db, existing, error, opts);
    const card = updated
      ? await buildCardFromRow(this.db, updated, currentBook)
      : await readSeriesRow(this.db, { ...opts, seedAsin: bookAsin }, currentBook);
    if (card && updated) synthesizeCurrentMemberIfEmpty(card, updated, bookForSynth);
    return {
      status: 'failed',
      series: card,
      ...(updated?.nextFetchAfter && { nextFetchAfter: updated.nextFetchAfter.toISOString() }),
      error: errorMessage(error),
    };
  }
}

/**
 * Build the current-book identity used to mark member.isCurrent in the card
 * data returned from refresh responses. Returns undefined when we have neither
 * a bookId nor an ASIN — buildCardFromRow treats undefined as "no current".
 */
function currentBookCtx(opts: ReconcileOpts, bookAsin: string): { id: number; asin: string | null } | undefined {
  if (opts.bookId != null) return { id: opts.bookId, asin: bookAsin };
  return undefined;
}

/**
 * Richer book context for `synthesizeCurrentMemberIfEmpty`. The synthesizer
 * needs title + seriesName + seriesPosition in addition to id + asin to build a
 * proper SeriesMemberCard. Returns undefined when those fields aren't plumbed
 * through — scheduled and import-orchestration paths only ever fire synthesis
 * incidentally and don't need the extra payload.
 */
function bookForSynthesis(
  opts: ReconcileOpts,
  bookAsin: string,
): { id: number; title: string; asin: string | null; seriesName: string | null; seriesPosition: number | null } | undefined {
  if (opts.bookId == null || opts.bookTitle == null) return undefined;
  return {
    id: opts.bookId,
    title: opts.bookTitle,
    asin: bookAsin,
    seriesName: opts.seriesName ?? null,
    seriesPosition: opts.seriesPosition ?? null,
  };
}

async function sleepWithJitter(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  await new Promise((resolve) => setTimeout(resolve, ms));
}
