// Use real MetadataService: a direct searchBooks stub cannot prove provider fan-out stops after 429.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitError, METADATA_SEARCH_PROVIDER_FACTORIES } from '@core/index.js';
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
  getAuthor: vi.fn().mockResolvedValue(null),
  getChapterRuntime: vi.fn().mockResolvedValue({ kind: 'not_found' }),
};

vi.mock('@core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/index.js')>();
  return {
    ...actual,
    METADATA_SEARCH_PROVIDER_FACTORIES: {
      audible: vi.fn().mockImplementation(function () { return mockAudibleProvider; }),
    },
    AudnexusProvider: vi.fn().mockImplementation(function () { return mockAudnexus; }),
  };
});

vi.mock('@core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn().mockResolvedValue(null),
}));

// #2292's ASIN rung reads a sidecar per book; keep these fixture paths off the real filesystem.
vi.mock('../utils/opf-reader.js', () => ({
  readOpfMetadata: vi.fn().mockResolvedValue(null),
}));

import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { readOpfMetadata } from '../utils/opf-reader.js';

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
    vi.mocked(METADATA_SEARCH_PROVIDER_FACTORIES);
    mockAudibleProvider.searchBooks.mockReset();
    mockAudibleProvider.searchSeries.mockReset();
    mockAudibleProvider.getBook.mockReset();
    mockAudibleProvider.test.mockReset();
    mockAudnexus.getBook.mockReset();
    mockAudnexus.getAuthor.mockReset();
    mockAudnexus.getChapterRuntime.mockReset();
    mockAudibleProvider.searchBooks.mockResolvedValue({ books: [] });
    mockAudibleProvider.searchSeries.mockResolvedValue([]);
    mockAudibleProvider.getBook.mockResolvedValue(null);
    mockAudibleProvider.test.mockResolvedValue({ success: true });
    mockAudnexus.getBook.mockResolvedValue(null);
    mockAudnexus.getAuthor.mockResolvedValue(null);
    mockAudnexus.getChapterRuntime.mockResolvedValue({ kind: 'not_found' });

    vi.mocked(scanAudioDirectory).mockReset();
    vi.mocked(readOpfMetadata).mockResolvedValue(null);

    mockLog = createMockLogger();
    metadataService = new MetadataService(inject<FastifyBaseLogger>(mockLog));
    settingsService = inject<SettingsService>({ get: vi.fn().mockResolvedValue({ ffmpegPath: '' }) });
    const bookService = inject<import('./book.service.js').BookService>({ findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false }) });
    matchService = new MatchJobService(metadataService, inject<FastifyBaseLogger>(mockLog), settingsService, bookService);
  });

  it('AC26 — RateLimitError on first attempt: provider.searchBooks called exactly once across multi-attempt planner', async () => {
    // These tags produce two distinct provider queries without the rate-limit gate.
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

    mockAudibleProvider.searchBooks.mockRejectedValueOnce(new RateLimitError(60_000, 'Audible.com'));

    const candidate: MatchCandidate = {
      path: '/audiobooks/Imagine Me',
      title: 'Imagine Me',
      author: 'Tahereh Mafi',
    };

    const id = matchService.createJob([candidate]);
    await waitForJob(matchService, id);

    // Rate-limit containment must not terminalize the job.
    expect(matchService.getJob(id)!.status).toBe('completed');
    const result = matchService.getJob(id)!.results[0];
    expect(result!.confidence).toBe('none');

    expect(mockAudibleProvider.searchBooks).toHaveBeenCalledTimes(1);
  });

  // A direct chapter-runtime stub cannot prove the provider backoff boundary.
  describe('chapter-runtime corroboration through the real service (#1942)', () => {
    const FABLEHAVEN_ASIN = 'B00CXXEX8W';

    function fablehavenScan() {
      return {
        codec: 'AAC',
        bitrate: 128000,
        sampleRate: 44100,
        channels: 2,
        bitrateMode: 'cbr' as const,
        fileFormat: 'm4b',
        totalDuration: 33219.47,
        totalSize: 100_000_000,
        fileCount: 1,
        hasCoverArt: false,
      };
    }

    const candidate: MatchCandidate = {
      path: '/audiobooks/Fablehaven',
      title: 'Fablehaven',
      author: 'Brandon Mull',
    };

    async function runMatch() {
      vi.mocked(scanAudioDirectory).mockResolvedValue(fablehavenScan());
      mockAudibleProvider.searchBooks.mockResolvedValue({
        books: [{ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], duration: 539, asin: FABLEHAVEN_ASIN }],
      });
      const id = matchService.createJob([candidate]);
      await waitForJob(matchService, id);
      return matchService.getJob(id)!.results[0]!;
    }

    it('rescues the would-be mismatch through the real Audnexus bridge', async () => {
      mockAudnexus.getChapterRuntime.mockResolvedValue({
        kind: 'ok', runtimeLengthMs: 33219490, isAccurate: true, trimmedRuntimeMs: 33219490, trimmedChapterCount: 0,
      });

      const result = await runMatch();

      expect(result.confidence).toBe('high');
      expect(result.reasonKind).toBeUndefined();
      expect(mockAudnexus.getChapterRuntime).toHaveBeenCalledExactlyOnceWith(FABLEHAVEN_ASIN);
    });

    it('a chapters 429 degrades to the scalar verdict and arms the shared provider backoff', async () => {
      mockAudnexus.getChapterRuntime.mockResolvedValue({ kind: 'rate_limited', retryAfterMs: 60_000 });

      const result = await runMatch();

      expect(result.confidence).toBe('medium');
      expect(result.reasonKind).toBe('duration-mismatch');
      expect(result.error).toBeUndefined();

      // The armed provider-wide gate returns the empty-runtime sentinel without another call.
      await expect(metadataService.getChapterRuntimeSeconds('B_ANY_OTHER')).resolves.toEqual({});
      expect(mockAudnexus.getChapterRuntime).toHaveBeenCalledTimes(1);
    });
  });
});
