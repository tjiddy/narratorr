import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { runSearchJob, runUpgradeSearchJob, searchAllWanted } from './search.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookService } from '../services/book.service.js';
import type { BookListService } from '../services/book-list.service.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { SearchResult } from '../../core/index.js';
import { DuplicateDownloadError } from '../services/download.service.js';

vi.mock('../utils/enrich-usenet-languages.js', () => ({
  enrichUsenetLanguages: vi.fn(),
}));

import { enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
const mockEnrichUsenet = vi.mocked(enrichUsenetLanguages);

function createMockBookListService(books: unknown[] = []): BookListService {
  return inject<BookListService>({
    getAll: vi.fn().mockResolvedValue({ data: books, total: books.length }),
    getIdentifiers: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue({ counts: {}, authors: [], series: [], narrators: [] }),
  });
}

function createMockBookService(monitoredBooks: unknown[] = []): BookService {
  return inject<BookService>({
    getMonitoredBooks: vi.fn().mockResolvedValue(monitoredBooks),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateStatus: vi.fn(),
    delete: vi.fn(),
    search: vi.fn(),
    findDuplicate: vi.fn(),
  });
}

function createMockIndexerService(results: SearchResult[] = []): IndexerService {
  return inject<IndexerService>({
    searchAll: vi.fn().mockResolvedValue(results),
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getAdapter: vi.fn(),
    test: vi.fn(),
    testConfig: vi.fn(),
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
    updateStatus: vi.fn(),
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

const mockResult = (seeders: number, downloadUrl?: string): SearchResult => ({
  title: 'Test Book',
  protocol: 'torrent',
  indexer: 'abb',
  seeders,
  downloadUrl,
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

    await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), retryBudget);

    expect(resetAllSpy).toHaveBeenCalledOnce();
  });

  it('returns zeros when search is disabled', async () => {
    const settings = createMockSettingsService({ search: { enabled: false, intervalMinutes: 60 } });
    const bookList = createMockBookListService();
    const indexer = createMockIndexerService();
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

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

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.searched).toBe(2);
    expect(indexer.searchAll).toHaveBeenCalledTimes(2);
    expect(vi.mocked(indexer.searchAll).mock.calls[0][0]).toBe('Book One Author A');
    expect(vi.mocked(indexer.searchAll).mock.calls[1][0]).toBe('Book Two Author B');
  });

  it('grabs best result when search finds matches', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

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
    const indexer = createMockIndexerService([]); // no results for any search
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.searched).toBe(2);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
    // Should log "No results found" for each book
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
    vi.mocked(indexer.searchAll)
      .mockResolvedValueOnce(results)     // Book A succeeds with results
      .mockRejectedValueOnce(new Error('Network error'))  // Book B throws
      .mockResolvedValueOnce(results);    // Book C succeeds with results
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    // Book A searched + grabbed, Book B failed (not counted), Book C searched + grabbed
    expect(result.searched).toBe(2);
    expect(result.grabbed).toBe(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 2 }),
      'Search failed for book',
    );
    // All three books should have been attempted
    expect(indexer.searchAll).toHaveBeenCalledTimes(3);
  });

  it('handles book with no author gracefully', async () => {
    const wantedBooks = [
      { id: 1, title: 'Anonymous Work', authors: null },
    ];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.searched).toBe(1);
    // Query should just be the title without author
    expect(vi.mocked(indexer.searchAll).mock.calls[0][0]).toBe('Anonymous Work');
  });

  it('skips grab when book already has active download', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    // grab throws duplicate error
    vi.mocked(download.grab).mockRejectedValueOnce(
      new DuplicateDownloadError('Book 1 already has an active download (id: 5)', 'ACTIVE_DOWNLOAD_EXISTS'),
    );

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Skipping grab — book already has active download',
    );
  });

  it('re-throws non-duplicate grab errors to outer catch', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    // grab throws a non-duplicate error
    vi.mocked(download.grab).mockRejectedValueOnce(
      new Error('No download client configured'),
    );

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    // Search succeeded but grab failed — searched is still counted
    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
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
    vi.mocked(indexer.searchAll)
      .mockRejectedValueOnce(new Error('Indexer down'))
      .mockResolvedValueOnce([]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.searched).toBe(1); // only second book counted
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

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

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

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Book M4B' }),
    );
  });

  it('applies quality filtering to search results (min seeders)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }], duration: 3600 }];
    // minSeeders = 5 should filter out the low-seeder result
    const settings = createMockSettingsService({
      search: { enabled: true, intervalMinutes: 60 },
      quality: { grabFloor: 0, minSeeders: 5, protocolPreference: 'none' },
    });
    const bookList = createMockBookListService(wantedBooks);
    // Only result has 2 seeders — below min
    const indexer = createMockIndexerService([mockResult(2, 'magnet:?xt=urn:btih:aaa')]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('applies quality filtering to search results (maxDownloadSize) and logs quality gate', async () => {
    const GB = 1_073_741_824;
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }], duration: 3600 }];
    const settings = createMockSettingsService({
      search: { enabled: true, intervalMinutes: 60 },
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 },
    });
    const bookList = createMockBookListService(wantedBooks);
    const oversizedResult: SearchResult = { ...mockResult(10, 'magnet:?xt=urn:btih:big'), size: 10 * GB };
    const indexer = createMockIndexerService([oversizedResult]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

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

    await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

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
      size: 500000,
    };
    const englishResult: SearchResult = {
      title: 'Book One',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      downloadUrl: 'magnet:?xt=urn:btih:english',
      language: 'english',
      size: 500000,
    };
    const indexer = createMockIndexerService([frenchResult, englishResult]);
    const download = createMockDownloadOrchestrator();

    const result = await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    // Only the English result should be grabbed — French is filtered out
    expect(download.grab).toHaveBeenCalledTimes(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:english' }),
    );
    expect(result.grabbed).toBe(1);
  });
});

describe('runUpgradeSearchJob', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
  });

  // A monitored book with audio metadata for quality calculations
  // audioDuration is in seconds, audioTotalSize in bytes
  function makeMonitoredBook(overrides: Record<string, unknown> = {}) {
    return {
      id: 1,
      title: 'Monitored Book',
      authors: [{ name: 'Author' }],
      status: 'imported',
      path: '/library/monitored-book',
      monitorForUpgrades: true,
      // ~100 MB/hr quality: 100MB over 1 hour (3600s)
      audioTotalSize: 100 * 1024 * 1024,
      audioDuration: 3600,
      size: null,
      duration: null,
      ...overrides,
    };
  }

  it('returns zeros when search is disabled', async () => {
    const settings = createMockSettingsService({ search: { enabled: false, intervalMinutes: 60 } });
    const books = createMockBookService([makeMonitoredBook()]);
    const indexer = createMockIndexerService();
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result).toEqual({ searched: 0, grabbed: 0 });
    expect(books.getMonitoredBooks).not.toHaveBeenCalled();
  });

  it('returns zeros when no monitored books', async () => {
    const settings = createMockSettingsService();
    const books = createMockBookService([]);
    const indexer = createMockIndexerService();
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result).toEqual({ searched: 0, grabbed: 0 });
  });

  it('skips books without path', async () => {
    const book = makeMonitoredBook({ path: null });
    const settings = createMockSettingsService();
    const books = createMockBookService([book]);
    const indexer = createMockIndexerService();
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result).toEqual({ searched: 0, grabbed: 0 });
    expect(indexer.searchAll).not.toHaveBeenCalled();
  });

  it('skips books without duration', async () => {
    const book = makeMonitoredBook({ audioDuration: null, duration: null });
    const settings = createMockSettingsService();
    const books = createMockBookService([book]);
    const indexer = createMockIndexerService();
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result).toEqual({ searched: 0, grabbed: 0 });
    expect(indexer.searchAll).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Skipping upgrade search — no duration',
    );
  });

  it('grabs when result quality is higher than existing', async () => {
    // Existing book: 100 MB/hr (100MB over 3600s)
    const book = makeMonitoredBook();
    const settings = createMockSettingsService();
    const books = createMockBookService([book]);
    // Search result: 500 MB over 3600s = 500 MB/hr — clearly higher
    const higherResult: SearchResult = {
      title: 'Better Quality',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      size: 500 * 1024 * 1024,
      downloadUrl: 'magnet:?xt=urn:btih:upgrade',
    };
    const indexer = createMockIndexerService([higherResult]);
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadUrl: 'magnet:?xt=urn:btih:upgrade',
        bookId: 1,
      }),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Upgrade grabbed',
    );
  });

  it('does NOT grab when result quality is lower or similar', async () => {
    // Existing book: 100 MB/hr (100MB over 3600s)
    const book = makeMonitoredBook();
    const settings = createMockSettingsService();
    const books = createMockBookService([book]);
    // Search result: 90 MB over 3600s = 90 MB/hr — similar/lower quality
    const similarResult: SearchResult = {
      title: 'Similar Quality',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      size: 90 * 1024 * 1024,
      downloadUrl: 'magnet:?xt=urn:btih:similar',
    };
    const indexer = createMockIndexerService([similarResult]);
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('does NOT grab when result is below grab floor', async () => {
    // Existing book: 50 MB/hr (50MB over 3600s)
    const book = makeMonitoredBook({ audioTotalSize: 50 * 1024 * 1024 });
    // Grab floor at 200 MB/hr
    const settings = createMockSettingsService({ quality: { grabFloor: 200, minSeeders: 0, protocolPreference: 'none' } });
    const books = createMockBookService([book]);
    // Search result: 100 MB over 3600s = 100 MB/hr — higher than existing but below floor
    const result100: SearchResult = {
      title: 'Above Existing But Below Floor',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      size: 100 * 1024 * 1024,
      downloadUrl: 'magnet:?xt=urn:btih:belowfloor',
    };
    const indexer = createMockIndexerService([result100]);
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('continues on per-book failure', async () => {
    const book1 = makeMonitoredBook({ id: 1, title: 'Book A' });
    const book2 = makeMonitoredBook({ id: 2, title: 'Book B' });
    const settings = createMockSettingsService();
    const books = createMockBookService([book1, book2]);
    const indexer = createMockIndexerService([]);
    vi.mocked(indexer.searchAll)
      .mockRejectedValueOnce(new Error('Indexer down'))
      .mockResolvedValueOnce([]);
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    // First book failed, second succeeded
    expect(result.searched).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Upgrade search failed for book',
    );
    expect(indexer.searchAll).toHaveBeenCalledTimes(2);
  });

  it('applies word filtering via filterAndRankResults (reject words)', async () => {
    const book = makeMonitoredBook();
    const settings = createMockSettingsService({
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'German', requiredWords: '' },
    });
    const books = createMockBookService([book]);
    // Higher quality result but with reject word
    const germanResult: SearchResult = {
      title: 'German Better Quality',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      size: 500 * 1024 * 1024,
      downloadUrl: 'magnet:?xt=urn:btih:german',
    };
    const indexer = createMockIndexerService([germanResult]);
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('applies word filtering via filterAndRankResults (required words)', async () => {
    const book = makeMonitoredBook();
    const settings = createMockSettingsService({
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: '', requiredWords: 'M4B' },
    });
    const books = createMockBookService([book]);
    // Higher quality result without required word
    const mp3Result: SearchResult = {
      title: 'Better Quality MP3',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      size: 500 * 1024 * 1024,
      downloadUrl: 'magnet:?xt=urn:btih:mp3',
    };
    const indexer = createMockIndexerService([mp3Result]);
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('handles active download error silently', async () => {
    // Existing book: 100 MB/hr
    const book = makeMonitoredBook();
    const settings = createMockSettingsService();
    const books = createMockBookService([book]);
    // Higher quality result
    const higherResult: SearchResult = {
      title: 'Better Quality',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      size: 500 * 1024 * 1024,
      downloadUrl: 'magnet:?xt=urn:btih:upgrade',
    };
    const indexer = createMockIndexerService([higherResult]);
    const download = createMockDownloadOrchestrator();

    vi.mocked(download.grab).mockRejectedValueOnce(
      new DuplicateDownloadError('Book 1 already has an active download (id: 5)', 'ACTIVE_DOWNLOAD_EXISTS'),
    );

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Skipping upgrade grab — active download exists',
    );
    // Should NOT have logged a warning (it was handled silently)
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('forwards indexerId from best search result to downloadOrchestrator.grab', async () => {
    const book = makeMonitoredBook();
    const settings = createMockSettingsService();
    const books = createMockBookService([book]);
    const higherResult: SearchResult = {
      title: 'Better Quality',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      size: 500 * 1024 * 1024,
      downloadUrl: 'magnet:?xt=urn:btih:upgrade',
      indexerId: 99,
    };
    const indexer = createMockIndexerService([higherResult]);
    const download = createMockDownloadOrchestrator();

    await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ indexerId: 99 }),
    );
  });

  it('languages filter excludes non-matching upgrade candidates', async () => {
    const book = makeMonitoredBook();
    const settings = createMockSettingsService({
      metadata: { audibleRegion: 'us', languages: ['english'] },
    });
    const books = createMockBookService([book]);
    // Two upgrade candidates: French (higher quality but wrong language) and English (good quality)
    const frenchUpgrade: SearchResult = {
      title: 'Monitored Book',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      size: 300 * 1024 * 1024, // 300 MB/hr — higher than existing 100 MB/hr
      downloadUrl: 'magnet:?xt=urn:btih:french-upgrade',
      language: 'french',
    };
    const englishUpgrade: SearchResult = {
      title: 'Monitored Book',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      size: 200 * 1024 * 1024, // 200 MB/hr — still higher than existing 100 MB/hr
      downloadUrl: 'magnet:?xt=urn:btih:english-upgrade',
      language: 'english',
    };
    const indexer = createMockIndexerService([frenchUpgrade, englishUpgrade]);
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    // French upgrade filtered out — only English upgrade grabbed
    expect(download.grab).toHaveBeenCalledTimes(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:english-upgrade' }),
    );
    expect(result.grabbed).toBe(1);
  });

  // #439 — upgrade search honors searchPriority
  it('accuracy mode grabs narrator-matched upgrade over higher-quality non-match upgrade', async () => {
    // Existing: 100 MB/hr (100MB over 3600s). Both candidates are upgrades.
    const book = makeMonitoredBook({ narrators: [{ name: 'Kevin R. Free' }] });
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60, searchPriority: 'accuracy' } });
    const books = createMockBookService([book]);
    const narratorUpgrade: SearchResult = {
      title: 'Narrator Match', protocol: 'torrent', indexer: 'test', seeders: 10,
      size: 200 * 1024 * 1024, downloadUrl: 'magnet:?xt=urn:btih:narrator', narrator: 'Kevin R. Free', matchScore: 0.9,
    };
    const qualityUpgrade: SearchResult = {
      title: 'Higher Quality', protocol: 'torrent', indexer: 'test', seeders: 10,
      size: 400 * 1024 * 1024, downloadUrl: 'magnet:?xt=urn:btih:quality', narrator: 'Someone Else', matchScore: 0.9,
    };
    const indexer = createMockIndexerService([qualityUpgrade, narratorUpgrade]);
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:narrator' }),
    );
  });

  it('quality mode grabs higher-quality upgrade over narrator-matched upgrade', async () => {
    const book = makeMonitoredBook({ narrators: [{ name: 'Kevin R. Free' }] });
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60, searchPriority: 'quality' } });
    const books = createMockBookService([book]);
    const narratorUpgrade: SearchResult = {
      title: 'Narrator Match', protocol: 'torrent', indexer: 'test', seeders: 10,
      size: 200 * 1024 * 1024, downloadUrl: 'magnet:?xt=urn:btih:narrator', narrator: 'Kevin R. Free', matchScore: 0.9,
    };
    const qualityUpgrade: SearchResult = {
      title: 'Higher Quality', protocol: 'torrent', indexer: 'test', seeders: 10,
      size: 400 * 1024 * 1024, downloadUrl: 'magnet:?xt=urn:btih:quality', narrator: 'Someone Else', matchScore: 0.9,
    };
    const indexer = createMockIndexerService([narratorUpgrade, qualityUpgrade]);
    const download = createMockDownloadOrchestrator();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:quality' }),
    );
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

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.searched).toBe(2);
    expect(indexer.searchAll).toHaveBeenCalledTimes(2);
    expect(vi.mocked(indexer.searchAll).mock.calls[0][0]).toBe('Book One Author A');
    expect(vi.mocked(indexer.searchAll).mock.calls[1][0]).toBe('Book Two Author B');
  });

  it('grabs the best ranked result per book', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa'), mockResult(5, 'magnet:?xt=urn:btih:bbb')];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:aaa', bookId: 1 }),
    );
  });

  // #197 — DuplicateDownloadError instanceof catch (ERR-1)
  it('skips books where grab throws DuplicateDownloadError — increments skipped', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();
    vi.mocked(download.grab).mockRejectedValueOnce(new DuplicateDownloadError('Book 1 already has an active download (id: 5)', 'ACTIVE_DOWNLOAD_EXISTS'));

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

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
    vi.mocked(indexer.searchAll)
      .mockResolvedValueOnce(results)
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(results);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.searched).toBe(2);
    expect(result.grabbed).toBe(2);
    expect(result.errors).toBe(1);
    expect(indexer.searchAll).toHaveBeenCalledTimes(3);
  });

  it('does NOT check searchSettings.enabled — manual trigger always runs', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const settings = createMockSettingsService({ search: { enabled: false, intervalMinutes: 60 } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([mockResult(10, 'magnet:?xt=urn:btih:aaa')]);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

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
    vi.mocked(indexer.searchAll)
      .mockResolvedValueOnce(results) // Book A — grab succeeds
      .mockResolvedValueOnce(results) // Book B — grab fails (active download)
      .mockResolvedValueOnce(results); // Book C — grab succeeds
    const download = createMockDownloadOrchestrator();
    vi.mocked(download.grab)
      .mockResolvedValueOnce({ id: 1 } as never)
      .mockRejectedValueOnce(new DuplicateDownloadError('already has an active download', 'ACTIVE_DOWNLOAD_EXISTS'))
      .mockResolvedValueOnce({ id: 2 } as never);

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result).toEqual({ searched: 3, grabbed: 2, skipped: 1, errors: 0 });
  });

  it('filters results below grab floor (no grab attempted)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author' }], duration: 36000 }];
    // size=1000 bytes, duration=36000s → very low MB/hr, should be filtered out
    const searchResults: SearchResult[] = [{ title: 'Test', protocol: 'torrent', indexer: 'abb', seeders: 10, downloadUrl: 'magnet:?aaa', size: 1000 }];
    const settings = createMockSettingsService({ quality: { grabFloor: 100, minSeeders: 0, protocolPreference: 'none' } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('grabFloor=0 disables quality filtering (all results eligible)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author' }], duration: 36000 }];
    const searchResults: SearchResult[] = [{ title: 'Test', protocol: 'torrent', indexer: 'abb', seeders: 10, downloadUrl: 'magnet:?aaa', size: 1000 }];
    const settings = createMockSettingsService({ quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.grabbed).toBe(1);
  });

  it('results without downloadUrl are skipped (not grabbable)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author' }] }];
    const searchResults = [mockResult(10, undefined)]; // no downloadUrl
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('returns zeros when no wanted books exist', async () => {
    const settings = createMockSettingsService();
    const bookList = createMockBookListService([]);
    const indexer = createMockIndexerService();
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

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
    vi.mocked(download.grab).mockRejectedValue(new DuplicateDownloadError('already has an active download', 'ACTIVE_DOWNLOAD_EXISTS'));

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

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

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.searched).toBe(2);
    expect(result.grabbed).toBe(0);
  });

  it('book with author=null — query uses title only', async () => {
    const wantedBooks = [{ id: 1, title: 'Anonymous Work', authors: null }];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadOrchestrator();

    await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(vi.mocked(indexer.searchAll).mock.calls[0][0]).toBe('Anonymous Work');
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
    vi.mocked(indexer.searchAll)
      .mockResolvedValueOnce(results) // Book A — grab succeeds
      .mockRejectedValueOnce(new Error('Timeout')) // Book B — search fails
      .mockResolvedValueOnce(results) // Book C — active download
      .mockResolvedValueOnce([]); // Book D — no results
    const download = createMockDownloadOrchestrator();
    vi.mocked(download.grab)
      .mockResolvedValueOnce({ id: 1 } as never) // Book A
      .mockRejectedValueOnce(new DuplicateDownloadError('already has an active download', 'ACTIVE_DOWNLOAD_EXISTS')); // Book C

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result).toEqual({ searched: 3, grabbed: 1, skipped: 1, errors: 1 });
  });

  it('non-Error thrown from grab — not treated as DuplicateDownloadError (instanceof fails for non-Error)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author' }] }];
    const settings = createMockSettingsService();
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([mockResult(10, 'magnet:?aaa')]);
    const download = createMockDownloadOrchestrator();
    vi.mocked(download.grab).mockRejectedValueOnce('some string error');

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(1);
  });

  // ===== #386 — metadata.languages wiring =====

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

    await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    // settingsService.get('metadata') must be called to get languages
    expect(settings.get).toHaveBeenCalledWith('metadata');
    expect(settings.get).toHaveBeenCalledWith('quality');
  });

  it('languages filter causes non-matching language results to be skipped', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }] }];
    const settings = createMockSettingsService({
      metadata: { audibleRegion: 'us', languages: ['english'] },
    });
    const bookList = createMockBookListService(wantedBooks);
    // Only a French result — should be filtered out by language, so nothing is grabbed
    const frenchResult: SearchResult = {
      title: 'Book One',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      downloadUrl: 'magnet:?xt=urn:btih:french',
      language: 'french',
      size: 500000,
    };
    const indexer = createMockIndexerService([frenchResult]);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    // French result filtered out → no grab
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
      size: 500000,
    };
    const frenchResult: SearchResult = {
      title: 'Book One',
      protocol: 'torrent',
      indexer: 'abb',
      seeders: 10,
      downloadUrl: 'magnet:?xt=urn:btih:french',
      language: 'french',
      size: 500000,
    };
    const indexer = createMockIndexerService([frenchResult, englishResult]);
    const download = createMockDownloadOrchestrator();

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    // Only the English result should be grabbed
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

    const result = await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

    // Search succeeded but grab failed — searched is counted, errors incremented
    expect(result).toEqual({ searched: 1, grabbed: 0, skipped: 0, errors: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Grab failed for book',
    );
  });
});

// ============================================================================
// #392 — Caller wiring: broadcaster passed to searchAndGrabForBook
// ============================================================================

function createStreamingIndexerService(results: SearchResult[] = []): IndexerService {
  return inject<IndexerService>({
    searchAll: vi.fn().mockResolvedValue(results),
    searchAllStreaming: vi.fn().mockImplementation(async (_q: string, _o: unknown, _c: Map<number, AbortController>, callbacks: { onComplete: (id: number, name: string, count: number, ms: number) => void }) => {
      callbacks.onComplete(10, 'MAM', results.length, 500);
      return results;
    }),
    getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getAdapter: vi.fn(),
    test: vi.fn(),
    testConfig: vi.fn(),
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

    await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), undefined, broadcaster as never);

    // When broadcaster is passed, searchAndGrabForBook uses streaming path
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

    await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService(), broadcaster as never);

    expect(indexer.getEnabledIndexers).toHaveBeenCalled();
    expect(indexer.searchAllStreaming).toHaveBeenCalled();
    expect(broadcaster.emit).toHaveBeenCalledWith('search_started', expect.objectContaining({ book_id: 1 }));
  });
});

describe('runSearchJob — narrator priority wiring (#439)', () => {
  // Two candidates in the same match-score band:
  // - Fair-quality narrator match (79 MB/hr for 10h book = ~828 MB)
  // - Good-quality non-match (200 MB/hr for 10h book = ~2097 MB)
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
    { id: 1, title: 'Book One', duration: 36000, authors: [{ name: 'Author' }], narrators: [{ name: 'Kevin R. Free' }] },
  ];

  it('accuracy mode grabs narrator-matched release over higher-quality non-match', async () => {
    const testLog = createMockLogger();
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60, searchPriority: 'accuracy' } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([qualityWin, narratorMatch]);
    const download = createMockDownloadOrchestrator();

    await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(testLog), createMockBlacklistService());

    expect(download.grab).toHaveBeenCalledWith(expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:narrator' }));
  });

  it('quality mode grabs higher-quality non-match over narrator-matched release', async () => {
    const testLog = createMockLogger();
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60, searchPriority: 'quality' } });
    const bookList = createMockBookListService(wantedBooks);
    const indexer = createMockIndexerService([narratorMatch, qualityWin]);
    const download = createMockDownloadOrchestrator();

    await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(testLog), createMockBlacklistService());

    expect(download.grab).toHaveBeenCalledWith(expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:quality' }));
  });
});

describe('searchAllWanted — narrator priority wiring (#439)', () => {
  const FAIR_SIZE = Math.round(79 * 10 * 1024 * 1024);
  const GOOD_SIZE = Math.round(200 * 10 * 1024 * 1024);
  const wantedBooks = [
    { id: 1, title: 'Book One', duration: 36000, authors: [{ name: 'Author' }], narrators: [{ name: 'Kevin R. Free' }] },
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

    await searchAllWanted(settings, bookList, indexer, download, inject<FastifyBaseLogger>(testLog), createMockBlacklistService());

    expect(download.grab).toHaveBeenCalledWith(expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:narrator' }));
  });
});

describe('#502 runUpgradeSearchJob — enrichment before filtering', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
    mockEnrichUsenet.mockReset();
  });

  function makeMonitoredBook(overrides: Record<string, unknown> = {}) {
    return {
      id: 1, title: 'Monitored Book', authors: [{ name: 'Author' }],
      status: 'imported', path: '/library/monitored-book', monitorForUpgrades: true,
      audioTotalSize: 100 * 1024 * 1024, audioDuration: 3600, size: null, duration: null,
      ...overrides,
    };
  }

  it('calls enrichUsenetLanguages before filterAndRankResults', async () => {
    const book = makeMonitoredBook();
    const settings = createMockSettingsService();
    const books = createMockBookService([book]);
    const usenetResult: SearchResult = {
      title: 'Better Quality', protocol: 'usenet', indexer: 'drunkslug',
      size: 500 * 1024 * 1024, downloadUrl: 'http://nzb.test/1',
    };
    const indexer = createMockIndexerService([usenetResult]);
    const download = createMockDownloadOrchestrator();

    await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(mockEnrichUsenet).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ protocol: 'usenet' })]),
      expect.anything(),
    );
  });

  it('usenet result with reject word in NZB name is filtered out before grab', async () => {
    const book = makeMonitoredBook();
    const settings = createMockSettingsService({
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'pack', requiredWords: '' },
    });
    const books = createMockBookService([book]);
    const usenetResult: SearchResult = {
      title: 'Clean Title', protocol: 'usenet', indexer: 'drunkslug',
      size: 500 * 1024 * 1024, downloadUrl: 'http://nzb.test/1',
    };
    const indexer = createMockIndexerService([usenetResult]);
    const download = createMockDownloadOrchestrator();

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Stephen King-Hörbuch-Pack.rar';
      }
    });

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });
});
