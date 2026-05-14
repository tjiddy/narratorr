import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { runSearchJob, searchAllWanted } from './search.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookListService } from '../services/book-list.service.js';
import type { IndexerSearchService } from '../services/indexer-search.service.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { SearchResult } from '../../core/index.js';
import { DuplicateDownloadError } from '../services/download.service.js';
import { BYTES_PER_GB } from '../../shared/constants.js';

vi.mock('../utils/enrich-usenet-languages.js', () => ({
  enrichUsenetLanguages: vi.fn(),
}));

function createMockBookListService(books: unknown[] = []): BookListService {
  return inject<BookListService>({
    getAll: vi.fn().mockResolvedValue({ data: books, total: books.length }),
    getIdentifiers: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue({ counts: {}, authors: [], series: [], narrators: [] }),
  });
}

function createMockIndexerService(results: SearchResult[] = []): IndexerSearchService {
  return inject<IndexerSearchService>({
    searchAll: vi.fn().mockResolvedValue(results),
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
    expect(vi.mocked(indexer.searchAll).mock.calls[0]![0]).toBe('Book One Author A');
    expect(vi.mocked(indexer.searchAll).mock.calls[1]![0]).toBe('Book Two Author B');
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
    expect(vi.mocked(indexer.searchAll).mock.calls[0]![0]).toBe('Anonymous Work');
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

    // Bare-string rejection — would serialize to {} via Pino without serializeError wrapping
    vi.mocked(download.grab).mockRejectedValueOnce('string error');

    await runSearchJob(settings, bookList, indexer, download, inject<FastifyBaseLogger>(log), createMockBlacklistService());

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
    const wantedBooks = [{ id: 1, title: 'Book One', authors: [{ name: 'Author A' }], duration: 3600 }];
    const settings = createMockSettingsService({
      search: { enabled: true, intervalMinutes: 60 },
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 },
    });
    const bookList = createMockBookListService(wantedBooks);
    const oversizedResult: SearchResult = { ...mockResult(10, 'magnet:?xt=urn:btih:big'), size: 10 * BYTES_PER_GB };
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
    expect(vi.mocked(indexer.searchAll).mock.calls[0]![0]).toBe('Book One Author A');
    expect(vi.mocked(indexer.searchAll).mock.calls[1]![0]).toBe('Book Two Author B');
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

    expect(vi.mocked(indexer.searchAll).mock.calls[0]![0]).toBe('Anonymous Work');
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
    // #852 — non-Error rejections must be wrapped via serializeError before logging.
    // #863 — tryGrab now normalizes non-Error rejections to Error at catch, so the
    // serialized shape is `type: 'Error'` with a real stack instead of `type: 'string'`.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: 1,
        error: expect.objectContaining({ message: 'some string error', type: 'Error', stack: expect.any(String) }),
      }),
      'Grab failed for book',
    );
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
    // #852 — Error rejections must be wrapped via serializeError, producing { message, type, stack }
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

// ============================================================================
// #392 — Caller wiring: broadcaster passed to searchAndGrabForBook
// ============================================================================

function createStreamingIndexerService(results: SearchResult[] = []): IndexerSearchService {
  return inject<IndexerSearchService>({
    searchAll: vi.fn().mockResolvedValue(results),
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

