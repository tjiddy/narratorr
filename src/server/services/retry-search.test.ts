import { describe, it, expect, vi } from 'vitest';
import { retrySearch, createRetrySearchDeps, type RetrySearchDeps } from './retry-search.js';
import { RetryBudget } from './retry-budget.js';
import { createMockLogger, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { DownloadWithBook } from './download.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { BookService, BookWithAuthor } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { FastifyBaseLogger } from 'fastify';

const mockBook: BookWithAuthor = {
  ...createMockDbBook({ duration: 3600 }),
  author: createMockDbAuthor(),
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
  progress: 0,
  externalId: 'ext-new',
  errorMessage: null,
  addedAt: new Date(),
  completedAt: null,
  progressUpdatedAt: null,
  indexerName: null,
};

function createDeps(overrides?: Partial<RetrySearchDeps>): RetrySearchDeps {
  return {
    indexerService: inject<IndexerService>({
      searchAll: vi.fn().mockResolvedValue([mockSearchResult]),
    }),
    downloadOrchestrator: inject<DownloadOrchestrator>({
      grab: vi.fn().mockResolvedValue(mockDownload),
    }),
    blacklistService: inject<BlacklistService>({
      getBlacklistedHashes: vi.fn().mockResolvedValue(new Set<string>()),
    }),
    bookService: inject<BookService>({
      getById: vi.fn().mockResolvedValue(mockBook),
    }),
    settingsService: createMockSettingsService(),
    retryBudget: new RetryBudget(),
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
    expect(deps.indexerService.searchAll).toHaveBeenCalled();
    expect(deps.downloadOrchestrator.grab).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadUrl: 'magnet:?xt=urn:btih:def456',
        bookId: 1,
        skipDuplicateCheck: true,
      }),
    );
  });

  it('returns exhausted when budget is spent', async () => {
    const deps = createDeps();
    deps.retryBudget.consumeAttempt(1);
    deps.retryBudget.consumeAttempt(1);
    deps.retryBudget.consumeAttempt(1);

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('exhausted');
    expect(deps.indexerService.searchAll).not.toHaveBeenCalled();
  });

  it('returns no_candidates when search returns empty results', async () => {
    const deps = createDeps({
      indexerService: inject<IndexerService>({
        searchAll: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
  });

  it('returns no_candidates when all results are blacklisted', async () => {
    const deps = createDeps({
      blacklistService: inject<BlacklistService>({
        getBlacklistedHashes: vi.fn().mockResolvedValue(new Set(['def456'])),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
  });

  it('excludes newly blacklisted hash from retry search results', async () => {
    const blacklistedHash = 'abc123';
    const goodResult = { ...mockSearchResult, infoHash: 'def456', downloadUrl: 'magnet:?xt=urn:btih:def456' };
    const blacklistedResult = { ...mockSearchResult, infoHash: blacklistedHash, downloadUrl: 'magnet:?xt=urn:btih:abc123' };

    const deps = createDeps({
      indexerService: inject<IndexerService>({
        searchAll: vi.fn().mockResolvedValue([blacklistedResult, goodResult]),
      }),
      blacklistService: inject<BlacklistService>({
        getBlacklistedHashes: vi.fn().mockResolvedValue(new Set([blacklistedHash])),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('retried');
    // Should have grabbed the non-blacklisted result
    expect(deps.downloadOrchestrator.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:def456' }),
    );
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
      indexerService: inject<IndexerService>({
        searchAll: vi.fn().mockRejectedValue(new Error('Connection refused')),
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
      indexerService: inject<IndexerService>({
        searchAll: vi.fn().mockResolvedValue([
          { ...mockSearchResult, downloadUrl: undefined },
        ]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
  });

  it('consumes a budget attempt even when result is no_candidates', async () => {
    const deps = createDeps({
      indexerService: inject<IndexerService>({
        searchAll: vi.fn().mockResolvedValue([]),
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

  it('handles book with no active indexers (empty results)', async () => {
    const deps = createDeps({
      indexerService: inject<IndexerService>({
        searchAll: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await retrySearch(1, deps);

    expect(result.outcome).toBe('no_candidates');
  });
});

describe('createRetrySearchDeps', () => {
  it('maps service bag fields to RetrySearchDeps contract by reference', () => {
    const indexer = {} as IndexerService;
    const downloadOrchestrator = {} as DownloadOrchestrator;
    const blacklist = {} as BlacklistService;
    const book = {} as BookService;
    const settings = {} as SettingsService;
    const retryBudget = new RetryBudget();
    const log = inject<FastifyBaseLogger>(createMockLogger());

    const result = createRetrySearchDeps(
      { indexer, downloadOrchestrator, blacklist, book, settings, retryBudget },
      log,
    );

    expect(result.indexerService).toBe(indexer);
    expect(result.downloadOrchestrator).toBe(downloadOrchestrator);
    expect(result.blacklistService).toBe(blacklist);
    expect(result.bookService).toBe(book);
    expect(result.settingsService).toBe(settings);
    expect(result.retryBudget).toBe(retryBudget);
    expect(result.log).toBe(log);
  });
});
