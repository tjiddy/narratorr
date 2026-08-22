import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockLogger, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { runRssJob } from './rss.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookListService } from '../services/book-list.service.js';
import type { IndexerSearchService } from '../services/indexer-search.service.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { SearchResult } from '@core/index.js';
import { DuplicateDownloadError } from '../services/download.service.js';
import { BYTES_PER_GB } from '@shared/constants.js';
import { IndexerError } from '@core/indexers/errors.js';

vi.mock('../utils/enrich-usenet-languages.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/enrich-usenet-languages.js')>()),
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

function createMockBookServices(wanted: unknown[] = []) {
  return {
    bookList: createMockBookListService(wanted),
  };
}

function createMockIndexerService(rssResults: SearchResult[] = []): IndexerSearchService {
  return inject<IndexerSearchService>({
    getRssCapableIndexers: vi.fn().mockResolvedValue([
      { id: 1, name: 'TestNewznab', type: 'newznab', enabled: true, priority: 1, settings: {} },
    ]),
    pollRss: vi.fn().mockResolvedValue({ results: rssResults }),
    searchAll: vi.fn().mockResolvedValue([]),
    searchAllStreaming: vi.fn().mockResolvedValue([]),
    getEnabledIndexers: vi.fn().mockResolvedValue([]),
  });
}

const mockIndexer = {
  getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
} as unknown as IndexerService;

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

// pollRss supplies title and author as separately parsed fields.
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
  duration: 600, // minutes
});

describe('runRssJob', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
  });

  it('returns zeros when RSS is disabled', async () => {
    const settings = createMockSettingsService({ rss: { enabled: false, intervalMinutes: 30 } });
    const { bookList } = createMockBookServices();
    const indexer = createMockIndexerService();
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result).toEqual({ polled: 0, skipped: 0, matched: 0, grabbed: 0 });
    expect(bookList.getAll).not.toHaveBeenCalled();
  });

  it('polls RSS-capable indexers and collects results', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.polled).toBe(1);
    expect(indexer.getRssCapableIndexers).toHaveBeenCalled();
    expect(indexer.pollRss).toHaveBeenCalledTimes(1);
  });

  it('excludes non-RSS adapters (ABB) — only polls RSS-capable', async () => {
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices([makeWantedBook(1, 'Test', 'Author')]);
    const indexer = createMockIndexerService();
    (indexer.getRssCapableIndexers as Mock).mockResolvedValue([
      { id: 1, name: 'Newznab', type: 'newznab', enabled: true },
      { id: 2, name: 'Torznab', type: 'torznab', enabled: true },
    ]);
    (indexer.pollRss as Mock).mockResolvedValue({ results: [] });
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(indexer.pollRss).toHaveBeenCalledTimes(2);
  });

  it('matches release to wanted book above 0.7 threshold and grabs', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1, source: 'rss' }),
    );
  });

  // Pins the existing floor decision through resolveBookQualityInputs.
  it('filters out a below-floor RSS candidate (10h book, 100MB release, 30 MB/h floor) (#1797 AC1)', async () => {
    const HUNDRED_MB = 100 * 1024 * 1024;
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson', { size: HUNDRED_MB })];
    const settings = createMockSettingsService({ rss: { enabled: true }, quality: { grabFloor: 30, minSeeders: 0 } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  // Conflicting values isolate audioDuration ?? duration*60 precedence.
  it('resolves audioDuration (seconds) over duration on the RSS path (#1797 AC5)', async () => {
    const HUNDRED_MB = 100 * 1024 * 1024;
    const wantedBooks = [{
      id: 1,
      title: 'The Way of Kings',
      author: { name: 'Brandon Sanderson' },
      status: 'wanted' as const,
      duration: 1,
      audioDuration: 36000,
    }];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson', { size: HUNDRED_MB })];
    const settings = createMockSettingsService({ rss: { enabled: true }, quality: { grabFloor: 30, minSeeders: 0 } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('forwards isFreeleech=true from matched RSS result to grab call (#1156 F2)', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson', { isFreeleech: true })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1, isFreeleech: true }),
    );
  });

  it('omits isFreeleech from grab call when matched RSS result does not set it (#1156 F2)', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    const grabCall = (download.grab as Mock).mock.calls[0]![0];
    expect(grabCall).not.toHaveProperty('isFreeleech');
  });

  it('skips release below 0.7 match threshold', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('Cooking with Julia Child', 'Julia Child')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('skips release with no parseable title', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test', 'Author')];
    const rssResults = [makeResult('', undefined, { title: '' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
  });

  it('matches best-scoring book when item scores above threshold for multiple books', async () => {
    const wantedBooks = [
      makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson'),
      makeWantedBook(2, 'Words of Radiance', 'Brandon Sanderson'),
    ];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
    );
  });

  it('skips release already in download queue (grab mutex)', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    (download.grab as Mock).mockRejectedValueOnce(
      new DuplicateDownloadError('Book 1 already has an active download (id: 5)', 'ACTIVE_DOWNLOAD_EXISTS', { active: { title: 'A Book', count: 1 } }),
    );
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Skipping RSS grab — book already has a blocking download or import',
    );
  });

  it('does not consider imported books in RSS candidate set', async () => {
    const wantedBooks = [makeWantedBook(1, 'Wanted Book', 'Author')];
    const rssResults = [makeResult('Some Imported Book', 'Other Author')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('continues polling remaining indexers when one throws', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService();
    (indexer.getRssCapableIndexers as Mock).mockResolvedValue([
      { id: 1, name: 'FailIndexer', type: 'newznab', enabled: true },
      { id: 2, name: 'GoodIndexer', type: 'torznab', enabled: true },
    ]);
    (indexer.pollRss as Mock)
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce({ results: [makeResult('Test Book', 'Author')] });
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

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
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService([]);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

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
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    (download.grab as Mock).mockRejectedValueOnce(new Error('Concurrent grab conflict'));
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'RSS grab failed (possible concurrent race)',
    );
  });

  /**
   * #2420 test 47 — the RSS surface's answer to a failed grab is to advance to the NEXT BOOK, not
   * to try another release for the same book. The pre-existing race test cannot see that: it has
   * one book and one release, so "advance to the next book", "try the runner-up" and "abandon the
   * cycle" are all indistinguishable. Two books × two releases separates all three.
   */
  it('advances to the next book when a grab fails, without trying the same book\'s runner-up', async () => {
    const detailsUrl = 'https://audiobookbay.test/audio-books/murder-in-the-new-forest/';
    const abbGuid = 'abb:/audio-books/murder-in-the-new-forest/';
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author'), makeWantedBook(2, 'Other Book', 'Author')];
    const rssResults = [
      makeResult('Test Book', 'Author', { downloadUrl: `abb-details://${detailsUrl}`, guid: abbGuid, indexer: 'AudioBookBay' }),
      makeResult('Test Book', 'Author', { downloadUrl: `abb-details://${detailsUrl}runner-up/`, guid: `${abbGuid}runner-up/`, indexer: 'AudioBookBay' }),
      makeResult('Other Book', 'Author'),
      makeResult('Other Book', 'Author', { downloadUrl: 'magnet:?xt=urn:btih:otherrunnerup' }),
    ];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    // Only book 1's grab fails, and it fails the way a grab-time ABB resolve failure does.
    (download.grab as Mock).mockImplementation(async (params: { bookId: number }) => {
      if (params.bookId === 1) {
        throw new IndexerError('AudioBookBay', `ABB detail fetch failed for ${detailsUrl}: HTTP 500`);
      }
      return { id: 2 };
    });
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.matched).toBe(2);
    expect(result.grabbed).toBe(1);
    // Exactly one attempt per book: book 1's failure did NOT fall back to its runner-up, and did
    // not abandon the cycle before book 2.
    const grabbedBookIds = (download.grab as Mock).mock.calls.map((call) => (call[0] as { bookId: number }).bookId);
    expect(grabbedBookIds).toEqual([1, 2]);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'RSS grab failed (possible concurrent race)',
    );
  });

  it('results pass through multipart Usenet filter', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book (1/5)', 'Author', { protocol: 'usenet' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('results pass through blacklist hash filter', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { infoHash: 'abc123' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService(new Set(['abc123']));

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

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
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
  });

  it('results pass through required word filter', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book MP3', 'Author')];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      quality: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: '', requiredWords: 'M4B' },
    });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
  });

  it('results pass through min seeders filter', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { seeders: 1 })];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      quality: { grabFloor: 0, minSeeders: 5, protocolPreference: 'none', rejectWords: '', requiredWords: '' },
    });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

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
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

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
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

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
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledTimes(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:high' }),
    );
  });

  it('grabs emit event-history entries with source rss', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'rss' }),
    );
  });

  it('completes with 0 grabbed when enabled but no wanted books', async () => {
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices([]);
    const indexer = createMockIndexerService();
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result).toEqual({ polled: 0, skipped: 0, matched: 0, grabbed: 0 });
    expect(indexer.pollRss).not.toHaveBeenCalled();
  });

  it('completes normally when all results filtered out by floor', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { size: 1000 })];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      quality: { grabFloor: 200, minSeeders: 0, protocolPreference: 'none', rejectWords: '', requiredWords: '' },
    });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
  });

  it('handles feed item matching book with no duration (grab floor skipped)', async () => {
    const wantedBooks = [{ ...makeWantedBook(1, 'Test Book', 'Author'), duration: null, audioDuration: null }];
    const rssResults = [makeResult('Test Book', 'Author')];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      quality: { grabFloor: 200, minSeeders: 0, protocolPreference: 'none', rejectWords: '', requiredWords: '' },
    });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
  });

  it('handles feed item matching book with no author (title-only scoring)', async () => {
    const wantedBooks = [{ ...makeWantedBook(1, 'Test Book'), author: undefined }];
    const rssResults = [makeResult('Test Book')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
  });
});

describe('rss tests — GUID blacklist filtering', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
  });

  describe('RSS job — GUID blacklist filtering', () => {
    it('filters out results with blacklisted guid', async () => {
      const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
      const rssResults = [makeResult('Test Book', 'Author', { guid: 'guid-bad' })];
      const settings = createMockSettingsService({ rss: { enabled: true } });
      const { bookList } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService();
      (blacklist.getBlacklistedIdentifiers as Mock).mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set(['guid-bad']) });

      const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

      expect(result.grabbed).toBe(0);
      expect(download.grab).not.toHaveBeenCalled();
    });

    it('filters out results with blacklisted infoHash (existing behavior)', async () => {
      const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
      const rssResults = [makeResult('Test Book', 'Author', { infoHash: 'hash-bad', guid: 'guid-ok' })];
      const settings = createMockSettingsService({ rss: { enabled: true } });
      const { bookList } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService();
      (blacklist.getBlacklistedIdentifiers as Mock).mockResolvedValue({ blacklistedHashes: new Set(['hash-bad']), blacklistedGuids: new Set() });

      const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

      expect(result.grabbed).toBe(0);
      expect(download.grab).not.toHaveBeenCalled();
    });

    it('passes through usenet results with no infoHash and no guid', async () => {
      const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
      const rssResults = [makeResult('Test Book', 'Author', { protocol: 'usenet' })];
      const settings = createMockSettingsService({ rss: { enabled: true } });
      const { bookList } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService();

      const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

      expect(blacklist.getBlacklistedIdentifiers).not.toHaveBeenCalled();
      expect(result.grabbed).toBe(1);
    });
  });

  it('reads metadata.languages and uses it for quality filtering', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson')];
    const settings = createMockSettingsService({
      rss: { enabled: true },
      metadata: { audibleRegion: 'us', languages: ['english', 'french'] },
    });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

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
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService([frenchResult, englishResult]);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

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
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService([frenchResult]);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(download.grab).not.toHaveBeenCalled();
    expect(result.grabbed).toBe(0);
  });

  it('forwards indexerId from best RSS result to downloadOrchestrator.grab', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson', { indexerId: 55 })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ indexerId: 55 }),
    );
  });

  it('omits indexerId when RSS result has no indexerId', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson')];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    const grabCall = vi.mocked(download.grab).mock.calls[0]![0];
    expect(grabCall).not.toHaveProperty('indexerId');
  });

  it('accuracy mode grabs narrator-matched release over higher-quality non-match via RSS', async () => {
    const FAIR_SIZE = Math.round(79 * 10 * 1024 * 1024);
    const GOOD_SIZE = Math.round(200 * 10 * 1024 * 1024);
    const wanted = [{ ...makeWantedBook(1, 'Book One', 'Author'), narrators: [{ name: 'Kevin R. Free' }], audioDuration: 36000 }];
    const { bookList } = createMockBookServices(wanted);
    const settings = createMockSettingsService({
      rss: { enabled: true, intervalMinutes: 30 },
      search: { searchPriority: 'accuracy' },
    });
    const indexer = createMockIndexerService();
    vi.mocked(indexer.pollRss).mockResolvedValue({ results: [
      makeResult('Book One', 'Author', { size: GOOD_SIZE, downloadUrl: 'magnet:?xt=urn:btih:quality', narrator: 'Someone Else', matchScore: 0.9 }),
      makeResult('Book One', 'Author', { size: FAIR_SIZE, downloadUrl: 'magnet:?xt=urn:btih:narrator', narrator: 'Kevin R. Free', matchScore: 0.9 }),
    ] });
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:narrator' }),
    );
  });

  it('grabs the higher-matchScore release over the narrator/size winner via canonicalCompare (#1330)', async () => {
    mockEnrichUsenet.mockReset();
    // Without item.matchScore = bestScore, both scores tie at zero and narrator/size wins.
    const wanted = [{ ...makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson'), narrators: [{ name: 'Kevin R. Free' }] }];
    const { bookList } = createMockBookServices(wanted);
    const settings = createMockSettingsService({
      rss: { enabled: true, intervalMinutes: 30 },
      search: { searchPriority: 'accuracy' },
    });
    const indexer = createMockIndexerService();
    vi.mocked(indexer.pollRss).mockResolvedValue({ results: [
      makeResult('Way of Kings', 'Sanderson', { narrator: 'Kevin R. Free', size: BYTES_PER_GB, downloadUrl: 'magnet:?xt=urn:btih:narratorpick' }),
      makeResult('The Way of Kings', 'Brandon Sanderson', { narrator: 'Someone Else', size: 500 * 1024 * 1024, downloadUrl: 'magnet:?xt=urn:btih:matchscorepick' }),
    ] });
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(download.grab).toHaveBeenCalledTimes(1);
    expect(download.grab).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:matchscorepick' }),
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
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Way of Kings-Hörbuch-Pack.rar';
      }
    });

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('usenet RSS item with multi-part marker in nzbName but clean title/rawTitle → filtered out', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [makeResult('The Way of Kings', 'Brandon Sanderson', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/1' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'The Way of Kings (01 of 30).rar';
      }
    });

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('usenet RSS item with multi-part marker in rawTitle → still filtered (regression)', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { protocol: 'usenet' as const, rawTitle: 'Test Book (3/10)', downloadUrl: 'http://nzb.test/2' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('torrent RSS item skips multi-part filter regardless of title content', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book (1/5)', 'Author', { protocol: 'torrent' as const })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalled();
  });

  it('multi-part check prefers nzbName over rawTitle when both present', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', {
      protocol: 'usenet' as const,
      rawTitle: 'Test Book [Audiobook]',
      downloadUrl: 'http://nzb.test/3',
    })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Test Book (02 of 15).rar';
      }
    });

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('empty nzbName falls through to rawTitle (|| operator, not ??)', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', {
      protocol: 'usenet' as const,
      rawTitle: 'Test Book (1/8)',
      downloadUrl: 'http://nzb.test/4',
    })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = '';
      }
    });

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('single-part usenet post (total === 1) with nzbName is NOT filtered', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/5' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Test Book (01 of 01).rar';
      }
    });

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalled();
  });

  it('usenet result with pre-populated language — enrichment skips, multi-part uses rawTitle fallback', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', {
      protocol: 'usenet' as const,
      rawTitle: 'Test Book (2/10)',
      language: 'English',
      downloadUrl: 'http://nzb.test/6',
    })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    mockEnrichUsenet.mockImplementation(async () => {});

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('blacklisted RSS items are never passed to enrichUsenetLanguages', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { protocol: 'usenet' as const, infoHash: 'blacklisted123', downloadUrl: 'http://nzb.test/7' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService(new Set(['blacklisted123']));

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.grabbed).toBe(0);
    expect(mockEnrichUsenet).not.toHaveBeenCalled();
  });

  it('enrichment only receives matched candidates, not unmatched below-threshold items', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [
      makeResult('The Way of Kings', 'Brandon Sanderson', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/matched' }),
      makeResult('Totally Unrelated Book XYZ', 'Someone Else', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/unmatched' }),
    ];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(mockEnrichUsenet).toHaveBeenCalledTimes(1);
    const enrichedResults = mockEnrichUsenet.mock.calls[0]![0];
    expect(enrichedResults).toHaveLength(1);
    expect(enrichedResults[0]!.title).toBe('The Way of Kings');
    expect(result.grabbed).toBe(1);
  });

  it('sets matchScore = bestScore on matched results and caps Phase-2 fetches before enrichment (#1315)', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [
      makeResult('The Way of Kings', 'Brandon Sanderson', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/matched' }),
    ];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(mockEnrichUsenet).toHaveBeenCalledTimes(1);
    const enrichedResults = mockEnrichUsenet.mock.calls[0]![0];
    expect(enrichedResults[0]!.matchScore).toBeGreaterThan(0.7);
    expect(mockEnrichUsenet.mock.calls[0]![3]).toEqual({ maxPhase2Fetches: 10 });
  });

  // #2573 decision 5: the RSS cycle has no deadline of any kind, so there is no signal to forward.
  it('passes no signal into the enrichment options (#2573 AC9)', async () => {
    const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
    const rssResults = [
      makeResult('The Way of Kings', 'Brandon Sanderson', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/matched' }),
    ];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    const options = mockEnrichUsenet.mock.calls[0]![3] as Record<string, unknown>;
    // `not.objectContaining({ signal: anything() })` passes against a present-but-undefined key.
    expect(options).not.toHaveProperty('signal');
    expect(options).toEqual({ maxPhase2Fetches: 10 });
  });

  it('matched count includes books whose candidates were all multi-part rejected', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book', 'Author')];
    const rssResults = [makeResult('Test Book', 'Author', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/8' })];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Test Book (05 of 20).rar';
      }
    });

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.matched).toBe(1);
    expect(result.grabbed).toBe(0);
  });

  it('grabbed count excludes multi-part-rejected items', async () => {
    const wantedBooks = [makeWantedBook(1, 'Test Book A', 'Author'), makeWantedBook(2, 'Test Book B', 'Author')];
    const rssResults = [
      makeResult('Test Book A', 'Author', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/9' }),
      makeResult('Test Book B', 'Author', { protocol: 'usenet' as const, downloadUrl: 'http://nzb.test/10' }),
    ];
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wantedBooks);
    const indexer = createMockIndexerService(rssResults);
    const download = createMockDownloadOrchestrator();
    const blacklist = createMockBlacklistService();

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet' && r.title === 'Test Book B') {
          r.nzbName = 'Test Book B (03 of 12).rar';
        }
      }
    });

    const result = await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

    expect(result.matched).toBe(2);
    expect(result.grabbed).toBe(1);
    expect(download.grab).toHaveBeenCalledTimes(1);
  });

  describe('caller-level debug logging (#932 F2)', () => {
    it('emits the blacklist drop log when an RSS item is filtered by the blacklist', async () => {
      const wantedBooks = [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')];
      const rssResults = [
        makeResult('The Way of Kings', 'Brandon Sanderson', { infoHash: 'badhash1' }),
      ];
      const settings = createMockSettingsService({ rss: { enabled: true } });
      const { bookList } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService(new Set(['badhash1']));

      await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

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
      const { bookList } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService();

      mockEnrichUsenet.mockImplementation(async (results) => {
        for (const r of results) r.nzbName = 'Test Book (07 of 30).rar';
      });

      await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
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
      const { bookList } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService();

      await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

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
      const { bookList } = createMockBookServices(wantedBooks);
      const indexer = createMockIndexerService(rssResults);
      const download = createMockDownloadOrchestrator();
      const blacklist = createMockBlacklistService();

      await runRssJob(settings, bookList, indexer, download, blacklist, mockIndexer, inject<FastifyBaseLogger>(log));

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'reject-word-match', matchedWord: 'banned' }),
        'Quality filter dropped result',
      );
    });
  });
});

describe('runRssJob — entirely-blacklisted feed batch (#2336 AC6)', () => {
  const BLACKLIST_LINE = 'All search results removed by the blacklist';
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
    mockEnrichUsenet.mockReset();
  });

  function blacklistLineFields(): Record<string, unknown> | undefined {
    const call = (log.info as Mock).mock.calls.find(([, message]) => message === BLACKLIST_LINE);
    return call?.[0] as Record<string, unknown> | undefined;
  }

  function run(wanted: unknown[], rssResults: SearchResult[], blacklisted: Set<string>) {
    const settings = createMockSettingsService({ rss: { enabled: true } });
    const { bookList } = createMockBookServices(wanted);
    const download = createMockDownloadOrchestrator();
    return {
      download,
      result: runRssJob(
        settings,
        bookList,
        createMockIndexerService(rssResults),
        download,
        createMockBlacklistService(blacklisted),
        mockIndexer,
        inject<FastifyBaseLogger>(log),
      ),
    };
  }

  it('logs the blacklist line with the feed-batch counts', async () => {
    const { result } = run(
      [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')],
      [
        makeResult('The Way of Kings', 'Brandon Sanderson', { infoHash: 'bad1' }),
        makeResult('The Way of Kings Unabridged', 'Brandon Sanderson', { infoHash: 'bad2' }),
      ],
      new Set(['bad1', 'bad2']),
    );
    await result;

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        polled: 1,
        skipped: 0,
        inputCount: 2,
        droppedCount: 2,
        reason: 'blacklist-match',
        dropCounts: { 'blacklist-match': 2 },
      }),
      BLACKLIST_LINE,
    );
  });

  // The gate runs once over the whole batch, before per-book matching — there is no book to name.
  it('carries no bookId, because the batch predates matching', async () => {
    const { result } = run(
      [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')],
      [makeResult('The Way of Kings', 'Brandon Sanderson', { infoHash: 'bad1' })],
      new Set(['bad1']),
    );
    await result;

    expect(blacklistLineFields()).not.toHaveProperty('bookId');
    expect(blacklistLineFields()).not.toHaveProperty('title');
  });

  it('emits one batch-wide line, not one per candidate book', async () => {
    const { result } = run(
      [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson'), makeWantedBook(2, 'Words of Radiance', 'Brandon Sanderson')],
      [
        makeResult('The Way of Kings', 'Brandon Sanderson', { infoHash: 'bad1' }),
        makeResult('Words of Radiance', 'Brandon Sanderson', { infoHash: 'bad2' }),
      ],
      new Set(['bad1', 'bad2']),
    );
    await result;

    expect((log.info as Mock).mock.calls.filter(([, message]) => message === BLACKLIST_LINE)).toHaveLength(1);
    expect(blacklistLineFields()).toMatchObject({ inputCount: 2 });
  });

  // AC6 forbids an early return: the loop no-ops, and the terminal record is byte-identical.
  it('leaves the job result and the completion log untouched', async () => {
    const { download, result } = run(
      [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')],
      [makeResult('The Way of Kings', 'Brandon Sanderson', { infoHash: 'bad1' })],
      new Set(['bad1']),
    );

    expect(await result).toEqual({ polled: 1, skipped: 0, matched: 0, grabbed: 0 });
    expect(log.info).toHaveBeenCalledWith({ polled: 1, skipped: 0, matched: 0, grabbed: 0 }, 'RSS sync completed');
    expect(download.grab).not.toHaveBeenCalled();
  });

  it('leaves an empty feed batch on its existing no-items line', async () => {
    const { result } = run([makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')], [], new Set(['bad1']));
    await result;

    expect(log.info).toHaveBeenCalledWith({ polled: 1, skipped: 0 }, 'RSS sync completed — no feed items');
    expect(blacklistLineFields()).toBeUndefined();
  });

  it('stays silent when a survivor remains, and grabs it (AC7)', async () => {
    const { download, result } = run(
      [makeWantedBook(1, 'The Way of Kings', 'Brandon Sanderson')],
      [
        makeResult('The Way of Kings', 'Brandon Sanderson', { infoHash: 'bad1' }),
        makeResult('The Way of Kings Unabridged', 'Brandon Sanderson', { infoHash: 'good1' }),
      ],
      new Set(['bad1']),
    );

    expect((await result).grabbed).toBe(1);
    expect(blacklistLineFields()).toBeUndefined();
    expect(download.grab).toHaveBeenCalledWith(expect.objectContaining({ bookId: 1, source: 'rss' }));
  });
});
