import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { runSearchJob, runUpgradeSearchJob } from './search.js';
import type { FastifyBaseLogger } from 'fastify';
import type { SettingsService } from '../services/settings.service.js';
import type { BookService } from '../services/book.service.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { DownloadService } from '../services/download.service.js';
import type { SearchResult } from '../../core/index.js';

function createMockSettingsService(overrides?: { search?: unknown; quality?: unknown }): SettingsService {
  const searchSettings = overrides?.search ?? { enabled: true, intervalMinutes: 60 };
  const qualitySettings = overrides?.quality ?? { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' };
  return inject<SettingsService>({
    get: vi.fn().mockImplementation((cat: string) => {
      if (cat === 'quality') return Promise.resolve(qualitySettings);
      return Promise.resolve(searchSettings);
    }),
    getAll: vi.fn(),
    set: vi.fn(),
    update: vi.fn(),
  });
}

function createMockBookService(books: unknown[] = [], monitoredBooks: unknown[] = []): BookService {
  return inject<BookService>({
    getAll: vi.fn().mockResolvedValue(books),
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

function createMockDownloadService(): DownloadService {
  return inject<DownloadService>({
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

  it('returns zeros when search is disabled', async () => {
    const settings = createMockSettingsService({ search: { enabled: false, intervalMinutes: 60 } });
    const books = createMockBookService();
    const indexer = createMockIndexerService();
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result).toEqual({ searched: 0, grabbed: 0 });
    expect(books.getAll).not.toHaveBeenCalled();
  });

  it('searches each wanted book', async () => {
    const wantedBooks = [
      { id: 1, title: 'Book One', author: { name: 'Author A' } },
      { id: 2, title: 'Book Two', author: { name: 'Author B' } },
    ];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(2);
    expect(indexer.searchAll).toHaveBeenCalledTimes(2);
    expect(vi.mocked(indexer.searchAll).mock.calls[0][0]).toBe('Book One Author A');
    expect(vi.mocked(indexer.searchAll).mock.calls[1][0]).toBe('Book Two Author B');
  });

  it('grabs best result when search finds matches', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', author: { name: 'Author A' } }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

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
      { id: 1, title: 'Obscure Book', author: { name: 'Unknown Author' } },
      { id: 2, title: 'Another Rare Book', author: { name: 'Nobody' } },
    ];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService([]); // no results for any search
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

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
      { id: 1, title: 'Book A', author: { name: 'Author' } },
      { id: 2, title: 'Book B', author: { name: 'Author' } },
      { id: 3, title: 'Book C', author: { name: 'Author' } },
    ];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const results = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    vi.mocked(indexer.searchAll)
      .mockResolvedValueOnce(results)     // Book A succeeds with results
      .mockRejectedValueOnce(new Error('Network error'))  // Book B throws
      .mockResolvedValueOnce(results);    // Book C succeeds with results
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

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
      { id: 1, title: 'Anonymous Work', author: null },
    ];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    // Query should just be the title without author
    expect(vi.mocked(indexer.searchAll).mock.calls[0][0]).toBe('Anonymous Work');
  });

  it('skips grab when book already has active download', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', author: { name: 'Author A' } }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadService();

    // grab throws duplicate error
    vi.mocked(download.grab).mockRejectedValueOnce(
      new Error('Book 1 already has an active download (id: 5)'),
    );

    const result = await runSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Skipping grab — book already has active download',
    );
  });

  it('re-throws non-duplicate grab errors to outer catch', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', author: { name: 'Author A' } }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadService();

    // grab throws a non-duplicate error
    vi.mocked(download.grab).mockRejectedValueOnce(
      new Error('No download client configured'),
    );

    const result = await runSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    // Outer catch handles it — search succeeded but grab failed, so searched is counted
    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Search failed for book',
    );
  });

  it('continues on per-book failure', async () => {
    const wantedBooks = [
      { id: 1, title: 'Failing Book', author: { name: 'Author' } },
      { id: 2, title: 'Good Book', author: { name: 'Author' } },
    ];
    const settings = createMockSettingsService({ search: { enabled: true, intervalMinutes: 60 } });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService([]);
    vi.mocked(indexer.searchAll)
      .mockRejectedValueOnce(new Error('Indexer down'))
      .mockResolvedValueOnce([]);
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1); // only second book counted
    expect(log.warn).toHaveBeenCalled();
  });

  it('applies word filtering via filterAndRankResults (reject words)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', author: { name: 'Author A' } }];
    const settings = createMockSettingsService({
      search: { enabled: true, intervalMinutes: 60 },
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'German', requiredWords: '' },
    });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService([
      { ...mockResult(10, 'magnet:?xt=urn:btih:aaa'), title: 'German Edition' },
      { ...mockResult(10, 'magnet:?xt=urn:btih:bbb'), title: 'English Edition' },
    ]);
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'English Edition' }),
    );
  });

  it('applies word filtering via filterAndRankResults (required words)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', author: { name: 'Author A' } }];
    const settings = createMockSettingsService({
      search: { enabled: true, intervalMinutes: 60 },
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: '', requiredWords: 'M4B' },
    });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService([
      { ...mockResult(10, 'magnet:?xt=urn:btih:aaa'), title: 'Book MP3' },
      { ...mockResult(10, 'magnet:?xt=urn:btih:bbb'), title: 'Book M4B' },
    ]);
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Book M4B' }),
    );
  });

  it('applies quality filtering to search results (min seeders)', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', author: { name: 'Author A' }, duration: 3600 }];
    // minSeeders = 5 should filter out the low-seeder result
    const settings = createMockSettingsService({
      search: { enabled: true, intervalMinutes: 60 },
      quality: { grabFloor: 0, minSeeders: 5, protocolPreference: 'none' },
    });
    const books = createMockBookService(wantedBooks);
    // Only result has 2 seeders — below min
    const indexer = createMockIndexerService([mockResult(2, 'magnet:?xt=urn:btih:aaa')]);
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
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
      author: { name: 'Author' },
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
    const books = createMockBookService([], [makeMonitoredBook()]);
    const indexer = createMockIndexerService();
    const download = createMockDownloadService();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result).toEqual({ searched: 0, grabbed: 0 });
    expect(books.getMonitoredBooks).not.toHaveBeenCalled();
  });

  it('returns zeros when no monitored books', async () => {
    const settings = createMockSettingsService();
    const books = createMockBookService([], []);
    const indexer = createMockIndexerService();
    const download = createMockDownloadService();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result).toEqual({ searched: 0, grabbed: 0 });
  });

  it('skips books without path', async () => {
    const book = makeMonitoredBook({ path: null });
    const settings = createMockSettingsService();
    const books = createMockBookService([], [book]);
    const indexer = createMockIndexerService();
    const download = createMockDownloadService();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result).toEqual({ searched: 0, grabbed: 0 });
    expect(indexer.searchAll).not.toHaveBeenCalled();
  });

  it('skips books without duration', async () => {
    const book = makeMonitoredBook({ audioDuration: null, duration: null });
    const settings = createMockSettingsService();
    const books = createMockBookService([], [book]);
    const indexer = createMockIndexerService();
    const download = createMockDownloadService();

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
    const books = createMockBookService([], [book]);
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
    const download = createMockDownloadService();

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
    const books = createMockBookService([], [book]);
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
    const download = createMockDownloadService();

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
    const books = createMockBookService([], [book]);
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
    const download = createMockDownloadService();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('continues on per-book failure', async () => {
    const book1 = makeMonitoredBook({ id: 1, title: 'Book A' });
    const book2 = makeMonitoredBook({ id: 2, title: 'Book B' });
    const settings = createMockSettingsService();
    const books = createMockBookService([], [book1, book2]);
    const indexer = createMockIndexerService([]);
    vi.mocked(indexer.searchAll)
      .mockRejectedValueOnce(new Error('Indexer down'))
      .mockResolvedValueOnce([]);
    const download = createMockDownloadService();

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
    const books = createMockBookService([], [book]);
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
    const download = createMockDownloadService();

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
    const books = createMockBookService([], [book]);
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
    const download = createMockDownloadService();

    const result = await runUpgradeSearchJob(settings, books, indexer, download, inject<FastifyBaseLogger>(log));

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('handles active download error silently', async () => {
    // Existing book: 100 MB/hr
    const book = makeMonitoredBook();
    const settings = createMockSettingsService();
    const books = createMockBookService([], [book]);
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
    const download = createMockDownloadService();

    vi.mocked(download.grab).mockRejectedValueOnce(
      new Error('Book 1 already has an active download (id: 5)'),
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
});
