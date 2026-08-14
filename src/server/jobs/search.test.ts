import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockLogger, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { runSearchJob, searchAllWanted } from './search.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookListService } from '../services/book-list.service.js';
import type { IndexerSearchService } from '../services/indexer-search.service.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { EventHistoryService } from '../services/event-history.service.js';
import type { SearchResult } from '@core/index.js';
import { DuplicateDownloadError } from '../services/download.service.js';
import { BYTES_PER_GB } from '@shared/constants.js';
import { SearchLadderCooldown } from '../services/search-ladder-cooldown.js';
import { RetryBudget } from '../services/retry-budget.js';
import { SEARCH_DEADLINE_MS } from '@core/utils/constants.js';
import { withSearchDeadline, _resetSearchRegistryForTesting } from '../services/search-deadline.js';

vi.mock('../utils/enrich-usenet-languages.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/enrich-usenet-languages.js')>()),
  enrichUsenetLanguages: vi.fn(),
}));


// succeeded: 1 makes empty results a genuine zero, allowing query-ladder fallback.
function withStatus(results: SearchResult[]) {
  return { results, succeeded: 1, failed: 0 };
}

function createMockBookListService(books: unknown[] = []): BookListService {
  return inject<BookListService>({
    getAll: vi.fn().mockResolvedValue({ data: books, total: books.length }),
    getIdentifiers: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue({ counts: {}, authors: [], series: [], narrators: [] }),
  });
}

function createMockIndexerService(results: SearchResult[] = []): IndexerSearchService {
  return inject<IndexerSearchService>({
    searchAllWithStatus: vi.fn().mockResolvedValue(withStatus(results)),
    searchAllStreaming: vi.fn().mockResolvedValue(results),
    getEnabledIndexers: vi.fn().mockResolvedValue([]),
    getRssCapableIndexers: vi.fn().mockResolvedValue([]),
    pollRss: vi.fn(),
  });
}

function createMockDownloadOrchestrator(): DownloadOrchestrator {
  return inject<DownloadOrchestrator>({
    grab: vi.fn().mockResolvedValue({ id: 1 }),
    getAll: vi.fn(),
    getById: vi.fn(),
    getActive: vi.fn(),
    getActiveByBookId: vi.fn(),
    updateProgress: vi.fn(),
    setError: vi.fn(),
    cancel: vi.fn(),
    delete: vi.fn(),
  });
}

function createMockBlacklistService(): BlacklistService {
  return inject<BlacklistService>({
    getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
      blacklistedHashes: new Set<string>(),
      blacklistedGuids: new Set<string>(),
    }),
  });
}

const mockIndexer = {
  getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
} as unknown as IndexerService;

const mockEventHistory = {
  create: vi.fn().mockResolvedValue({ id: 1 }),
} as unknown as EventHistoryService;

const mockResult = (seeders: number, downloadUrl?: string): SearchResult => ({
  title: 'Test Book',
  protocol: 'torrent',
  indexer: 'abb',
  seeders,
  ...(downloadUrl !== undefined && { downloadUrl }),
});

describe('runSearchJob', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
  });

  it('resets retry budget at the start of every search cycle', async () => {
    const { RetryBudget } = await import('../services/retry-budget.js');
    const retryBudget = new RetryBudget();
    retryBudget.consumeAttempt(1);
    retryBudget.consumeAttempt(2);
    const resetAllSpy = vi.spyOn(retryBudget, 'resetAll');

    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService([]);
    const indexer = createMockIndexerService();
    const download = createMockDownloadOrchestrator();

    await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory, retryBudget);

    expect(resetAllSpy).toHaveBeenCalledOnce();
  });

  it('returns zeros when search is disabled', async () => {
    const settings = createMockSettingsService({ search: { enabled: false, intervalMinutes: 60 } });
    const bookList = createMockBookListService();
    const indexer = createMockIndexerService();
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result).toEqual({ searched: 0, grabbed: 0 });
    expect(bookList.getAll).not.toHaveBeenCalled();
  });

  it('searches each wanted book', async () => {
    const wantedBooks = [
      { id: 1, title: 'Book One', authors: [{ name: 'Author A' }] },
      { id: 2, title: 'Book Two', authors: [{ name: 'Author B' }] },
    ];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(2);
    // Each genuine zero advances once to the author-free rung.
    expect(vi.mocked(indexer.searchAllWithStatus).mock.calls.map((c) => c[0])).toEqual([
      'Book One Author A', 'book one',
      'Book Two Author B', 'book two',
    ]);
  });

  it('grabs best result when search finds matches', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadUrl: 'magnet:?xt=urn:btih:aaa',
        bookId: 1,
      }),
    );
  });

  it('returns searched count but zero grabbed when no indexer returns results', async () => {
    const wantedBooks = [
      { id: 1, title: 'Obscure Book', authors: [{ name: 'Unknown Author' }] },
      { id: 2, title: 'Another Rare Book', authors: [{ name: 'Nobody' }] },
    ];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(2);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'No results found',
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 2 }),
      'No results found',
    );
  });

  it('counts only successful searches when one book throws during processing', async () => {
    const wantedBooks = [
      { id: 1, title: 'Book A', authors: [{ name: 'Author' }] },
      { id: 2, title: 'Book B', authors: [{ name: 'Author' }] },
      { id: 3, title: 'Book C', authors: [{ name: 'Author' }] },
    ];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const results = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    vi.mocked(indexer.searchAllWithStatus).mockResolvedValueOnce(withStatus(results))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(withStatus(results));
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(2);
    expect(result.grabbed).toBe(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 2 }),
      'Search failed for book',
    );
    expect(indexer.searchAllWithStatus).toHaveBeenCalledTimes(3);
  });

  it('handles book with no author gracefully', async () => {
    const wantedBooks = [
      { id: 1, title: 'Anonymous Work', authors: null },
    ];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(1);
    expect(vi.mocked(indexer.searchAllWithStatus).mock.calls[0]![0]).toBe('Anonymous Work');
  });

  it('skips grab when book already has active download', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    vi.mocked(download.grab).mockRejectedValueOnce(
      new DuplicateDownloadError('Book 1 already has an active download (id: 5)', 'ACTIVE_DOWNLOAD_EXISTS', { active: { title: 'A Book', count: 1 } }),
    );

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Skipping grab — book already has a blocking download or import',
    );
  });

  it('re-throws non-duplicate grab errors to outer catch', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    vi.mocked(download.grab).mockRejectedValueOnce(
      new Error('No download client configured'),
    );

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: 1,
        error: expect.objectContaining({
          message: 'No download client configured',
          type: 'Error',
          stack: expect.any(String),
        }),
      }),
      'Search failed for book',
    );
  });

  it('serializes non-Error grab rejections at the grab_error log site (#852)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    vi.mocked(download.grab).mockRejectedValueOnce('string error');

    await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: 1,
        error: expect.objectContaining({ message: 'string error', type: 'Error', stack: expect.any(String) }),
      }),
      'Search failed for book',
    );
  });

  it('continues on per-book failure', async () => {
    const wantedBooks = [
      { id: 1, title: 'Failing Book', authors: [{ name: 'Author' }] },
      { id: 2, title: 'Good Book', authors: [{ name: 'Author' }] },
    ];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    vi.mocked(indexer.searchAllWithStatus)
      .mockRejectedValueOnce(new Error('Indexer down'))
      .mockResolvedValueOnce(withStatus([]));
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it('applies word filtering via filterAndRankResults (reject words)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const settings = createMockSettingsService({
      search: { enabled: true, intervalMinutes: 60 },
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'German', requiredWords: '' },
    });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([
      { ...mockResult(10, 'magnet:?xt=urn:btih:aaa'), title: 'German Edition' },
      { ...mockResult(10, 'magnet:?xt=urn:btih:bbb'), title: 'English Edition' },
    ]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'English Edition' }),
    );
  });

  it('applies word filtering via filterAndRankResults (required words)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const settings = createMockSettingsService({
      search: { enabled: true, intervalMinutes: 60 },
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: '', requiredWords: 'M4B' },
    });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([
      { ...mockResult(10, 'magnet:?xt=urn:btih:aaa'), title: 'Book MP3' },
      { ...mockResult(10, 'magnet:?xt=urn:btih:bbb'), title: 'Book M4B' },
    ]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Book M4B' }),
    );
  });

  it('applies quality filtering to search results (min seeders)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }], duration: 3600 }];
    const settings = createMockSettingsService({
      search: { enabled: true, intervalMinutes: 60 },
      quality: { grabFloor: 0, minSeeders: 5, protocolPreference: 'none' },
    });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([mockResult(2, 'magnet:?xt=urn:btih:aaa')]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('applies quality filtering to search results (maxDownloadSize) and logs quality gate', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }], duration: 3600 }];
    const settings = createMockSettingsService({
      search: { enabled: true, intervalMinutes: 60 },
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 },
    });
    const bookList = createMockBookListService(wantedBooks);
    const oversizedResult: SearchResult = { ...mockResult(10, 'magnet:?xt=urn:btih:big'), size: 10 * BYTES_PER_GB };
    const indexer = createMockIndexerService([oversizedResult]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      { inputCount: 1, outputCount: 0 },
      'Quality gate filtering applied',
    );
  });

  it('forwards indexerId from best search result to downloadOrchestrator.grab', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const searchResults: SearchResult[] = [{ ...mockResult(10, 'magnet:?xt=urn:btih:aaa'), indexerId: 42 }];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ indexerId: 42 }),
    );
  });

  it('languages filter excludes non-matching language results in scheduled search', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const settings = createMockSettingsService({
      search: { enabled: true, intervalMinutes: 60 },
      metadata: { audibleRegion: 'us', languages: ['english'] },
    });
    const bookList = createMockBookListService(wantedBooks);
    const frenchResult: SearchResult = {
      title: 'Book One',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      downloadUrl: 'magnet:?xt=urn:btih:french',
      language: 'french',
      size: 500_000_000,
    };
    const englishResult: SearchResult = {
      title: 'Book One',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      downloadUrl: 'magnet:?xt=urn:btih:english',
      language: 'english',
      size: 500_000_000,
    };
    const indexer = createMockIndexerService([frenchResult, englishResult]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(download.grab).toHaveBeenCalledTimes(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:english' }),
    );
    expect(result.grabbed).toBe(1);
  });
});


describe('searchAllWanted', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
  });

  it('searches each wanted book against all enabled indexers', async () => {
    const wantedBooks = [
      { id: 1, title: 'Book One', authors: [{ name: 'Author A' }] },
      { id: 2, title: 'Book Two', authors: [{ name: 'Author B' }] },
    ];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(2);
    // Each genuine zero advances once to the author-free rung.
    expect(vi.mocked(indexer.searchAllWithStatus).mock.calls.map((c) => c[0])).toEqual([
      'Book One Author A', 'book one',
      'Book Two Author B', 'book two',
    ]);
  });

  it('grabs the best ranked result per book', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa'), mockResult(5, 'magnet:?xt=urn:btih:bbb')];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:aaa', bookId: 1 }),
    );
  });

  it('skips books where grab throws DuplicateDownloadError — increments skipped', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();
    vi.mocked(download.grab).mockRejectedValueOnce(new DuplicateDownloadError('Book 1 already has an active download (id: 5)', 'ACTIVE_DOWNLOAD_EXISTS', { active: { title: 'A Book', count: 1 } }));

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.grabbed).toBe(0);
  });

  it('continues searching remaining books when one book search throws — increments errors', async () => {
    const wantedBooks = [
      { id: 1, title: 'Book A', authors: [{ name: 'Author' }] },
      { id: 2, title: 'Book B', authors: [{ name: 'Author' }] },
      { id: 3, title: 'Book C', authors: [{ name: 'Author' }] },
    ];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const results = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    vi.mocked(indexer.searchAllWithStatus).mockResolvedValueOnce(withStatus(results))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(withStatus(results));
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(2);
    expect(result.grabbed).toBe(2);
    expect(result.errors).toBe(1);
    expect(indexer.searchAllWithStatus).toHaveBeenCalledTimes(3);
  });

  it('does NOT check searchSettings.enabled — manual trigger always runs', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const settings = createMockSettingsService({ search: { enabled: false, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([mockResult(10, 'magnet:?xt=urn:btih:aaa')]);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(1);
  });

  it('returns accurate searched, grabbed, skipped, and errors counts', async () => {
    const wantedBooks = [
      { id: 1, title: 'Book A', authors: [{ name: 'Author' }] },
      { id: 2, title: 'Book B', authors: [{ name: 'Author' }] },
      { id: 3, title: 'Book C', authors: [{ name: 'Author' }] },
    ];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const results = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    vi.mocked(indexer.searchAllWithStatus).mockResolvedValueOnce(withStatus(results))
      .mockResolvedValueOnce(withStatus(results))
      .mockResolvedValueOnce(withStatus(results));
    const download = createMockDownloadOrchestrator();
    vi.mocked(download.grab)
      .mockResolvedValueOnce({ id: 1 } as never)
      .mockRejectedValueOnce(new DuplicateDownloadError('already has an active download', 'ACTIVE_DOWNLOAD_EXISTS', { active: { title: 'A Book', count: 1 } }))
      .mockResolvedValueOnce({ id: 2 } as never);

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result).toEqual({ searched: 3, grabbed: 2, skipped: 1, errors: 0 });
  });

  it('filters results below grab floor (no grab attempted)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author' }], duration: 600 }];
    const searchResults: SearchResult[] = [{ title: 'Test', protocol: 'torrent', indexer: 'abb', seeders: 10, downloadUrl: 'magnet:?aaa', size: 1000 }];
    const settings = createMockSettingsService({ quality: { grabFloor: 100, minSeeders: 0, protocolPreference: 'none' } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('grabFloor=0 disables quality filtering (all results eligible)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author' }], duration: 600 }];
    const searchResults: SearchResult[] = [{ title: 'Test', protocol: 'torrent', indexer: 'abb', seeders: 10, downloadUrl: 'magnet:?aaa', size: 1000 }];
    // Disable the independent size gate so this isolates grabFloor.
    const settings = createMockSettingsService({ quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 0 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.grabbed).toBe(1);
  });

  it('results without downloadUrl are skipped (not grabbable)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author' }] }];
    const searchResults = [mockResult(10, undefined)];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('returns zeros when no wanted books exist', async () => {
    const settings = createMockSettingsService();
    const bookList = createMockBookListService([]);
    const indexer = createMockIndexerService();
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result).toEqual({ searched: 0, grabbed: 0, skipped: 0, errors: 0 });
  });

  it('all books already have active downloads — grabbed: 0, skipped: N', async () => {
    const wantedBooks = [
      { id: 1, title: 'Book A', authors: [{ name: 'Author' }] },
      { id: 2, title: 'Book B', authors: [{ name: 'Author' }] },
    ];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([mockResult(10, 'magnet:?aaa')]);
    const download = createMockDownloadOrchestrator();
    vi.mocked(download.grab).mockRejectedValue(new DuplicateDownloadError('already has an active download', 'ACTIVE_DOWNLOAD_EXISTS', { active: { title: 'A Book', count: 1 } }));

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.grabbed).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it('all indexer searches return zero results — searched: N, grabbed: 0', async () => {
    const wantedBooks = [
      { id: 1, title: 'Book A', authors: [{ name: 'Author' }] },
      { id: 2, title: 'Book B', authors: [{ name: 'Author' }] },
    ];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.searched).toBe(2);
    expect(result.grabbed).toBe(0);
  });

  it('book with author=null — query uses title only', async () => {
    const wantedBooks = [{ id: 1, title: 'Anonymous Work', authors: null }];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadOrchestrator();

    await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(vi.mocked(indexer.searchAllWithStatus).mock.calls[0]![0]).toBe('Anonymous Work');
  });

  it('mixed success/failure: accurate partial counts', async () => {
    const wantedBooks = [
      { id: 1, title: 'Book A', authors: [{ name: 'Author' }] },
      { id: 2, title: 'Book B', authors: [{ name: 'Author' }] },
      { id: 3, title: 'Book C', authors: [{ name: 'Author' }] },
      { id: 4, title: 'Book D', authors: [{ name: 'Author' }] },
    ];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const results = [mockResult(10, 'magnet:?aaa')];
    vi.mocked(indexer.searchAllWithStatus).mockResolvedValueOnce(withStatus(results))
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockResolvedValueOnce(withStatus(results))
      .mockResolvedValueOnce(withStatus([]));
    const download = createMockDownloadOrchestrator();
    vi.mocked(download.grab)
      .mockResolvedValueOnce({ id: 1 } as never)
      .mockRejectedValueOnce(new DuplicateDownloadError('already has an active download', 'ACTIVE_DOWNLOAD_EXISTS', { active: { title: 'A Book', count: 1 } }));

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result).toEqual({ searched: 3, grabbed: 1, skipped: 1, errors: 1 });
  });

  it('non-Error thrown from grab — not treated as DuplicateDownloadError (instanceof fails for non-Error)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author' }] }];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([mockResult(10, 'magnet:?aaa')]);
    const download = createMockDownloadOrchestrator();
    vi.mocked(download.grab).mockRejectedValueOnce('some string error');

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: 1,
        error: expect.objectContaining({ message: 'some string error', type: 'Error', stack: expect.any(String) }),
      }),
      'Grab failed for book',
    );
  });

  it('reads metadata.languages and passes it to searchAndGrabForBook', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const settings = createMockSettingsService({
      search: { enabled: true, intervalMinutes: 60 },
      metadata: { audibleRegion: 'us', languages: ['english'] },
    });
    const bookList = createMockBookListService(wantedBooks);
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(settings.get).toHaveBeenCalledWith('metadata');
    expect(settings.get).toHaveBeenCalledWith('quality');
  });

  it('languages filter causes non-matching language results to be skipped', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const settings = createMockSettingsService({
      metadata: { audibleRegion: 'us', languages: ['english'] },
    });
    const bookList = createMockBookListService(wantedBooks);
    const frenchResult: SearchResult = {
      title: 'Book One',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      downloadUrl: 'magnet:?xt=urn:btih:french',
      language: 'french',
      size: 500_000_000,
    };
    const indexer = createMockIndexerService([frenchResult]);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(download.grab).not.toHaveBeenCalled();
    expect(result.grabbed).toBe(0);
  });

  it('languages filter allows matching language results to be grabbed', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const settings = createMockSettingsService({
      metadata: { audibleRegion: 'us', languages: ['english'] },
    });
    const bookList = createMockBookListService(wantedBooks);
    const englishResult: SearchResult = {
      title: 'Book One',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      downloadUrl: 'magnet:?xt=urn:btih:english',
      language: 'english',
      size: 500_000_000,
    };
    const frenchResult: SearchResult = {
      title: 'Book One',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      downloadUrl: 'magnet:?xt=urn:btih:french',
      language: 'french',
      size: 500_000_000,
    };
    const indexer = createMockIndexerService([frenchResult, englishResult]);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(download.grab).toHaveBeenCalledTimes(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:english' }),
    );
    expect(result.grabbed).toBe(1);
  });

  it('counts searched and errors when grab fails with non-duplicate error', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([mockResult(10, 'magnet:?xt=urn:btih:aaa')]);
    const download = createMockDownloadOrchestrator();
    vi.mocked(download.grab).mockRejectedValueOnce(
      new Error('No download client configured'),
    );

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result).toEqual({ searched: 1, grabbed: 0, skipped: 0, errors: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: 1,
        error: expect.objectContaining({
          message: 'No download client configured',
          type: 'Error',
          stack: expect.any(String),
        }),
      }),
      'Grab failed for book',
    );
  });
});

function createStreamingIndexerService(results: SearchResult[] = []): IndexerSearchService {
  return inject<IndexerSearchService>({
    searchAllWithStatus: vi.fn().mockResolvedValue(withStatus(results)),
    searchAllStreaming: vi.fn().mockImplementation(async (_q: string, _o: unknown, _c: Map<number, AbortController>, callbacks: { onComplete: (id: number, name: string, count: number, ms: number) => void }) => {
      callbacks.onComplete(10, 'MAM', results.length, 500);
      return results;
    }),
    getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
    getRssCapableIndexers: vi.fn().mockResolvedValue([]),
    pollRss: vi.fn(),
  });
}

describe('#392 runSearchJob broadcaster wiring', () => {
  it('passes EventBroadcaster to searchAndGrabForBook — triggers streaming path', async () => {
    const settings = createMockSettingsService();
    const bookList = createMockBookListService([{ id: 1, title: 'Test Book', authors: [{ name: 'Author' }] }]);
    const results: SearchResult[] = [{ title: 'Test Book', protocol: 'torrent' as const, indexer: 'test', seeders: 10, size: 500_000_000, downloadUrl: 'magnet:?xt=urn:btih:aaa', indexerId: 10 }];
    const indexer = createStreamingIndexerService(results);
    const download = createMockDownloadOrchestrator();
    const log = createMockLogger();
    const broadcaster = { emit: vi.fn() };

    await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory, undefined, broadcaster as never);

    expect(indexer.getEnabledIndexers).toHaveBeenCalled();
    expect(indexer.searchAllStreaming).toHaveBeenCalled();
    expect(broadcaster.emit).toHaveBeenCalledWith('search_started', expect.objectContaining({ book_id: 1 }));
  });
});

describe('#392 searchAllWanted broadcaster wiring', () => {
  it('passes EventBroadcaster to searchAndGrabForBook — triggers streaming path', async () => {
    const settings = createMockSettingsService();
    const bookList = createMockBookListService([{ id: 1, title: 'Test Book', authors: [{ name: 'Author' }] }]);
    const results: SearchResult[] = [{ title: 'Test Book', protocol: 'torrent' as const, indexer: 'test', seeders: 10, size: 500_000_000, downloadUrl: 'magnet:?xt=urn:btih:aaa', indexerId: 10 }];
    const indexer = createStreamingIndexerService(results);
    const download = createMockDownloadOrchestrator();
    const log = createMockLogger();
    const broadcaster = { emit: vi.fn() };

    await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory, broadcaster as never);

    expect(indexer.getEnabledIndexers).toHaveBeenCalled();
    expect(indexer.searchAllStreaming).toHaveBeenCalled();
    expect(broadcaster.emit).toHaveBeenCalledWith('search_started', expect.objectContaining({ book_id: 1 }));
  });
});

describe('runSearchJob — narrator priority wiring (#439)', () => {
  // Same match-score band; narrator match competes with higher audio quality.
  const FAIR_SIZE = Math.round(79 * 10 * 1024 * 1024);
  const GOOD_SIZE = Math.round(200 * 10 * 1024 * 1024);
  const narratorMatch: SearchResult = {
    title: 'Book One', protocol: 'torrent', indexer: 'test', seeders: 10,
    size: FAIR_SIZE, downloadUrl: 'magnet:?xt=urn:btih:narrator', narrator: 'Kevin R. Free', matchScore: 0.9,
  };
  const qualityWin: SearchResult = {
    title: 'Book One', protocol: 'torrent', indexer: 'test', seeders: 10,
    size: GOOD_SIZE, downloadUrl: 'magnet:?xt=urn:btih:quality', narrator: 'Someone Else', matchScore: 0.9,
  };
  const wantedBooks = [
    { id: 1, title: 'Book One', duration: 600, authors: [{ name: 'Author' }], narrators: [{ name: 'Kevin R. Free' }] },
  ];

  it('accuracy mode grabs narrator-matched release over higher-quality non-match', async () => {
    const testLog = createMockLogger();
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60, searchPriority: 'accuracy' } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([qualityWin, narratorMatch]);
    const download = createMockDownloadOrchestrator();

    await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(testLog), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(download.grab).toHaveBeenCalledWith(expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:narrator' }));
  });

  it('quality mode grabs higher-quality non-match over narrator-matched release', async () => {
    const testLog = createMockLogger();
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60, searchPriority: 'quality' } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([narratorMatch, qualityWin]);
    const download = createMockDownloadOrchestrator();

    await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(testLog), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(download.grab).toHaveBeenCalledWith(expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:quality' }));
  });
});

describe('searchAllWanted — narrator priority wiring (#439)', () => {
  const FAIR_SIZE = Math.round(79 * 10 * 1024 * 1024);
  const GOOD_SIZE = Math.round(200 * 10 * 1024 * 1024);
  const wantedBooks = [
    { id: 1, title: 'Book One', duration: 600, authors: [{ name: 'Author' }], narrators: [{ name: 'Kevin R. Free' }] },
  ];

  it('accuracy mode grabs narrator-matched release in searchAllWanted', async () => {
    const testLog = createMockLogger();
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60, searchPriority: 'accuracy' } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([
      { title: 'Book One', protocol: 'torrent', indexer: 'test', seeders: 10, size: GOOD_SIZE, downloadUrl: 'magnet:?xt=urn:btih:quality', narrator: 'Someone Else', matchScore: 0.9 },
      { title: 'Book One', protocol: 'torrent', indexer: 'test', seeders: 10, size: FAIR_SIZE, downloadUrl: 'magnet:?xt=urn:btih:narrator', narrator: 'Kevin R. Free', matchScore: 0.9 },
    ]);
    const download = createMockDownloadOrchestrator();

    await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(testLog), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(download.grab).toHaveBeenCalledWith(expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:narrator' }));
  });
});

describe('runSearchJob — query-ladder cooldown (#2104)', () => {
  // This fixture's full ladder has exactly two rungs.
  const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
  const enabledSearch = () => createMockSettingsService({ search: { enabled: true, intervalMinutes: 360 } });
  const log = createMockLogger();

  const cycle = (indexer: IndexerSearchService, searchLadderCooldown: SearchLadderCooldown, retryBudget?: RetryBudget) =>
    runSearchJob(
      enabledSearch(),
      createMockBookListService(wantedBooks),
      indexer,
      createMockDownloadOrchestrator(),
      inject<FastifyBaseLogger>(log),
      createMockBlacklistService(),
      mockIndexer,
      mockEventHistory,
      retryBudget,
      undefined,
      searchLadderCooldown,
    );

  const queriesOf = (svc: IndexerSearchService) =>
    vi.mocked(svc.searchAllWithStatus).mock.calls.map((c) => c[0] as string);

  it('runs the full ladder on the exhausting cycle and rung 1 only on the next (AC20)', async () => {
    const searchLadderCooldown = new SearchLadderCooldown();

    const first = createMockIndexerService([]);
    await cycle(first, searchLadderCooldown);
    expect(queriesOf(first)).toEqual(['Book One Author A', 'book one']);

    const second = createMockIndexerService([]);
    await cycle(second, searchLadderCooldown);
    expect(queriesOf(second)).toEqual(['Book One Author A']);
  });

  // Keep cooldown off RetryBudget: resetAll() runs at every cycle entry.
  it('survives the per-cycle retryBudget.resetAll() (AC21)', async () => {
    const searchLadderCooldown = new SearchLadderCooldown();
    const retryBudget = new RetryBudget();
    const resetAll = vi.spyOn(retryBudget, 'resetAll');

    await cycle(createMockIndexerService([]), searchLadderCooldown, retryBudget);
    const second = createMockIndexerService([]);
    await cycle(second, searchLadderCooldown, retryBudget);

    expect(resetAll).toHaveBeenCalledTimes(2);
    expect(queriesOf(second)).toEqual(['Book One Author A']);
  });

  it('leaves searchAllWanted running the FULL ladder while a cooldown entry is live (AC34)', async () => {
    const searchLadderCooldown = new SearchLadderCooldown();
    await cycle(createMockIndexerService([]), searchLadderCooldown);

    const manual = createMockIndexerService([]);
    await searchAllWanted(
      enabledSearch(),
      createMockBookListService(wantedBooks),
      manual,
      createMockDownloadOrchestrator(),
      inject<FastifyBaseLogger>(log),
      createMockBlacklistService(),
      mockIndexer,
      mockEventHistory,
    );

    expect(queriesOf(manual)).toEqual(['Book One Author A', 'book one']);
  });
});

describe('runSearchJob — #2322 unsatisfied limit', () => {
  const atLimitResult = (overrides: Partial<SearchResult> = {}): SearchResult => ({
    title: 'MAM Release',
    protocol: 'torrent',
    indexer: 'MyAnonamouse',
    indexerId: 10,
    seeders: 10,
    downloadUrl: 'magnet:?xt=urn:btih:aaa',
    unsatisfied: { count: 150, limit: 150 },
    ...overrides,
  });

  const eventsOfType = (history: EventHistoryService, type: string) =>
    vi.mocked(history.create).mock.calls.filter((c) => (c[0] as { eventType: string }).eventType === type);

  it('grabs nothing and records the blocked event for a wanted book at the limit', async () => {
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService([{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }]);
    const indexer = createMockIndexerService([atLimitResult()]);
    const download = createMockDownloadOrchestrator();
    const eventHistory = { create: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as EventHistoryService;

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(createMockLogger()), createMockBlacklistService(), mockIndexer, eventHistory);

    // No grab and no failure marking, so the book is left exactly as the cycle found it: wanted.
    expect(download.grab).not.toHaveBeenCalled();
    expect(result).toEqual({ searched: 1, grabbed: 0 });
    expect(eventsOfType(eventHistory, 'grab_blocked_unsatisfied')).toHaveLength(1);
    expect(eventsOfType(eventHistory, 'grab_failed')).toHaveLength(0);
  });

  it('still grabs the best non-MAM release in the same cycle', async () => {
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService([{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }]);
    const indexer = createMockIndexerService([
      atLimitResult({ seeders: 99 }),
      { title: 'Prowlarr Release', protocol: 'torrent', indexer: 'Prowlarr', indexerId: 3, seeders: 5, downloadUrl: 'magnet:?xt=urn:btih:bbb' },
    ]);
    const download = createMockDownloadOrchestrator();
    const eventHistory = { create: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as EventHistoryService;

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(createMockLogger()), createMockBlacklistService(), mockIndexer, eventHistory);

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(expect.objectContaining({ title: 'Prowlarr Release' }));
    expect(eventsOfType(eventHistory, 'grab_blocked_unsatisfied')).toHaveLength(0);
  });

  it('leaves an unannotated result set entirely unchanged', async () => {
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService([{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }]);
    const { unsatisfied: _unsatisfied, ...unannotated } = atLimitResult();
    const indexer = createMockIndexerService([unannotated as SearchResult]);
    const download = createMockDownloadOrchestrator();
    const eventHistory = { create: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as EventHistoryService;

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(createMockLogger()), createMockBlacklistService(), mockIndexer, eventHistory);

    expect(result.grabbed).toBe(1);
    expect(eventHistory.create).not.toHaveBeenCalled();
  });
});

// #2310: the shared entry now bounds its own duration. These drive the real deadline by capturing
// the timer it arms (a hand-rolled setTimeout, so a globalThis spy does see it).
describe('search deadline expiry (#2310)', () => {
  const NEVER = () => new Promise<never>(() => { /* the stalled leaf */ });

  function captureDeadlineTimers() {
    const armed: Array<() => void> = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number, ...rest: unknown[]) => {
      if (delay !== SEARCH_DEADLINE_MS) return original(fn as never, delay as never, ...rest as never[]);
      armed.push(fn);
      // A real, never-firing handle so the production clearTimeout stays valid.
      const parked = original(() => { /* parked */ }, 2 ** 30);
      parked.unref();
      return parked;
    }) as never);
    return armed;
  }

  const fourBooks = () => [1, 2, 3, 4].map((id) => ({ id, title: `Book ${id}`, authors: [{ name: 'Author' }] }));
  const hit = () => withStatus([mockResult(10, 'magnet:?xt=urn:btih:aaa')]);

  beforeEach(() => {
    _resetSearchRegistryForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // The abandoned operations never settle, so their slots would leak into later suites.
    _resetSearchRegistryForTesting();
  });

  it('lets runSearchJob reach books 3 and 4 after book 2 expires, counting neither searched nor grabbed for it', async () => {
    const armed = captureDeadlineTimers();
    const log = createMockLogger();
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(fourBooks());
    const indexer = createMockIndexerService();
    vi.mocked(indexer.searchAllWithStatus)
      .mockResolvedValueOnce(hit())
      .mockImplementationOnce(NEVER)
      .mockResolvedValueOnce(hit())
      .mockResolvedValueOnce(hit());
    const download = createMockDownloadOrchestrator();

    const running = runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);
    await vi.waitFor(() => expect(armed).toHaveLength(2));
    armed[1]!();

    await expect(running).resolves.toEqual({ searched: 3, grabbed: 3 });
    expect(indexer.searchAllWithStatus).toHaveBeenCalledTimes(4);
  });

  it('logs the deadline shape from the scheduled catch, with budgetMs as a sibling field', async () => {
    const armed = captureDeadlineTimers();
    const log = createMockLogger();
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService([{ id: 8, title: 'Stalled', authors: [{ name: 'Author' }] }]);
    const indexer = createMockIndexerService();
    vi.mocked(indexer.searchAllWithStatus).mockImplementationOnce(NEVER);

    const running = runSearchJob(settings, bookList, indexer, createMockDownloadOrchestrator(), inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);
    await vi.waitFor(() => expect(armed).toHaveLength(1));
    armed[0]!();
    await running;

    const call = log.warn.mock.calls.find(([, message]) => message === 'Search abandoned at its deadline');
    expect(call).toBeDefined();
    const fields = call![0] as Record<string, unknown>;
    expect(fields).toMatchObject({ bookId: 8, title: 'Stalled', budgetMs: SEARCH_DEADLINE_MS });
    const serialized = fields.error as Record<string, unknown>;
    expect(serialized).not.toBeInstanceOf(Error);
    expect(Object.keys(serialized).sort()).toEqual(['message', 'stack', 'type']);
    expect(serialized.type).toBe('SearchDeadlineError');
  });

  it('keeps the ordinary scheduled failure log unchanged, with no budget field', async () => {
    const log = createMockLogger();
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService([{ id: 9, title: 'Broken', authors: [{ name: 'Author' }] }]);
    const indexer = createMockIndexerService();
    vi.mocked(indexer.searchAllWithStatus).mockRejectedValueOnce(new Error('Network error'));

    await runSearchJob(settings, bookList, indexer, createMockDownloadOrchestrator(), inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    const call = log.warn.mock.calls.find(([, message]) => message === 'Search failed for book');
    expect(call).toBeDefined();
    expect(call![0]).not.toHaveProperty('budgetMs');
  });

  it('counts an expired book as an error in searchAllWanted and keeps searching', async () => {
    const armed = captureDeadlineTimers();
    const log = createMockLogger();
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(fourBooks());
    const indexer = createMockIndexerService();
    vi.mocked(indexer.searchAllWithStatus)
      .mockResolvedValueOnce(hit())
      .mockImplementationOnce(NEVER)
      .mockResolvedValueOnce(hit())
      .mockResolvedValueOnce(hit());

    const running = searchAllWanted(settings, bookList, indexer, createMockDownloadOrchestrator(), inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);
    await vi.waitFor(() => expect(armed).toHaveLength(2));
    armed[1]!();

    await expect(running).resolves.toEqual({ searched: 3, grabbed: 3, skipped: 0, errors: 1 });
  });

  it('logs the deadline shape from the manual catch too', async () => {
    const armed = captureDeadlineTimers();
    const log = createMockLogger();
    const bookList = createMockBookListService([{ id: 21, title: 'Stalled', authors: [{ name: 'Author' }] }]);
    const indexer = createMockIndexerService();
    vi.mocked(indexer.searchAllWithStatus).mockImplementationOnce(NEVER);

    const running = searchAllWanted(createMockSettingsService(), bookList, indexer, createMockDownloadOrchestrator(), inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);
    await vi.waitFor(() => expect(armed).toHaveLength(1));
    armed[0]!();
    await running;

    const call = log.warn.mock.calls.find(([, message]) => message === 'Search abandoned at its deadline');
    expect(call).toBeDefined();
    expect(call![0]).toMatchObject({ bookId: 21, budgetMs: SEARCH_DEADLINE_MS });
  });

  it('keeps the ordinary manual failure log unchanged, with no budget field', async () => {
    const log = createMockLogger();
    const bookList = createMockBookListService([{ id: 22, title: 'Broken', authors: [{ name: 'Author' }] }]);
    const indexer = createMockIndexerService();
    vi.mocked(indexer.searchAllWithStatus).mockRejectedValueOnce(new Error('Network error'));

    await searchAllWanted(createMockSettingsService(), bookList, indexer, createMockDownloadOrchestrator(), inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    const call = log.warn.mock.calls.find(([, message]) => message === 'Search failed for book');
    expect(call).toBeDefined();
    expect(call![0]).not.toHaveProperty('budgetMs');
  });

  it('counts an already-in-flight book in searched and skipped, never in errors', async () => {
    const log = createMockLogger();
    const bookList = createMockBookListService([{ id: 31, title: 'Busy', authors: [{ name: 'Author' }] }]);
    const indexer = createMockIndexerService([mockResult(10, 'magnet:?xt=urn:btih:aaa')]);
    // Occupy book 31's slot exactly as a concurrent caller would.
    void withSearchDeadline({ budgetMs: 0, bookId: 31, log: inject<FastifyBaseLogger>(log) }, NEVER);

    const result = await searchAllWanted(createMockSettingsService(), bookList, indexer, createMockDownloadOrchestrator(), inject<FastifyBaseLogger>(log), createMockBlacklistService(), mockIndexer, mockEventHistory);

    expect(result).toEqual({ searched: 1, grabbed: 0, skipped: 1, errors: 0 });
    expect(indexer.searchAllWithStatus).not.toHaveBeenCalled();
  });
});
