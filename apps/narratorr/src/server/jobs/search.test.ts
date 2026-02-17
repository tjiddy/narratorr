import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger } from '../__tests__/helpers.js';
import { selectBestResult, runSearchJob } from './search.js';
import type { SettingsService } from '../services/settings.service.js';
import type { BookService } from '../services/book.service.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { DownloadService } from '../services/download.service.js';
import type { SearchResult } from '@narratorr/core';

function createMockSettingsService(searchSettings = { enabled: true, intervalMinutes: 60, autoGrab: false }): SettingsService {
  return {
    get: vi.fn().mockResolvedValue(searchSettings),
    getAll: vi.fn(),
    set: vi.fn(),
    update: vi.fn(),
  } as unknown as SettingsService;
}

function createMockBookService(books: unknown[] = []): BookService {
  return {
    getAll: vi.fn().mockResolvedValue(books),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateStatus: vi.fn(),
    delete: vi.fn(),
    search: vi.fn(),
    findDuplicate: vi.fn(),
  } as unknown as BookService;
}

function createMockIndexerService(results: SearchResult[] = []): IndexerService {
  return {
    searchAll: vi.fn().mockResolvedValue(results),
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getAdapter: vi.fn(),
    test: vi.fn(),
    testConfig: vi.fn(),
  } as unknown as IndexerService;
}

function createMockDownloadService(): DownloadService {
  return {
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
  } as unknown as DownloadService;
}

const mockResult = (seeders: number, downloadUrl?: string): SearchResult => ({
  title: 'Test Book',
  protocol: 'torrent',
  indexer: 'abb',
  seeders,
  downloadUrl,
});

describe('selectBestResult', () => {
  it('returns null for empty array', () => {
    expect(selectBestResult([])).toBeNull();
  });

  it('returns result with highest seeders', () => {
    const results = [
      mockResult(5, 'magnet:?xt=urn:btih:aaa'),
      mockResult(20, 'magnet:?xt=urn:btih:bbb'),
      mockResult(10, 'magnet:?xt=urn:btih:ccc'),
    ];
    const best = selectBestResult(results);
    expect(best).not.toBeNull();
    expect(best!.seeders).toBe(20);
  });

  it('skips results without downloadUrl', () => {
    const results = [
      mockResult(100, undefined),
      mockResult(5, 'magnet:?xt=urn:btih:aaa'),
    ];
    const best = selectBestResult(results);
    expect(best).not.toBeNull();
    expect(best!.seeders).toBe(5);
  });

  it('returns null when all results lack downloadUrl', () => {
    const results = [mockResult(10, undefined), mockResult(20, undefined)];
    expect(selectBestResult(results)).toBeNull();
  });
});

describe('runSearchJob', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
  });

  it('returns zeros when search is disabled', async () => {
    const settings = createMockSettingsService({ enabled: false, intervalMinutes: 60, autoGrab: false });
    const books = createMockBookService();
    const indexer = createMockIndexerService();
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, log as any);

    expect(result).toEqual({ searched: 0, grabbed: 0 });
    expect(books.getAll).not.toHaveBeenCalled();
  });

  it('searches each wanted book', async () => {
    const wantedBooks = [
      { id: 1, title: 'Book One', author: { name: 'Author A' } },
      { id: 2, title: 'Book Two', author: { name: 'Author B' } },
    ];
    const settings = createMockSettingsService({ enabled: true, intervalMinutes: 60, autoGrab: false });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, log as any);

    expect(result.searched).toBe(2);
    expect(indexer.searchAll).toHaveBeenCalledTimes(2);
    expect((indexer.searchAll as any).mock.calls[0][0]).toBe('Book One Author A');
    expect((indexer.searchAll as any).mock.calls[1][0]).toBe('Book Two Author B');
  });

  it('auto-grabs when enabled and results found', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', author: { name: 'Author A' } }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService({ enabled: true, intervalMinutes: 60, autoGrab: true });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, log as any);

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadUrl: 'magnet:?xt=urn:btih:aaa',
        bookId: 1,
      }),
    );
  });

  it('does not grab when autoGrab is disabled', async () => {
    const wantedBooks = [{ id: 1, title: 'Book One', author: { name: 'Author A' } }];
    const searchResults = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    const settings = createMockSettingsService({ enabled: true, intervalMinutes: 60, autoGrab: false });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService(searchResults);
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, log as any);

    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('returns searched count but zero grabbed when no indexer returns results', async () => {
    const wantedBooks = [
      { id: 1, title: 'Obscure Book', author: { name: 'Unknown Author' } },
      { id: 2, title: 'Another Rare Book', author: { name: 'Nobody' } },
    ];
    const settings = createMockSettingsService({ enabled: true, intervalMinutes: 60, autoGrab: true });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService([]); // no results for any search
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, log as any);

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
    const settings = createMockSettingsService({ enabled: true, intervalMinutes: 60, autoGrab: true });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const results = [mockResult(10, 'magnet:?xt=urn:btih:aaa')];
    (indexer.searchAll as any)
      .mockResolvedValueOnce(results)     // Book A succeeds with results
      .mockRejectedValueOnce(new Error('Network error'))  // Book B throws
      .mockResolvedValueOnce(results);    // Book C succeeds with results
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, log as any);

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
    const settings = createMockSettingsService({ enabled: true, intervalMinutes: 60, autoGrab: false });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, log as any);

    expect(result.searched).toBe(1);
    // Query should just be the title without author
    expect((indexer.searchAll as any).mock.calls[0][0]).toBe('Anonymous Work');
  });

  it('continues on per-book failure', async () => {
    const wantedBooks = [
      { id: 1, title: 'Failing Book', author: { name: 'Author' } },
      { id: 2, title: 'Good Book', author: { name: 'Author' } },
    ];
    const settings = createMockSettingsService({ enabled: true, intervalMinutes: 60, autoGrab: false });
    const books = createMockBookService(wantedBooks);
    const indexer = createMockIndexerService([]);
    (indexer.searchAll as any)
      .mockRejectedValueOnce(new Error('Indexer down'))
      .mockResolvedValueOnce([]);
    const download = createMockDownloadService();

    const result = await runSearchJob(settings, books, indexer, download, log as any);

    expect(result.searched).toBe(1); // only second book counted
    expect(log.warn).toHaveBeenCalled();
  });
});
