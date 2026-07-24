/**
 * AC26 / F2 — provider fan-out regression test.
 *
 * Wires a REAL MetadataService against a mocked `METADATA_SEARCH_PROVIDER_FACTORIES`
 * so we can observe the underlying provider's `searchBooks` call count after a
 * `RateLimitError`. The match-job mock-service test (`match-job.service.test.ts`)
 * stubs `metadataService.searchBooks` directly — that boundary cannot prove the
 * planner doesn't fan out to the provider when the service-level rate-limit gate
 * short-circuits.
 *
 * Strategy: the provider rejects on the first call with `RateLimitError`. The
 * service's internal `setRateLimited` sets the backoff, and `withThrottle`
 * short-circuits subsequent calls via `isRateLimited` — the planner's remaining
 * attempts return `[]` without ever invoking the provider.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitError, METADATA_SEARCH_PROVIDER_FACTORIES } from '../../core/index.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { MatchJobService, type MatchCandidate } from './match-job.service.js';
import { MetadataService } from './metadata.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { SettingsService } from './settings.service.js';

const mockAudibleProvider = {
  name: 'Audible.com',
  type: 'audible',
  searchBooks: vi.fn().mockResolvedValue({ books: [] }),
  searchSeries: vi.fn().mockResolvedValue([]),
  getBook: vi.fn().mockResolvedValue(null),
  test: vi.fn().mockResolvedValue({ success: true }),
};

const mockAudnexus = {
  name: 'Audnexus',
  type: 'audnexus',
  getBook: vi.fn().mockResolvedValue(null),
  getBookDetailed: vi.fn().mockResolvedValue({ kind: 'not_found' }),
  getChaptersDetailed: vi.fn().mockResolvedValue({ kind: 'not_found' }),
  getAuthor: vi.fn().mockResolvedValue(null),
};

vi.mock('../../core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/index.js')>();
  return {
    ...actual,
    METADATA_SEARCH_PROVIDER_FACTORIES: {
      audible: vi.fn().mockImplementation(function () { return mockAudibleProvider; }),
    },
    AudnexusProvider: vi.fn().mockImplementation(function () { return mockAudnexus; }),
  };
});

vi.mock('../../core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn().mockResolvedValue(null),
}));

import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';

async function waitForJob(service: MatchJobService, id: string, maxMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const status = service.getJob(id);
    if (!status || status.status === 'completed' || status.status === 'cancelled' || status.status === 'failed') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('MatchJobService — rate-limit provider fan-out (AC26 / F2)', () => {
  let mockLog: ReturnType<typeof createMockLogger>;
  let metadataService: MetadataService;
  let matchService: MatchJobService;
  let settingsService: SettingsService;

  beforeEach(() => {
    vi.mocked(METADATA_SEARCH_PROVIDER_FACTORIES); // ensure mock factories are available
    mockAudibleProvider.searchBooks.mockReset();
    mockAudibleProvider.searchSeries.mockReset();
    mockAudibleProvider.getBook.mockReset();
    mockAudibleProvider.test.mockReset();
    mockAudnexus.getBook.mockReset();
    mockAudnexus.getBookDetailed.mockReset();
    mockAudnexus.getChaptersDetailed.mockReset();
    mockAudnexus.getAuthor.mockReset();
    mockAudibleProvider.searchBooks.mockResolvedValue({ books: [] });
    mockAudibleProvider.searchSeries.mockResolvedValue([]);
    mockAudibleProvider.getBook.mockResolvedValue(null);
    mockAudibleProvider.test.mockResolvedValue({ success: true });
    mockAudnexus.getBook.mockResolvedValue(null);
    mockAudnexus.getBookDetailed.mockResolvedValue({ kind: 'not_found' });
    mockAudnexus.getChaptersDetailed.mockResolvedValue({ kind: 'not_found' });
    mockAudnexus.getAuthor.mockResolvedValue(null);

    vi.mocked(scanAudioDirectory).mockReset();

    mockLog = createMockLogger();
    metadataService = new MetadataService(inject<FastifyBaseLogger>(mockLog));
    settingsService = inject<SettingsService>({ get: vi.fn().mockResolvedValue({ ffmpegPath: '' }) });
    const bookService = inject<import('./book.service.js').BookService>({ findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false }) });
    matchService = new MatchJobService(metadataService, inject<FastifyBaseLogger>(mockLog), settingsService, bookService);
  });

  it('AC26 — RateLimitError on first attempt: provider.searchBooks called exactly once across multi-attempt planner', async () => {
    // Tag-derived input that drives the planner to emit MULTIPLE attempts:
    //   1. exact: 'Imagine Me - Part 3 Tahereh Mafi'
    //   2. album-derived: 'Imagine Me' (after dash-series-keyword + cleanTagTitle)
    //   3. strip-trailing-part: 'Imagine Me'  (deduped against album)
    //   4. strip-leading-series: same as exact (no match) → deduped
    // Without the rate-limit gate, the planner would fan out to 2+ provider calls.
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'AAC',
      bitrate: 128000,
      sampleRate: 44100,
      channels: 2,
      bitrateMode: 'cbr' as const,
      fileFormat: 'm4b',
      totalDuration: 36000,
      totalSize: 100_000_000,
      fileCount: 1,
      hasCoverArt: false,
      tagTitle: 'Imagine Me - Part 3',
      tagAuthor: 'Tahereh Mafi',
      tagAlbum: 'Imagine Me - Shatter Me Series, Book 6',
    });

    // First provider call rejects with RateLimitError. The service's
    // `withThrottle` catches it, sets `rateLimitUntil` for Audible.com, and
    // returns the fallback `{ books: [] }`. Subsequent calls short-circuit via
    // the `isRateLimited` gate before reaching the provider.
    mockAudibleProvider.searchBooks.mockRejectedValueOnce(new RateLimitError(60_000, 'Audible.com'));

    const candidate: MatchCandidate = {
      path: '/audiobooks/Imagine Me',
      title: 'Imagine Me',
      author: 'Tahereh Mafi',
    };

    const id = matchService.createJob([candidate]);
    await waitForJob(matchService, id);

    // Per-book rate-limit containment must NOT reach the run() catch (#1864) — the
    // job completes normally, never terminalizes 'failed'.
    expect(matchService.getJob(id)!.status).toBe('completed');
    const result = matchService.getJob(id)!.results[0];
    expect(result!.confidence).toBe('none');

    // The load-bearing assertion: provider was called EXACTLY ONCE despite the
    // planner's multi-attempt sequence. If the planner bypassed the service
    // gate (or if MetadataService's `isRateLimited` short-circuit broke), this
    // would be ≥ 2.
    expect(mockAudibleProvider.searchBooks).toHaveBeenCalledTimes(1);
  });

  // #1932 (F9) — the duration-mismatch chapter rescue participates in the SAME
  // shared Audnexus backoff. A fresh 429 from the first rescue seeds the backoff;
  // once active, no further chapter provider call is issued.
  it('chapter-rescue fan-out: a 429 seeds Audnexus backoff and the next mismatch makes no chapter call', async () => {
    // No tags → filename-single path. Scanned 36000s vs scalar 650min (39000s) →
    // Δ3000 out of band → duration-mismatch → rescue triggers on the matched ASIN.
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'AAC', bitrate: 128000, sampleRate: 44100, channels: 2,
      bitrateMode: 'cbr' as const, fileFormat: 'm4b', totalDuration: 36000,
      totalSize: 100_000_000, fileCount: 1, hasCoverArt: false,
    });
    mockAudibleProvider.searchBooks.mockResolvedValue({
      books: [{ title: 'The Way of Kings', asin: 'B_ASIN', duration: 650, authors: [{ name: 'Brandon Sanderson' }] }],
    });
    // The first rescue's chapter call is rate-limited; every later one is skipped
    // by the active shared backoff.
    mockAudnexus.getChaptersDetailed.mockResolvedValue({ kind: 'rate_limited', retryAfterMs: 60_000 });

    const fullSettings = inject<SettingsService>({
      get: vi.fn().mockResolvedValue({ ffmpegPath: '', languages: [], minDurationMinutes: 0, rejectWords: '' }),
    });
    matchService = new MatchJobService(metadataService, inject<FastifyBaseLogger>(mockLog), fullSettings, inject<import('./book.service.js').BookService>({ findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false }) }));

    const candidate: MatchCandidate = { path: '/audiobooks/The Way of Kings', title: 'The Way of Kings', author: 'Brandon Sanderson' };

    const id1 = matchService.createJob([candidate]);
    await waitForJob(matchService, id1);
    // First rescue reached the provider (and got a 429) but the flag still stands.
    expect(matchService.getJob(id1)!.results[0]!.confidence).toBe('medium');
    expect(matchService.getJob(id1)!.results[0]!.reasonKind).toBe('duration-mismatch');

    const id2 = matchService.createJob([candidate]);
    await waitForJob(matchService, id2);
    expect(matchService.getJob(id2)!.results[0]!.confidence).toBe('medium');

    // The load-bearing assertion: the chapter provider was hit EXACTLY ONCE — the
    // active Audnexus backoff short-circuited the second mismatch's rescue.
    expect(mockAudnexus.getChaptersDetailed).toHaveBeenCalledTimes(1);
  });
});
