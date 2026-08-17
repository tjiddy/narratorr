import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retrySearch, createRetrySearchDeps, type RetrySearchDeps } from './retry-search.js';
import { RetryBudget } from './retry-budget.js';
import { createMockLogger, inject, createMockSettingsService, mockSearchAllWithStatus, answeringSearchStatus } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { DownloadWithBook } from './download.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { BookService, BookWithAuthor } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { FastifyBaseLogger } from 'fastify';
import { BYTES_PER_GB } from '@shared/constants.js';
import { MAX_SEARCH_RUNGS } from './search-query-ladder.js';

vi.mock('../utils/enrich-usenet-languages.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/enrich-usenet-languages.js')>()),
  enrichUsenetLanguages: vi.fn(),
}));

import { enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
const mockEnrichUsenet = vi.mocked(enrichUsenetLanguages);

const mockBook: BookWithAuthor = {
  ...createMockDbBook({ duration: 3600 }),
  authors: [createMockDbAuthor()],
  narrators: [],
};

const mockSearchResult = {
  title: 'The Way of Kings [MP3 64kbps]',
  protocol: 'torrent' as const,
  downloadUrl: 'magnet:?xt=urn:btih:def456',
  infoHash: 'def456',
  size: 500000000,
  seeders: 10,
  indexer: 'TestIndexer',
};

const mockDownload: DownloadWithBook = {
  id: 2,
  publicId: 'dl_test000000000000000',
  bookId: 1,
  indexerId: 1,
  downloadClientId: 1,
  title: 'The Way of Kings [MP3 64kbps]',
  protocol: 'torrent' as const,
  infoHash: 'def456',
  downloadUrl: 'magnet:?xt=urn:btih:def456',
  size: 500000000,
  seeders: 10,
  status: 'downloading',
  clientStatus: 'downloading',
  pipelineStage: 'idle',
  progress: 0,
  externalId: 'ext-new',
  errorMessage: null,
  addedAt: new Date(),
  completedAt: null,
  progressUpdatedAt: null,
  guid: null,
  outputPath: null,
  pendingCleanup: null,
  bookStatusAtGrab: null,
  indexerName: null,
};

function createDeps(overrides?: Partial<RetrySearchDeps>): RetrySearchDeps {
  return {
    indexerSearchService: inject<IndexerSearchService>({
      searchAllWithStatus: mockSearchAllWithStatus([mockSearchResult]),
    }),
    indexerService: inject<IndexerService>({
      getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }),
    }),
    downloadOrchestrator: inject<DownloadOrchestrator>({
      grab: vi.fn().mockResolvedValue(mockDownload),
      grabForRetry: vi.fn().mockResolvedValue(mockDownload),
      hasGrabBlocker: vi.fn().mockResolvedValue(false),
    }),
    blacklistService: inject<BlacklistService>({
      getBlacklistedHashes: vi.fn().mockResolvedValue(new Set<string>()),
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>() }),
    }),
    bookService: inject<BookService>({
      getById: vi.fn().mockResolvedValue(mockBook),
    }),
    settingsService: createMockSettingsService(),
    retryBudget: new RetryBudget(),
    eventHistory: inject<EventHistoryService>({ create: vi.fn().mockResolvedValue(undefined) }),
    log: inject<FastifyBaseLogger>(createMockLogger()),
    ...overrides,
  };
}

describe('retrySearch', () => {
  it('searches, filters blacklist, ranks, and grabs best candidate', async () => {
    const deps = createDeps();
    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    if (result.outcome === 'retried') {
      expect(result.download.id).toBe(2);
    }
    expect(deps.indexerSearchService.searchAllWithStatus).toHaveBeenCalled();
    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadUrl: 'magnet:?xt=urn:btih:def456',
        bookId: 1,
        skipDuplicateCheck: true,
      }),
    );
  });

  describe('already_active (#1857 AC17/F43/F47)', () => {
    it('early precheck: returns already_active with ZERO budget consumed when the book is already active', async () => {
      const deps = createDeps({
        downloadOrchestrator: inject<DownloadOrchestrator>({
          grabForRetry: vi.fn().mockResolvedValue(mockDownload),
          hasGrabBlocker: vi.fn().mockResolvedValue(true), // replacement present before retry starts
        }),
      });

      const result = await retrySearch(1, deps);

      expect(result.outcome).toBe('already_active');
      expect(deps.retryBudget.hasRemaining(1, 1)).toBe(true); // 0 consumed (max 1, still remaining)
      expect(deps.indexerSearchService.searchAllWithStatus).not.toHaveBeenCalled();
      expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
    });

    it('in-lock detection: returns already_active having consumed ONE accepted attempt (no refund)', async () => {
      const deps = createDeps({
        downloadOrchestrator: inject<DownloadOrchestrator>({
          // The blocker appears only inside the grab mutex, after the early precheck.
          hasGrabBlocker: vi.fn().mockResolvedValue(false),
          grabForRetry: vi.fn().mockResolvedValue('already_active'),
        }),
      });

      const result = await retrySearch(1, deps);

      expect(result.outcome).toBe('already_active');
      expect(deps.indexerSearchService.searchAllWithStatus).toHaveBeenCalled();
      expect(deps.retryBudget.hasRemaining(1, 1)).toBe(false);
      // The in-lock diagnostic is blocker-neutral across downloads, quality gate, and import jobs.
      expect(deps.log.info).toHaveBeenCalledWith(
        { bookId: 1, attempt: 1 },
        'Retry search: book gained a grab blocker during search — skipping (attempt consumed, not refunded)',
      );
    });
  });

  it('returns exhausted when budget is spent', async () => {
    const deps = createDeps();
    deps.retryBudget.consumeAttempt(1);
    deps.retryBudget.consumeAttempt(1);
    deps.retryBudget.consumeAttempt(1);

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('exhausted');
    expect(deps.indexerSearchService.searchAllWithStatus).not.toHaveBeenCalled();
  });

  it('returns no_candidates when search returns empty results', async () => {
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
  });

  it('returns no_candidates when all results are blacklisted', async () => {
    const log = createMockLogger();
    const retryBudget = new RetryBudget();
    vi.spyOn(retryBudget, 'consumeAttempt');
    const deps = createDeps({
      blacklistService: inject<BlacklistService>({
        getBlacklistedHashes: vi.fn().mockResolvedValue(new Set(['def456'])),
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(['def456']), blacklistedGuids: new Set() }),
      }),
      retryBudget,
      log: inject<FastifyBaseLogger>(log),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
    // #2336 AC5: the attempt the log reports is the one the budget just handed out.
    expect(retryBudget.consumeAttempt).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: 1,
        title: 'The Way of Kings',
        attempt: 1,
        inputCount: 1,
        droppedCount: 1,
        reason: 'blacklist-match',
        dropCounts: { 'blacklist-match': 1 },
      }),
      'All search results removed by the blacklist',
    );
    // AC5 forbids an early return: the path still falls through to ranking and records no event.
    expect(log.debug).toHaveBeenCalledWith(
      { bookId: 1, title: 'The Way of Kings', attempt: 1 },
      'No viable candidates after filtering',
    );
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });

  // `book.duration` is minutes while the quality floor consumes seconds.
  it('does not grab a below-floor release on retry (duration is minutes) (#1797 AC1)', async () => {
    const HUNDRED_MB = 100 * 1024 * 1024;
    const deps = createDeps({
      bookService: inject<BookService>({
        getById: vi.fn().mockResolvedValue({ ...mockBook, duration: 600 }),
      }),
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([{ ...mockSearchResult, size: HUNDRED_MB }]),
      }),
      settingsService: createMockSettingsService({ quality: { grabFloor: 30, minSeeders: 0 } }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
  });

  it('resolves audioDuration (seconds) over duration on the retry path (#1797 AC5)', async () => {
    const HUNDRED_MB = 100 * 1024 * 1024;
    const deps = createDeps({
      bookService: inject<BookService>({
        getById: vi.fn().mockResolvedValue({ ...mockBook, duration: 1, audioDuration: 36000 }),
      }),
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([{ ...mockSearchResult, size: HUNDRED_MB }]),
      }),
      settingsService: createMockSettingsService({ quality: { grabFloor: 30, minSeeders: 0 } }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
  });

  it('excludes newly blacklisted hash from retry search results', async () => {
    const blacklistedHash = 'abc123';
    const goodResult = { ...mockSearchResult, infoHash: 'def456', downloadUrl: 'magnet:?xt=urn:btih:def456' };
    const blacklistedResult = { ...mockSearchResult, infoHash: blacklistedHash, downloadUrl: 'magnet:?xt=urn:btih:abc123' };

    const log = createMockLogger();
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([blacklistedResult, goodResult]),
      }),
      blacklistService: inject<BlacklistService>({
        getBlacklistedHashes: vi.fn().mockResolvedValue(new Set([blacklistedHash])),
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set([blacklistedHash]), blacklistedGuids: new Set() }),
      }),
      log: inject<FastifyBaseLogger>(log),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:def456' }),
    );
    // #2336 AC7: a survivor means the set was never emptied.
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'All search results removed by the blacklist');
  });

  it('returns retry_error when book not found', async () => {
    const deps = createDeps({
      bookService: inject<BookService>({
        getById: vi.fn().mockResolvedValue(null),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retry_error');
    if (result.outcome === 'retry_error') {
      expect(result.error).toBe('Book not found');
    }
  });

  it('returns retry_error when indexer search throws', async () => {
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: vi.fn().mockRejectedValue(new Error('Connection refused')),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retry_error');
    if (result.outcome === 'retry_error') {
      expect(result.error).toContain('Connection refused');
    }
  });

  it('returns no_candidates when no results have downloadUrl', async () => {
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([
          { ...mockSearchResult, downloadUrl: undefined },
        ]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
  });

  it('consumes a budget attempt even when result is no_candidates', async () => {
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([]),
      }),
    });

    await retrySearch(1, deps);

    expect(deps.retryBudget.hasRemaining(1)).toBe(true); // 1 of 3 used
    expect(deps.retryBudget.consumeAttempt(1)).toBe(2); // next would be 2
  });

  it('handles book with no duration (grabFloor filtering skipped)', async () => {
    const bookNoDuration = { ...mockBook, duration: null };
    const deps = createDeps({
      bookService: inject<BookService>({
        getById: vi.fn().mockResolvedValue(bookNoDuration),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
  });

  it('reads metadata.languages and passes them to filterAndRankResults', async () => {
    const settings = createMockSettingsService({
      metadata: { audibleRegion: 'us', languages: ['english'] },
    });
    const deps = createDeps({ settingsService: settings });

    await retrySearch(1, deps);

    expect(settings.get).toHaveBeenCalledWith('metadata');
    expect(settings.get).toHaveBeenCalledWith('quality');
  });

  it('languages filter causes non-matching language candidates to be skipped', async () => {
    const frenchResult = {
      title: 'The Way of Kings [MP3 64kbps]',
      protocol: 'torrent' as const,
      downloadUrl: 'magnet:?xt=urn:btih:french',
      infoHash: 'french123',
      size: 500000000,
      seeders: 10,
      indexer: 'TestIndexer',
      language: 'french',
    };
    const settings = createMockSettingsService({
      metadata: { audibleRegion: 'us', languages: ['english'] },
    });
    const deps = createDeps({
      settingsService: settings,
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([frenchResult]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
  });

  it('languages filter allows matching language candidate to be grabbed', async () => {
    const englishResult = {
      title: 'The Way of Kings [MP3 64kbps]',
      protocol: 'torrent' as const,
      downloadUrl: 'magnet:?xt=urn:btih:english',
      infoHash: 'english123',
      size: 500000000,
      seeders: 10,
      indexer: 'TestIndexer',
      language: 'english',
    };
    const frenchResult = {
      title: 'The Way of Kings [MP3 64kbps]',
      protocol: 'torrent' as const,
      downloadUrl: 'magnet:?xt=urn:btih:french',
      infoHash: 'french123',
      size: 500000000,
      seeders: 10,
      indexer: 'TestIndexer',
      language: 'french',
    };
    const settings = createMockSettingsService({
      metadata: { audibleRegion: 'us', languages: ['english'] },
    });
    const deps = createDeps({
      settingsService: settings,
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([frenchResult, englishResult]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:english' }),
    );
  });

  it('filters oversized candidates via maxDownloadSize and logs quality gate filtering', async () => {
    const oversizedResult = {
      ...mockSearchResult,
      size: 10 * BYTES_PER_GB,
      downloadUrl: 'magnet:?xt=urn:btih:oversized',
      infoHash: 'oversized123',
    };
    const settings = createMockSettingsService({
      quality: { maxDownloadSize: 5 },
    });
    const deps = createDeps({
      settingsService: settings,
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([oversizedResult]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
    expect(deps.log.debug).toHaveBeenCalledWith(
      { inputCount: 1, outputCount: 0 },
      'Quality gate filtering applied',
    );
  });

  it('filters undersized candidates via minDownloadSize and logs quality gate filtering', async () => {
    const undersizedResult = {
      ...mockSearchResult,
      size: 5 * 1024 * 1024, // 5MB — below 50MB threshold
      downloadUrl: 'magnet:?xt=urn:btih:tinyspam',
      infoHash: 'tinyspam123',
    };
    const settings = createMockSettingsService({
      quality: { minDownloadSize: 50 },
    });
    const deps = createDeps({
      settingsService: settings,
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([undersizedResult]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
    expect(deps.log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'The Way of Kings [MP3 64kbps]',
        reason: 'below-min-size',
        sizeBytes: 5 * 1024 * 1024,
        minBytes: 50 * 1024 * 1024,
      }),
      'Quality filter dropped result',
    );
    expect(deps.log.debug).toHaveBeenCalledWith(
      { inputCount: 1, outputCount: 0 },
      'Quality gate filtering applied',
    );
  });

  it('handles book with no active indexers (empty results)', async () => {
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
  });
});

describe('retrySearch — imported-book guard (#1103 F1, F6)', () => {
  it('short-circuits with no_candidates when book.path is non-null', async () => {
    const importedBook: BookWithAuthor = {
      ...createMockDbBook({ duration: 3600 }),
      path: '/library/some-imported-book',
      authors: [createMockDbAuthor()],
      narrators: [],
    };
    const deps = createDeps({
      bookService: inject<BookService>({
        getById: vi.fn().mockResolvedValue(importedBook),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result).toEqual({ outcome: 'no_candidates' });
    expect(deps.indexerSearchService.searchAllWithStatus).not.toHaveBeenCalled();
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
  });

  it('does not consume a retry-budget attempt when guard fires', async () => {
    const importedBook: BookWithAuthor = {
      ...createMockDbBook({ duration: 3600 }),
      path: '/library/imported-book',
      authors: [createMockDbAuthor()],
      narrators: [],
    };
    const retryBudget = new RetryBudget();
    const before = retryBudget.hasRemaining(1);

    const deps = createDeps({
      retryBudget,
      bookService: inject<BookService>({
        getById: vi.fn().mockResolvedValue(importedBook),
      }),
    });

    await retrySearch(1, deps);

    expect(retryBudget.hasRemaining(1)).toBe(before);
  });
});

describe('createRetrySearchDeps', () => {
  it('maps service bag fields to RetrySearchDeps contract by reference', () => {
    const indexerSearch = {} as IndexerSearchService;
    const indexer = {} as IndexerService;
    const downloadOrchestrator = {} as DownloadOrchestrator;
    const blacklist = {} as BlacklistService;
    const book = {} as BookService;
    const settings = {} as SettingsService;
    const retryBudget = new RetryBudget();
    const eventHistory = {} as EventHistoryService;
    const log = inject<FastifyBaseLogger>(createMockLogger());

    const result = createRetrySearchDeps(
      { indexerSearch, indexer, downloadOrchestrator, blacklist, book, settings, retryBudget, eventHistory },
      log,
    );

    expect(result.indexerSearchService).toBe(indexerSearch);
    expect(result.indexerService).toBe(indexer);
    expect(result.downloadOrchestrator).toBe(downloadOrchestrator);
    expect(result.blacklistService).toBe(blacklist);
    expect(result.bookService).toBe(book);
    expect(result.settingsService).toBe(settings);
    expect(result.retryBudget).toBe(retryBudget);
    expect(result.eventHistory).toBe(eventHistory);
    expect(result.log).toBe(log);
  });
});

describe('retrySearch — GUID blacklist filtering', () => {
  const usenetResult = {
    title: 'The Way of Kings [MP3 128kbps]',
    protocol: 'usenet' as const,
    downloadUrl: 'https://nzb.example.com/download/abc',
    size: 500000000,
    seeders: undefined,
    indexer: 'TestUsenetIndexer',
    guid: 'usenet-guid-123',
  };

  it('filters out results with blacklisted guid (usenet)', async () => {
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([usenetResult]),
      }),
      blacklistService: inject<BlacklistService>({
        getBlacklistedHashes: vi.fn().mockResolvedValue(new Set<string>()),
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
          blacklistedHashes: new Set<string>(),
          blacklistedGuids: new Set(['usenet-guid-123']),
        }),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
  });

  it('filters out results with blacklisted infoHash (torrent — existing behavior)', async () => {
    const deps = createDeps({
      blacklistService: inject<BlacklistService>({
        getBlacklistedHashes: vi.fn().mockResolvedValue(new Set(['def456'])),
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
          blacklistedHashes: new Set(['def456']),
          blacklistedGuids: new Set<string>(),
        }),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
  });

  it('passes through results with no infoHash and no guid', async () => {
    const noIdentifierResult = {
      title: 'The Way of Kings [MP3 128kbps]',
      protocol: 'usenet' as const,
      downloadUrl: 'https://nzb.example.com/download/xyz',
      size: 500000000,
      seeders: undefined,
      indexer: 'TestUsenetIndexer',
    };

    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([noIdentifierResult]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadUrl: 'https://nzb.example.com/download/xyz',
      }),
    );
  });

  it('treats empty string guid as absent (not matched against blacklist)', async () => {
    const emptyGuidResult = {
      title: 'The Way of Kings [MP3 128kbps]',
      protocol: 'usenet' as const,
      downloadUrl: 'https://nzb.example.com/download/xyz',
      size: 500000000,
      seeders: undefined,
      indexer: 'TestUsenetIndexer',
      guid: '',
    };

    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([emptyGuidResult]),
      }),
      blacklistService: inject<BlacklistService>({
        getBlacklistedHashes: vi.fn().mockResolvedValue(new Set<string>()),
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
          blacklistedHashes: new Set<string>(),
          blacklistedGuids: new Set(['']),
        }),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
  });

  it('passes best.guid to grab() when available', async () => {
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([usenetResult]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        guid: 'usenet-guid-123',
        downloadUrl: 'https://nzb.example.com/download/abc',
      }),
    );
  });

  it('omits guid from grab() when not available on the search result', async () => {
    const deps = createDeps();

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalled();
    // Omit a missing GUID rather than passing explicit undefined.
    const grabArg = vi.mocked(deps.downloadOrchestrator.grabForRetry).mock.calls[0]![0];
    expect(grabArg).toMatchObject({ downloadUrl: 'magnet:?xt=urn:btih:def456' });
    expect(grabArg).not.toHaveProperty('guid');
  });

  it('forwards indexerId from best search result to downloadOrchestrator.grabForRetry', async () => {
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([{ ...mockSearchResult, indexerId: 42 }]),
      }),
    });

    await retrySearch(1, deps);

    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledWith(
      expect.objectContaining({ indexerId: 42 }),
    );
  });

  it('omits indexerId when search result has no indexerId', async () => {
    const deps = createDeps();

    await retrySearch(1, deps);

    const grabCall = vi.mocked(deps.downloadOrchestrator.grabForRetry).mock.calls[0]![0];
    expect(grabCall).not.toHaveProperty('indexerId');
  });

  it('forwards isFreeleech=true from best search result to downloadOrchestrator.grabForRetry (#1156 F2)', async () => {
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([{ ...mockSearchResult, isFreeleech: true }]),
      }),
    });

    await retrySearch(1, deps);

    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledWith(
      expect.objectContaining({ isFreeleech: true }),
    );
  });

  it('omits isFreeleech from grab call when best search result does not set it (#1156 F2)', async () => {
    const deps = createDeps();

    await retrySearch(1, deps);

    const grabCall = vi.mocked(deps.downloadOrchestrator.grabForRetry).mock.calls[0]![0];
    expect(grabCall).not.toHaveProperty('isFreeleech');
  });

  it('accuracy mode grabs narrator-matched release over higher-quality non-match on retry', async () => {
    const FAIR_SIZE = Math.round(79 * 10 * 1024 * 1024);
    const GOOD_SIZE = Math.round(200 * 10 * 1024 * 1024);
    const bookWithNarrators: BookWithAuthor = {
      ...createMockDbBook({ duration: 600 }),
      authors: [createMockDbAuthor()],
      narrators: [{ id: 1, publicId: 'nr_test000000000000000', name: 'Kevin R. Free', slug: 'kevin-r-free', createdAt: new Date() }],
    };
    const deps = createDeps({
      bookService: inject<BookService>({
        getById: vi.fn().mockResolvedValue(bookWithNarrators),
      }),
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([
          { ...mockSearchResult, size: GOOD_SIZE, downloadUrl: 'magnet:?xt=urn:btih:quality', narrator: 'Someone Else', matchScore: 0.9 },
          { ...mockSearchResult, size: FAIR_SIZE, downloadUrl: 'magnet:?xt=urn:btih:narrator', narrator: 'Kevin R. Free', matchScore: 0.9 },
        ]),
      }),
      settingsService: createMockSettingsService({
        search: { searchPriority: 'accuracy' },
      }),
    });

    await retrySearch(1, deps);

    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:narrator' }),
    );
  });
});

describe('#502 retrySearch — enrichment before filtering', () => {
  beforeEach(() => {
    mockEnrichUsenet.mockReset();
  });

  it('calls enrichUsenetLanguages before filterAndRankResults', async () => {
    const usenetResult = {
      ...mockSearchResult,
      protocol: 'usenet' as const,
      downloadUrl: 'http://nzb.test/1',
      infoHash: undefined,
    };
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([usenetResult]),
      }),
    });

    await retrySearch(1, deps);

    expect(mockEnrichUsenet).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ protocol: 'usenet' })]),
      expect.anything(),
      expect.objectContaining({ hostPort: expect.any(Set), hostname: expect.any(Set) }),
      { maxPhase2Fetches: 10 },
    );
  });

  it('usenet result with reject word in NZB name is filtered out before grab', async () => {
    const usenetResult = {
      ...mockSearchResult,
      protocol: 'usenet' as const,
      downloadUrl: 'http://nzb.test/1',
      infoHash: undefined,
    };
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([usenetResult]),
      }),
      settingsService: createMockSettingsService({
        quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'pack', requiredWords: '' },
      }),
    });

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Stephen King-Hörbuch-Pack.rar';
      }
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
  });

  describe('caller-level debug logging (#932 F3)', () => {
    it('emits the blacklist drop log when retrySearch filters a blacklisted candidate', async () => {
      const log = createMockLogger();
      const deps = createDeps({
        indexerSearchService: inject<IndexerSearchService>({
          searchAllWithStatus: mockSearchAllWithStatus([{ ...mockSearchResult, infoHash: 'badhash' }]),
        }),
        blacklistService: inject<BlacklistService>({
          getBlacklistedHashes: vi.fn().mockResolvedValue(new Set<string>(['badhash'])),
          getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
            blacklistedHashes: new Set(['badhash']),
            blacklistedGuids: new Set<string>(),
          }),
        }),
        log: inject<FastifyBaseLogger>(log),
      });

      await retrySearch(1, deps);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'blacklist-match', matchedRule: 'hash' }),
        'Blacklisted result dropped',
      );
    });

    it('emits a quality filter drop log when retrySearch reject-words filter rejects an item', async () => {
      const log = createMockLogger();
      const deps = createDeps({
        indexerSearchService: inject<IndexerSearchService>({
          searchAllWithStatus: mockSearchAllWithStatus([{ ...mockSearchResult, title: 'The Way of Kings BANNED' }]),
        }),
        settingsService: createMockSettingsService({
          quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'banned', requiredWords: '', maxDownloadSize: 0 },
        }),
        log: inject<FastifyBaseLogger>(log),
      });

      await retrySearch(1, deps);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'reject-word-match', matchedWord: 'banned' }),
        'Quality filter dropped result',
      );
    });
  });
});

describe('retrySearch — multi-part usenet filter (#1777)', () => {
  const multiPartUsenet = {
    title: 'The Way of Kings Part 2 of 5',
    protocol: 'usenet' as const,
    downloadUrl: 'http://nzb.test/multi',
    guid: 'multi-guid',
    size: 500000000,
    indexer: 'TestIndexer',
  };
  const validUsenet = {
    title: 'The Way of Kings Complete Edition',
    protocol: 'usenet' as const,
    downloadUrl: 'http://nzb.test/valid',
    guid: 'valid-guid',
    size: 500000000,
    indexer: 'TestIndexer',
  };

  beforeEach(() => {
    mockEnrichUsenet.mockReset();
  });

  it('does not grab a multi-part usenet post ranked ahead of a valid one — the valid candidate wins', async () => {
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        // Put multi-part first so ranking would select it if filtering regresses.
        searchAllWithStatus: mockSearchAllWithStatus([multiPartUsenet, validUsenet]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'http://nzb.test/valid' }),
    );
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'http://nzb.test/multi' }),
    );
  });

  it('returns no_candidates when every usenet candidate is multi-part', async () => {
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([multiPartUsenet]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
  });

  it('still grabs a torrent whose title matches the multi-part pattern (protocol scoping)', async () => {
    const multiPartTorrent = { ...multiPartUsenet, protocol: 'torrent' as const, downloadUrl: 'magnet:?xt=urn:btih:multi', seeders: 10 };
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([multiPartTorrent]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:multi' }),
    );
  });

  it('rejects a usenet post whose multi-part marker only appears in the enrichment-populated nzbName (ordering guard)', async () => {
    // Enrichment adds the marker, so filtering must run afterward.
    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.downloadUrl === 'http://nzb.test/multi') r.nzbName = 'The Way of Kings (02 of 30).part02.rar';
      }
    });
    const cleanTitleMultiPart = { ...multiPartUsenet, title: 'The Way of Kings' };
    const deps = createDeps({
      indexerSearchService: inject<IndexerSearchService>({
        searchAllWithStatus: mockSearchAllWithStatus([cleanTitleMultiPart]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
  });
});

describe('retrySearch — query ladder (#2104)', () => {
  const franchiseBook: BookWithAuthor = {
    ...createMockDbBook({ duration: 3600, title: 'Star Wars: The High Republic: Haunted Starlight' }),
    authors: [{ ...createMockDbAuthor(), name: 'George Mann' }],
    narrators: [],
  };

  const churnBook: BookWithAuthor = {
    ...createMockDbBook({ duration: 3600, title: 'The Churn: An Expanse Novella' }),
    authors: [{ ...createMockDbAuthor(), name: 'James S. A. Corey' }],
    narrators: [],
  };

  const depsFor = (book: BookWithAuthor) => (searchAllWithStatus: ReturnType<typeof vi.fn>) =>
    createDeps({
      indexerSearchService: inject<IndexerSearchService>({ searchAllWithStatus }),
      bookService: inject<BookService>({ getById: vi.fn().mockResolvedValue(book) }),
    });

  const franchiseDeps = depsFor(franchiseBook);
  const churnDeps = depsFor(churnBook);

  it('finds a book at a deep rung while consuming exactly ONE budget attempt (AC19)', async () => {
    const searchAllWithStatus = answeringSearchStatus({
      'star wars haunted starlight George Mann': [{ ...mockSearchResult, title: 'Star Wars: Haunted Starlight' }],
    });
    const deps = franchiseDeps(searchAllWithStatus);
    const consumeAttempt = vi.spyOn(deps.retryBudget, 'consumeAttempt');

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    expect(consumeAttempt).toHaveBeenCalledTimes(1);
    expect(searchAllWithStatus.mock.calls.map((c) => c[0])).toEqual([
      'Star Wars The High Republic Haunted Starlight George Mann',
      'star wars the high republic George Mann',
      'the high republic haunted starlight George Mann',
      'star wars haunted starlight George Mann',
    ]);
  });

  // Retry owns a separate filter/rank/grab chain despite sharing candidate selection.
  it('withholds the grab and records ONE held event when every downloadable candidate fails the floor (AC14)', async () => {
    const deps = franchiseDeps(answeringSearchStatus({
      'star wars haunted starlight George Mann': [
        { ...mockSearchResult, title: 'Star Wars: The High Republic: Cataclysm', seeders: 99 },
        { ...mockSearchResult, title: 'Star Wars: Haunted Totally Different Starlight', seeders: 1 },
      ],
    }));
    const consumeAttempt = vi.spyOn(deps.retryBudget, 'consumeAttempt');

    const result = await retrySearch(1, deps);

    expect(result).toEqual({ outcome: 'no_candidates' });
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
    expect(consumeAttempt).toHaveBeenCalledTimes(1);
    expect(deps.eventHistory.create).toHaveBeenCalledTimes(1);
    expect(deps.eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      reason: {
        relaxed_query: 'star wars haunted starlight George Mann',
        variant_tag: 'first+last',
        release_title: 'Star Wars: The High Republic: Cataclysm',
      },
    }));
  });

  it('grabs a lower-ranked passing candidate past a failing top-ranked one, holding nothing (AC31)', async () => {
    const deps = franchiseDeps(answeringSearchStatus({
      'star wars haunted starlight George Mann': [
        { ...mockSearchResult, title: 'Star Wars: The High Republic: Cataclysm', seeders: 99 },
        { ...mockSearchResult, title: 'Star Wars: Haunted Starlight', seeders: 5 },
      ],
    }));

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });

  it('holds every High-Republic sibling found at the prefix(2) rung, recording ONE event (#2133 AC5, AC10)', async () => {
    const deps = franchiseDeps(answeringSearchStatus({
      'star wars the high republic George Mann': [
        { ...mockSearchResult, title: '01 Star Wars-The High Republic-The Eye of Darkness', seeders: 99 },
        { ...mockSearchResult, title: 'Star Wars: The High Republic: Cataclysm', seeders: 1 },
      ],
    }));

    const result = await retrySearch(1, deps);

    expect(result).toEqual({ outcome: 'no_candidates' });
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
    expect(deps.eventHistory.create).toHaveBeenCalledTimes(1);
    expect(deps.eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      reason: {
        relaxed_query: 'star wars the high republic George Mann',
        variant_tag: 'prefix(2)',
        release_title: '01 Star Wars-The High Republic-The Eye of Darkness',
      },
    }));
  });

  it('holds a head-only The Churn release at the prefix(1) rung (#2133 AC7, AC10)', async () => {
    const deps = churnDeps(answeringSearchStatus({
      'the churn James S A Corey': [{ ...mockSearchResult, title: 'The Churn (Unabridged) [M4B]' }],
    }));

    const result = await retrySearch(1, deps);

    expect(result).toEqual({ outcome: 'no_candidates' });
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
    expect(deps.eventHistory.create).toHaveBeenCalledTimes(1);
    expect(deps.eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      reason: {
        relaxed_query: 'the churn James S A Corey',
        variant_tag: 'prefix(1)',
        release_title: 'The Churn (Unabridged) [M4B]',
      },
    }));
  });

  it('runs the FULL ladder — it never consults the scheduled-cycle cooldown (AC34)', async () => {
    const searchAllWithStatus = answeringSearchStatus({});
    await retrySearch(1, franchiseDeps(searchAllWithStatus));

    expect(searchAllWithStatus.mock.calls.map((c) => c[0])).toHaveLength(MAX_SEARCH_RUNGS);
  });

  it('passes the canonical author as rankingAuthor on every rung (AC17)', async () => {
    const searchAllWithStatus = answeringSearchStatus({});
    await retrySearch(1, franchiseDeps(searchAllWithStatus));

    for (const [, options] of searchAllWithStatus.mock.calls) {
      expect(options).toEqual(expect.objectContaining({
        title: 'Star Wars: The High Republic: Haunted Starlight',
        rankingAuthor: 'George Mann',
      }));
    }
    // Rungs 0–4 include the transport author; the author-free arm starts at 5.
    const authorOff = (o: unknown) => (o as { author?: string }).author === undefined;
    expect(searchAllWithStatus.mock.calls.slice(0, 5).some(([, o]) => authorOff(o))).toBe(false);
    expect(searchAllWithStatus.mock.calls.slice(5).every(([, o]) => authorOff(o))).toBe(true);
  });

  it('grabs a release found at the tail rung that carries both anchors (AC10)', async () => {
    const deps = franchiseDeps(answeringSearchStatus({
      'haunted starlight George Mann': [{ ...mockSearchResult, title: 'Star Wars: Haunted Starlight' }],
    }));
    const consumeAttempt = vi.spyOn(deps.retryBudget, 'consumeAttempt');

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledTimes(1);
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
    expect(consumeAttempt).toHaveBeenCalledTimes(1);
  });

  it('holds a franchise-dropping release found at the tail rung, recording ONE event (AC10)', async () => {
    const deps = franchiseDeps(answeringSearchStatus({
      'haunted starlight George Mann': [{ ...mockSearchResult, title: 'Haunted Starlight - George Mann' }],
    }));
    const consumeAttempt = vi.spyOn(deps.retryBudget, 'consumeAttempt');

    const result = await retrySearch(1, deps);

    // The shared floor requires both canonical title anchors; there is no per-rung exception.
    expect(result).toEqual({ outcome: 'no_candidates' });
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
    expect(consumeAttempt).toHaveBeenCalledTimes(1);
    expect(deps.eventHistory.create).toHaveBeenCalledTimes(1);
    expect(deps.eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      reason: {
        relaxed_query: 'haunted starlight George Mann',
        variant_tag: 'suffix(1)',
        release_title: 'Haunted Starlight - George Mann',
      },
    }));
  });
});

describe('retrySearch — #2322 unsatisfied limit', () => {
  const AT_LIMIT = { count: 150, limit: 150 };

  const churnBook: BookWithAuthor = {
    ...createMockDbBook({ duration: 3600, title: 'The Churn: An Expanse Novella' }),
    authors: [{ ...createMockDbAuthor(), name: 'James S. A. Corey' }],
    narrators: [],
  };
  const CHURN_RUNG_1 = 'The Churn An Expanse Novella James S A Corey';
  const CHURN_CUT_RUNG = 'the churn James S A Corey';
  const FLOOR_PASSING = 'The Churn: An Expanse Novella';
  const FLOOR_FAILING = 'The Churn (Unabridged) [M4B]';

  const mam = (overrides: Record<string, unknown> = {}) => ({
    ...mockSearchResult, indexer: 'MyAnonamouse', unsatisfied: AT_LIMIT, ...overrides,
  });
  const nonMam = (overrides: Record<string, unknown> = {}) => ({
    ...mockSearchResult, indexer: 'Prowlarr', title: 'Prowlarr Release', ...overrides,
  });

  const depsFor = (book: BookWithAuthor, searchAllWithStatus: ReturnType<typeof vi.fn>) =>
    createDeps({
      indexerSearchService: inject<IndexerSearchService>({ searchAllWithStatus }),
      bookService: inject<BookService>({ getById: vi.fn().mockResolvedValue(book) }),
    });

  const eventsOfType = (deps: RetrySearchDeps, type: string) =>
    vi.mocked(deps.eventHistory.create).mock.calls.filter((c) => (c[0] as { eventType: string }).eventType === type);

  it('returns no_candidates, grabs nothing and records the blocked event when every candidate is at the limit', async () => {
    const deps = depsFor(mockBook, answeringSearchStatus({ 'The Way of Kings Brandon Sanderson': [mam({ title: 'MAM Only' })] }));

    const result = await retrySearch(1, deps);

    expect(result).toEqual({ outcome: 'no_candidates' });
    expect(deps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
    expect(deps.eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'grab_blocked_unsatisfied',
      reason: { indexer: 'MyAnonamouse', count: 150, limit: 150, release_title: 'MAM Only' },
    }));
  });

  it('consumes exactly one budget attempt on an all-blocked set', async () => {
    const deps = depsFor(mockBook, answeringSearchStatus({ 'The Way of Kings Brandon Sanderson': [mam()] }));
    const consumeAttempt = vi.spyOn(deps.retryBudget, 'consumeAttempt');

    await retrySearch(1, deps);

    expect(consumeAttempt).toHaveBeenCalledTimes(1);
    expect(deps.retryBudget.hasRemaining(1)).toBe(true);
  });

  it('records the event once per blocked retry, not once per discarded release', async () => {
    const deps = depsFor(mockBook, answeringSearchStatus({
      'The Way of Kings Brandon Sanderson': [mam({ title: 'MAM A' }), mam({ title: 'MAM B' })],
    }));

    await retrySearch(1, deps);

    expect(eventsOfType(deps, 'grab_blocked_unsatisfied')).toHaveLength(1);
  });

  it('retries on the best remaining non-MAM candidate, recording no blocked event', async () => {
    const deps = depsFor(mockBook, answeringSearchStatus({
      'The Way of Kings Brandon Sanderson': [mam({ title: 'MAM Best', seeders: 99 }), nonMam({ seeders: 5 })],
    }));

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledTimes(1);
    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Prowlarr Release' }),
    );
    expect(eventsOfType(deps, 'grab_blocked_unsatisfied')).toHaveLength(0);
  });

  it('records no blocked event when the only at-limit candidate has no download link', async () => {
    const deps = depsFor(mockBook, answeringSearchStatus({
      'The Way of Kings Brandon Sanderson': [mam({ title: 'Unlinked', downloadUrl: undefined })],
    }));

    const result = await retrySearch(1, deps);

    expect(result).toEqual({ outcome: 'no_candidates' });
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });

  it('records no blocked event when the only at-limit candidate has an empty download link', async () => {
    const deps = depsFor(mockBook, answeringSearchStatus({
      'The Way of Kings Brandon Sanderson': [mam({ title: 'Unlinked', downloadUrl: '' })],
    }));

    expect(await retrySearch(1, deps)).toEqual({ outcome: 'no_candidates' });
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });

  it('keeps the pre-existing hold when the floor, not the limit, stopped the grab', async () => {
    const deps = depsFor(churnBook, answeringSearchStatus({ [CHURN_CUT_RUNG]: [mam({ title: FLOOR_FAILING })] }));

    const result = await retrySearch(1, deps);

    expect(result).toEqual({ outcome: 'no_candidates' });
    expect(eventsOfType(deps, 'search_relaxed_held')).toHaveLength(1);
    expect(eventsOfType(deps, 'grab_blocked_unsatisfied')).toHaveLength(0);
  });

  it('records the blocked event when the limit removed the release the floor had admitted', async () => {
    const deps = depsFor(churnBook, answeringSearchStatus({
      [CHURN_CUT_RUNG]: [mam({ title: FLOOR_PASSING, seeders: 99 }), nonMam({ title: FLOOR_FAILING, seeders: 5 })],
    }));

    const result = await retrySearch(1, deps);

    expect(result).toEqual({ outcome: 'no_candidates' });
    expect(eventsOfType(deps, 'grab_blocked_unsatisfied')).toHaveLength(1);
    expect(eventsOfType(deps, 'search_relaxed_held')).toHaveLength(0);
  });

  it('is inert on a full rung, where the same fixture simply retries the remainder', async () => {
    const deps = depsFor(churnBook, answeringSearchStatus({
      [CHURN_RUNG_1]: [mam({ title: FLOOR_PASSING, seeders: 99 }), nonMam({ title: FLOOR_FAILING, seeders: 5 })],
    }));

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    expect(deps.downloadOrchestrator.grabForRetry).toHaveBeenCalledWith(
      expect.objectContaining({ title: FLOOR_FAILING }),
    );
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });

  const grabbing: Array<{ name: string; unsatisfied: { count: number; limit: number } | undefined }> = [
    { name: '149 of 150', unsatisfied: { count: 149, limit: 150 } },
    { name: '0 of 150', unsatisfied: { count: 0, limit: 150 } },
    { name: 'nothing attached', unsatisfied: undefined },
  ];

  for (const { name, unsatisfied } of grabbing) {
    it(`retries normally at ${name}`, async () => {
      const deps = depsFor(mockBook, answeringSearchStatus({
        'The Way of Kings Brandon Sanderson': [{ ...mockSearchResult, ...(unsatisfied !== undefined && { unsatisfied }) }],
      }));

      expect((await retrySearch(1, deps)).outcome).toBe('retried');
      expect(deps.eventHistory.create).not.toHaveBeenCalled();
    });
  }
});
