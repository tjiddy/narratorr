import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createMockLogger, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { runRssJob, startRssJob } from './rss.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookService } from '../services/book.service.js';
import type { BookListService } from '../services/book-list.service.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { DownloadService } from '../services/download.service.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { SearchResult } from '../../core/index.js';

function createMockBookListService(wanted: unknown[] = []): BookListService {
  return inject<BookListService>({
    getAll: vi.fn().mockResolvedValue({ data: wanted, total: wanted.length }),
    getIdentifiers: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue({ counts: {}, authors: [], series: [], narrators: [] }),
  });
}

function createMockBookServices(wanted: unknown[] = [], monitored: unknown[] = []) {
  return {
    bookList: createMockBookListService(wanted),
    book: createMockBookService(monitored),
  };
}

function createMockBookService(monitored: unknown[] = []): BookService {
  return inject<BookService>({
    getMonitoredBooks: vi.fn().mockResolvedValue(monitored),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateStatus: vi.fn(),
    delete: vi.fn(),
    search: vi.fn(),
    findDuplicate: vi.fn(),
  });
}

function createMockIndexerService(rssResults: SearchResult[] = []): IndexerService {
  return inject<IndexerService>({
    getRssCapableIndexers: vi.fn().mockResolvedValue([
      { id: 1, name: 'TestNewznab', type: 'newznab', enabled: true, priority: 1, settings: {} },
    ]),
    pollRss: vi.fn().mockResolvedValue(rssResults),
    searchAll: vi.fn().mockResolvedValue([]),
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

function createMockBlacklistService(blacklisted: Set<string> = new Set()): BlacklistService {
  return inject<BlacklistService>({
    getBlacklistedHashes: vi.fn().mockResolvedValue(blacklisted),
    isBlacklisted: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    getAll: vi.fn(),
  });
}

/**
 * Create a mock search result with parsed author (as pollRss returns after parseReleaseNames).
 * Results from pollRss have title and author parsed separately.
 */
const makeResult = (title: string, author?: string, overrides: Partial<SearchResult> = {}): SearchResult => ({
  title,
  author,
  protocol: 'torrent',
  indexer: 'TestNewznab',
  downloadUrl: `magnet:?xt=urn:btih:${title.replace(/\s/g, '')}`,
  seeders: 10,
  size: 500 * 1024 * 1024,
  ...overrides,
});

const makeWantedBook = (id: number, title: string, author?: string) => ({
  id,
  title,
  author: author ? { name: author } : undefined,
  status: 'wanted' as const,
  duration: 600, // 10 hours in minutes
});

describe('runRssJob', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
  });

  // --- Polling ---

  it('returns zeros when RSS is disabled', async () => {
    const settings = createMockSettingsService({ rss: { enabled: false, intervalMinutes: 30 } });
    const { bookList, book } = createMockBookServices();
    const indexer = createMockIndexerService();
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result).toEqual({ polled: 0, matched: 0, grabbed: 0 });
    expect(bookList.getAll).not.toHaveBeenCalled();
  });

  it('polls RSS-capable indexers and collects results', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.polled).toBe(1);
    expect(indexer.getRssCapableIndexers).toHaveBeenCalled();
    expect(indexer.pollRss).toHaveBeenCalledTimes(1);
  });

  it('excludes non-RSS adapters (ABB) — only polls RSS-capable', async () => {
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices([makeWantedBook(1, 'Test', 'Author')]);
    const indexer = createMockIndexerService();
    (indexer.getRssCapableIndexers as Mock).mockResolvedValue([
      { id: 1, name: 'Newznab', type: 'newznab', enabled: true },
      { id: 2, name: 'Torznab', type: 'torznab', enabled: true },
    ]);
    (indexer.pollRss as Mock).mockResolvedValue([]);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(indexer.pollRss).toHaveBeenCalledTimes(2);
  });

  // --- Matching ---

  it('matches release to wanted book above 0.7 threshold and grabs', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1, source: 'rss' }),
    );
  });

  it('skips release below 0.7 match threshold', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('Cooking with Julia Child', 'Julia Child')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('skips release with no parseable title', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test', 'Author')];
    const rssResults = [makeResult('', undefined, { title: '' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
  });

  it('matches best-scoring book when item scores above threshold for multiple books', async () => {
    const wantedBooks = [
      makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson'),
      makeWantedBook(2, 'Words of Radiance', 'Brandon Sanderson'),
    ];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
    );
  });

  // --- Deduplication / mutex ---

  it('skips release already in download queue (grab mutex)', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    (download.grab as Mock).mockRejectedValueOnce(
      new Error('Book 1 already has an active download (id: 5)'),
    );
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Skipping RSS grab — book already has active download',
    );
  });

  // --- Upgrades ---

  it('triggers upgrade grab for monitored book with better quality', async () => {
    const monitoredBooks = [{
      id: 1,
      title: 'Monitored Book',
      author: { name: 'Author' },
      status: 'imported',
      path: '/library/monitored-book',
      monitorForUpgrades: true,
      audioTotalSize: 100 * 1024 * 1024,
      audioDuration: 3600,
      size: null,
      duration: null,
    }];
    const rssResults = [makeResult('Monitored Book', 'Author', { size: 500 * 1024 * 1024 })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices([], monitoredBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1, source: 'rss' }),
    );
  });

  it('skips upgrade when imported at equal/higher quality', async () => {
    const monitoredBooks = [{
      id: 1,
      title: 'Monitored Book',
      author: { name: 'Author' },
      status: 'imported',
      path: '/library/monitored-book',
      monitorForUpgrades: true,
      audioTotalSize: 500 * 1024 * 1024,
      audioDuration: 3600,
      size: null,
      duration: null,
    }];
    const rssResults = [makeResult('Monitored Book', 'Author', { size: 100 * 1024 * 1024 })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices([], monitoredBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
  });

  // --- Error handling ---

  it('continues polling remaining indexers when one throws', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService();
    (indexer.getRssCapableIndexers as Mock).mockResolvedValue([
      { id: 1, name: 'FailIndexer', type: 'newznab', enabled: true },
      { id: 2, name: 'GoodIndexer', type: 'torznab', enabled: true },
    ]);
    (indexer.pollRss as Mock)
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce([makeResult('Test Book', 'Author')]);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.polled).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ indexer: 'FailIndexer' }),
      'RSS poll failed for indexer',
    );
    expect(result.grabbed).toBe(1);
  });

  it('logs debug (not warn) when indexer returns empty results', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test', 'Author')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ indexer: 'TestNewznab' }),
      'RSS feed returned zero items',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('catches concurrent grab race and logs info', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    (download.grab as Mock).mockRejectedValueOnce(new Error('Concurrent grab conflict'));
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'RSS grab failed (possible concurrent race)',
    );
  });

  // --- Filter pipeline ---

  it('results pass through multipart Usenet filter', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book (1/5)', 'Author', { protocol: 'usenet' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('results pass through blacklist hash filter', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { infoHash: 'abc123' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService(new Set(['abc123']));

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('results pass through reject word filter', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book German Edition', 'Author')];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'German', requiredWords: '' },
    });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
  });

  it('results pass through required word filter', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book MP3', 'Author')];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: '', requiredWords: 'M4B' },
    });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
  });

  it('results pass through min seeders filter', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { seeders: 1 })];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      quality: { grabFloor: 0, minSeeders: 5, protocolPreference: 'none', rejectWords: '', requiredWords: '' },
    });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
  });

  it('grabs the best-ranked item (not just best match score) when multiple items match same book', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [
      makeResult('Test Book', 'Author', { size: 50 * 1024 * 1024, downloadUrl: 'magnet:low' }),
      makeResult('Test Book', 'Author', { size: 500 * 1024 * 1024, downloadUrl: 'magnet:high' }),
    ];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledTimes(1);
    // Best-ranked by quality (higher size = higher quality) should be grabbed
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:high' }),
    );
  });

  // --- Event recording ---

  it('grabs emit event-history entries with source rss', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'rss' }),
    );
  });

  // --- Edge cases ---

  it('completes with 0 grabbed when enabled but no wanted books', async () => {
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices([], []);
    const indexer = createMockIndexerService();
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result).toEqual({ polled: 0, matched: 0, grabbed: 0 });
    expect(indexer.pollRss).not.toHaveBeenCalled();
  });

  it('completes normally when all results filtered out by floor', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { size: 1000 })];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      quality: { grabFloor: 200, minSeeders: 0, protocolPreference: 'none', rejectWords: '', requiredWords: '' },
    });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
  });

  it('handles feed item matching book with no duration (grab floor skipped)', async () => {
    const wantedBooks = [{ ...makeWantedBook(1, 'Test Book', 'Author'), duration: null, audioDuration: null }];
    const rssResults = [makeResult('Test Book', 'Author')];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      quality: { grabFloor: 200, minSeeders: 0, protocolPreference: 'none', rejectWords: '', requiredWords: '' },
    });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    // Grab floor is skipped when no duration — result passes through
    expect(result.grabbed).toBe(1);
  });

  it('handles feed item matching book with no author (title-only scoring)', async () => {
    const wantedBooks = [{ ...makeWantedBook(1, 'Test Book'), author: undefined }];
    const rssResults = [makeResult('Test Book')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
  });
});

describe('startRssJob', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    log = createMockLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules next run using intervalMinutes from settings', async () => {
    const settings = createMockSettingsService({ rss: { enabled: false, intervalMinutes: 15 } });
    const { bookList, book } = createMockBookServices();
    const indexer = createMockIndexerService();
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    startRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    // scheduleNext reads settings then sets a setTimeout
    await vi.advanceTimersByTimeAsync(0);

    expect(settings.get).toHaveBeenCalledWith('rss');
    // After intervalMinutes elapses, runRssJob should be called
    expect(log.info).toHaveBeenCalledWith('RSS sync job scheduler started');

    // Advance past the 15-minute interval
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    // runRssJob was called (it reads settings again internally)
    expect((settings.get as Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('retries in 5 minutes when settings read fails', async () => {
    const settings = createMockSettingsService({ rss: { enabled: true } });
    (settings.get as Mock).mockRejectedValueOnce(new Error('DB connection lost'));
    // Second call succeeds (for the retry)
    (settings.get as Mock).mockResolvedValueOnce({ enabled: false, intervalMinutes: 30 });
    const { bookList, book } = createMockBookServices();
    const indexer = createMockIndexerService();
    const download = createMockDownloadService();
    const blacklist = createMockBlacklistService();

    startRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    // Let the first scheduleNext run and fail
    await vi.advanceTimersByTimeAsync(0);

    expect(log.error).toHaveBeenCalledWith(
      expect.any(Error),
      'Failed to read RSS interval, retrying in 5 minutes',
    );

    // Advance 5 minutes for the retry
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    // The retry should have read settings again
    expect((settings.get as Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
