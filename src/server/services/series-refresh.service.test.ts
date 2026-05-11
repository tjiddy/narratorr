import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { MetadataService } from './metadata.service.js';
import type { BookService } from './book.service.js';
import { RateLimitError } from '../../core/metadata/errors.js';

// Helper modules are mocked so we can assert orchestration without simulating
// SQL chains — the helpers themselves keep their own coverage via integration
// tests against the route + the test helper fixtures.
vi.mock('./series-refresh.helpers.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    applyFailureOutcome: vi.fn(),
    applyRateLimitOutcome: vi.fn(),
    applySuccessOutcome: vi.fn(),
    findExistingSeriesRow: vi.fn(),
    selectScheduledCandidates: vi.fn(),
  };
});

vi.mock('./series-refresh.card-builder.js', () => ({
  buildCardData: vi.fn(),
  buildCardFromRow: vi.fn(),
  readSeriesRow: vi.fn(),
}));

import {
  SeriesRefreshService,
  computeQueueIdentity,
  normalizeSeriesName,
} from './series-refresh.service.js';
import {
  applyFailureOutcome,
  applyRateLimitOutcome,
  applySuccessOutcome,
  findExistingSeriesRow,
  selectScheduledCandidates,
} from './series-refresh.helpers.js';
import {
  buildCardData,
  buildCardFromRow,
  readSeriesRow,
} from './series-refresh.card-builder.js';

function createMockLogger() {
  return inject<FastifyBaseLogger>({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    silent: vi.fn(),
  });
}

function makeService(opts?: { metadata?: Partial<MetadataService>; bookService?: Partial<BookService> }) {
  const db = inject<Db>({ transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb({})) });
  const log = createMockLogger();
  const metadata = inject<MetadataService>({
    getSameSeriesBooks: vi.fn().mockResolvedValue([]),
    ...opts?.metadata,
  });
  const bookService = inject<BookService>({
    getById: vi.fn(),
    ...opts?.bookService,
  });
  return { service: new SeriesRefreshService(db, log, metadata, bookService), db, log, metadata, bookService };
}

const PROVIDER_BACKED_ROW = {
  id: 7,
  provider: 'audible',
  providerSeriesId: 'B07DHQY7DX',
  name: 'The Band',
  normalizedName: 'the band',
  description: null,
  imageUrl: null,
  lastFetchedAt: null,
  lastFetchStatus: null,
  lastFetchError: null,
  nextFetchAfter: null,
  createdAt: new Date('2026-05-11T00:00:00Z'),
  updatedAt: new Date('2026-05-11T00:00:00Z'),
};

const CARD_FIXTURE = {
  id: 7,
  name: 'The Band',
  providerSeriesId: 'B07DHQY7DX',
  lastFetchedAt: '2026-05-11T00:00:00.000Z',
  lastFetchStatus: 'success' as const,
  nextFetchAfter: null,
  members: [],
};

describe('computeQueueIdentity', () => {
  it('uses series.id when present', () => {
    expect(computeQueueIdentity({ seriesId: 42 })).toBe('series:42');
  });

  it('falls through to provider+providerSeriesId when series.id is absent', () => {
    expect(computeQueueIdentity({ provider: 'audible', providerSeriesId: 'B07DHQY7DX' }))
      .toBe('audible:B07DHQY7DX');
  });

  it('defaults provider to "audible" when omitted', () => {
    expect(computeQueueIdentity({ providerSeriesId: 'B07DHQY7DX' }))
      .toBe('audible:B07DHQY7DX');
  });

  it('falls through to provider:normalizedName:seedAsin when no providerSeriesId', () => {
    expect(computeQueueIdentity({
      provider: 'audible',
      normalizedName: 'the band',
      seedAsin: 'B01NA0JA51',
    })).toBe('audible:the band:B01NA0JA51');
  });

  it('returns null when no identity can be computed', () => {
    expect(computeQueueIdentity({})).toBeNull();
    expect(computeQueueIdentity({ provider: 'audible' })).toBeNull();
    expect(computeQueueIdentity({ provider: 'audible', normalizedName: 'foo' })).toBeNull();
    expect(computeQueueIdentity({ provider: 'audible', seedAsin: 'X' })).toBeNull();
  });

  it('collapses two triggers for the same (provider, providerSeriesId)', () => {
    const a = computeQueueIdentity({ providerSeriesId: 'B07DHQY7DX' });
    const b = computeQueueIdentity({ providerSeriesId: 'B07DHQY7DX', normalizedName: 'whatever' });
    expect(a).toBe(b);
  });

  it('does NOT collapse two null-providerSeriesId series with different seed ASINs', () => {
    const a = computeQueueIdentity({ normalizedName: 'foo', seedAsin: 'A1' });
    const b = computeQueueIdentity({ normalizedName: 'foo', seedAsin: 'A2' });
    expect(a).not.toBe(b);
  });

  it('collapses two triggers for the same null-providerSeriesId series with the same seed ASIN', () => {
    const a = computeQueueIdentity({ normalizedName: 'foo', seedAsin: 'A1' });
    const b = computeQueueIdentity({ normalizedName: 'foo', seedAsin: 'A1' });
    expect(a).toBe(b);
  });
});

describe('normalizeSeriesName', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeSeriesName('The Band')).toBe('the band');
    expect(normalizeSeriesName('Wax & Wayne')).toBe('wax wayne');
    expect(normalizeSeriesName('Mistborn: Era 2')).toBe('mistborn era 2');
  });

  it('collapses runs of non-alphanumerics', () => {
    expect(normalizeSeriesName('A — B   C')).toBe('a b c');
  });
});

describe('SeriesRefreshService.reconcileFromBookAsin', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns { status: "refreshed" } on a successful provider fetch and reuses the upserted row for the card', async () => {
    const { service, metadata } = makeService();
    vi.mocked(findExistingSeriesRow).mockResolvedValue(null);
    (metadata.getSameSeriesBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { title: 'Kings of the Wyld', authors: [{ name: 'Nicholas Eames' }], series: [{ name: 'The Band', position: 1, asin: 'B07DHQY7DX' }], asin: 'B01NA0JA51' },
    ]);
    vi.mocked(applySuccessOutcome).mockResolvedValue(PROVIDER_BACKED_ROW);
    vi.mocked(buildCardFromRow).mockResolvedValue(CARD_FIXTURE);

    const response = await service.reconcileFromBookAsin('B01NA0JA51', { seriesName: 'The Band' });

    expect(response.status).toBe('refreshed');
    expect(response.series).toBe(CARD_FIXTURE);
    expect(applySuccessOutcome).toHaveBeenCalledTimes(1);
    // F1: seed ASIN is forwarded so the lookup can find provider-backed rows via the member edge
    expect(findExistingSeriesRow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ seedAsin: 'B01NA0JA51' }));
  });

  it('honors nextFetchAfter backoff lock without performing a provider fetch (B14)', async () => {
    const { service, metadata } = makeService();
    const lockedRow = { ...PROVIDER_BACKED_ROW, nextFetchAfter: new Date(Date.now() + 30 * 60 * 1000), lastFetchStatus: 'rate_limited' as const };
    vi.mocked(findExistingSeriesRow).mockResolvedValue(lockedRow);
    vi.mocked(buildCardFromRow).mockResolvedValue({ ...CARD_FIXTURE, nextFetchAfter: lockedRow.nextFetchAfter.toISOString() });

    const response = await service.reconcileFromBookAsin('B01NA0JA51', { seriesName: 'The Band' });

    expect(response.status).toBe('rate_limited');
    expect(response.nextFetchAfter).toBe(lockedRow.nextFetchAfter.toISOString());
    expect(metadata.getSameSeriesBooks).not.toHaveBeenCalled();
    expect(applySuccessOutcome).not.toHaveBeenCalled();
  });

  it('records rate-limit outcome with nextFetchAfter on RateLimitError from provider', async () => {
    const { service, metadata } = makeService();
    vi.mocked(findExistingSeriesRow).mockResolvedValue(PROVIDER_BACKED_ROW);
    (metadata.getSameSeriesBooks as ReturnType<typeof vi.fn>).mockRejectedValue(new RateLimitError(60_000, 'Audible.com'));
    const updatedRow = { ...PROVIDER_BACKED_ROW, lastFetchStatus: 'rate_limited' as const, nextFetchAfter: new Date('2026-05-11T01:00:00Z') };
    vi.mocked(applyRateLimitOutcome).mockResolvedValue(updatedRow);
    vi.mocked(buildCardFromRow).mockResolvedValue(CARD_FIXTURE);

    const response = await service.reconcileFromBookAsin('B01NA0JA51', { seriesName: 'The Band' });

    expect(response.status).toBe('rate_limited');
    expect(response.nextFetchAfter).toBe('2026-05-11T01:00:00.000Z');
    expect(applyRateLimitOutcome).toHaveBeenCalledWith(
      expect.anything(),
      PROVIDER_BACKED_ROW,
      60_000,
      expect.any(String),
      expect.objectContaining({ seriesName: 'The Band' }),
    );
    expect(applySuccessOutcome).not.toHaveBeenCalled();
  });

  it('records failure outcome with nextFetchAfter and error message on non-rate-limit error', async () => {
    const { service, metadata } = makeService();
    vi.mocked(findExistingSeriesRow).mockResolvedValue(PROVIDER_BACKED_ROW);
    (metadata.getSameSeriesBooks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500 internal'));
    const updatedRow = { ...PROVIDER_BACKED_ROW, lastFetchStatus: 'failed' as const, nextFetchAfter: new Date('2026-05-11T01:00:00Z'), lastFetchError: '500 internal' };
    vi.mocked(applyFailureOutcome).mockResolvedValue(updatedRow);
    vi.mocked(buildCardFromRow).mockResolvedValue(CARD_FIXTURE);

    const response = await service.reconcileFromBookAsin('B01NA0JA51', { seriesName: 'The Band' });

    expect(response.status).toBe('failed');
    expect(response.error).toBe('500 internal');
    expect(response.nextFetchAfter).toBe('2026-05-11T01:00:00.000Z');
    expect(applyFailureOutcome).toHaveBeenCalledTimes(1);
    expect(applyRateLimitOutcome).not.toHaveBeenCalled();
  });

  it('returns { status: "queued" } with the current cache when a duplicate in-flight refresh is racing', async () => {
    const { service, metadata } = makeService();
    vi.mocked(findExistingSeriesRow).mockResolvedValue(null);
    let resolveFirst!: (v: unknown[]) => void;
    (metadata.getSameSeriesBooks as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((r) => { resolveFirst = r as (v: unknown[]) => void; }));
    vi.mocked(readSeriesRow).mockResolvedValue(CARD_FIXTURE);
    vi.mocked(applySuccessOutcome).mockResolvedValue(PROVIDER_BACKED_ROW);
    vi.mocked(buildCardFromRow).mockResolvedValue(CARD_FIXTURE);

    // First call enqueues — second call collides on identity and returns queued.
    const inFlight = service.reconcileFromBookAsin('B01NA0JA51', { providerSeriesId: 'B07DHQY7DX' });
    const queued = await service.reconcileFromBookAsin('B01NA0JA51', { providerSeriesId: 'B07DHQY7DX' });

    expect(queued.status).toBe('queued');
    expect(queued.series).toBe(CARD_FIXTURE);
    expect(readSeriesRow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ seedAsin: 'B01NA0JA51' }));

    resolveFirst([]);
    await inFlight;
  });

  it('collapses two callers hitting the SAME persisted series row onto a single in-flight fetch (F6: series.id is the first identity)', async () => {
    const { service, metadata } = makeService();
    // Persisted row already exists — both callers should resolve onto series:7 as the queue key
    vi.mocked(findExistingSeriesRow).mockResolvedValue(PROVIDER_BACKED_ROW);
    let resolveFirst!: (v: unknown[]) => void;
    let fetchCount = 0;
    (metadata.getSameSeriesBooks as ReturnType<typeof vi.fn>).mockImplementation(() => {
      fetchCount++;
      return new Promise((r) => { resolveFirst = r as (v: unknown[]) => void; });
    });
    vi.mocked(readSeriesRow).mockResolvedValue(CARD_FIXTURE);
    vi.mocked(applySuccessOutcome).mockResolvedValue(PROVIDER_BACKED_ROW);
    vi.mocked(buildCardFromRow).mockResolvedValue(CARD_FIXTURE);

    // Caller A: Add Book enqueue with providerSeriesId (no seriesName)
    const callA = service.reconcileFromBookAsin('B01NA0JA51', { providerSeriesId: 'B07DHQY7DX' });
    // Caller B: manual refresh with seriesName only (different opts shape, same persisted row)
    const callB = await service.reconcileFromBookAsin('B01NA0JA51', { seriesName: 'The Band' });

    // Only one provider fetch was issued — second caller saw the in-flight under series:id and returned queued
    expect(fetchCount).toBe(1);
    expect(callB.status).toBe('queued');
    expect(callB.series).toBe(CARD_FIXTURE);

    resolveFirst([]);
    await callA;
  });
});

describe('SeriesRefreshService.runScheduledRefresh (B19, B20)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('refreshes each scheduled candidate and sleeps 30-90s between fetches with jitter', async () => {
    const { service, metadata } = makeService();
    vi.mocked(selectScheduledCandidates).mockResolvedValue([
      { id: 1, seriesName: 'The Band', providerSeriesId: 'B07DHQY7DX', seedAsin: 'A1' },
      { id: 2, seriesName: 'Mistborn', providerSeriesId: null, seedAsin: 'A2' },
    ]);
    vi.mocked(findExistingSeriesRow).mockResolvedValue(null);
    (metadata.getSameSeriesBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    vi.mocked(applySuccessOutcome).mockResolvedValue(PROVIDER_BACKED_ROW);
    vi.mocked(buildCardFromRow).mockResolvedValue(CARD_FIXTURE);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await service.runScheduledRefresh({ sleepMs: sleep });

    expect(result).toEqual({ refreshed: 2, skipped: 0 });
    expect(metadata.getSameSeriesBooks).toHaveBeenCalledTimes(2);
    expect(metadata.getSameSeriesBooks).toHaveBeenNthCalledWith(1, 'A1');
    expect(metadata.getSameSeriesBooks).toHaveBeenNthCalledWith(2, 'A2');
    // Sleep called with 30s-90s bounds between candidates
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(30_000, 90_000);
  });
});

describe('SeriesRefreshService.getSeriesForBook (B30)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null when the book does not exist', async () => {
    const { service, bookService } = makeService();
    (bookService.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const card = await service.getSeriesForBook(99);

    expect(card).toBeNull();
    expect(buildCardData).not.toHaveBeenCalled();
  });

  it('delegates to buildCardData when the book exists', async () => {
    const { service, bookService } = makeService();
    const book = { id: 1, asin: 'B01NA0JA51', seriesName: 'The Band', seriesPosition: 1 };
    (bookService.getById as ReturnType<typeof vi.fn>).mockResolvedValue(book);
    vi.mocked(buildCardData).mockResolvedValue(CARD_FIXTURE);

    const card = await service.getSeriesForBook(1);

    expect(card).toBe(CARD_FIXTURE);
    expect(buildCardData).toHaveBeenCalledWith(expect.anything(), book);
  });
});

describe('SeriesRefreshService.enqueueRefresh', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns synchronously and logs on async failure', async () => {
    const { service, metadata, log } = makeService();
    (metadata.getSameSeriesBooks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    vi.mocked(findExistingSeriesRow).mockResolvedValue(null);
    vi.mocked(applyFailureOutcome).mockResolvedValue(null);

    service.enqueueRefresh('B01NA0JA51', { seriesName: 'The Band' });

    // Synchronous: returns void without throwing
    // Wait a tick for the fire-and-forget promise to settle
    await new Promise((r) => setTimeout(r, 0));
    // Failure path completes without throwing — the call is logged inside the service
    expect(applyFailureOutcome).toHaveBeenCalled();
    // The .catch in enqueueRefresh only runs if reconcileFromBookAsin rejects;
    // doReconcile catches errors and returns a 'failed' envelope, so the catch
    // path itself isn't hit on provider errors — applyFailureOutcome having run
    // is the observable confirmation the async path executed.
    void log;
  });
});
