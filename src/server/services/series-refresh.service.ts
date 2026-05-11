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
  buildCardData,
  buildCardFromRow,
  errorMessage,
  findExistingSeriesRow,
  readSeriesRow,
  selectScheduledCandidates,
  type BookSeriesCardData,
} from './series-refresh.helpers.js';

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
    const identityHint: TriggerInput = {
      provider: AUDIBLE_PROVIDER,
      ...(opts.providerSeriesId !== undefined && opts.providerSeriesId !== null ? { providerSeriesId: opts.providerSeriesId } : {}),
      ...(opts.seriesName ? { normalizedName: normalizeSeriesName(opts.seriesName) } : {}),
      seedAsin: bookAsin,
    };
    const key = computeQueueIdentity(identityHint) ?? `${AUDIBLE_PROVIDER}:seed:${bookAsin}`;

    const existing = this.inFlight.get(key);
    if (existing) {
      const current = await readSeriesRow(this.db, { ...opts, seedAsin: bookAsin });
      return { status: 'queued', series: current };
    }

    const promise = this.doReconcile(bookAsin, opts).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
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

  private async doReconcile(bookAsin: string, opts: ReconcileOpts): Promise<RefreshResponse> {
    // Seed ASIN gives the strongest identity — find the existing series row by
    // walking the member edge first so provider-backed Add Book rows are found
    // even when the caller only knows the book ASIN. (F1)
    const existing = await findExistingSeriesRow(this.db, {
      providerSeriesId: opts.providerSeriesId ?? null,
      seriesName: opts.seriesName ?? null,
      seedAsin: bookAsin,
    });

    // Honor backoff lock from nextFetchAfter
    if (existing?.nextFetchAfter && existing.nextFetchAfter.getTime() > Date.now()) {
      const card = await buildCardFromRow(this.db, existing);
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
    const card = upserted ? await buildCardFromRow(this.db, upserted) : await readSeriesRow(this.db, { ...opts, seedAsin: bookAsin });
    return { status: 'refreshed', series: card };
  }

  private async handleFetchError(error: unknown, existing: SeriesRow | null, opts: ReconcileOpts, bookAsin: string): Promise<RefreshResponse> {
    if (error instanceof RateLimitError) {
      const updated = await applyRateLimitOutcome(this.db, existing, error.retryAfterMs, error.message, opts);
      const card = updated ? await buildCardFromRow(this.db, updated) : await readSeriesRow(this.db, { ...opts, seedAsin: bookAsin });
      return {
        status: 'rate_limited',
        series: card,
        ...(updated?.nextFetchAfter && { nextFetchAfter: updated.nextFetchAfter.toISOString() }),
      };
    }
    const updated = await applyFailureOutcome(this.db, existing, error, opts);
    const card = updated ? await buildCardFromRow(this.db, updated) : await readSeriesRow(this.db, { ...opts, seedAsin: bookAsin });
    return {
      status: 'failed',
      series: card,
      ...(updated?.nextFetchAfter && { nextFetchAfter: updated.nextFetchAfter.toISOString() }),
      error: errorMessage(error),
    };
  }
}

async function sleepWithJitter(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  await new Promise((resolve) => setTimeout(resolve, ms));
}
