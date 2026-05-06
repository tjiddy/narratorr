import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockLogger, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { runRssJob } from './rss.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookService } from '../services/book.service.js';
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

import { enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
const mockEnrichUsenet = vi.mocked(enrichUsenetLanguages);

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

function createMockIndexerService(rssResults: SearchResult[] = []): IndexerSearchService {
  return inject<IndexerSearchService>({
    getRssCapableIndexers: vi.fn().mockResolvedValue([
      { id: 1, name: 'TestNewznab', type: 'newznab', enabled: true, priority: 1, settings: {} },
    ]),
    pollRss: vi.fn().mockResolvedValue(rssResults),
    searchAll: vi.fn().mockResolvedValue([]),
    searchAllStreaming: vi.fn().mockResolvedValue([]),
    getEnabledIndexers: vi.fn().mockResolvedValue([]),
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

function createMockBlacklistService(blacklisted: Set<string> = new Set()): BlacklistService {
  return inject<BlacklistService>({
    getBlacklistedHashes: vi.fn().mockResolvedValue(blacklisted),
    getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: blacklisted, blacklistedGuids: new Set() }),
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
  ...(author !== undefined && { author }),
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
    (download.grab as Mock).mockRejectedValueOnce(
      new DuplicateDownloadError('Book 1 already has an active download (id: 5)', 'ACTIVE_DOWNLOAD_EXISTS'),
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
  });

  it('filters oversized RSS items via maxDownloadSize and logs quality gate', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [
      makeResult('Test Book', 'Author', { size: 10 * BYTES_PER_GB, downloadUrl: 'magnet:oversized' }),
    ];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 },
    });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      { inputCount: 1, outputCount: 0 },
      'Quality gate filtering applied',
    );
  });

  it('forwards minDownloadSize from settings: drops undersized RSS items before grab', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [
      makeResult('Test Book', 'Author', { size: 5 * 1024 * 1024, downloadUrl: 'magnet:tinyspam' }),
    ];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50, maxDownloadSize: 0 },
    });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Test Book',
        reason: 'below-min-size',
        sizeBytes: 5 * 1024 * 1024,
        minBytes: 50 * 1024 * 1024,
      }),
      'Quality filter dropped result',
    );
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
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
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
  });
});

describe('rss tests — GUID blacklist filtering', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
  });

  // ===== #248 — GUID blacklist filtering in RSS =====

  describe('RSS job — GUID blacklist filtering', () => {
    it('filters out results with blacklisted guid', async () => {
      const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
      const rssResults = [makeResult('Test Book', 'Author', { guid: 'guid-bad' })];
      const settings = createMockSettingsService({ rss: { enabled: true } });
      const { bookList, book } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService();
      (blacklist.getBlacklistedIdentifiers as Mock).mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set(['guid-bad']) });

      const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

      expect(result.grabbed).toBe(0);
      expect(download.grab).not.toHaveBeenCalled();
    });

    it('filters out results with blacklisted infoHash (existing behavior)', async () => {
      const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
      const rssResults = [makeResult('Test Book', 'Author', { infoHash: 'hash-bad', guid: 'guid-ok' })];
      const settings = createMockSettingsService({ rss: { enabled: true } });
      const { bookList, book } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService();
      (blacklist.getBlacklistedIdentifiers as Mock).mockResolvedValue({ blacklistedHashes: new Set(['hash-bad']), blacklistedGuids: new Set() });

      const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

      expect(result.grabbed).toBe(0);
      expect(download.grab).not.toHaveBeenCalled();
    });

    it('passes through usenet results with no infoHash and no guid', async () => {
      const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
      const rssResults = [makeResult('Test Book', 'Author', { protocol: 'usenet' })];
      const settings = createMockSettingsService({ rss: { enabled: true } });
      const { bookList, book } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService();

      const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

      // Result has no infoHash and no guid, so blacklist check should not be called
      expect(blacklist.getBlacklistedIdentifiers).not.toHaveBeenCalled();
      // Usenet with no seeders still passes through if minSeeders is 0
      expect(result.grabbed).toBe(1);
    });
  });

  // ===== #386 — metadata.languages wiring in RSS job =====

  it('reads metadata.languages and uses it for quality filtering', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson')];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      metadata: { audibleRegion: 'us', languages: ['english', 'french'] },
    });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    // settingsService.get('metadata') must be called to get languages for filterAndRankResults
    expect(settings.get).toHaveBeenCalledWith('metadata');
    expect(settings.get).toHaveBeenCalledWith('quality');
  });

  it('languages filter excludes non-matching language RSS results from grab', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const englishResult = makeResult('The Way of Kings', 'Brandon Sanderson', {
      language: 'english',
      downloadUrl: 'magnet:?xt=urn:btih:english',
    });
    const frenchResult = makeResult('The Way of Kings', 'Brandon Sanderson', {
      language: 'french',
      downloadUrl: 'magnet:?xt=urn:btih:french',
    });
    const settings = createMockSettingsService({
      rss: { enabled: true },
      metadata: { audibleRegion: 'us', languages: ['english'] },
    });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService([frenchResult, englishResult]);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    // Only the English result should be grabbed; the French one is filtered out
    expect(download.grab).toHaveBeenCalledTimes(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:english' }),
    );
  });

  it('languages filter blocks all results when none match configured languages', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const frenchResult = makeResult('The Way of Kings', 'Brandon Sanderson', {
      language: 'french',
      downloadUrl: 'magnet:?xt=urn:btih:french',
    });
    const settings = createMockSettingsService({
      rss: { enabled: true },
      metadata: { audibleRegion: 'us', languages: ['english'] },
    });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService([frenchResult]);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    // French-only result filtered out → no grab
    expect(download.grab).not.toHaveBeenCalled();
    expect(result.grabbed).toBe(0);
  });

  it('forwards indexerId from best RSS result to downloadOrchestrator.grab', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson', { indexerId: 55 })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ indexerId: 55 }),
    );
  });

  it('omits indexerId when RSS result has no indexerId', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    const grabCall = vi.mocked(download.grab).mock.calls[0]![0];
    expect(grabCall).not.toHaveProperty('indexerId');
  });

  // #439 — RSS ranking honors searchPriority
  it('accuracy mode grabs narrator-matched release over higher-quality non-match via RSS', async () => {
    const FAIR_SIZE = Math.round(79 * 10 * 1024 * 1024);
    const GOOD_SIZE = Math.round(200 * 10 * 1024 * 1024);
    const wanted = [{ ...makeWantedBook(1, 'Book One', 'Author'), narrators: [{ name: 'Kevin R. Free' }], audioDuration: 36000 }];
    const { bookList, book } = createMockBookServices(wanted);
    const settings = createMockSettingsService({
      rss: { enabled: true, intervalMinutes: 30 },
      search: { searchPriority: 'accuracy' },
    });
    const indexer = createMockIndexerService();
    vi.mocked(indexer.pollRss).mockResolvedValue([
      makeResult('Book One', 'Author', { size: GOOD_SIZE, downloadUrl: 'magnet:?xt=urn:btih:quality', narrator: 'Someone Else', matchScore: 0.9 }),
      makeResult('Book One', 'Author', { size: FAIR_SIZE, downloadUrl: 'magnet:?xt=urn:btih:narrator', narrator: 'Kevin R. Free', matchScore: 0.9 }),
    ]);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:narrator' }),
    );
  });
});

describe('#502 runRssJob — enrichment before filtering', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
    mockEnrichUsenet.mockReset();
  });

  it('usenet RSS item with reject word in NZB name is filtered out before grab', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/1' })];
    const settings = createMockSettingsService({ rss: { enabled: true }, quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'pack', requiredWords: '' } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    // Simulate enrichment populating nzbName with reject word
    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Way of Kings-Hörbuch-Pack.rar';
      }
    });

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('usenet RSS item with multi-part marker in nzbName but clean title/rawTitle → filtered out', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/1' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    // Enrichment populates nzbName with multi-part marker (title/rawTitle are clean)
    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'The Way of Kings (01 of 30).rar';
      }
    });

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('usenet RSS item with multi-part marker in rawTitle → still filtered (regression)', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { protocol: 'usenet' as const, rawTitle: 'Test Book (3/10)', downloadUrl: 'http://nzb.test/2' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('torrent RSS item skips multi-part filter regardless of title content', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    // Torrent with multi-part pattern in title — should NOT be filtered
    const rssResults = [makeResult('Test Book (1/5)', 'Author', { protocol: 'torrent' as const })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalled();
  });

  it('multi-part check prefers nzbName over rawTitle when both present', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    // rawTitle is clean, but nzbName has multi-part marker
    const rssResults = [makeResult('Test Book', 'Author', {
      protocol: 'usenet' as const,
      rawTitle: 'Test Book [Audiobook]',
      downloadUrl: 'http://nzb.test/3',
    })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Test Book (02 of 15).rar';
      }
    });

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('empty nzbName falls through to rawTitle (|| operator, not ??)', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    // rawTitle has multi-part marker; nzbName will be empty string (should fall through)
    const rssResults = [makeResult('Test Book', 'Author', {
      protocol: 'usenet' as const,
      rawTitle: 'Test Book (1/8)',
      downloadUrl: 'http://nzb.test/4',
    })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    // Enrichment sets empty string nzbName (failed NZB parse)
    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = '';
      }
    });

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('single-part usenet post (total === 1) with nzbName is NOT filtered', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/5' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    // Enrichment sets nzbName with single-part marker (1 of 1)
    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Test Book (01 of 01).rar';
      }
    });

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalled();
  });

  it('usenet result with pre-populated language — enrichment skips, multi-part uses rawTitle fallback', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    // Pre-populated language means enrichment won't set nzbName; rawTitle has multi-part marker
    const rssResults = [makeResult('Test Book', 'Author', {
      protocol: 'usenet' as const,
      rawTitle: 'Test Book (2/10)',
      language: 'English',
      downloadUrl: 'http://nzb.test/6',
    })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    // Enrichment does nothing (language already set)
    mockEnrichUsenet.mockImplementation(async () => {});

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('blacklisted RSS items are never passed to enrichUsenetLanguages', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { protocol: 'usenet' as const, infoHash: 'blacklisted123', downloadUrl: 'http://nzb.test/7' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService(new Set(['blacklisted123']));

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(mockEnrichUsenet).not.toHaveBeenCalled();
  });

  it('enrichment only receives matched candidates, not unmatched below-threshold items', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [
      // Matched: title matches wanted book above threshold
      makeResult('The Way of Kings', 'Brandon Sanderson', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/matched' }),
      // Unmatched: completely different title, will score below 0.7
      makeResult('Totally Unrelated Book XYZ', 'Someone Else', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/unmatched' }),
    ];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    // enrichUsenetLanguages called exactly once (for the matched book's candidates)
    expect(mockEnrichUsenet).toHaveBeenCalledTimes(1);
    // The call should contain only the matched result, not the unmatched one
    const enrichedResults = mockEnrichUsenet.mock.calls[0]![0];
    expect(enrichedResults).toHaveLength(1);
    expect(enrichedResults[0]!.title).toBe('The Way of Kings');
    expect(result.grabbed).toBe(1);
  });

  it('matched count includes books whose candidates were all multi-part rejected', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/8' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    // Enrichment populates nzbName with multi-part marker
    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Test Book (05 of 20).rar';
      }
    });

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    // Book was matched but all candidates rejected by multi-part filter
    expect(result.matched).toBe(1);
    expect(result.grabbed).toBe(0);
  });

  it('grabbed count excludes multi-part-rejected items', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book A', 'Author'), makeWantedBook(2, 'Test Book B', 'Author')];
    const rssResults = [
      // Book A: clean result, should be grabbed
      makeResult('Test Book A', 'Author', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/9' }),
      // Book B: will get multi-part nzbName, should NOT be grabbed
      makeResult('Test Book B', 'Author', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/10' }),
    ];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList, book } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    // Only Book B gets multi-part nzbName
    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet' && r.title === 'Test Book B') {
          r.nzbName = 'Test Book B (03 of 12).rar';
        }
      }
    });

    const result = await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

    expect(result.matched).toBe(2);
    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledTimes(1);
  });

  // ── #932 F2 — Caller-level logging assertions for the RSS path ──────────
  describe('caller-level debug logging (#932 F2)', () => {
    it('emits the blacklist drop log when an RSS item is filtered by the blacklist', async () => {
      const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
      const rssResults = [
        makeResult('The Way of Kings', 'Brandon Sanderson', { infoHash: 'badhash1' }),
      ];
      const settings = createMockSettingsService({ rss: { enabled: true } });
      const { bookList, book } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService(new Set(['badhash1']));

      await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'blacklist-match', matchedRule: 'hash' }),
        'Blacklisted result dropped',
      );
    });

    it('emits the multi-part drop log with matchedPattern when RSS item is rejected', async () => {
      const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
      const rssResults = [
        makeResult('Test Book', 'Author', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/100' }),
      ];
      const settings = createMockSettingsService({ rss: { enabled: true } });
      const { bookList, book } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService();

      mockEnrichUsenet.mockImplementation(async (results) => {
        for (const r of results) r.nzbName = 'Test Book (07 of 30).rar';
      });

      await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'multi-part-detected',
          matchedPattern: expect.any(String),
        }),
        'Multi-part Usenet result rejected',
      );
    });

    it('emits the language-undetermined passed log when RSS rejects on language', async () => {
      const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
      const rssResults = [
        makeResult('Test Book', 'Author'),
      ];
      const settings = createMockSettingsService({
        rss: { enabled: true },
        metadata: { languages: ['english'] },
      });
      const { bookList, book } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService();

      await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'language-undetermined', dropped: false }),
        'Language filter passed undetected result',
      );
    });

    it('emits a quality filter drop log when RSS reject-words filter rejects an item', async () => {
      const wantedBooks = [makeWantedBook(1, 'Test Book M4B', 'Author')];
      const rssResults = [
        makeResult('Test Book M4B BANNED', 'Author'),
      ];
      const settings = createMockSettingsService({
        rss: { enabled: true },
        quality: {
          grabFloor: 0,
          minSeeders: 0,
          protocolPreference: 'none',
          rejectWords: 'banned',
          requiredWords: '',
          maxDownloadSize: 0,
        },
      });
      const { bookList, book } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService();

      await runRssJob(settings, bookList, book, indexer, download, blacklist, inject<FastifyBaseLogger>(log));

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'reject-word-match', matchedWord: 'banned' }),
        'Quality filter dropped result',
      );
    });
  });
});
