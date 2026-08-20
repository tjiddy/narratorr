import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from 'vitest';
import { buildSearchQuery, buildNarratorPriority, filterAndRankResults, filterBlacklistedResults, searchAndGrabForBook, postProcessSearchResults, applyMultiPartFilterAndRank, buildSearchFilterOptions } from './search-pipeline.js';
import type { SingleBookSearchResult, SearchFilterOptions } from './search-pipeline.js';
import type { SettingsService } from './settings.service.js';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { BlacklistService } from './blacklist.service.js';
import { DuplicateDownloadError } from './download.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '@core/index.js';
import { parseMamSize } from '@core/indexers/mam-helpers.js';
import { scoreResult } from '@core/utils/similarity.js';
import { BYTES_PER_GB as GB, BYTES_PER_MB as MB } from '@shared/constants.js';
import type { SearchResponsePayload, SearchResultPayload } from '@shared/schemas/search-stream.js';
import { SearchLadderCooldown } from './search-ladder-cooldown.js';
import { SEARCH_DEADLINE_MS } from '@core/utils/constants.js';
import { SearchDeadlineError, _resetSearchRegistryForTesting } from './search-deadline.js';
import { withBookAdmissionLock } from './book-admission.js';
import { BlackholeClient } from '@core/download-clients/blackhole.js';
import { fetchWithSsrfRedirect } from '@core/utils/network-service.js';
import { tmpdir } from 'node:os';
import { runImmediateSearchChain } from './immediate-search-chain.js';
import { inject, searchStatus, mockSearchAllWithStatus, answeringSearchStatus, type SearchStatusOverrides } from '../__tests__/helpers.js';

// Passthrough mocks: only the #2310 stall-class cases override these, so every other test in this
// file keeps the real implementations.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});
const { writeFile } = await import('node:fs/promises');
const { lookup: dnsLookup } = await import('node:dns/promises');


const mockIndexer = {
  getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
} as unknown as IndexerService;

function createMockEventHistory(): EventHistoryService {
  return {
    create: vi.fn().mockResolvedValue({ id: 1 }),
  } as unknown as EventHistoryService;
}

// Describes that assert history shadow this default with a fresh mock.
const eventHistory: EventHistoryService = createMockEventHistory();

function createMockLogger(): FastifyBaseLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as FastifyBaseLogger;
}

type MakeResultOverrides = { [K in keyof SearchResult]?: SearchResult[K] | undefined };

function makeResult(overrides: MakeResultOverrides = {}): SearchResult {
  const result: SearchResult = {
    title: 'Test Book',
    protocol: 'torrent',
    indexer: 'test',
    seeders: 10,
    size: 500 * 1024 * 1024,
    downloadUrl: 'magnet:?xt=urn:btih:aaa',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete (result as unknown as Record<string, unknown>)[key];
    } else {
      (result as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

const defaultQualitySettings = {
  grabFloor: 0,
  minSeeders: 1,
  protocolPreference: 'none',
  maxDownloadSize: 5,
};

describe('buildSearchQuery', () => {
  it('returns "title authorname" when book has title and author', () => {
    expect(buildSearchQuery({ title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] }))
      .toBe('The Way of Kings Brandon Sanderson');
  });

  it('returns title only when book has no author object', () => {
    expect(buildSearchQuery({ title: 'The Way of Kings' }))
      .toBe('The Way of Kings');
  });

  it('returns title only when author is null', () => {
    expect(buildSearchQuery({ title: 'The Way of Kings', authors: null }))
      .toBe('The Way of Kings');
  });

  it('returns title only when author.name is undefined', () => {
    expect(buildSearchQuery({ title: 'The Way of Kings', authors: [{ name: undefined } as unknown as { name: string }] }))
      .toBe('The Way of Kings');
  });

  it('returns author only when title is empty string', () => {
    expect(buildSearchQuery({ title: '', authors: [{ name: 'Brandon Sanderson' }] }))
      .toBe('Brandon Sanderson');
  });

  it('returns empty string when both title and author are missing', () => {
    expect(buildSearchQuery({ title: '', authors: null }))
      .toBe('');
  });

  it('strips trailing parenthetical series annotation, keeping inner words', () => {
    expect(buildSearchQuery({ title: 'Blood Ties (World of Warcraft: Midnight)', authors: [{ name: 'Christie Golden' }] }))
      .toBe('Blood Ties World of Warcraft Midnight Christie Golden');
  });

  it('strips colon subtitle separator', () => {
    expect(buildSearchQuery({ title: 'Dune: Messiah', authors: null }))
      .toBe('Dune Messiah');
  });

  it('strips bracket edition tag, keeping inner words', () => {
    expect(buildSearchQuery({ title: 'Mistborn [Audible Studios]', authors: null }))
      .toBe('Mistborn Audible Studios');
  });

  it('strips multiple delimiters in one title', () => {
    expect(buildSearchQuery({ title: 'Foundation (Robot Series, Book 0): Prequel', authors: null }))
      .toBe('Foundation Robot Series Book 0 Prequel');
  });

  it('strips brace edition tag, keeping inner words', () => {
    expect(buildSearchQuery({ title: 'Mistborn {Box Set}', authors: null }))
      .toBe('Mistborn Box Set');
  });

  it('strips dots from spaced author initials', () => {
    expect(buildSearchQuery({ title: 'The Big Door Prize', authors: [{ name: 'M. O. Walsh' }] }))
      .toBe('The Big Door Prize M O Walsh');
  });

  it('strips dots from no-space author initials', () => {
    expect(buildSearchQuery({ title: 'The Hobbit', authors: [{ name: 'J.R.R. Tolkien' }] }))
      .toBe('The Hobbit J R R Tolkien');
  });

  it('strips dots from author title prefix', () => {
    expect(buildSearchQuery({ title: 'Doctor Strange', authors: [{ name: 'Dr. Strange' }] }))
      .toBe('Doctor Strange Dr Strange');
  });

  it('strips dots from numeric titles (indexers tokenize dots themselves)', () => {
    expect(buildSearchQuery({ title: '11.22.63', authors: null }))
      .toBe('11 22 63');
  });

  it('strips semicolons', () => {
    expect(buildSearchQuery({ title: 'Dune; Messiah', authors: null }))
      .toBe('Dune Messiah');
  });

  it('passes plain title and author through unchanged', () => {
    expect(buildSearchQuery({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }] }))
      .toBe('Mistborn Brandon Sanderson');
  });

  it('collapses whitespace introduced by stripped punctuation', () => {
    expect(buildSearchQuery({ title: 'Foo  (Bar)  Baz', authors: null }))
      .toBe('Foo Bar Baz');
  });

  it('#1904 specimen — strips the trailing "?" so the automatic path forwards a matchable query', () => {
    expect(buildSearchQuery({
      title: 'Is She Really Going Out with Him?',
      authors: [{ name: 'Sophie Cousens' }],
    })).toBe('Is She Really Going Out with Him Sophie Cousens');
  });

  it('#1904 drops apostrophes in the author name without splitting the token', () => {
    expect(buildSearchQuery({ title: 'Trouble', authors: [{ name: "Fintan O'Toole" }] }))
      .toBe('Trouble Fintan OToole');
  });
});

describe('searchAndGrabForBook', () => {
  let indexerSearchService: IndexerSearchService;
  let downloadService: DownloadOrchestrator;
  let log: FastifyBaseLogger;
  let blacklistService: BlacklistService;
  let eventHistory: EventHistoryService;

  beforeEach(() => {
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult()])),
    } as unknown as IndexerSearchService;

    downloadService = {
      grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }),
    } as unknown as DownloadOrchestrator;

    blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set<string>(),
      }),
    } as unknown as BlacklistService;

    eventHistory = createMockEventHistory();
    log = createMockLogger();
  });

  // Duration is minutes; grabFloor 0 makes this 60-hour value inert (#1797).
  const book = { id: 1, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };

  it('returns grabbed result on happy path (search → filter → grab)', async () => {
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ bookId: 1 }));
  });

  it('forwards indexerId from best search result to downloadOrchestrator.grab', async () => {
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult({ indexerId: 42 })])),
    } as unknown as IndexerSearchService;

    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    expect(downloadService.grab).toHaveBeenCalledWith(
      expect.objectContaining({ indexerId: 42 }),
    );
  });

  it('omits indexerId when search result has no indexerId', async () => {
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    const grabCall = vi.mocked(downloadService.grab).mock.calls[0]![0];
    expect(grabCall).not.toHaveProperty('indexerId');
  });

  it('forwards isFreeleech=true from best search result to grab (#1156 F2)', async () => {
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult({ indexerId: 7, isFreeleech: true })])),
    } as unknown as IndexerSearchService;

    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    expect(downloadService.grab).toHaveBeenCalledWith(
      expect.objectContaining({ isFreeleech: true }),
    );
  });

  it('omits isFreeleech from grab when best search result does not set it (#1156 F2)', async () => {
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    const grabCall = vi.mocked(downloadService.grab).mock.calls[0]![0];
    expect(grabCall).not.toHaveProperty('isFreeleech');
  });

  it('returns no_results when indexers return empty array', async () => {
    vi.mocked(indexerSearchService.searchAllWithStatus).mockResolvedValue(searchStatus([]));
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
  });

  it('returns no_results when all results filtered out by grabFloor', async () => {
    vi.mocked(indexerSearchService.searchAllWithStatus).mockResolvedValue(searchStatus([makeResult({ size: 100 })]));
    const settings = { ...defaultQualitySettings, grabFloor: 999 };
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: settings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'no_results' });
  });

  it('returns no_results when all results filtered out by word lists', async () => {
    vi.mocked(indexerSearchService.searchAllWithStatus).mockResolvedValue(searchStatus([makeResult({ title: 'bad book' })]));
    const settings = { ...defaultQualitySettings, rejectWords: 'bad' };
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: settings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'no_results' });
  });

  it('returns no_results when all results filtered out by maxDownloadSize', async () => {

    vi.mocked(indexerSearchService.searchAllWithStatus).mockResolvedValue(searchStatus([makeResult({ size: 10 * GB })]));
    const settings = { ...defaultQualitySettings, maxDownloadSize: 5 };
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: settings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'no_results' });
  });

  it('logs quality gate filtering when results are filtered by maxDownloadSize', async () => {

    vi.mocked(indexerSearchService.searchAllWithStatus).mockResolvedValue(searchStatus([
      makeResult({ title: 'Small', size: 2 * GB }),
      makeResult({ title: 'Huge', size: 10 * GB }),
    ]));
    const settings = { ...defaultQualitySettings, maxDownloadSize: 5 };
    await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: settings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(log.debug).toHaveBeenCalledWith(
      { inputCount: 2, outputCount: 1 },
      'Quality gate filtering applied',
    );
  });

  it('does not log quality gate filtering when no results are filtered', async () => {
    vi.mocked(indexerSearchService.searchAllWithStatus).mockResolvedValue(searchStatus([makeResult({ size: 500 * 1024 * 1024 })]));
    const settings = { ...defaultQualitySettings, maxDownloadSize: 5 };
    await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: settings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ inputCount: expect.any(Number), outputCount: expect.any(Number) }),
      'Quality gate filtering applied',
    );
  });

  it('returns no_results when no result has downloadUrl', async () => {
    vi.mocked(indexerSearchService.searchAllWithStatus).mockResolvedValue(searchStatus([makeResult({ downloadUrl: undefined })]));
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'no_results' });
  });

  it('treats empty-string downloadUrl as no download URL', async () => {
    vi.mocked(indexerSearchService.searchAllWithStatus).mockResolvedValue(searchStatus([makeResult({ downloadUrl: '' })]));
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'no_results' });
  });

  it('returns skipped with reason when grab throws "already has an active download"', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(new DuplicateDownloadError('Book already has an active download', 'ACTIVE_DOWNLOAD_EXISTS', { active: { title: 'A Book', count: 1 } }));
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'skipped', reason: 'grab_blocked' });
  });

  it('returns skipped when DuplicateDownloadError is thrown (instanceof check, not string match)', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(new DuplicateDownloadError('Book already has an active download', 'ACTIVE_DOWNLOAD_EXISTS', { active: { title: 'A Book', count: 1 } }));
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'skipped', reason: 'grab_blocked' });
  });

  it('returns skipped when DuplicateDownloadError with PIPELINE_ACTIVE is thrown', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(new DuplicateDownloadError('Book has pipeline download', 'PIPELINE_ACTIVE', { reason: 'processing' }));
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'skipped', reason: 'grab_blocked' });
  });

  it('returns grab_error when non-DuplicateDownloadError is thrown (not swallowed)', async () => {
    const genericError = new Error('Connection refused');
    vi.mocked(downloadService.grab).mockRejectedValue(genericError);
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result.result).toBe('grab_error');
    if (result.result !== 'grab_error') return;
    expect(result.error).toBe(genericError);
  });

  it('records grab_failed event via eventHistory on grab_error in non-broadcaster path', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(new Error('Connection refused'));
    await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 1,
      bookTitle: 'Test Book',
      eventType: 'grab_failed',
      source: 'auto',
      reason: { error: 'Connection refused', release_title: 'Test Book' },
    }));
  });

  it('substitutes "Unknown grab error" in non-broadcaster path when grab error.message is empty', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(new Error(''));
    await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'grab_failed',
      reason: { error: 'Unknown grab error', release_title: 'Test Book' },
    }));
  });

  it('returns grab_error for non-duplicate grab errors', async () => {
    const grabError = new Error('Connection refused');
    vi.mocked(downloadService.grab).mockRejectedValue(grabError);
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result.result).toBe('grab_error');
    if (result.result !== 'grab_error') return;
    expect(result.error).toBe(grabError);
  });

  it('wraps string grab rejection into Error with the string as message', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue('connection failed');
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result.result).toBe('grab_error');
    if (result.result !== 'grab_error') return;
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('connection failed');
  });

  it('wraps plain-object grab rejection into Error with message "[object Object]"', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue({ msg: 'oops' });
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result.result).toBe('grab_error');
    if (result.result !== 'grab_error') return;
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('[object Object]');
  });

  it('wraps null grab rejection into Error with message "null"', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(null);
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result.result).toBe('grab_error');
    if (result.result !== 'grab_error') return;
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('null');
  });

  it('wraps undefined grab rejection into Error with message "undefined"', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(undefined);
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result.result).toBe('grab_error');
    if (result.result !== 'grab_error') return;
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('undefined');
  });

  it('handles book with duration: null', async () => {
    const nullDurationBook = { ...book, duration: null };
    const result = await searchAndGrabForBook(nullDurationBook, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
  });

  it('handles book with duration: undefined', async () => {
    const { duration: _duration, ...undefinedDurationBook } = book;
    const result = await searchAndGrabForBook(undefinedDurationBook, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
  });

  it('handles book with duration: 0', async () => {
    const zeroDurationBook = { ...book, duration: 0 };
    const result = await searchAndGrabForBook(zeroDurationBook, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
  });

  it('passes guid from best result to grab()', async () => {
    vi.mocked(indexerSearchService.searchAllWithStatus).mockResolvedValue(searchStatus([makeResult({ guid: 'nzb-guid-abc' })]));
    await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(downloadService.grab).toHaveBeenCalledWith(
      expect.objectContaining({ guid: 'nzb-guid-abc', bookId: 1 }),
    );
  });

  it('omits guid from the grab payload when the result has none', async () => {
    vi.mocked(indexerSearchService.searchAllWithStatus).mockResolvedValue(searchStatus([makeResult({ guid: undefined })]));
    await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    const payload = vi.mocked(downloadService.grab).mock.calls[0]![0];
    expect(payload.bookId).toBe(1);
    expect(payload).not.toHaveProperty('guid');
  });

  it('calls buildSearchQuery to construct the query', async () => {
    await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    // The third argument is the run-scoped exclusion channel the ladder executor owns (#2375).
    expect(indexerSearchService.searchAllWithStatus).toHaveBeenCalledWith(
      'Test Book Author',
      expect.any(Object),
      expect.objectContaining({ excludeIndexerIds: expect.any(Set), onOutcome: expect.any(Function) }),
    );
  });
});

describe('filterAndRankResults — ebook format filtering', () => {
  const base = { bookDuration: undefined as number | undefined, grabFloor: 0, minSeeders: 0, protocolPreference: 'none' };

  it('filters result with only EPUB in title', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune EPUB' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(0);
  });

  it('filters result with only PDF in title', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune PDF' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(0);
  });

  it('filters result with only MOBI in title', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune MOBI' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(0);
  });

  it('filters result with only AZW3 in title', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune AZW3' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(0);
  });

  it('passes result with no ebook keywords in title', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune Audiobook M4B' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(1);
  });

  it('passes result with EPUB and M4B (mixed format)', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune EPUB M4B' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(1);
  });

  it('passes result with EPUB and MP3 (mixed format)', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune EPUB MP3' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(1);
  });

  it('passes result with EPUB and AAC (mixed format)', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune EPUB AAC' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(1);
  });

  it('filter is case-insensitive (epub, pdf, mobi, azw3)', () => {
    const epubLower = filterAndRankResults([makeResult({ title: 'dune.epub.2023' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    const pdfMixed = filterAndRankResults([makeResult({ title: 'Dune.Pdf' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    const mobiLower = filterAndRankResults([makeResult({ title: 'DUNE.mobi' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(epubLower.results).toHaveLength(0);
    expect(pdfMixed.results).toHaveLength(0);
    expect(mobiLower.results).toHaveLength(0);
  });

  it('uses rawTitle for matching when present, ignoring title', () => {
    const { results } = filterAndRankResults([makeResult({ rawTitle: 'dune.epub.2023', title: 'Dune' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(0);
  });

  it('falls back to title when rawTitle is absent', () => {
    const { results } = filterAndRankResults([makeResult({ rawTitle: undefined, title: 'Dune EPUB' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(0);
  });

  it('filters underscore-separated ebook-only titles (scene-style)', () => {
    const epub = filterAndRankResults([makeResult({ title: 'Dune_EPUB' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    const pdf = filterAndRankResults([makeResult({ title: 'Author.Title_PDF_2023' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(epub.results).toHaveLength(0);
    expect(pdf.results).toHaveLength(0);
  });

  it('passes underscore-separated mixed-format title (ebook + audio)', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune_EPUB_M4B' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(1);
  });

  it('passes result with EPUB and FLAC (mixed format)', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune EPUB FLAC' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(1);
  });

  it('passes result with EPUB and OGG (mixed format)', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune EPUB OGG' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(results).toHaveLength(1);
  });

  // Companion ebooks are observed, never acquired; EPUB support must not relax EBOOK_FORMAT_RE (#1986).
  it('still rejects an ebook-only release while companion EPUB support lands (#1986)', () => {
    const ebookOnly = filterAndRankResults([makeResult({ title: 'Dune EPUB' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    const withAudio = filterAndRankResults([makeResult({ title: 'Dune EPUB M4B' })], base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference });
    expect(ebookOnly.results).toHaveLength(0);
    expect(withAudio.results).toHaveLength(1);
  });

  describe('debug-level drop logging (AC6)', () => {
    it('emits per-drop debug log for ebook-only filter when logger is provided', () => {
      const log = createMockLogger();
      filterAndRankResults(
        [makeResult({ title: 'Dune EPUB' })],
        base.bookDuration,
        { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference },
        log,
      );
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Dune EPUB', dropped: true, reason: 'ebook-only-format' }),
        'Quality filter dropped result',
      );
    });

    it('emits per-drop debug log for reject-word filter with the matched word', () => {
      const log = createMockLogger();
      filterAndRankResults(
        [makeResult({ title: 'Dune Audiobook M4B BANNED' })],
        base.bookDuration,
        { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference, rejectWords: 'banned' },
        log,
      );
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'reject-word-match', matchedWord: 'banned' }),
        'Quality filter dropped result',
      );
    });

    it('emits the "language-undetermined passed" log line for results with no detected language (AC6 critical case)', () => {
      const log = createMockLogger();
      filterAndRankResults(
        [makeResult({ title: 'Mystery Book M4B', language: undefined })],
        base.bookDuration,
        { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference, languages: ['english'] },
        log,
      );
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Mystery Book M4B', reason: 'language-undetermined', dropped: false }),
        'Language filter passed undetected result',
      );
    });

    it('emits language-mismatch debug log for explicit non-matching language', () => {
      const log = createMockLogger();
      filterAndRankResults(
        [makeResult({ title: 'German Book M4B', language: 'german' })],
        base.bookDuration,
        { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference, languages: ['english'] },
        log,
      );
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'German Book M4B', reason: 'language-mismatch', dropped: true }),
        'Language filter dropped result',
      );
    });
  });

  it('filters result when nzbName contains ebook keyword but rawTitle/title do not', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: 'BookTitle-EPUB.part01.rar', rawTitle: 'BookTitle', title: 'Book Title' })],
      base.bookDuration,
      { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference },
    );
    expect(results).toHaveLength(0);
  });

  it('passes result when nzbName contains ebook keyword AND audio keyword (mixed format)', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: 'BookTitle-EPUB-MP3', rawTitle: 'BookTitle', title: 'Book Title' })],
      base.bookDuration,
      { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference },
    );
    expect(results).toHaveLength(1);
  });

  it('filters result when nzbName is undefined and rawTitle contains ebook keyword (existing fallback)', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: undefined, rawTitle: 'BookTitle EPUB', title: 'Book Title' })],
      base.bookDuration,
      { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference },
    );
    expect(results).toHaveLength(0);
  });

  it('filters result when nzbName is empty string and rawTitle contains ebook keyword (|| falls through)', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: '', rawTitle: 'BookTitle MOBI', title: 'Book Title' })],
      base.bookDuration,
      { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference },
    );
    expect(results).toHaveLength(0);
  });

  it('keeps result when nzbName has ebook keyword and rawTitle has audio keyword (cross-field)', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: 'BookTitle-EPUB.part01.rar', rawTitle: 'BookTitle MP3', title: 'Book Title' })],
      base.bookDuration,
      { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference },
    );
    expect(results).toHaveLength(1);
  });

  it('keeps result when nzbName has ebook keyword and title has audio keyword (cross-field)', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: 'BookTitle-EPUB.part01.rar', rawTitle: 'BookTitle', title: 'Book Title M4B' })],
      base.bookDuration,
      { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference },
    );
    expect(results).toHaveLength(1);
  });

  it('filters result when nzbName has ebook keyword and no audio keyword in any field', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: 'BookTitle-EPUB.part01.rar', rawTitle: 'BookTitle', title: 'Book Title' })],
      base.bookDuration,
      { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference },
    );
    expect(results).toHaveLength(0);
  });
});

describe('filterAndRankResults — minSeeders default', () => {
  it('filters torrent with 0 seeders when minSeeders is 1 (new default)', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: 0 })], undefined, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none' });
    expect(results).toHaveLength(0);
  });

  it('passes torrent with 1 seeder when minSeeders is 1', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: 1 })], undefined, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none' });
    expect(results).toHaveLength(1);
  });

  it('passes torrent with undefined seeders when minSeeders is 1 (unknown ≠ zero)', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: undefined })], undefined, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none' });
    expect(results).toHaveLength(1);
  });

  it('passes torrent with null seeders when minSeeders is 1 (unknown ≠ zero)', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: null as unknown as undefined })], undefined, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none' });
    expect(results).toHaveLength(1);
  });

  it('passes torrent with 0 seeders when minSeeders is 0 (filter disabled)', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: 0 })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' });
    expect(results).toHaveLength(1);
  });

  it('passes torrent with seeders above threshold', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: 5 })], undefined, { grabFloor: 0, minSeeders: 3, protocolPreference: 'none' });
    expect(results).toHaveLength(1);
  });

  it('filters torrent with seeders below threshold', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: 2 })], undefined, { grabFloor: 0, minSeeders: 3, protocolPreference: 'none' });
    expect(results).toHaveLength(0);
  });

  it('mixed: undefined seeders survives while 0 seeders is filtered', () => {
    const { results } = filterAndRankResults([
      makeResult({ title: 'ABB Result', protocol: 'torrent', seeders: undefined }),
      makeResult({ title: 'Dead Torrent', protocol: 'torrent', seeders: 0 }),
    ], undefined, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none' });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('ABB Result');
  });

  it('passes usenet result regardless of seeders when minSeeders is 1', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'usenet', seeders: undefined })], undefined, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none' });
    expect(results).toHaveLength(1);
  });
});

describe('filterAndRankResults — maxDownloadSize', () => {


  it('filters result exceeding maxDownloadSize threshold', () => {
    const { results } = filterAndRankResults([makeResult({ size: 6 * GB })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 });
    expect(results).toHaveLength(0);
  });

  it('keeps result within maxDownloadSize threshold', () => {
    const { results } = filterAndRankResults([makeResult({ size: 3 * GB })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 });
    expect(results).toHaveLength(1);
  });

  it('keeps result exactly at maxDownloadSize threshold (inclusive <=)', () => {
    const { results } = filterAndRankResults([makeResult({ size: 5 * GB })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 });
    expect(results).toHaveLength(1);
  });

  it('filters result 1 byte over maxDownloadSize threshold', () => {
    const { results } = filterAndRankResults([makeResult({ size: 5 * GB + 1 })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 });
    expect(results).toHaveLength(0);
  });

  it('disables filter when maxDownloadSize is 0', () => {
    const { results } = filterAndRankResults([makeResult({ size: 100 * GB })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 0 });
    expect(results).toHaveLength(1);
  });

  it('passes result with undefined size when maxDownloadSize is set', () => {
    const { results } = filterAndRankResults([makeResult({ size: undefined })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 });
    expect(results).toHaveLength(1);
  });

  it('passes result with size 0 when maxDownloadSize is set', () => {
    const { results } = filterAndRankResults([makeResult({ size: 0 })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 });
    expect(results).toHaveLength(1);
  });

  it('applies filter even when book duration is unknown', () => {
    const { results } = filterAndRankResults([makeResult({ size: 10 * GB })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 });
    expect(results).toHaveLength(0);
  });

  it('applies filter to both torrent and usenet results', () => {
    const { results } = filterAndRankResults([
        makeResult({ protocol: 'torrent', size: 10 * GB, seeders: 10 }),
        makeResult({ protocol: 'usenet', size: 10 * GB }),
      ], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 });
    expect(results).toHaveLength(0);
  });

  it('mixed: only oversized results removed, others retained in order', () => {
    const small = makeResult({ title: 'Small Book', size: 2 * GB });
    const big = makeResult({ title: 'Big Pack', size: 30 * GB });
    const medium = makeResult({ title: 'Medium Book', size: 4 * GB });
    const { results } = filterAndRankResults([small, big, medium], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 });
    expect(results).toHaveLength(2);
    expect(results.map(r => r.title)).toContain('Small Book');
    expect(results.map(r => r.title)).toContain('Medium Book');
    expect(results.map(r => r.title)).not.toContain('Big Pack');
  });

  it('interacts with minSeeders and grabFloor independently', () => {
    const { results } = filterAndRankResults([
        makeResult({ title: 'Good', protocol: 'torrent', seeders: 5, size: 2 * GB }),
        makeResult({ title: 'Too big', protocol: 'torrent', seeders: 5, size: 10 * GB }),
        makeResult({ title: 'No seeders', protocol: 'torrent', seeders: 0, size: 1 * GB }),
      ], undefined, { grabFloor: 0, minSeeders: 3, protocolPreference: 'none', maxDownloadSize: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('Good');
  });
});

describe('filterAndRankResults — minDownloadSize', () => {
  it('filters result below minDownloadSize threshold', () => {
    const { results } = filterAndRankResults([makeResult({ size: 5 * MB })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 });
    expect(results).toHaveLength(0);
  });

  it('keeps result above minDownloadSize threshold', () => {
    const { results } = filterAndRankResults([makeResult({ size: 100 * MB })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 });
    expect(results).toHaveLength(1);
  });

  it('keeps result exactly at minDownloadSize threshold (inclusive >=)', () => {
    const { results } = filterAndRankResults([makeResult({ size: 50 * MB })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 });
    expect(results).toHaveLength(1);
  });

  it('filters result 1 byte under minDownloadSize threshold', () => {
    const { results } = filterAndRankResults([makeResult({ size: 50 * MB - 1 })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 });
    expect(results).toHaveLength(0);
  });

  it('disables filter when minDownloadSize is 0', () => {
    const { results } = filterAndRankResults([makeResult({ size: 1 * MB })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 0 });
    expect(results).toHaveLength(1);
  });

  it('passes result with undefined size when minDownloadSize is set', () => {
    const { results } = filterAndRankResults([makeResult({ size: undefined })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 });
    expect(results).toHaveLength(1);
  });

  it('passes result with size 0 when minDownloadSize is set', () => {
    const { results } = filterAndRankResults([makeResult({ size: 0 })], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 });
    expect(results).toHaveLength(1);
  });

  it('applies filter to both torrent and usenet results', () => {
    const { results } = filterAndRankResults([
        makeResult({ protocol: 'torrent', size: 5 * MB, seeders: 10 }),
        makeResult({ protocol: 'usenet', size: 5 * MB }),
      ], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 });
    expect(results).toHaveLength(0);
  });

  it('mixed: only undersized results removed, others retained', () => {
    const tiny = makeResult({ title: 'Tracker test', size: 5 * MB });
    const real = makeResult({ title: 'Real Book', size: 500 * MB });
    const big = makeResult({ title: 'Big Pack', size: 2 * GB });
    const { results } = filterAndRankResults([tiny, real, big], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 });
    expect(results).toHaveLength(2);
    expect(results.map(r => r.title)).toContain('Real Book');
    expect(results.map(r => r.title)).toContain('Big Pack');
    expect(results.map(r => r.title)).not.toContain('Tracker test');
  });

  it('combines with maxDownloadSize: rejects both undersized and oversized', () => {
    const { results } = filterAndRankResults([
        makeResult({ title: 'Tiny', size: 5 * MB }),
        makeResult({ title: 'Just right', size: 500 * MB }),
        makeResult({ title: 'Big', size: 1 * GB }),
        makeResult({ title: 'Huge', size: 6 * GB }),
      ], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50, maxDownloadSize: 5 });
    expect(results.map(r => r.title).sort()).toEqual(['Big', 'Just right']);
  });

  it('min-size drop log carries the correctly-converted minBytes (MB → bytes)', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ title: 'Tracker test', size: 5 * MB })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 },
      log,
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Tracker test',
        reason: 'below-min-size',
        sizeBytes: 5 * MB,
        minBytes: 50 * MB,
      }),
      'Quality filter dropped result',
    );
  });

  it('min-size gate does not fire when minDownloadSize is 0', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ size: 1 * MB })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 0 },
      log,
    );
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'below-min-size' }),
      expect.any(String),
    );
  });

  it('min-size gate does not fire when minDownloadSize is undefined', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ size: 1 * MB })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' },
      log,
    );
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'below-min-size' }),
      expect.any(String),
    );
  });
});

describe('filterAndRankResults — MAM grouped size reaches the gate intact (#2316)', () => {
  const options = { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 } as const;

  it('keeps a 1,008.8 MiB MAM release once the size parses correctly', () => {
    const { results } = filterAndRankResults([makeResult({ size: parseMamSize('1,008.8 MiB') })], undefined, { ...options });
    expect(results).toHaveLength(1);
  });

  it('drops the same release at the pre-fix mangled size', () => {
    const { results } = filterAndRankResults([makeResult({ size: 1048576 })], undefined, { ...options });
    expect(results).toHaveLength(0);
  });
});

describe('filterAndRankResults — size-drop logs name the raw size string (#2316)', () => {
  function dropLogFields(log: FastifyBaseLogger, reason: string): Record<string, unknown> | undefined {
    const call = vi.mocked(log.debug).mock.calls.find(
      ([fields]) => (fields as { reason?: string }).reason === reason,
    );
    return call?.[0] as Record<string, unknown> | undefined;
  }

  it('below-min-size drop log carries rawSize when the result has one', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ title: 'Play of Shadows', size: 1048576, rawSize: '1,008.8 MiB' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 },
      log,
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Play of Shadows', reason: 'below-min-size', sizeBytes: 1048576, rawSize: '1,008.8 MiB' }),
      'Quality filter dropped result',
    );
  });

  it('below-min-size drop log omits the rawSize key when the result has none', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ title: 'Tracker test', size: 5 * MB })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 },
      log,
    );
    const fields = dropLogFields(log, 'below-min-size');
    expect(fields).toBeDefined();
    expect(Object.keys(fields!)).not.toContain('rawSize');
  });

  it('over-max-size drop log carries rawSize when the result has one', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ title: 'Huge', size: 10 * GB, rawSize: '10.0 GiB' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 },
      log,
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Huge', reason: 'over-max-size', sizeBytes: 10 * GB, rawSize: '10.0 GiB' }),
      'Quality filter dropped result',
    );
  });

  it('over-max-size drop log omits the rawSize key when the result has none', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ title: 'Huge', size: 10 * GB })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 },
      log,
    );
    const fields = dropLogFields(log, 'over-max-size');
    expect(fields).toBeDefined();
    expect(Object.keys(fields!)).not.toContain('rawSize');
  });
});

describe('canonicalCompare — grabs tiebreaker (#272)', () => {
  it('higher grabs wins when matchScore, MB/hr, protocol, and language are equal', () => {
    const a = makeResult({ matchScore: 0.9, grabs: 1000, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, grabs: 100, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.grabs).toBe(1000);
    expect(results[1]!.grabs).toBe(100);
  });

  it('title similarity (matchScore > 0.1 diff) beats grabs', () => {
    const a = makeResult({ matchScore: 0.9, grabs: 10 });
    const b = makeResult({ matchScore: 0.5, grabs: 10000 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.matchScore).toBe(0.9);
  });

  it('MB/hr quality beats grabs', () => {
    const a = makeResult({ matchScore: 0.9, size: 1000 * 1024 * 1024, grabs: 10, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, size: 100 * 1024 * 1024, grabs: 10000, seeders: 5 });
    const { results } = filterAndRankResults([b, a], 3600, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.grabs).toBe(10);
  });

  it('grabs=undefined on one result, grabs=1000 on other → result with grabs wins', () => {
    const a = makeResult({ matchScore: 0.9, grabs: 1000, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, grabs: undefined, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.grabs).toBe(1000);
  });

  it('both grabs=undefined → falls through to seeders tiebreaker', () => {
    const a = makeResult({ matchScore: 0.9, grabs: undefined, seeders: 20 });
    const b = makeResult({ matchScore: 0.9, grabs: undefined, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.seeders).toBe(20);
  });

  it('Math.log10(grabs+1) normalization: 10 vs 100 grabs produces meaningful difference', () => {
    // log10(11) ≈ 1.04, log10(101) ≈ 2.00 → clear separation
    const a = makeResult({ matchScore: 0.9, grabs: 100, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, grabs: 10, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.grabs).toBe(100);
    expect(results[1]!.grabs).toBe(10);
  });

  it('grabs=0 → Math.log10(1)=0, lowest-popularity, not treated as missing', () => {
    const a = makeResult({ matchScore: 0.9, grabs: 100, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, grabs: 0, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.grabs).toBe(100);
    expect(results[1]!.grabs).toBe(0);
  });
});

describe('canonicalCompare — language tier (#272)', () => {
  it('language mismatch ranks below matching-language result within same tier', () => {
    const match = makeResult({ matchScore: 0.9, language: 'english', seeders: 5 });
    const mismatch = makeResult({ matchScore: 0.9, language: 'german', seeders: 5 });
    const { results } = filterAndRankResults([mismatch, match], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english'] });
    expect(results[0]!.language).toBe('english');
  });

  it('language mismatch ranks below unknown-language result (absence ≠ mismatch)', () => {
    const unknown = makeResult({ matchScore: 0.9, language: undefined, seeders: 5, title: 'Unknown' });
    const mismatch = makeResult({ matchScore: 0.9, language: 'german', seeders: 5, title: 'German' });
    const { results } = filterAndRankResults([mismatch, unknown], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english'] });
    expect(results).toHaveLength(1);
    expect(results[0]!.language).toBeUndefined();
  });

  it('result with no language field → no penalty applied', () => {
    const noLang = makeResult({ matchScore: 0.9, seeders: 10, title: 'No Lang' });
    const withLang = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, title: 'With Lang' });
    const { results } = filterAndRankResults([withLang, noLang], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english'] });
    expect(results[0]!.seeders).toBe(10);
  });

  it('language tier does not cross 0.1 matchScore gate (title similarity wins)', () => {
    const highScore = makeResult({ matchScore: 0.9, language: 'english', seeders: 5 });
    const lowScore = makeResult({ matchScore: 0.5, language: 'english', seeders: 5 });
    const { results } = filterAndRankResults([lowScore, highScore], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english'] });
    expect(results[0]!.matchScore).toBe(0.9);
  });

  it('empty languages array → no language penalty applied to any result', () => {
    const german = makeResult({ matchScore: 0.9, language: 'german', seeders: 10, title: 'German' });
    const english = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, title: 'English' });
    const { results } = filterAndRankResults([english, german], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.seeders).toBe(10);
  });

  it('language match ranks equal to unknown-language result', () => {
    const match = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, title: 'Match' });
    const unknown = makeResult({ matchScore: 0.9, language: undefined, seeders: 10, title: 'Unknown' });
    const { results } = filterAndRankResults([match, unknown], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english'] });
    expect(results[0]!.seeders).toBe(10);
  });
});

describe('filterAndRankResults — grabs tiebreaker (#272)', () => {
  it('auto-search selects higher-grabs result when title scores are equal', () => {
    const popular = makeResult({ matchScore: 0.9, grabs: 5000, seeders: 5, title: 'Popular' });
    const niche = makeResult({ matchScore: 0.9, grabs: 50, seeders: 5, title: 'Niche' });
    const { results } = filterAndRankResults([niche, popular], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.title).toBe('Popular');
  });
});

describe('canonicalCompare — language array', () => {
  it('no penalty when result language matches any selected language — both kept', () => {
    const english = makeResult({ matchScore: 0.9, language: 'english', seeders: 5 });
    const spanish = makeResult({ matchScore: 0.9, language: 'spanish', seeders: 10 });
    const { results } = filterAndRankResults([english, spanish], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english', 'spanish'] });
    expect(results).toHaveLength(2);
    expect(results[0]!.language).toBe('english');
    expect(results[1]!.language).toBe('spanish');
  });

  it('penalty when result language does not match any selected language', () => {
    const match = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, title: 'Match' });
    const mismatch = makeResult({ matchScore: 0.9, language: 'french', seeders: 10, title: 'Mismatch' });
    const { results } = filterAndRankResults([mismatch, match], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english', 'spanish'] });
    expect(results).toHaveLength(1);
    expect(results[0]!.language).toBe('english');
  });

  it('no penalty when result has no language (pass through)', () => {
    const noLang = makeResult({ matchScore: 0.9, seeders: 10, title: 'No Lang' });
    const match = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, title: 'Match' });
    const { results } = filterAndRankResults([match, noLang], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english'] });
    expect(results).toHaveLength(2);
    expect(results[0]!.seeders).toBe(10);
  });

  it('no penalty when languages array is empty (filtering disabled)', () => {
    const french = makeResult({ matchScore: 0.9, language: 'french', seeders: 10 });
    const german = makeResult({ matchScore: 0.9, language: 'german', seeders: 5 });
    const { results } = filterAndRankResults([german, french], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results).toHaveLength(2);
  });

  it('first entry used as primary for sort ranking — primary language outranks secondary', () => {
    const english = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, grabs: 100, title: 'English' });
    const spanish = makeResult({ matchScore: 0.9, language: 'spanish', seeders: 5, grabs: 100, title: 'Spanish' });
    const { results } = filterAndRankResults([spanish, english], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english', 'spanish'] });
    expect(results[0]!.language).toBe('english');
    expect(results[1]!.language).toBe('spanish');
  });

  it('primary language tiebreaker does not apply with single language', () => {
    const english = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, grabs: 100 });
    const noLang = makeResult({ matchScore: 0.9, seeders: 5, grabs: 100, title: 'No Lang' });
    const { results } = filterAndRankResults([noLang, english], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english'] });
    expect(results).toHaveLength(2);
  });
});

describe('filterAndRankResults — language filtering', () => {
  it('excludes results with explicit non-matching language', () => {
    const french = makeResult({ language: 'french', title: 'French Book' });
    const english = makeResult({ language: 'english', title: 'English Book' });
    const { results } = filterAndRankResults([french, english], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english'] });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('English Book');
  });

  it('includes results matching any selected language', () => {
    const spanish = makeResult({ language: 'spanish', title: 'Spanish Book' });
    const english = makeResult({ language: 'english', title: 'English Book' });
    const { results } = filterAndRankResults([spanish, english], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english', 'spanish'] });
    expect(results).toHaveLength(2);
  });

  it('passes through results with undefined language', () => {
    const noLang = makeResult({ language: undefined, title: 'Unknown Lang' });
    const { results } = filterAndRankResults([noLang], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english'] });
    expect(results).toHaveLength(1);
  });

  it('passes through results with empty string language', () => {
    const emptyLang = makeResult({ language: '', title: 'Empty Lang' });
    const { results } = filterAndRankResults([emptyLang], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english'] });
    expect(results).toHaveLength(1);
  });

  it('no filtering when languages array is empty', () => {
    const french = makeResult({ language: 'french' });
    const { results } = filterAndRankResults([french], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results).toHaveLength(1);
  });

  it('normalizes language comparison to lowercase', () => {
    const upper = makeResult({ language: 'English', title: 'Upper' });
    const { results } = filterAndRankResults([upper], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english'] });
    expect(results).toHaveLength(1);
  });
});

describe('filterAndRankResults — gate ordering (#945)', () => {
  it('result failing reject-word AND min-seeders is logged only under reject-word (earlier gate wins)', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ title: 'BANNED Book', protocol: 'torrent', seeders: 0 })],
      undefined,
      { grabFloor: 0, minSeeders: 5, protocolPreference: 'none', rejectWords: 'banned' },
      log,
    );
    const debugCalls = vi.mocked(log.debug).mock.calls;
    const rejectCalls = debugCalls.filter(c => (c[0] as Record<string, unknown>)?.reason === 'reject-word-match');
    const seederCalls = debugCalls.filter(c => (c[0] as Record<string, unknown>)?.reason === 'below-min-seeders');
    expect(rejectCalls).toHaveLength(1);
    expect(seederCalls).toHaveLength(0);
  });

  it('preserves canonical gate order: reject-word → required-word → ebook-only → min-seeders → grab-floor → max-size', () => {
    const log = createMockLogger();
    const rejectAndRequired = makeResult({ title: 'BANNED extra', protocol: 'torrent', seeders: 10 });
    const requiredAndEbook = makeResult({ title: 'Plain EPUB only', protocol: 'torrent', seeders: 10 });
    const ebookAndSeeders = makeResult({ title: 'audiobook EPUB only', protocol: 'torrent', seeders: 0 });
    filterAndRankResults(
      [rejectAndRequired, requiredAndEbook, ebookAndSeeders],
      undefined,
      { grabFloor: 0, minSeeders: 5, protocolPreference: 'none', rejectWords: 'banned', requiredWords: 'audiobook' },
      log,
    );
    const calls = vi.mocked(log.debug).mock.calls;
    const reasonsByTitle = new Map<string, string[]>();
    for (const [arg] of calls) {
      const payload = arg as Record<string, unknown>;
      const t = payload.title as string;
      const reasons = reasonsByTitle.get(t) ?? [];
      reasons.push(payload.reason as string);
      reasonsByTitle.set(t, reasons);
    }
    expect(reasonsByTitle.get('BANNED extra')).toEqual(['reject-word-match']);
    expect(reasonsByTitle.get('Plain EPUB only')).toEqual(['required-word-missing']);
    expect(reasonsByTitle.get('audiobook EPUB only')).toEqual(['ebook-only-format']);
  });
});

describe('filterAndRankResults — disabled-gate short-circuit (#945)', () => {
  it('reject-word gate does not fire when rejectWords is empty', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ title: 'Anything goes' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: '' },
      log,
    );
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'reject-word-match' }),
      expect.any(String),
    );
  });

  it('reject-word gate does not fire when rejectWords is undefined', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ title: 'Anything goes' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' },
      log,
    );
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'reject-word-match' }),
      expect.any(String),
    );
  });

  it('reject-word gate matches "Sample" at word boundary in "Sample.Audiobook.MP3"', () => {
    const log = createMockLogger();
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Sample.Audiobook.MP3', nzbName: 'Sample.Audiobook.MP3' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'Sample' },
      log,
    );
    expect(results).toHaveLength(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'reject-word-match', matchedWord: 'sample' }),
      'Quality filter dropped result',
    );
  });

  it('reject-word gate does NOT match "Sample" against "Sampleyana" (no word boundary inside word)', () => {
    const log = createMockLogger();
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Sampleyana.Audiobook.MP3', nzbName: 'Sampleyana.Audiobook.MP3' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'Sample' },
      log,
    );
    expect(results).toHaveLength(1);
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'reject-word-match' }),
      expect.any(String),
    );
  });

  it('reject-word gate does NOT match "Abridged" against "unabridged" release (the abridged/unabridged collision)', () => {
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Dune.Unabridged.M4B', nzbName: 'Dune.Unabridged.M4B' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'Abridged' },
    );
    expect(results).toHaveLength(1);
  });

  it('reject-word gate drops result with reject word in narrator', () => {
    const log = createMockLogger();
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Grave Peril', narrator: 'GraphicAudio' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'GraphicAudio' },
      log,
    );
    expect(results).toHaveLength(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'reject-word-match', matchedWord: 'graphicaudio' }),
      'Quality filter dropped result',
    );
  });

  it('reject-word gate drops result with reject word in author', () => {
    const log = createMockLogger();
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Some Book', author: 'Banned Author' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'Banned Author' },
      log,
    );
    expect(results).toHaveLength(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'reject-word-match', matchedWord: 'banned author' }),
      'Quality filter dropped result',
    );
  });

  it('reject-word gate still drops result with reject word only in title (no regression)', () => {
    const { results } = filterAndRankResults(
      [makeResult({ title: 'BANNED Book Title', narrator: 'Good Narrator', author: 'Good Author' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'BANNED' },
    );
    expect(results).toHaveLength(0);
  });

  it('reject-word gate drops result with reject word in rawTitle even when nzbName is clean', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: 'Clean.NZB.Name', rawTitle: 'BANNED Edition', title: 'Good Title' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'BANNED' },
    );
    expect(results).toHaveLength(0);
  });

  it('reject-word gate drops result with reject word in title even when nzbName and rawTitle are clean', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: 'Clean.NZB.Name', rawTitle: 'Clean Raw Title', title: 'BANNED Book' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'BANNED' },
    );
    expect(results).toHaveLength(0);
  });

  it('reject-word gate passes result with no reject word match in any field', () => {
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Good Book', narrator: 'Great Narrator', author: 'Fine Author' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'BANNED' },
    );
    expect(results).toHaveLength(1);
  });

  it('reject-word gate respects word boundaries in narrator — "GraphicAudio" does not match "GraphicAudiobook"', () => {
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Some Book', narrator: 'GraphicAudiobook' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'GraphicAudio' },
    );
    expect(results).toHaveLength(1);
  });

  it('reject-word gate does not crash on undefined author and narrator', () => {
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Some Book', author: undefined, narrator: undefined })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'BANNED' },
    );
    expect(results).toHaveLength(1);
  });

  it('reject-word gate does not false-match on empty-string author', () => {
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Some Book', author: '' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'BANNED' },
    );
    expect(results).toHaveLength(1);
  });

  it('reject-word gate matches case-insensitively in narrator', () => {
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Some Book', narrator: 'graphicaudio' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'GraphicAudio' },
    );
    expect(results).toHaveLength(0);
  });

  it('required-word gate does not fire when requiredWords is empty', () => {
    const log = createMockLogger();
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Plain title' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', requiredWords: '' },
      log,
    );
    expect(results).toHaveLength(1);
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'required-word-missing' }),
      expect.any(String),
    );
  });

  it('required-word gate keeps result when required word is only in rawTitle (nzbName populated, non-matching)', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: 'Clean.NZB.Name', rawTitle: 'The Book Unabridged Edition', title: 'Good Title' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', requiredWords: 'unabridged' },
    );
    expect(results).toHaveLength(1);
  });

  it('required-word gate keeps result when required word is only in title (nzbName populated, non-matching)', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: 'Clean.NZB.Name', rawTitle: 'Clean Raw Title', title: 'The Book Unabridged' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', requiredWords: 'unabridged' },
    );
    expect(results).toHaveLength(1);
  });

  it('required-word gate keeps result when required word is only in author (nzbName populated, non-matching)', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: 'Clean.NZB.Name', title: 'Good Title', author: 'Brandon Sanderson' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', requiredWords: 'Sanderson' },
    );
    expect(results).toHaveLength(1);
  });

  it('required-word gate keeps result when required word is only in narrator (nzbName populated, non-matching)', () => {
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: 'Clean.NZB.Name', title: 'Good Title', narrator: 'Michael Kramer' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', requiredWords: 'Kramer' },
    );
    expect(results).toHaveLength(1);
  });

  it('required-word gate does NOT match "abridged" inside "unabridged" (word boundary)', () => {
    const log = createMockLogger();
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Dune.Unabridged.M4B', nzbName: 'Dune.Unabridged.M4B' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', requiredWords: 'abridged' },
      log,
    );
    expect(results).toHaveLength(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'required-word-missing', dropped: true }),
      'Quality filter dropped result',
    );
  });

  it('required-word gate matches "mp3" at word boundary in "Sample.Audiobook.MP3"', () => {
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Sample.Audiobook.MP3', nzbName: 'Sample.Audiobook.MP3' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', requiredWords: 'mp3' },
    );
    expect(results).toHaveLength(1);
  });

  it('required-word gate drops and logs result with no required word on any surface', () => {
    const log = createMockLogger();
    const { results } = filterAndRankResults(
      [makeResult({ nzbName: 'Plain NZB', rawTitle: 'Plain Raw', title: 'Plain Title', author: 'Plain Author', narrator: 'Plain Narrator' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', requiredWords: 'unabridged' },
      log,
    );
    expect(results).toHaveLength(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'required-word-missing', dropped: true }),
      'Quality filter dropped result',
    );
  });

  it('required-word gate does not fire when requiredWords is undefined', () => {
    const log = createMockLogger();
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Plain title' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' },
      log,
    );
    expect(results).toHaveLength(1);
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'required-word-missing' }),
      expect.any(String),
    );
  });

  it('max-size gate does not fire when maxDownloadSize is 0', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ size: 100 * GB })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 0 },
      log,
    );
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'over-max-size' }),
      expect.any(String),
    );
  });

  it('max-size gate does not fire when maxDownloadSize is undefined', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ size: 100 * GB })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' },
      log,
    );
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'over-max-size' }),
      expect.any(String),
    );
  });

  it('language gate does not fire when languages is empty', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ title: 'Mystery Book', language: undefined })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] },
      log,
    );
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'language-mismatch' }),
      expect.any(String),
    );
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'language-undetermined' }),
      expect.any(String),
    );
  });
});

describe('filterAndRankResults — closure-scoped gate variables (#945)', () => {
  it('grab-floor drop log carries the per-result mbPerHour, not a hoisted/shared value', () => {
    const log = createMockLogger();
    const small = makeResult({ title: 'Small', size: 50 * 1024 * 1024 });
    const tiny = makeResult({ title: 'Tiny', size: 10 * 1024 * 1024 });
    filterAndRankResults(
      [small, tiny],
      3600,
      { grabFloor: 100, minSeeders: 0, protocolPreference: 'none' },
      log,
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Small', reason: 'below-grab-floor', mbPerHour: 50, grabFloor: 100 }),
      'Quality filter dropped result',
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Tiny', reason: 'below-grab-floor', mbPerHour: 10, grabFloor: 100 }),
      'Quality filter dropped result',
    );
  });

  it('max-size drop log carries the correctly-converted maxBytes (GB → bytes)', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ title: 'Huge', size: 10 * GB })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 },
      log,
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Huge',
        reason: 'over-max-size',
        sizeBytes: 10 * GB,
        maxBytes: 5 * GB,
      }),
      'Quality filter dropped result',
    );
  });

  it('min-seeders drop log carries the per-result seeders count and the configured minSeeders', () => {
    const log = createMockLogger();
    filterAndRankResults(
      [makeResult({ title: 'LowSeed', protocol: 'torrent', seeders: 1 })],
      undefined,
      { grabFloor: 0, minSeeders: 5, protocolPreference: 'none' },
      log,
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'LowSeed',
        reason: 'below-min-seeders',
        seeders: 1,
        minSeeders: 5,
      }),
      'Quality filter dropped result',
    );
  });
});

describe('#392 searchAndGrabForBook with broadcaster', () => {
  let indexerSearchService: IndexerSearchService;
  let downloadService: DownloadOrchestrator;
  let broadcaster: EventBroadcasterService;
  let blacklistService: BlacklistService;
  let log: FastifyBaseLogger;
  let eventHistory: EventHistoryService;

  const book = { id: 1, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };

  beforeEach(() => {
    broadcaster = {
      emit: vi.fn(),
    } as unknown as EventBroadcasterService;

    blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set<string>(),
      }),
    } as unknown as BlacklistService;

    eventHistory = createMockEventHistory();
    log = createMockLogger();

    downloadService = {
      grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }),
    } as unknown as DownloadOrchestrator;

    indexerSearchService = {
      searchAllStreaming: vi.fn().mockImplementation(
        async (_query: string, _options: unknown, _controllers: Map<number, AbortController>, callbacks: { onComplete: (id: number, name: string, count: number, ms: number) => void }) => {
          callbacks.onComplete(10, 'MAM', 1, 500);
          return [makeResult({ indexerId: 10 })];
        },
      ),
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
    } as unknown as IndexerSearchService;
  });

  describe('search_started emission', () => {
    it('emits search_started with correct indexer list before querying', async () => {
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(broadcaster.emit).toHaveBeenCalledWith('search_started', {
        book_id: 1,
        book_title: 'Test Book',
        indexers: [{ id: 10, name: 'MAM' }],
      });
    });

    it('emits search_started even when no enabled indexers (empty list)', async () => {
      vi.mocked(indexerSearchService.getEnabledIndexers).mockResolvedValue([]);
      vi.mocked(indexerSearchService.searchAllStreaming).mockResolvedValue([]);
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(broadcaster.emit).toHaveBeenCalledWith('search_started', {
        book_id: 1,
        book_title: 'Test Book',
        indexers: [],
      });
    });
  });

  describe('per-indexer events', () => {
    it('emits search_indexer_complete with results_found and elapsed_ms for each successful indexer', async () => {
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(broadcaster.emit).toHaveBeenCalledWith('search_indexer_complete', {
        book_id: 1,
        indexer_id: 10,
        indexer_name: 'MAM',
        results_found: 1,
        elapsed_ms: 500,
      });
    });

    it('emits search_indexer_error with error message and elapsed_ms when indexer throws', async () => {
      vi.mocked(indexerSearchService.searchAllStreaming).mockImplementation(
        async (_q, _o, _c, callbacks) => {
          callbacks.onError(10, 'MAM', 'timeout', 30000);
          return [];
        },
      );
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(broadcaster.emit).toHaveBeenCalledWith('search_indexer_error', {
        book_id: 1,
        indexer_id: 10,
        indexer_name: 'MAM',
        error: 'timeout',
        elapsed_ms: 30000,
      });
    });

    it('emits search_indexer_complete with results_found: 0 for indexer returning empty results', async () => {
      vi.mocked(indexerSearchService.searchAllStreaming).mockImplementation(
        async (_q, _o, _c, callbacks) => {
          callbacks.onComplete(10, 'MAM', 0, 200);
          return [];
        },
      );
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(broadcaster.emit).toHaveBeenCalledWith('search_indexer_complete', {
        book_id: 1,
        indexer_id: 10,
        indexer_name: 'MAM',
        results_found: 0,
        elapsed_ms: 200,
      });
    });
  });

  describe('outcome events', () => {
    it('emits search_grabbed then search_complete with outcome grabbed on successful grab', async () => {
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      const emitCalls = vi.mocked(broadcaster.emit).mock.calls;
      const grabbedCall = emitCalls.find(c => c[0] === 'search_grabbed');
      const completeCall = emitCalls.find(c => c[0] === 'search_complete');
      expect(grabbedCall).toBeDefined();
      expect(grabbedCall![1]).toEqual({
        book_id: 1,
        release_title: 'Test Book',
        indexer_name: 'MAM',
      });
      expect(completeCall).toBeDefined();
      expect(completeCall![1]).toEqual({
        book_id: 1,
        total_results: 1,
        outcome: 'grabbed',
      });
      const grabbedIdx = emitCalls.indexOf(grabbedCall!);
      const completeIdx = emitCalls.indexOf(completeCall!);
      expect(grabbedIdx).toBeLessThan(completeIdx);
    });

    it('emits search_complete with outcome no_results when raw results are empty', async () => {
      vi.mocked(indexerSearchService.searchAllStreaming).mockResolvedValue([]);
      vi.mocked(indexerSearchService.getEnabledIndexers).mockResolvedValue([]);
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', {
        book_id: 1,
        total_results: 0,
        outcome: 'no_results',
      });
    });

    it('emits search_complete with outcome no_results when all results filtered out', async () => {
      vi.mocked(indexerSearchService.searchAllStreaming).mockImplementation(
        async (_q, _o, _c, callbacks) => {
          callbacks.onComplete(10, 'MAM', 1, 300);
          return [makeResult({ size: 100 })];
        },
      );
      const settings = { ...defaultQualitySettings, grabFloor: 999 };
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: settings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', expect.objectContaining({
        outcome: 'no_results',
      }));
      expect(broadcaster.emit).not.toHaveBeenCalledWith('search_grabbed', expect.anything());
    });

    it('filters oversized results via maxDownloadSize in broadcaster path and logs quality gate', async () => {
  
      vi.mocked(indexerSearchService.searchAllStreaming).mockImplementation(
        async (_q, _o, _c, callbacks) => {
          callbacks.onComplete(10, 'MAM', 1, 300);
          return [makeResult({ size: 10 * GB })];
        },
      );
      const settings = { ...defaultQualitySettings, maxDownloadSize: 5 };
      const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: settings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(result).toEqual({ result: 'no_results' });
      expect(downloadService.grab).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(
        { inputCount: 1, outputCount: 0 },
        'Quality gate filtering applied',
      );
    });

    it('emits search_complete with outcome skipped on DuplicateDownloadError (not search_grabbed)', async () => {
      vi.mocked(downloadService.grab).mockRejectedValue(new DuplicateDownloadError('Active download exists', 'ACTIVE_DOWNLOAD_EXISTS', { active: { title: 'A Book', count: 1 } }));
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(broadcaster.emit).not.toHaveBeenCalledWith('search_grabbed', expect.anything());
      expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', expect.objectContaining({
        outcome: 'skipped',
      }));
    });

    it('emits search_complete with outcome grab_error on generic grab error', async () => {
      vi.mocked(downloadService.grab).mockRejectedValue(new Error('Connection refused'));
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(broadcaster.emit).not.toHaveBeenCalledWith('search_grabbed', expect.anything());
      expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', expect.objectContaining({
        outcome: 'grab_error',
      }));
    });

    it('search_complete grab_error payload carries book_title, release_title, and error_message', async () => {
      vi.mocked(downloadService.grab).mockRejectedValue(new Error('Connection refused'));
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', {
        book_id: 1,
        total_results: 1,
        outcome: 'grab_error',
        book_title: 'Test Book',
        error_message: 'Connection refused',
        release_title: 'Test Book',
      });
    });

    it('records grab_failed event via eventHistory on grab_error (broadcaster path)', async () => {
      vi.mocked(downloadService.grab).mockRejectedValue(new Error('Connection refused'));
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 1,
        bookTitle: 'Test Book',
        eventType: 'grab_failed',
        source: 'auto',
        reason: { error: 'Connection refused', release_title: 'Test Book' },
      }));
    });

    it('substitutes "Unknown grab error" when grab error.message is empty', async () => {
      vi.mocked(downloadService.grab).mockRejectedValue(new Error(''));
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', expect.objectContaining({
        outcome: 'grab_error',
        error_message: 'Unknown grab error',
      }));
      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'grab_failed',
        reason: { error: 'Unknown grab error', release_title: 'Test Book' },
      }));
    });

    it('grabbed outcome omits book_title / release_title / error_message from search_complete payload', async () => {
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      const completeCalls = vi.mocked(broadcaster.emit).mock.calls.filter(c => c[0] === 'search_complete');
      const completePayload = completeCalls[0]![1] as Record<string, unknown>;
      expect(completePayload).not.toHaveProperty('book_title');
      expect(completePayload).not.toHaveProperty('release_title');
      expect(completePayload).not.toHaveProperty('error_message');
      expect(eventHistory.create).not.toHaveBeenCalled();
    });

    it('total_results in search_complete sums across all indexers', async () => {
      vi.mocked(indexerSearchService.getEnabledIndexers).mockResolvedValue([{ id: 10, name: 'MAM' }, { id: 20, name: 'ABB' }]);
      vi.mocked(indexerSearchService.searchAllStreaming).mockImplementation(
        async (_q, _o, _c, callbacks) => {
          callbacks.onComplete(10, 'MAM', 3, 500);
          callbacks.onComplete(20, 'ABB', 2, 800);
          return [makeResult({ indexerId: 10 }), makeResult({ indexerId: 10 }), makeResult({ indexerId: 10 }), makeResult({ indexerId: 20 }), makeResult({ indexerId: 20 })];
        },
      );
      await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', expect.objectContaining({
        total_results: 5,
      }));
    });
  });

  describe('backwards compatibility', () => {
    it('no events emitted when broadcaster is not provided', async () => {
      indexerSearchService = {
        searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult()])),
      } as unknown as IndexerSearchService;
      const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
      expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    });
  });

  describe('fire-and-forget safety', () => {
    it('broadcaster.emit() throwing does not break search pipeline', async () => {
      vi.mocked(broadcaster.emit).mockImplementation(() => { throw new Error('SSE write failed'); });
      const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(result.result).toBe('grabbed');
    });

    it('search still returns correct result when broadcaster fails', async () => {
      vi.mocked(broadcaster.emit).mockImplementation(() => { throw new Error('SSE write failed'); });
      vi.mocked(indexerSearchService.searchAllStreaming).mockResolvedValue([]);
      vi.mocked(indexerSearchService.getEnabledIndexers).mockResolvedValue([]);
      const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
      expect(result).toEqual({ result: 'no_results' });
    });
  });
});

describe('#1310 searchAndGrabForBook broadcaster/non-broadcaster parity', () => {
  let blacklistService: BlacklistService;
  let log: FastifyBaseLogger;
  let eventHistory: EventHistoryService;

  const book = { id: 1, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };

  beforeEach(() => {
    blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set<string>(),
      }),
    } as unknown as BlacklistService;
    eventHistory = createMockEventHistory();
    log = createMockLogger();
  });

  // Both search methods return the same results, isolating entry-point wiring.
  function makeParityIndexer(results: SearchResult[]): IndexerSearchService {
    return {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus(results)),
      searchAllStreaming: vi.fn().mockImplementation(
        async (_q: string, _o: unknown, _c: Map<number, AbortController>, callbacks: { onComplete: (id: number, name: string, count: number, ms: number) => void }) => {
          callbacks.onComplete(10, 'MAM', results.length, 500);
          return results;
        },
      ),
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
    } as unknown as IndexerSearchService;
  }

  const grabError = new Error('Connection refused');

  const cases: Array<{
    name: string;
    results: SearchResult[];
    grab: () => ReturnType<typeof vi.fn>;
    expected: SingleBookSearchResult;
  }> = [
    {
      name: 'grabbed',
      results: [makeResult({ indexerId: 10 })],
      grab: () => vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }),
      expected: { result: 'grabbed', title: 'Test Book' },
    },
    {
      name: 'no_results (empty result set)',
      results: [],
      grab: () => vi.fn(),
      expected: { result: 'no_results' },
    },
    {
      name: 'no_results (no result has a downloadUrl)',
      results: [makeResult({ indexerId: 10, downloadUrl: undefined })],
      grab: () => vi.fn(),
      expected: { result: 'no_results' },
    },
    {
      name: 'skipped (DuplicateDownloadError)',
      results: [makeResult({ indexerId: 10 })],
      grab: () => vi.fn().mockRejectedValue(new DuplicateDownloadError('Active download exists', 'ACTIVE_DOWNLOAD_EXISTS', { active: { title: 'A Book', count: 1 } })),
      expected: { result: 'skipped', reason: 'grab_blocked' },
    },
    {
      name: 'grab_error (generic grab rejection)',
      results: [makeResult({ indexerId: 10 })],
      grab: () => vi.fn().mockRejectedValue(grabError),
      expected: { result: 'grab_error', error: grabError },
    },
  ];

  for (const c of cases) {
    it(`produces identical ${c.name} outcome on both paths`, async () => {
      // Share the mock so rejected errors have identical object identity.
      const grab = c.grab();
      const downloadOrchestrator = { grab } as unknown as DownloadOrchestrator;
      const baseDeps = {
        downloadOrchestrator,
        qualitySettings: defaultQualitySettings,
        log,
        blacklistService,
        indexerService: mockIndexer,
        eventHistory,
      };

      const broadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const broadcasterResult = await searchAndGrabForBook(book, {
        ...baseDeps,
        indexerSearchService: makeParityIndexer(c.results),
        broadcaster,
      });

      const nonBroadcasterResult = await searchAndGrabForBook(book, {
        ...baseDeps,
        indexerSearchService: makeParityIndexer(c.results),
      });

      expect(broadcasterResult).toEqual(c.expected);
      expect(nonBroadcasterResult).toEqual(c.expected);
      expect(broadcasterResult).toEqual(nonBroadcasterResult);
    });
  }

  it('records the grab failure exactly once on each path (not zero or twice)', async () => {
    const downloadOrchestrator = { grab: vi.fn().mockRejectedValue(grabError) } as unknown as DownloadOrchestrator;
    const baseDeps = {
      downloadOrchestrator,
      qualitySettings: defaultQualitySettings,
      log,
      blacklistService,
      indexerService: mockIndexer,
    };

    const broadcasterEventHistory = createMockEventHistory();
    await searchAndGrabForBook(book, {
      ...baseDeps,
      indexerSearchService: makeParityIndexer([makeResult({ indexerId: 10 })]),
      eventHistory: broadcasterEventHistory,
      broadcaster: { emit: vi.fn() } as unknown as EventBroadcasterService,
    });
    expect(broadcasterEventHistory.create).toHaveBeenCalledTimes(1);

    const nonBroadcasterEventHistory = createMockEventHistory();
    await searchAndGrabForBook(book, {
      ...baseDeps,
      indexerSearchService: makeParityIndexer([makeResult({ indexerId: 10 })]),
      eventHistory: nonBroadcasterEventHistory,
    });
    expect(nonBroadcasterEventHistory.create).toHaveBeenCalledTimes(1);
  });

  it('selects the identical result from a multi-candidate ranked set on both paths (#1330)', async () => {
    // Undefined and empty-string URLs outrank the explicit winner but are both ungrabbable.
    // makeResult deletes undefined overrides while preserving the empty string.
    const candidates = [
      makeResult({ indexerId: 10, title: 'Top Ranked No URL', matchScore: 0.99, seeders: 50, downloadUrl: undefined }),
      makeResult({ indexerId: 10, title: 'Empty URL Row', matchScore: 0.95, seeders: 40, downloadUrl: '' }),
      makeResult({ indexerId: 10, title: 'The Real Winner', guid: 'winner-guid', matchScore: 0.90, seeders: 30, downloadUrl: 'magnet:?xt=urn:btih:winner' }),
      makeResult({ indexerId: 10, title: 'Lower Ranked', guid: 'loser-guid', matchScore: 0.50, seeders: 5, downloadUrl: 'magnet:?xt=urn:btih:loser' }),
    ];
    const grab = vi.fn().mockResolvedValue({ id: 1, status: 'downloading' });
    const downloadOrchestrator = { grab } as unknown as DownloadOrchestrator;
    const baseDeps = {
      downloadOrchestrator,
      qualitySettings: defaultQualitySettings,
      log,
      blacklistService,
      indexerService: mockIndexer,
      eventHistory,
    };

    const broadcasterResult = await searchAndGrabForBook(book, {
      ...baseDeps,
      indexerSearchService: makeParityIndexer(candidates),
      broadcaster: { emit: vi.fn() } as unknown as EventBroadcasterService,
    });
    const nonBroadcasterResult = await searchAndGrabForBook(book, {
      ...baseDeps,
      indexerSearchService: makeParityIndexer(candidates),
    });

    expect(broadcasterResult).toEqual({ result: 'grabbed', title: 'The Real Winner' });
    expect(nonBroadcasterResult).toEqual(broadcasterResult);

    expect(grab).toHaveBeenCalledTimes(2);
    expect(grab.mock.calls[1]![0]).toEqual(grab.mock.calls[0]![0]);
    expect(grab.mock.calls[0]![0]).toEqual(expect.objectContaining({ guid: 'winner-guid' }));
  });
});

describe('canonicalCompare — indexer priority tiebreaker (#394)', () => {
  it('lower indexerPriority wins when all higher tiers are equal', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 10, grabs: 50, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 50, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.indexerPriority).toBe(10);
    expect(results[1]!.indexerPriority).toBe(50);
  });

  it('missing indexerPriority (undefined) treated as Infinity — loses to any defined priority', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 50, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: undefined, grabs: 50, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.indexerPriority).toBe(50);
    expect(results[1]!.indexerPriority).toBeUndefined();
  });

  it('equal indexerPriority falls through to grabs tier', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 1000, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 10, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.grabs).toBe(1000);
    expect(results[1]!.grabs).toBe(10);
  });

  it('priority tier does NOT override matchScore', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 99 });
    const b = makeResult({ matchScore: 0.5, indexerPriority: 1 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.matchScore).toBe(0.9);
  });

  it('priority tier does NOT override protocol preference', () => {
    const a = makeResult({ matchScore: 0.9, protocol: 'torrent', indexerPriority: 99 });
    const b = makeResult({ matchScore: 0.9, protocol: 'usenet', indexerPriority: 1 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'torrent', languages: [] });
    expect(results[0]!.protocol).toBe('torrent');
  });

  it('priority tier does NOT override MB/hr when duration is known', () => {
    const a = makeResult({ matchScore: 0.9, size: 1000 * 1024 * 1024, indexerPriority: 99, grabs: 50, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, size: 100 * 1024 * 1024, indexerPriority: 1, grabs: 50, seeders: 5 });
    const { results } = filterAndRankResults([b, a], 3600, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.indexerPriority).toBe(99);
  });

  it('priority tier does NOT override language tier', () => {
    const a = makeResult({ matchScore: 0.9, language: 'english', indexerPriority: 99, grabs: 50, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, language: 'german', indexerPriority: 1, grabs: 50, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: ['english'] });
    expect(results[0]!.language).toBe('english');
  });

  it('priority 1 (best) vs priority 100 (worst) — 1 wins', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 1, grabs: 50, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: 100, grabs: 50, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.indexerPriority).toBe(1);
  });

  it('priority 50 vs priority 50 — falls through to grabs', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 500, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 5, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.grabs).toBe(500);
  });

  it('both undefined — falls through to grabs (Infinity === Infinity)', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: undefined, grabs: 800, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: undefined, grabs: 10, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.grabs).toBe(800);
  });

  it('one undefined vs one defined — defined value wins', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 100, grabs: 50, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: undefined, grabs: 50, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.indexerPriority).toBe(100);
  });
});

describe('filterAndRankResults — indexer priority integration (#394)', () => {
  it('results from indexer with priority 10 rank above priority 50 when all other factors equal', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 10, grabs: 50, seeders: 5, indexer: 'MAM' });
    const b = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 50, seeders: 5, indexer: 'Torznab' });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.indexer).toBe('MAM');
    expect(results[1]!.indexer).toBe('Torznab');
  });

  it('all indexers sharing same priority produces identical ordering to current behavior', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 1000, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 10, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', languages: [] });
    expect(results[0]!.grabs).toBe(1000);
    expect(results[1]!.grabs).toBe(10);
  });
});

describe('filterBlacklistedResults', () => {
  let blacklistService: BlacklistService;

  beforeEach(() => {
    blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set<string>(),
      }),
    } as unknown as BlacklistService;
  });

  it('filters result with blacklisted infoHash', async () => {
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['hash1']),
      blacklistedGuids: new Set(),
    });
    const results = [makeResult({ infoHash: 'hash1' })];
    const filtered = await filterBlacklistedResults(results, blacklistService);
    expect(filtered).toHaveLength(0);
    expect(blacklistService.getBlacklistedIdentifiers).toHaveBeenCalledWith(['hash1'], []);
  });

  it('filters result with blacklisted guid', async () => {
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(),
      blacklistedGuids: new Set(['guid1']),
    });
    const results = [makeResult({ guid: 'guid1' })];
    const filtered = await filterBlacklistedResults(results, blacklistService);
    expect(filtered).toHaveLength(0);
    expect(blacklistService.getBlacklistedIdentifiers).toHaveBeenCalledWith([], ['guid1']);
  });

  it('filters result with both identifiers when only hash is blacklisted', async () => {
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['hash1']),
      blacklistedGuids: new Set(),
    });
    const results = [makeResult({ infoHash: 'hash1', guid: 'guid1' })];
    const filtered = await filterBlacklistedResults(results, blacklistService);
    expect(filtered).toHaveLength(0);
  });

  it('filters result with both identifiers when only guid is blacklisted', async () => {
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(),
      blacklistedGuids: new Set(['guid1']),
    });
    const results = [makeResult({ infoHash: 'hash1', guid: 'guid1' })];
    const filtered = await filterBlacklistedResults(results, blacklistService);
    expect(filtered).toHaveLength(0);
  });

  it('passes through result with neither infoHash nor guid', async () => {
    const results = [makeResult({ infoHash: undefined, guid: undefined })];
    const filtered = await filterBlacklistedResults(results, blacklistService);
    expect(filtered).toHaveLength(1);
    expect(blacklistService.getBlacklistedIdentifiers).not.toHaveBeenCalled();
  });

  it('returns only clean results from a mixed set', async () => {
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['bad-hash']),
      blacklistedGuids: new Set(),
    });
    const clean = makeResult({ infoHash: 'good-hash', title: 'Clean' });
    const blacklisted = makeResult({ infoHash: 'bad-hash', title: 'Blacklisted' });
    const filtered = await filterBlacklistedResults([blacklisted, clean], blacklistService);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.title).toBe('Clean');
  });

  it('returns empty array when all results are blacklisted', async () => {
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['h1', 'h2']),
      blacklistedGuids: new Set(),
    });
    const results = [makeResult({ infoHash: 'h1' }), makeResult({ infoHash: 'h2' })];
    const filtered = await filterBlacklistedResults(results, blacklistService);
    expect(filtered).toHaveLength(0);
  });

  it('returns results unchanged when input array is empty', async () => {
    const filtered = await filterBlacklistedResults([], blacklistService);
    expect(filtered).toHaveLength(0);
    expect(blacklistService.getBlacklistedIdentifiers).not.toHaveBeenCalled();
  });

  it('returns results unchanged when getBlacklistedIdentifiers returns empty sets', async () => {
    const results = [makeResult({ infoHash: 'hash1', guid: 'guid1' })];
    const filtered = await filterBlacklistedResults(results, blacklistService);
    expect(filtered).toHaveLength(1);
  });

  it('emits a per-drop debug log when a logger is provided (AC3)', async () => {
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['hash1']),
      blacklistedGuids: new Set(),
    });
    const results = [makeResult({ infoHash: 'hash1', guid: 'guid1', title: 'Filtered Book' })];
    const log = createMockLogger();
    await filterBlacklistedResults(results, blacklistService, log);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Filtered Book', reason: 'blacklist-match', matchedRule: 'hash' }),
      'Blacklisted result dropped',
    );
  });

  it('reports matchedRule "guid" when only guid is blacklisted (AC3)', async () => {
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(),
      blacklistedGuids: new Set(['guid1']),
    });
    const results = [makeResult({ guid: 'guid1', title: 'Filtered Book' })];
    const log = createMockLogger();
    await filterBlacklistedResults(results, blacklistService, log);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Filtered Book', matchedRule: 'guid' }),
      'Blacklisted result dropped',
    );
  });
});

describe('#406 searchAndGrabForBook blacklist filtering', () => {
  const book = { id: 1, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };
  let indexerSearchService: IndexerSearchService;
  let downloadService: DownloadOrchestrator;
  let blacklistService: BlacklistService;
  let log: FastifyBaseLogger;

  beforeEach(() => {
    downloadService = {
      grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }),
    } as unknown as DownloadOrchestrator;
    blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set<string>(),
      }),
    } as unknown as BlacklistService;
    log = createMockLogger();
  });

  it('filters blacklisted results before ranking — non-broadcaster path', async () => {
    const clean = makeResult({ infoHash: 'good', title: 'Clean', seeders: 5 });
    const blacklisted = makeResult({ infoHash: 'bad', title: 'Blacklisted', seeders: 100 });
    indexerSearchService = { searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([blacklisted, clean])) } as unknown as IndexerSearchService;
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['bad']),
      blacklistedGuids: new Set(),
    });

    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result.result).toBe('grabbed');
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ title: 'Clean' }));
  });

  it('returns no_results when all results are blacklisted — non-broadcaster path', async () => {
    indexerSearchService = { searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult({ infoHash: 'h1' }), makeResult({ infoHash: 'h2' })])) } as unknown as IndexerSearchService;
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['h1', 'h2']),
      blacklistedGuids: new Set(),
    });

    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
  });

  it('grabs only clean results when mix of blacklisted and clean — non-broadcaster path', async () => {
    const clean = makeResult({ guid: 'good-guid', title: 'Clean' });
    const blacklisted = makeResult({ guid: 'bad-guid', title: 'Blacklisted' });
    indexerSearchService = { searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([blacklisted, clean])) } as unknown as IndexerSearchService;
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(),
      blacklistedGuids: new Set(['bad-guid']),
    });

    await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ title: 'Clean' }));
    expect(downloadService.grab).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Blacklisted' }));
  });
});

describe('#406 searchAndGrabForBook blacklist filtering with broadcaster', () => {
  const book = { id: 1, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };
  let indexerSearchService: IndexerSearchService;
  let downloadService: DownloadOrchestrator;
  let blacklistService: BlacklistService;
  let broadcaster: EventBroadcasterService;
  let log: FastifyBaseLogger;

  beforeEach(() => {
    downloadService = {
      grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }),
    } as unknown as DownloadOrchestrator;
    blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set<string>(),
      }),
    } as unknown as BlacklistService;
    broadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    log = createMockLogger();
  });

  it('filters blacklisted results before ranking — broadcaster path', async () => {
    const clean = makeResult({ infoHash: 'good', title: 'Clean', seeders: 5, indexerId: 10 });
    const blacklisted = makeResult({ infoHash: 'bad', title: 'Blacklisted', seeders: 100, indexerId: 10 });
    indexerSearchService = {
      searchAllStreaming: vi.fn().mockImplementation(async (_q: string, _o: unknown, _c: Map<number, AbortController>, callbacks: { onComplete: (id: number, name: string, count: number, ms: number) => void }) => {
        callbacks.onComplete(10, 'MAM', 2, 500);
        return [blacklisted, clean];
      }),
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
    } as unknown as IndexerSearchService;
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['bad']),
      blacklistedGuids: new Set(),
    });

    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
    expect(result.result).toBe('grabbed');
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ title: 'Clean' }));
  });

  it('returns no_results when all results are blacklisted — broadcaster path', async () => {
    indexerSearchService = {
      searchAllStreaming: vi.fn().mockImplementation(async (_q: string, _o: unknown, _c: Map<number, AbortController>, callbacks: { onComplete: (id: number, name: string, count: number, ms: number) => void }) => {
        callbacks.onComplete(10, 'MAM', 2, 500);
        return [makeResult({ infoHash: 'h1', indexerId: 10 }), makeResult({ infoHash: 'h2', indexerId: 10 })];
      }),
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
    } as unknown as IndexerSearchService;
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['h1', 'h2']),
      blacklistedGuids: new Set(),
    });

    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', expect.objectContaining({ outcome: 'no_results' }));
  });

  it('grabs only clean results when mix of blacklisted and clean — broadcaster path', async () => {
    const clean = makeResult({ guid: 'good-guid', title: 'Clean', indexerId: 10 });
    const blacklisted = makeResult({ guid: 'bad-guid', title: 'Blacklisted', indexerId: 10 });
    indexerSearchService = {
      searchAllStreaming: vi.fn().mockImplementation(async (_q: string, _o: unknown, _c: Map<number, AbortController>, callbacks: { onComplete: (id: number, name: string, count: number, ms: number) => void }) => {
        callbacks.onComplete(10, 'MAM', 2, 500);
        return [blacklisted, clean];
      }),
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
    } as unknown as IndexerSearchService;
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(),
      blacklistedGuids: new Set(['bad-guid']),
    });

    await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ title: 'Clean' }));
  });
});

describe('filterAndRankResults — narrator priority', () => {
  // For a 10-hour book, target MB/h multiplied by 10 yields total MB.
  const BOOK_DURATION = 36000;
  function sizeForMbhr(mbhr: number) { return Math.round(mbhr * 10 * 1024 * 1024); }

  const narratorPriority = { bookNarrators: ['Kevin R. Free'] };

  describe('narrator-match tier in canonicalCompare', () => {
    it('narrator-match result beats non-match when priority is accuracy (Fair vs Good quality)', () => {
      const fairMatch = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(79), matchScore: 0.9 });
      const goodNoMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(80), matchScore: 0.9 });
      const { results } = filterAndRankResults([goodNoMatch, fairMatch], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: narratorPriority });
      expect(results[0]!.narrator).toBe('Kevin R. Free');
    });

    it('narrator-match with 29 MB/hr does NOT beat non-match — below quality floor', () => {
      const lowMatch = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(29), matchScore: 0.9 });
      const goodNoMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9 });
      const { results } = filterAndRankResults([lowMatch, goodNoMatch], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: narratorPriority });
      expect(results[0]!.narrator).toBe('Someone Else');
    });

    it('narrator-match with exactly 30 MB/hr beats non-match — meets Low tier floor', () => {
      const lowMatch = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(30), matchScore: 0.9 });
      const goodNoMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9 });
      const { results } = filterAndRankResults([goodNoMatch, lowMatch], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: narratorPriority });
      expect(results[0]!.narrator).toBe('Kevin R. Free');
    });

    it('two narrator-matched results sorted by quality (higher quality wins)', () => {
      const fairMatch = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(79), matchScore: 0.9, title: 'A' });
      const goodMatch = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(200), matchScore: 0.9, title: 'B' });
      const { results } = filterAndRankResults([fairMatch, goodMatch], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: narratorPriority });
      expect(results[0]!.title).toBe('B');
    });

    it('two non-matched results sorted by quality as today (no change)', () => {
      const fair = makeResult({ narrator: 'Someone', size: sizeForMbhr(79), matchScore: 0.9, title: 'A' });
      const good = makeResult({ narrator: 'Other', size: sizeForMbhr(200), matchScore: 0.9, title: 'B' });
      const { results } = filterAndRankResults([fair, good], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: narratorPriority });
      expect(results[0]!.title).toBe('B');
    });

    it('#1655 5B: a placeholder book narrator ("Full Cast") creates NO narrator-priority boost', () => {
      // Full Cast carries no identity signal in either search priority or import caps.
      const placeholderMatch = makeResult({ narrator: 'Full Cast', size: sizeForMbhr(79), matchScore: 0.9, title: 'Placeholder' });
      const goodNoMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9, title: 'NoMatch' });
      const { results } = filterAndRankResults(
        [placeholderMatch, goodNoMatch],
        BOOK_DURATION,
        { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: { bookNarrators: ['Full Cast'] } },
      );
      expect(results[0]!.title).toBe('NoMatch');
    });

    it('unknown quality narrator-match beats known Good quality non-match', () => {
      const unknownMatch = makeResult({ narrator: 'Kevin R. Free', size: undefined, matchScore: 0.9, title: 'Match' });
      const goodNoMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9, title: 'NoMatch' });
      const { results } = filterAndRankResults([goodNoMatch, unknownMatch], undefined, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: narratorPriority });
      expect(results[0]!.title).toBe('Match');
    });

    it('match-score gate: score delta > 0.1 overrides narrator tier', () => {
      const lowScoreMatch = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(200), matchScore: 0.6 });
      const highScoreNoMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.8 });
      const { results } = filterAndRankResults([lowScoreMatch, highScoreNoMatch], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: narratorPriority });
      expect(results[0]!.narrator).toBe('Someone Else');
    });
  });

  describe('narratorPriority parameter behavior', () => {
    it('omitting narratorPriority preserves exact current ranking (regression)', () => {
      const fair = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(79), matchScore: 0.9, title: 'Fair' });
      const good = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9, title: 'Good' });
      const { results } = filterAndRankResults([fair, good], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none' });
      expect(results[0]!.title).toBe('Good');
    });

    it('empty bookNarrators array disables narrator tier', () => {
      const fair = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(79), matchScore: 0.9, title: 'Fair' });
      const good = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9, title: 'Good' });
      const { results } = filterAndRankResults([fair, good], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: { bookNarrators: [] } });
      expect(results[0]!.title).toBe('Good');
    });

    it('undefined SearchResult.narrator treated as non-match (no crash)', () => {
      const noNarrator = makeResult({ size: sizeForMbhr(200), matchScore: 0.9, title: 'NoNarr' });
      const withNarrator = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(79), matchScore: 0.9, title: 'WithNarr' });
      const { results } = filterAndRankResults([noNarrator, withNarrator], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: narratorPriority });
      expect(results[0]!.title).toBe('WithNarr');
    });
  });

  describe('fuzzy narrator matching in scoring', () => {
    it('normalized names match via diceCoefficient >= 0.8', () => {
      const match = makeResult({ narrator: 'Kevin R Free', size: sizeForMbhr(79), matchScore: 0.9 });
      const noMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9 });
      const { results } = filterAndRankResults([noMatch, match], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: { bookNarrators: ['Kevin R. Free'] } });
      expect(results[0]!.narrator).toBe('Kevin R Free');
    });

    it('different person similar name below 0.8 threshold is not boosted', () => {
      const falseMatch = makeResult({ narrator: 'Mark Kramer', size: sizeForMbhr(79), matchScore: 0.9, title: 'False' });
      const good = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9, title: 'Good' });
      const { results } = filterAndRankResults([falseMatch, good], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: { bookNarrators: ['Michael Kramer'] } });
      expect(results[0]!.title).toBe('Good');
    });

    it('multi-value result narrator tokenized before matching', () => {
      const multiNarr = makeResult({ narrator: 'Travis Baldree, Jeff Hays', size: sizeForMbhr(79), matchScore: 0.9 });
      const good = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9 });
      const { results } = filterAndRankResults([good, multiNarr], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: { bookNarrators: ['Travis Baldree'] } });
      expect(results[0]!.narrator).toBe('Travis Baldree, Jeff Hays');
    });

    it('multi-narrator book uses max pairwise score', () => {
      const match = makeResult({ narrator: 'Kate Reading', size: sizeForMbhr(79), matchScore: 0.9 });
      const noMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9 });
      const { results } = filterAndRankResults([noMatch, match], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: { bookNarrators: ['Michael Kramer', 'Kate Reading'] } });
      expect(results[0]!.narrator).toBe('Kate Reading');
    });
  });

  describe('fallback behavior', () => {
    it('priority accuracy with zero narrator matches falls back to quality ranking', () => {
      const fair = makeResult({ narrator: 'Nobody Match', size: sizeForMbhr(79), matchScore: 0.9, title: 'Fair' });
      const good = makeResult({ narrator: 'Also Nobody', size: sizeForMbhr(200), matchScore: 0.9, title: 'Good' });
      const { results } = filterAndRankResults([fair, good], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: { bookNarrators: ['Specific Narrator'] } });
      expect(results[0]!.title).toBe('Good');
    });

    it('priority accuracy with no book narrators falls back to quality ranking', () => {
      const fair = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(79), matchScore: 0.9, title: 'Fair' });
      const good = makeResult({ narrator: 'Someone', size: sizeForMbhr(200), matchScore: 0.9, title: 'Good' });
      const { results } = filterAndRankResults([fair, good], BOOK_DURATION, { grabFloor: 0, minSeeders: 1, protocolPreference: 'none', languages: [], narratorPriority: { bookNarrators: [] } });
      expect(results[0]!.title).toBe('Good');
    });
  });
});

describe('buildNarratorPriority', () => {
  it('returns NarratorPriority when searchPriority is accuracy and book has narrators', () => {
    const result = buildNarratorPriority('accuracy', [{ name: 'Kevin R. Free' }]);
    expect(result).toEqual({ bookNarrators: ['Kevin R. Free'] });
  });

  it('returns undefined when searchPriority is quality', () => {
    expect(buildNarratorPriority('quality', [{ name: 'Kevin R. Free' }])).toBeUndefined();
  });

  it('returns undefined when book has no narrators (undefined)', () => {
    expect(buildNarratorPriority('accuracy', undefined)).toBeUndefined();
  });

  it('returns undefined when book has no narrators (null)', () => {
    expect(buildNarratorPriority('accuracy', null)).toBeUndefined();
  });

  it('returns undefined when book has empty narrators array', () => {
    expect(buildNarratorPriority('accuracy', [])).toBeUndefined();
  });

  it('extracts names from narrator entities', () => {
    const result = buildNarratorPriority('accuracy', [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }]);
    expect(result).toEqual({ bookNarrators: ['Michael Kramer', 'Kate Reading'] });
  });
});

describe('postProcessSearchResults — maxDownloadSize', () => {


  function createMockSettingsServiceInline(qualityOverrides?: Record<string, unknown>): SettingsService {
    const qualityDefaults = { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5, rejectWords: '', requiredWords: '' };
    const metadataDefaults = { audibleRegion: 'us', languages: [] };
    return {
      get: vi.fn().mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve({ ...qualityDefaults, ...qualityOverrides });
        if (cat === 'metadata') return Promise.resolve(metadataDefaults);
        return Promise.resolve({});
      }),
    } as unknown as SettingsService;
  }

  it('filters oversized results and logs quality gate filtering', async () => {
    const log = createMockLogger();
    const blacklist = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }),
    } as unknown as BlacklistService;
    const settings = createMockSettingsServiceInline({ maxDownloadSize: 5 });

    const results = [
      makeResult({ title: 'Small', size: 2 * GB }),
      makeResult({ title: 'Huge', size: 10 * GB }),
    ];

    const output = await postProcessSearchResults(results, 3600, blacklist, settings, mockIndexer, log);

    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.title).toBe('Small');
    expect(log.debug).toHaveBeenCalledWith(
      { inputCount: 2, outputCount: 1 },
      'Quality gate filtering applied',
    );
  });

  it('does not log quality gate filtering when no results are filtered', async () => {
    const log = createMockLogger();
    const blacklist = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }),
    } as unknown as BlacklistService;
    const settings = createMockSettingsServiceInline({ maxDownloadSize: 5 });

    const results = [makeResult({ title: 'Small', size: 2 * GB })];

    await postProcessSearchResults(results, 3600, blacklist, settings, mockIndexer, log);

    expect(log.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ inputCount: expect.any(Number), outputCount: expect.any(Number) }),
      'Quality gate filtering applied',
    );
  });

  it('forwards minDownloadSize from settings: drops undersized results', async () => {
    const log = createMockLogger();
    const blacklist = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }),
    } as unknown as BlacklistService;
    const settings = createMockSettingsServiceInline({ minDownloadSize: 50 });

    const results = [
      makeResult({ title: 'Tracker test', size: 5 * MB }),
      makeResult({ title: 'Real Book', size: 500 * MB }),
    ];

    const output = await postProcessSearchResults(results, 3600, blacklist, settings, mockIndexer, log);

    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.title).toBe('Real Book');
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Tracker test',
        reason: 'below-min-size',
        sizeBytes: 5 * MB,
        minBytes: 50 * MB,
      }),
      'Quality filter dropped result',
    );
  });
});

describe('filterAndRankResults — nzbName reject/required word filtering (#502)', () => {
  const base = { bookDuration: undefined as number | undefined, grabFloor: 0, minSeeders: 0, protocolPreference: 'none' };

  it('reject words match against nzbName when present', () => {
    const results = [makeResult({ title: 'Clean Title', nzbName: 'Title with Pack inside' })];
    const { results: filtered } = filterAndRankResults(results, base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference, rejectWords: 'pack' });
    expect(filtered).toHaveLength(0);
  });

  it('reject words fall back to rawTitle when nzbName is absent', () => {
    const results = [makeResult({ title: 'Clean Title', rawTitle: 'Raw with Pack' })];
    const { results: filtered } = filterAndRankResults(results, base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference, rejectWords: 'pack' });
    expect(filtered).toHaveLength(0);
  });

  it('reject words fall back to title when both nzbName and rawTitle are absent', () => {
    const results = [makeResult({ title: 'Title with Pack' })];
    const { results: filtered } = filterAndRankResults(results, base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference, rejectWords: 'pack' });
    expect(filtered).toHaveLength(0);
  });

  it('required words match against nzbName when present', () => {
    const results = [makeResult({ title: 'Clean Title', nzbName: 'NZB with unabridged inside' })];
    const { results: filtered } = filterAndRankResults(results, base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference, requiredWords: 'unabridged' });
    expect(filtered).toHaveLength(1);
  });

  it('required words fall back to rawTitle when nzbName is absent', () => {
    const results = [makeResult({ title: 'Clean Title', rawTitle: 'Raw with unabridged' })];
    const { results: filtered } = filterAndRankResults(results, base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference, requiredWords: 'unabridged' });
    expect(filtered).toHaveLength(1);
  });

  it('matching is case-insensitive with nzbName', () => {
    const results = [makeResult({ title: 'Clean Title', nzbName: 'Title with PACK inside' })];
    const { results: filtered } = filterAndRankResults(results, base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference, rejectWords: 'pack' });
    expect(filtered).toHaveLength(0);
  });

  it('result with reject word in nzbName but NOT in rawTitle/title is filtered out', () => {
    const results = [makeResult({ title: 'Stephen King - The Stand MP3', rawTitle: 'Stephen King - The Stand (2012) MP3', nzbName: 'Stephen King-Hörbuch-Pack.part01.rar' })];
    const { results: filtered } = filterAndRankResults(results, base.bookDuration, { grabFloor: base.grabFloor, minSeeders: base.minSeeders, protocolPreference: base.protocolPreference, rejectWords: 'pack' });
    expect(filtered).toHaveLength(0);
  });
});

vi.mock('../utils/enrich-usenet-languages.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/enrich-usenet-languages.js')>()),
  enrichUsenetLanguages: vi.fn(),
}));

import { enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
const mockEnrichUsenet = vi.mocked(enrichUsenetLanguages);

describe('#502 searchAndGrabForBook — enrichment before filtering', () => {
  let indexerSearchService: IndexerSearchService;
  let downloadService: DownloadOrchestrator;
  let log: FastifyBaseLogger;
  let blacklistService: BlacklistService;

  beforeEach(() => {
    mockEnrichUsenet.mockReset();
    downloadService = {
      grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }),
    } as unknown as DownloadOrchestrator;
    blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set<string>(),
      }),
    } as unknown as BlacklistService;
    log = createMockLogger();
  });

  const book = { id: 1, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };

  it('calls enrichUsenetLanguages before filterAndRankResults', async () => {
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult({ protocol: 'usenet', downloadUrl: 'http://nzb.test/1' })])),
    } as unknown as IndexerSearchService;

    await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });

    expect(mockEnrichUsenet).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ protocol: 'usenet' })]),
      log,
      expect.objectContaining({ hostPort: expect.any(Set), hostname: expect.any(Set) }),
      { maxPhase2Fetches: 10 },
    );
  });

  it('usenet result with reject word in NZB name is filtered out before grab', async () => {
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult({ protocol: 'usenet', title: 'Clean Title', downloadUrl: 'http://nzb.test/1' })])),
    } as unknown as IndexerSearchService;

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Stephen King-Hörbuch-Pack.rar';
      }
    });

    const settings = { ...defaultQualitySettings, rejectWords: 'pack' };
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: settings, log, blacklistService, indexerService: mockIndexer, eventHistory });

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
  });

  it('torrent results are not enriched with nzbName', async () => {
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult({ protocol: 'torrent' })])),
    } as unknown as IndexerSearchService;

    await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });

    expect(mockEnrichUsenet).toHaveBeenCalled();
  });
});

describe('#502 searchAndGrabForBook with broadcaster — enrichment before filtering', () => {
  it('usenet result with reject word in NZB name is filtered out before grab on broadcaster path', async () => {
    mockEnrichUsenet.mockReset();
    const log = createMockLogger();
    const blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set<string>(),
      }),
    } as unknown as BlacklistService;
    const indexerSearchService = {
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 1, name: 'Test' }]),
      searchAllStreaming: vi.fn().mockResolvedValue([makeResult({ protocol: 'usenet', title: 'Clean Title', downloadUrl: 'http://nzb.test/1' })]),
    } as unknown as IndexerSearchService;
    const downloadService = {
      grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }),
    } as unknown as DownloadOrchestrator;
    const broadcaster = {
      emit: vi.fn(),
    } as unknown as EventBroadcasterService;

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Stephen King-Hörbuch-Pack.rar';
      }
    });

    const settings = { ...defaultQualitySettings, rejectWords: 'pack' };
    const book = { id: 1, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };
    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: settings, log, blacklistService, indexerService: mockIndexer, eventHistory, broadcaster });

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
  });
});

describe('#533 postProcessSearchResults — multi-part filter uses nzbName after enrichment', () => {
  function createMockSettingsService533(): SettingsService {
    const qualityDefaults = { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5, rejectWords: '', requiredWords: '' };
    const metadataDefaults = { audibleRegion: 'us', languages: [] };
    return {
      get: vi.fn().mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve(qualityDefaults);
        if (cat === 'metadata') return Promise.resolve(metadataDefaults);
        return Promise.resolve({});
      }),
    } as unknown as SettingsService;
  }

  function createMockBlacklist533(): BlacklistService {
    return {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set<string>(),
      }),
    } as unknown as BlacklistService;
  }

  beforeEach(() => {
    mockEnrichUsenet.mockReset();
  });

  it('filters Usenet result whose nzbName contains multi-part marker but rawTitle/title do not', async () => {
    const log = createMockLogger();
    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Book Title (01 of 30).part01.rar';
      }
    });

    const results = [makeResult({ protocol: 'usenet', title: 'Book Title', downloadUrl: 'http://nzb.test/1' })];
    const output = await postProcessSearchResults(results, 3600, createMockBlacklist533(), createMockSettingsService533(), mockIndexer, log);

    expect(output.results).toHaveLength(0);
    expect(output.unsupportedResults.count).toBe(1);
  });

  it('still filters Usenet result whose rawTitle contains multi-part marker when nzbName is absent (regression)', async () => {
    const log = createMockLogger();
    mockEnrichUsenet.mockResolvedValue(undefined);

    const results = [makeResult({ protocol: 'usenet', title: 'Book Title', rawTitle: 'Book (08 of 30)', downloadUrl: 'http://nzb.test/1' })];
    const output = await postProcessSearchResults(results, 3600, createMockBlacklist533(), createMockSettingsService533(), mockIndexer, log);

    expect(output.results).toHaveLength(0);
    expect(output.unsupportedResults.count).toBe(1);
  });

  it('still filters Usenet result whose title contains multi-part marker with no rawTitle or nzbName (regression)', async () => {
    const log = createMockLogger();
    mockEnrichUsenet.mockResolvedValue(undefined);

    const results = [makeResult({ protocol: 'usenet', title: 'Book (3/10)', downloadUrl: 'http://nzb.test/1' })];
    const output = await postProcessSearchResults(results, 3600, createMockBlacklist533(), createMockSettingsService533(), mockIndexer, log);

    expect(output.results).toHaveLength(0);
    expect(output.unsupportedResults.count).toBe(1);
  });

  it('falls through to rawTitle when nzbName is empty string (|| not ?? operator)', async () => {
    const log = createMockLogger();
    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = '';
      }
    });

    const results = [makeResult({ protocol: 'usenet', title: 'Clean Title', rawTitle: 'Book (01 of 30)', downloadUrl: 'http://nzb.test/1' })];
    const output = await postProcessSearchResults(results, 3600, createMockBlacklist533(), createMockSettingsService533(), mockIndexer, log);

    expect(output.results).toHaveLength(0);
    expect(output.unsupportedResults.count).toBe(1);
  });

  it('falls through to rawTitle then title when nzbName is undefined', async () => {
    const log = createMockLogger();
    mockEnrichUsenet.mockResolvedValue(undefined);

    const results = [makeResult({ protocol: 'usenet', title: 'Book (5/10)', downloadUrl: 'http://nzb.test/1' })];
    const output = await postProcessSearchResults(results, 3600, createMockBlacklist533(), createMockSettingsService533(), mockIndexer, log);

    expect(output.results).toHaveLength(0);
    expect(output.unsupportedResults.count).toBe(1);
  });

  it('torrent result with multi-part-like title passes through unfiltered (protocol gate)', async () => {
    const log = createMockLogger();
    mockEnrichUsenet.mockResolvedValue(undefined);

    const results = [makeResult({ protocol: 'torrent', title: 'Book (01/05)', seeders: 5 })];
    const output = await postProcessSearchResults(results, 3600, createMockBlacklist533(), createMockSettingsService533(), mockIndexer, log);

    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.title).toBe('Book (01/05)');
    expect(output.unsupportedResults.count).toBe(0);
  });

  it('Usenet result with pre-populated language and multi-part marker in rawTitle is still filtered', async () => {
    const log = createMockLogger();
    mockEnrichUsenet.mockResolvedValue(undefined);

    const results = [makeResult({ protocol: 'usenet', title: 'Clean Title', rawTitle: 'Book (08 of 30)', language: 'English', downloadUrl: 'http://nzb.test/1' })];
    const output = await postProcessSearchResults(results, 3600, createMockBlacklist533(), createMockSettingsService533(), mockIndexer, log);

    expect(output.results).toHaveLength(0);
    expect(output.unsupportedResults.count).toBe(1);
  });

  it('Usenet result with pre-populated language and no nzbName falls back to rawTitle for detection', async () => {
    const log = createMockLogger();
    mockEnrichUsenet.mockResolvedValue(undefined);

    const results = [makeResult({ protocol: 'usenet', title: 'Clean Title', rawTitle: 'Also Clean', language: 'English', downloadUrl: 'http://nzb.test/1' })];
    const output = await postProcessSearchResults(results, 3600, createMockBlacklist533(), createMockSettingsService533(), mockIndexer, log);

    expect(output.results).toHaveLength(1);
    expect(output.unsupportedResults.count).toBe(0);
  });

  it('records nzbName in unsupportedResults.titles when nzbName triggers the filter', async () => {
    const log = createMockLogger();
    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'NZB Multi-Part (01 of 30).rar';
      }
    });

    const results = [makeResult({ protocol: 'usenet', title: 'Clean Title', downloadUrl: 'http://nzb.test/1' })];
    const output = await postProcessSearchResults(results, 3600, createMockBlacklist533(), createMockSettingsService533(), mockIndexer, log);

    expect(output.unsupportedResults.titles).toEqual(['NZB Multi-Part (01 of 30).rar']);
  });

  it('blacklist filtering still runs before enrichment (blacklisted result not enriched)', async () => {
    const log = createMockLogger();
    const blacklist = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set(['blacklisted-guid']),
      }),
    } as unknown as BlacklistService;

    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Some NZB Name';
      }
    });

    const results = [
      makeResult({ protocol: 'usenet', title: 'Blacklisted', guid: 'blacklisted-guid', downloadUrl: 'http://nzb.test/1' }),
      makeResult({ protocol: 'usenet', title: 'Clean Result', guid: 'clean-guid', downloadUrl: 'http://nzb.test/2' }),
    ];
    const output = await postProcessSearchResults(results, 3600, blacklist, createMockSettingsService533(), mockIndexer, log);

    expect(mockEnrichUsenet).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.objectContaining({ guid: 'blacklisted-guid' })]),
      log,
      expect.objectContaining({ hostPort: expect.any(Set), hostname: expect.any(Set) }),
    );
    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.guid).toBe('clean-guid');
  });
});

describe('postProcessSearchResults — interactive path stays uncapped (#1330)', () => {
  function createSettings(): SettingsService {
    const quality = { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5, rejectWords: '', requiredWords: '' };
    const metadata = { audibleRegion: 'us', languages: [] };
    return {
      get: vi.fn().mockImplementation((cat: string) =>
        Promise.resolve(cat === 'quality' ? quality : cat === 'metadata' ? metadata : {})),
    } as unknown as SettingsService;
  }

  function createBlacklist(): BlacklistService {
    return {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set<string>(),
      }),
    } as unknown as BlacklistService;
  }

  beforeEach(() => {
    mockEnrichUsenet.mockReset();
  });

  it('calls enrichUsenetLanguages without a maxPhase2Fetches cap option (no 4th argument)', async () => {
    const log = createMockLogger();
    const results = [makeResult({ protocol: 'usenet', title: 'A Book', downloadUrl: 'http://nzb.test/1' })];

    await postProcessSearchResults(results, 3600, createBlacklist(), createSettings(), mockIndexer, log);

    expect(mockEnrichUsenet).toHaveBeenCalledTimes(1);
    // Copying AUTO_GRAB_PHASE2_CAP from auto-grab would add a forbidden fourth argument (#1330).
    expect(mockEnrichUsenet.mock.calls[0]).toHaveLength(3);
    expect(mockEnrichUsenet.mock.calls[0]![3]).toBeUndefined();
  });
});

/** Normalize Zod's optional `T | undefined` artifact so checks flag only contract drift. */
type TightenOptional<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

describe('postProcessSearchResults — search-complete payload schema compatibility (#734 AC1)', () => {
  it('return type is structurally compatible with searchResponseSchema', () => {
    // Only the SSE route knows the winning rung, so post-processing cannot return relaxedQuery.
    type TightSearchResponse = Omit<SearchResponsePayload, 'results' | 'relaxedQuery'> & { results: TightenOptional<SearchResultPayload>[] };
    expectTypeOf<Awaited<ReturnType<typeof postProcessSearchResults>>>()
      .branded.toEqualTypeOf<TightSearchResponse>();
  });
});

describe('applyMultiPartFilterAndRank (#1777)', () => {
  const options = { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' };

  it('drops multi-part usenet posts, keeps valid usenet and pattern-matching torrents, and reports rejections', () => {
    const multiPartUsenet = makeResult({ protocol: 'usenet', title: 'Book Part 2 of 5', downloadUrl: 'http://nzb.test/multi' });
    const validUsenet = makeResult({ protocol: 'usenet', title: 'Book Complete', downloadUrl: 'http://nzb.test/valid' });
    const multiPartTorrent = makeResult({ protocol: 'torrent', title: 'Book Part 2 of 5', downloadUrl: 'magnet:?xt=urn:btih:tor' });

    const out = applyMultiPartFilterAndRank([multiPartUsenet, validUsenet, multiPartTorrent], 3600, options);

    const survivingUrls = out.results.map((r) => r.downloadUrl);
    expect(survivingUrls).toContain('http://nzb.test/valid');
    expect(survivingUrls).toContain('magnet:?xt=urn:btih:tor');
    expect(survivingUrls).not.toContain('http://nzb.test/multi');
    expect(out.multipartRejections).toEqual([{ title: 'Book Part 2 of 5', matchedPattern: expect.any(String) }]);
  });

  it('retains a series-titled usenet release (Book 1 of 14) — the #1801 false-positive class survives on all four paths', () => {
    const seriesTitled = makeResult({ protocol: 'usenet', title: 'The Eye of the World Book 1 of 14', downloadUrl: 'http://nzb.test/series' });
    const genuine = makeResult({ protocol: 'usenet', title: 'The Eye of the World Part 2 of 5', downloadUrl: 'http://nzb.test/part' });

    const out = applyMultiPartFilterAndRank([seriesTitled, genuine], 3600, options);

    const survivingUrls = out.results.map((r) => r.downloadUrl);
    expect(survivingUrls).toContain('http://nzb.test/series');
    expect(survivingUrls).not.toContain('http://nzb.test/part');
    expect(out.multipartRejections).toEqual([{ title: 'The Eye of the World Part 2 of 5', matchedPattern: expect.any(String) }]);
  });

  it('emits one multi-part-detected info log per dropped result with title + matchedPattern', () => {
    const log = createMockLogger();
    const results = [
      makeResult({ protocol: 'usenet', title: 'Book A Part 2 of 5', downloadUrl: 'http://nzb.test/a' }),
      makeResult({ protocol: 'usenet', title: 'Book B (3/10)', downloadUrl: 'http://nzb.test/b' }),
    ];

    applyMultiPartFilterAndRank(results, 3600, options, log);

    const multiPartLogs = vi.mocked(log.info).mock.calls.filter(
      ([payload]) => (payload as { reason?: string }).reason === 'multi-part-detected',
    );
    expect(multiPartLogs).toHaveLength(2);
    expect(multiPartLogs[0]![0]).toMatchObject({ title: expect.any(String), matchedPattern: expect.any(String) });
  });

  it('passes durationUnknown straight through from filterAndRankResults for known and unknown durations', () => {
    const input = [makeResult({ protocol: 'usenet', title: 'Book Complete', downloadUrl: 'http://nzb.test/1' })];

    const known = applyMultiPartFilterAndRank(input, 3600, options);
    const unknown = applyMultiPartFilterAndRank(input, undefined, options);

    expect(known.durationUnknown).toBe(filterAndRankResults(input, 3600, options).durationUnknown);
    expect(unknown.durationUnknown).toBe(filterAndRankResults(input, undefined, options).durationUnknown);
    expect(known.durationUnknown).toBe(false);
    expect(unknown.durationUnknown).toBe(true);
  });
});

describe('buildSearchFilterOptions (#1777)', () => {
  const quality = {
    grabFloor: 5,
    minSeeders: 2,
    protocolPreference: 'usenet',
    rejectWords: 'reject',
    requiredWords: 'required',
    minDownloadSize: 1,
    maxDownloadSize: 9,
  };

  it('maps quality + metadata fields and omits narratorPriority when not provided', () => {
    const opts = buildSearchFilterOptions(quality, { languages: ['english'] });
    expect(opts).toEqual({
      grabFloor: 5,
      minSeeders: 2,
      protocolPreference: 'usenet',
      rejectWords: 'reject',
      requiredWords: 'required',
      languages: ['english'],
      minDownloadSize: 1,
      maxDownloadSize: 9,
    });
    expect(opts).not.toHaveProperty('narratorPriority');
  });

  it('includes narratorPriority when provided', () => {
    const narratorPriority = { bookNarrators: ['Michael Kramer'] };
    const opts = buildSearchFilterOptions(quality, { languages: [] }, { narratorPriority });
    expect(opts.narratorPriority).toEqual(narratorPriority);
  });

  it('omits narratorPriority when explicitly passed undefined', () => {
    const opts = buildSearchFilterOptions(quality, { languages: [] }, { narratorPriority: undefined });
    expect(opts).not.toHaveProperty('narratorPriority');
  });
});

describe('#1777 searchAndGrabForBook — multi-part usenet filter on the auto-grab path', () => {
  let indexerSearchService: IndexerSearchService;
  let downloadService: DownloadOrchestrator;
  let log: FastifyBaseLogger;
  let blacklistService: BlacklistService;

  beforeEach(() => {
    mockEnrichUsenet.mockReset();
    downloadService = {
      grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }),
    } as unknown as DownloadOrchestrator;
    blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set<string>(),
      }),
    } as unknown as BlacklistService;
    log = createMockLogger();
  });

  // Duration is minutes; grabFloor 0 makes this 60-hour value inert (#1797).
  const book = { id: 1, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };

  it('does not grab a multi-part usenet post ranked ahead of a valid one — the valid candidate wins', async () => {
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([
        makeResult({ protocol: 'usenet', title: 'Book Part 2 of 5', downloadUrl: 'http://nzb.test/multi' }),
        makeResult({ protocol: 'usenet', title: 'Book Complete', downloadUrl: 'http://nzb.test/valid' }),
      ])),
    } as unknown as IndexerSearchService;

    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });

    expect(result).toEqual({ result: 'grabbed', title: 'Book Complete' });
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ downloadUrl: 'http://nzb.test/valid' }));
    expect(downloadService.grab).not.toHaveBeenCalledWith(expect.objectContaining({ downloadUrl: 'http://nzb.test/multi' }));
  });

  it('returns no_results when every usenet candidate is multi-part', async () => {
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult({ protocol: 'usenet', title: 'Book Part 2 of 5', downloadUrl: 'http://nzb.test/multi' })])),
    } as unknown as IndexerSearchService;

    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
  });

  it('still grabs a torrent whose title matches the multi-part pattern (protocol scoping)', async () => {
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult({ protocol: 'torrent', title: 'Book Part 2 of 5', downloadUrl: 'magnet:?xt=urn:btih:tor' })])),
    } as unknown as IndexerSearchService;

    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });

    expect(result).toEqual({ result: 'grabbed', title: 'Book Part 2 of 5' });
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ downloadUrl: 'magnet:?xt=urn:btih:tor' }));
  });

  it('rejects a usenet post whose multi-part marker only appears in the enrichment-populated nzbName (ordering guard)', async () => {
    mockEnrichUsenet.mockImplementation(async (results) => {
      for (const r of results) {
        if (r.protocol === 'usenet') r.nzbName = 'Book (02 of 30).part02.rar';
      }
    });
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult({ protocol: 'usenet', title: 'Book Clean Title', downloadUrl: 'http://nzb.test/multi' })])),
    } as unknown as IndexerSearchService;

    const result = await searchAndGrabForBook(book, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings, log, blacklistService, indexerService: mockIndexer, eventHistory });

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
  });

  // Display receives duration * 60 seconds; auto-grab must derive the same value
  // from raw minutes. A nonzero floor exposes the old 60× MB/h inflation (#1797).
  it('display and auto-grab reject the same below-floor release for the same book row (unit-honest parity)', async () => {
    mockEnrichUsenet.mockReset();
    // 600 minutes = 10 hours. A 100MB release is 10 MB/h — below the 30 MB/h floor.
    const parityBook = { id: 1, title: 'Test Book', duration: 600, authors: [{ name: 'Author' }] };
    const input = () => [
      makeResult({ protocol: 'usenet', title: 'Book Part 2 of 5', size: 100 * MB, downloadUrl: 'http://nzb.test/multi' }),
      makeResult({ protocol: 'usenet', title: 'Book Complete', size: 100 * MB, downloadUrl: 'http://nzb.test/valid' }),
    ];

    const settingsFloor = {
      get: vi.fn().mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve({ grabFloor: 30, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 0, maxDownloadSize: 5, rejectWords: '', requiredWords: '' });
        if (cat === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: [] });
        return Promise.resolve({});
      }),
    } as unknown as SettingsService;

    const display = await postProcessSearchResults(input(), parityBook.duration * 60, blacklistService, settingsFloor, mockIndexer, log);

    indexerSearchService = { searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus(input())) } as unknown as IndexerSearchService;
    const grab = await searchAndGrabForBook(parityBook, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: { ...defaultQualitySettings, grabFloor: 30, minSeeders: 0 }, log, blacklistService, indexerService: mockIndexer, eventHistory });

    expect(display.results.map((r) => r.downloadUrl)).toEqual([]);
    expect(grab).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
  });

  // Treating raw minutes as seconds inflates MB/h 60× and defeats this floor (#1797 AC1).
  it('does not auto-grab a below-floor release (duration is minutes, floor is seconds-based MB/h) (#1797 AC1)', async () => {
    // 600 min = 10h; 100MB / 10h = 10 MB/h < 30 floor → reject.
    const floorBook = { id: 1, title: 'Test Book', duration: 600, authors: [{ name: 'Author' }] };
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult({ size: 100 * MB, downloadUrl: 'magnet:?xt=urn:btih:below' })])),
    } as unknown as IndexerSearchService;

    const result = await searchAndGrabForBook(floorBook, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: { ...defaultQualitySettings, grabFloor: 30, minSeeders: 0 }, log, blacklistService, indexerService: mockIndexer, eventHistory });

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
  });

  it('resolves audioDuration (seconds) over duration on the auto-grab path (#1797 AC5)', async () => {
    // 36,000 seconds yields 10 MB/h; falling back to one minute would falsely pass.
    const precedenceBook = { id: 1, title: 'Test Book', duration: 1, audioDuration: 36000, authors: [{ name: 'Author' }] };
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult({ size: 100 * MB, downloadUrl: 'magnet:?xt=urn:btih:prec' })])),
    } as unknown as IndexerSearchService;

    const result = await searchAndGrabForBook(precedenceBook, { indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: { ...defaultQualitySettings, grabFloor: 30, minSeeders: 0 }, log, blacklistService, indexerService: mockIndexer, eventHistory });

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
  });
});

describe('#1777 postProcessSearchResults — durationUnknown passthrough survives the refactor', () => {
  function createSettings(): SettingsService {
    return {
      get: vi.fn().mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5, rejectWords: '', requiredWords: '' });
        if (cat === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: [] });
        return Promise.resolve({});
      }),
    } as unknown as SettingsService;
  }
  function createBlacklist(): BlacklistService {
    return { getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>() }) } as unknown as BlacklistService;
  }

  beforeEach(() => mockEnrichUsenet.mockReset());

  it('returns durationUnknown: false for a known book duration', async () => {
    const results = [makeResult({ protocol: 'usenet', title: 'A Book', downloadUrl: 'http://nzb.test/1' })];
    const output = await postProcessSearchResults(results, 3600, createBlacklist(), createSettings(), mockIndexer, createMockLogger());
    expect(output.durationUnknown).toBe(false);
  });

  it('returns durationUnknown: true for an unknown book duration', async () => {
    const results = [makeResult({ protocol: 'usenet', title: 'A Book', downloadUrl: 'http://nzb.test/1' })];
    const output = await postProcessSearchResults(results, undefined, createBlacklist(), createSettings(), mockIndexer, createMockLogger());
    expect(output.durationUnknown).toBe(true);
  });
});

describe('searchAndGrabForBook — query ladder (#2104)', () => {
  const franchiseBook = {
    id: 1,
    title: 'Star Wars: The High Republic: Haunted Starlight',
    duration: 3600,
    authors: [{ name: 'George Mann' }],
  };
  const churnBook = {
    id: 2,
    title: 'The Churn: An Expanse Novella',
    duration: 3600,
    authors: [{ name: 'James S. A. Corey' }],
  };
  const risingStormBook = {
    id: 3,
    title: 'Star Wars: The Rising Storm (The High Republic)',
    duration: 3600,
    authors: [{ name: 'Cavan Scott' }],
  };

  let downloadService: DownloadOrchestrator;
  let blacklistService: BlacklistService;
  let eventHistory: EventHistoryService;
  let log: FastifyBaseLogger;

  beforeEach(() => {
    downloadService = { grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }) } as unknown as DownloadOrchestrator;
    blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>() }),
    } as unknown as BlacklistService;
    eventHistory = createMockEventHistory();
    log = createMockLogger();
  });

  function indexerServiceAnswering(
    byQuery: Record<string, SearchResult[]>,
    overrides?: SearchStatusOverrides,
  ): IndexerSearchService {
    return inject<IndexerSearchService>({ searchAllWithStatus: answeringSearchStatus(byQuery, overrides) });
  }

  const deps = (indexerSearchService: IndexerSearchService, extra: Record<string, unknown> = {}) => ({
    indexerSearchService,
    downloadOrchestrator: downloadService,
    qualitySettings: defaultQualitySettings,
    log,
    blacklistService,
    indexerService: mockIndexer,
    eventHistory,
    ...extra,
  });

  const queriesOf = (svc: IndexerSearchService): string[] =>
    vi.mocked(svc.searchAllWithStatus).mock.calls.map((c) => c[0] as string);

  // Removing stop-on-first-hit would run later rungs despite a canonical hit (AC15).
  it('issues exactly ONE query, byte-identical to the pre-ladder one, when rung 1 answers (AC15)', async () => {
    const svc = indexerServiceAnswering({ 'Star Wars The High Republic Haunted Starlight George Mann': [makeResult()] });

    const result = await searchAndGrabForBook(franchiseBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    expect(queriesOf(svc)).toEqual(['Star Wars The High Republic Haunted Starlight George Mann']);
  });

  it('finds the deep-franchise example at the first+last rung and grabs it (AC13)', async () => {
    const svc = indexerServiceAnswering({
      'star wars haunted starlight George Mann': [makeResult({ title: 'Star Wars: Haunted Starlight' })],
    });

    const result = await searchAndGrabForBook(franchiseBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title: 'Star Wars: Haunted Starlight' });
    expect(queriesOf(svc)).toEqual([
      'Star Wars The High Republic Haunted Starlight George Mann',
      'star wars the high republic George Mann',
      'the high republic haunted starlight George Mann',
      'star wars haunted starlight George Mann',
    ]);
  });

  // Head-only "The Churn" is circular evidence; fail to Needs Review rather than
  // risk the indistinguishable same-author suffix-sibling case (#2133 AC7).
  it('holds The Churn at the prefix(1) rung — a head-only release is circular evidence (AC13, #2133 AC7)', async () => {
    const svc = indexerServiceAnswering({
      'the churn James S A Corey': [makeResult({ title: 'The Churn (Unabridged) [M4B]' })],
    });

    const result = await searchAndGrabForBook(churnBook, deps(svc));

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(queriesOf(svc)).toEqual([
      'The Churn An Expanse Novella James S A Corey',
      'the churn James S A Corey',
    ]);
    expect(eventHistory.create).toHaveBeenCalledTimes(1);
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      bookId: 2,
      reason: {
        relaxed_query: 'the churn James S A Corey',
        variant_tag: 'prefix(1)',
        release_title: 'The Churn (Unabridged) [M4B]',
      },
    }));
  });

  it('still grabs a release carrying the whole canonical title at the prefix(1) rung (#2133 AC7)', async () => {
    const svc = indexerServiceAnswering({
      'the churn James S A Corey': [makeResult({ title: 'The Churn: An Expanse Novella' })],
    });

    const result = await searchAndGrabForBook(churnBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title: 'The Churn: An Expanse Novella' });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  // Both suffix siblings share the author, so the transport author filter cannot distinguish them.
  it('holds a franchise sibling found at the suffix(1) rung (#2133 AC7)', async () => {
    const svc = indexerServiceAnswering({
      'an expanse novella James S A Corey': [
        makeResult({ title: 'The Vital Abyss: An Expanse Novella', seeders: 99 }),
        makeResult({ title: 'Gods of Risk: An Expanse Novella', seeders: 1 }),
      ],
    });

    const result = await searchAndGrabForBook(churnBook, deps(svc));

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(eventHistory.create).toHaveBeenCalledTimes(1);
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      reason: {
        relaxed_query: 'an expanse novella James S A Corey',
        variant_tag: 'suffix(1)',
        release_title: 'The Vital Abyss: An Expanse Novella',
      },
    }));
  });

  it('finds Rising Storm at the paren-stripped full rung and grabs it (AC13)', async () => {
    const svc = indexerServiceAnswering({
      'star wars the rising storm Cavan Scott': [makeResult({ title: 'Star Wars: The Rising Storm' })],
    });

    const result = await searchAndGrabForBook(risingStormBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title: 'Star Wars: The Rising Storm' });
    expect(queriesOf(svc)).toEqual([
      'Star Wars The Rising Storm The High Republic Cavan Scott',
      'star wars the rising storm Cavan Scott',
    ]);
  });

  // Moving gates inside the rung loop multiplies these calls; only the winner is gated (AC16).
  it('runs the gate chain exactly once, on the winning rung, across a 4-rung ladder (AC16)', async () => {
    const svc = indexerServiceAnswering({
      // A guid prevents the blacklist lookup spy from becoming vacuous via short-circuit.
      'star wars haunted starlight George Mann': [makeResult({ title: 'Star Wars: Haunted Starlight', guid: 'g-1' })],
    });
    mockEnrichUsenet.mockClear();

    await searchAndGrabForBook(franchiseBook, deps(svc));

    expect(queriesOf(svc)).toHaveLength(4);
    expect(blacklistService.getBlacklistedIdentifiers).toHaveBeenCalledTimes(1);
    expect(mockEnrichUsenet).toHaveBeenCalledTimes(1);
  });

  it('withholds the grab and records one held event when every downloadable candidate fails the floor (AC14, AC32)', async () => {
    const svc = indexerServiceAnswering({
      'star wars haunted starlight George Mann': [
        makeResult({ title: 'Star Wars: The High Republic: Cataclysm', seeders: 99 }),
        makeResult({ title: 'Star Wars: Haunted Totally Different Starlight', seeders: 1 }),
      ],
    });

    const result = await searchAndGrabForBook(franchiseBook, deps(svc));

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(eventHistory.create).toHaveBeenCalledTimes(1);
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      bookId: 1,
      reason: {
        relaxed_query: 'star wars haunted starlight George Mann',
        variant_tag: 'first+last',
        release_title: 'Star Wars: The High Republic: Cataclysm',
      },
    }));
  });

  // Gating the floor on durationUnknown would bypass it for this known-duration book.
  it('applies the floor identically on a book with a KNOWN duration (AC14)', async () => {
    const svc = indexerServiceAnswering({
      'star wars haunted starlight George Mann': [makeResult({ title: 'Star Wars: The High Republic: Cataclysm' })],
    });

    const result = await searchAndGrabForBook({ ...franchiseBook, duration: 600, audioDuration: 36000 }, deps(svc));

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'search_relaxed_held' }));
  });

  it('grabs a lower-ranked passing candidate past a failing top-ranked one (AC31)', async () => {
    const svc = indexerServiceAnswering({
      'star wars haunted starlight George Mann': [
        makeResult({ title: 'Star Wars: The High Republic: Cataclysm', seeders: 99 }),
        makeResult({ title: 'Star Wars: Haunted Starlight', seeders: 5 }),
      ],
    });

    const result = await searchAndGrabForBook(franchiseBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title: 'Star Wars: Haunted Starlight' });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  it('reaches the tail rung and grabs a release carrying both anchors (AC1, AC10)', async () => {
    const svc = indexerServiceAnswering({
      'haunted starlight George Mann': [makeResult({ title: 'Star Wars: Haunted Starlight' })],
    });

    const result = await searchAndGrabForBook(franchiseBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title: 'Star Wars: Haunted Starlight' });
    expect(queriesOf(svc)).toEqual([
      'Star Wars The High Republic Haunted Starlight George Mann',
      'star wars the high republic George Mann',
      'the high republic haunted starlight George Mann',
      'star wars haunted starlight George Mann',
      'haunted starlight George Mann',
    ]);
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  // The shared first/last anchor floor intentionally holds tail-only releases;
  // a per-rung floor would weaken franchise suppression (#2138 AC10).
  it('holds a franchise-dropping release found at the tail rung, recording ONE event (AC10)', async () => {
    const svc = indexerServiceAnswering({
      'haunted starlight George Mann': [makeResult({ title: 'Haunted Starlight - George Mann' })],
    });

    const result = await searchAndGrabForBook(franchiseBook, deps(svc));

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(eventHistory.create).toHaveBeenCalledTimes(1);
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      bookId: 1,
      reason: {
        relaxed_query: 'haunted starlight George Mann',
        variant_tag: 'suffix(1)',
        release_title: 'Haunted Starlight - George Mann',
      },
    }));
  });

  // Using rung.segments as the floor lets every prefix(2) sibling corroborate itself (#2133 AC5).
  it('holds every High-Republic sibling found at the prefix(2) rung, recording ONE event (AC5)', async () => {
    const svc = indexerServiceAnswering({
      'star wars the high republic George Mann': [
        makeResult({ title: '01 Star Wars-The High Republic-The Eye of Darkness', seeders: 99 }),
        makeResult({ title: 'Star Wars: The High Republic: Cataclysm', seeders: 1 }),
      ],
    });

    const result = await searchAndGrabForBook(franchiseBook, deps(svc));

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(eventHistory.create).toHaveBeenCalledTimes(1);
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      bookId: 1,
      reason: {
        relaxed_query: 'star wars the high republic George Mann',
        variant_tag: 'prefix(2)',
        release_title: '01 Star Wars-The High Republic-The Eye of Darkness',
      },
    }));
  });

  it('grabs a lower-ranked release naming the wanted book at the prefix(2) rung (AC6)', async () => {
    const svc = indexerServiceAnswering({
      'star wars the high republic George Mann': [
        makeResult({ title: '01 Star Wars-The High Republic-The Eye of Darkness', seeders: 99 }),
        makeResult({ title: 'Star Wars: Haunted Starlight', seeders: 5 }),
      ],
    });

    const result = await searchAndGrabForBook(franchiseBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title: 'Star Wars: Haunted Starlight' });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  it("grabs the book's own canonical title at the prefix(2) rung (AC6)", async () => {
    const svc = indexerServiceAnswering({
      'star wars the high republic George Mann': [makeResult({ title: 'Star Wars: The High Republic: Haunted Starlight' })],
    });

    const result = await searchAndGrabForBook(franchiseBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title: 'Star Wars: The High Republic: Haunted Starlight' });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  // Both anchors normalize to "star wars"; occurrence counts prevent one copy satisfying both.
  const collapsedBook = { id: 4, title: 'Star Wars: The High Republic: Star Wars', duration: 3600, authors: [{ name: 'George Mann' }] };

  it('holds the sibling of a collapsed-anchor title at the prefix(2) rung (AC16)', async () => {
    const svc = indexerServiceAnswering({
      'star wars the high republic George Mann': [makeResult({ title: 'Star Wars: The High Republic: The Eye of Darkness' })],
    });

    const result = await searchAndGrabForBook(collapsedBook, deps(svc));

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(eventHistory.create).toHaveBeenCalledTimes(1);
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      bookId: 4,
      reason: expect.objectContaining({ variant_tag: 'prefix(2)' }),
    }));
  });

  // Overlap at the shared delimiter is required or the canonical release fails its own floor.
  it.each([
    ['Star Wars: The High Republic: Star Wars'],
    ['01 Star Wars-The High Republic-Star Wars'],
  ])('grabs %s for the collapsed-anchor book at the prefix(2) rung (AC16)', async (title) => {
    const svc = indexerServiceAnswering({ 'star wars the high republic George Mann': [makeResult({ title })] });

    const result = await searchAndGrabForBook(collapsedBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  // The queried prefix supplies one gamma; occurrence counts require the distinguishing second.
  const neighbourBook = { id: 5, title: 'Alpha: Beta Gamma: Gamma', duration: 3600, authors: [{ name: 'Ann Author' }] };

  it('holds the sibling of a recurring-anchor title at the prefix(2) rung (AC16)', async () => {
    const svc = indexerServiceAnswering({
      'alpha beta gamma Ann Author': [makeResult({ title: 'Alpha: Beta Gamma: Delta' })],
    });

    const result = await searchAndGrabForBook(neighbourBook, deps(svc));

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(eventHistory.create).toHaveBeenCalledTimes(1);
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      bookId: 5,
      reason: expect.objectContaining({ variant_tag: 'prefix(2)', release_title: 'Alpha: Beta Gamma: Delta' }),
    }));
  });

  it('grabs the recurring-anchor book at the prefix(2) rung when the release names it (AC16)', async () => {
    const svc = indexerServiceAnswering({
      'alpha beta gamma Ann Author': [makeResult({ title: 'Alpha: Beta Gamma: Gamma' })],
    });

    const result = await searchAndGrabForBook(neighbourBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title: 'Alpha: Beta Gamma: Gamma' });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  // Both sides need titleSegments; scalar normalization alone rejects this book's own release.
  const parenBook = { id: 6, title: 'Star (Deluxe) Wars: Haunted Starlight', duration: 3600, authors: [{ name: 'George Mann' }] };

  it('grabs the paren-intact own release of a split-anchor title at the prefix(1) rung (AC16)', async () => {
    const svc = indexerServiceAnswering({
      'star wars George Mann': [makeResult({ title: 'Star (Deluxe) Wars: Haunted Starlight' })],
    });

    const result = await searchAndGrabForBook(parenBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title: 'Star (Deluxe) Wars: Haunted Starlight' });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  // ASCII folding erases these siblings' distinguishing characters; the survival gate must hold them.
  const lossyBook = { id: 7, title: 'World of Warcraft: A', duration: 3600, authors: [{ name: 'Christie Golden' }] };

  it('holds a lossy-fold sibling found at the prefix(1) rung rather than grabbing it (F1)', async () => {
    const svc = indexerServiceAnswering({
      'world of warcraft Christie Golden': [
        makeResult({ title: 'World of Warcraft: A前夜', seeders: 99 }),
        makeResult({ title: 'World of Warcraft: A後夜', seeders: 1 }),
      ],
    });

    const result = await searchAndGrabForBook(lossyBook, deps(svc));

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(eventHistory.create).toHaveBeenCalledTimes(1);
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      bookId: 7,
      reason: expect.objectContaining({ variant_tag: 'prefix(1)', release_title: 'World of Warcraft: A前夜' }),
    }));
  });

  it('still grabs the lossy-gated book own ASCII release at the prefix(1) rung (F1)', async () => {
    const svc = indexerServiceAnswering({
      'world of warcraft Christie Golden': [makeResult({ title: 'World of Warcraft: A' })],
    });

    const result = await searchAndGrabForBook(lossyBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title: 'World of Warcraft: A' });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  it('holds the sibling of a split-anchor title at the prefix(1) rung (AC16)', async () => {
    const svc = indexerServiceAnswering({
      'star wars George Mann': [makeResult({ title: 'Star (Deluxe) Wars: Cataclysm' })],
    });

    const result = await searchAndGrabForBook(parenBook, deps(svc));

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(eventHistory.create).toHaveBeenCalledTimes(1);
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'search_relaxed_held',
      bookId: 6,
      reason: expect.objectContaining({ variant_tag: 'prefix(1)', release_title: 'Star (Deluxe) Wars: Cataclysm' }),
    }));
  });

  // Held events name only downloadable floor failures, never passing rows without URLs.
  it('records no held event when floor-passing results exist but none is downloadable (AC40, AC41)', async () => {
    const svc = indexerServiceAnswering({
      'star wars haunted starlight George Mann': [makeResult({ title: 'Star Wars: Haunted Starlight', downloadUrl: undefined })],
    });

    const result = await searchAndGrabForBook(franchiseBook, deps(svc));

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  it('records no held event when the gates removed every result (AC40)', async () => {
    const svc = indexerServiceAnswering({
      'star wars haunted starlight George Mann': [makeResult({ title: 'Dune EPUB' })],
    });

    const result = await searchAndGrabForBook(franchiseBook, deps(svc));

    expect(result).toEqual({ result: 'no_results' });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  // A full rung is not a segment cut, so it has no corroboration floor (AC33).
  it('never applies the floor or holds on a full-tagged winning rung (AC33)', async () => {
    const svc = indexerServiceAnswering({
      'star wars the rising storm Cavan Scott': [makeResult({ title: 'Completely Unrelated Release' })],
    });

    const result = await searchAndGrabForBook(risingStormBook, deps(svc));

    expect(result).toEqual({ result: 'grabbed', title: 'Completely Unrelated Release' });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  // Every indexer rejected is an outage, not a genuine zero; never advance or record cooldown (AC36).
  it('aborts the ladder after ONE rung when no indexer answered, recording no cooldown (AC36)', async () => {
    const svc = indexerServiceAnswering({}, { succeeded: 0 });
    const searchLadderCooldown = new SearchLadderCooldown();
    const recordExhausted = vi.spyOn(searchLadderCooldown, 'recordExhausted');

    const result = await searchAndGrabForBook(franchiseBook, deps(svc, { searchLadderCooldown, ladderMode: 'scheduled' }));

    expect(result).toEqual({ result: 'no_results' });
    expect(queriesOf(svc)).toHaveLength(1);
    expect(recordExhausted).not.toHaveBeenCalled();
  });

  // One answered-empty indexer makes the aggregate a genuine zero despite another failure.
  it('advances when at least one indexer answered but the aggregate is empty (AC35)', async () => {
    const svc = inject<IndexerSearchService>({ searchAllWithStatus: mockSearchAllWithStatus([], { failed: 1 }) });

    await searchAndGrabForBook(churnBook, deps(svc));

    expect(queriesOf(svc)).toEqual([
      'The Churn An Expanse Novella James S A Corey',
      'the churn James S A Corey',
      'an expanse novella James S A Corey',
      'the churn an expanse novella',
      'the churn',
      'an expanse novella',
    ]);
  });

  it('honours a live cooldown under ladderMode "scheduled" and ignores it under the default (AC34)', async () => {
    const searchLadderCooldown = new SearchLadderCooldown();
    const scheduledSvc = indexerServiceAnswering({});

    // First scheduled cycle exhausts and records.
    await searchAndGrabForBook(churnBook, deps(scheduledSvc, { searchLadderCooldown, ladderMode: 'scheduled' }));
    expect(queriesOf(scheduledSvc)).toHaveLength(6);

    // The next scheduled cycle is restricted to rung 1.
    const cycle2 = indexerServiceAnswering({});
    await searchAndGrabForBook(churnBook, deps(cycle2, { searchLadderCooldown, ladderMode: 'scheduled' }));
    expect(queriesOf(cycle2)).toEqual(['The Churn An Expanse Novella James S A Corey']);

    // Manual mode still runs the full ladder while the cooldown is live.
    const manual = indexerServiceAnswering({});
    await searchAndGrabForBook(churnBook, deps(manual, { searchLadderCooldown }));
    expect(queriesOf(manual)).toHaveLength(6);
  });

  it('clears a live cooldown entry when rung 1 hits (AC23)', async () => {
    const searchLadderCooldown = new SearchLadderCooldown();
    await searchAndGrabForBook(churnBook, deps(indexerServiceAnswering({}), { searchLadderCooldown, ladderMode: 'scheduled' }));

    const hit = indexerServiceAnswering({ 'The Churn An Expanse Novella James S A Corey': [makeResult()] });
    await searchAndGrabForBook(churnBook, deps(hit, { searchLadderCooldown, ladderMode: 'scheduled' }));

    const after = indexerServiceAnswering({});
    await searchAndGrabForBook(churnBook, deps(after, { searchLadderCooldown, ladderMode: 'scheduled' }));
    expect(queriesOf(after)).toHaveLength(6);
  });

  // Restricted cycles must not refresh the window or the cooldown never expires.
  it('does not re-record exhaustion off a restricted (rung-1-only) cycle', async () => {
    const searchLadderCooldown = new SearchLadderCooldown();
    const recordExhausted = vi.spyOn(searchLadderCooldown, 'recordExhausted');

    await searchAndGrabForBook(churnBook, deps(indexerServiceAnswering({}), { searchLadderCooldown, ladderMode: 'scheduled' }));
    await searchAndGrabForBook(churnBook, deps(indexerServiceAnswering({}), { searchLadderCooldown, ladderMode: 'scheduled' }));

    expect(recordExhausted).toHaveBeenCalledTimes(1);
  });

  // Without rankingAuthor, author-off rungs lose canonical-author ranking context.
  it('passes the canonical author as rankingAuthor on every rung, transport author only on author-ON ones (AC17)', async () => {
    const svc = indexerServiceAnswering({ 'the churn': [makeResult()] });

    await searchAndGrabForBook(churnBook, deps(svc));

    const calls = vi.mocked(svc.searchAllWithStatus).mock.calls;
    for (const [, options] of calls) {
      expect(options).toEqual(expect.objectContaining({
        title: 'The Churn: An Expanse Novella',
        rankingAuthor: 'James S. A. Corey',
      }));
    }
    expect(calls.map(([query, options]) => [query, (options as { author?: string }).author])).toEqual([
      ['The Churn An Expanse Novella James S A Corey', 'James S. A. Corey'],
      ['the churn James S A Corey', 'James S. A. Corey'],
      ['an expanse novella James S A Corey', 'James S. A. Corey'],
      ['the churn an expanse novella', undefined],
      ['the churn', undefined],
    ]);
  });
});

describe('searchAndGrabForBook — query ladder on the broadcaster path (#2104)', () => {
  const churnBook = { id: 2, title: 'The Churn: An Expanse Novella', duration: 3600, authors: [{ name: 'James S. A. Corey' }] };

  // search_started is per call; emitting inside the rung executor duplicates it (AC18).
  it('emits search_started exactly once regardless of how many rungs run (AC18)', async () => {
    const broadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    const indexerSearchService = {
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
      searchAllStreaming: vi.fn().mockImplementation(
        async (_q: string, _o: unknown, _c: Map<number, AbortController>, cb: { onComplete: (id: number, n: string, count: number, ms: number) => void }) => {
          cb.onComplete(10, 'MAM', 0, 5);
          return [];
        },
      ),
    } as unknown as IndexerSearchService;

    await searchAndGrabForBook(churnBook, {
      indexerSearchService,
      downloadOrchestrator: { grab: vi.fn() } as unknown as DownloadOrchestrator,
      qualitySettings: defaultQualitySettings,
      log: createMockLogger(),
      blacklistService: {
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>() }),
      } as unknown as BlacklistService,
      indexerService: mockIndexer,
      eventHistory: createMockEventHistory(),
      broadcaster,
    });

    expect(indexerSearchService.searchAllStreaming).toHaveBeenCalledTimes(6);
    const startedEmissions = vi.mocked(broadcaster.emit).mock.calls.filter(([event]) => event === 'search_started');
    expect(startedEmissions).toHaveLength(1);
  });

  // One controller map preserves cancellations from earlier rungs (D11).
  it('reuses one sticky controller map across every rung (AC27)', async () => {
    const seen: Array<Map<number, AbortController>> = [];
    const indexerSearchService = {
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
      searchAllStreaming: vi.fn().mockImplementation(
        async (_q: string, _o: unknown, controllers: Map<number, AbortController>, cb: { onComplete: (id: number, n: string, count: number, ms: number) => void }) => {
          seen.push(controllers);
          cb.onComplete(10, 'MAM', 0, 5);
          return [];
        },
      ),
    } as unknown as IndexerSearchService;

    await searchAndGrabForBook(churnBook, {
      indexerSearchService,
      downloadOrchestrator: { grab: vi.fn() } as unknown as DownloadOrchestrator,
      qualitySettings: defaultQualitySettings,
      log: createMockLogger(),
      blacklistService: {
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>() }),
      } as unknown as BlacklistService,
      indexerService: mockIndexer,
      eventHistory: createMockEventHistory(),
      broadcaster: { emit: vi.fn() } as unknown as EventBroadcasterService,
    });

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(1);
  });
});

describe('filterAndRankResults — drop accounting (#2325)', () => {
  const base = { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' };

  it('reports the gate that emptied the set with its threshold', () => {
    const { results, dropSummary } = filterAndRankResults(
      [makeResult({ title: 'Tracker test', size: 5 * MB })],
      3600,
      { ...base, minDownloadSize: 50 },
    );

    expect(results).toHaveLength(0);
    expect(dropSummary.total).toBe(1);
    expect(dropSummary.reasons[0]).toEqual({ reason: 'below-min-size', count: 1, threshold: '50 MB' });
  });

  it('attributes a doubly-failing result to the earlier gate only (AC3)', () => {
    const { dropSummary } = filterAndRankResults(
      [makeResult({ title: 'German Sample', size: 5 * MB })],
      3600,
      { ...base, rejectWords: 'german', minDownloadSize: 50 },
    );

    expect(dropSummary.total).toBe(1);
    expect(dropSummary.reasons).toEqual([{ reason: 'reject-word-match', count: 1 }]);
  });

  it('counts nothing for results sitting exactly on each inclusive threshold', () => {
    const { results, dropSummary } = filterAndRankResults(
      [
        makeResult({ title: 'At min size', size: 50 * MB, seeders: 5 }),
        makeResult({ title: 'At max size', size: 2 * GB, seeders: 5 }),
      ],
      3600,
      { ...base, minSeeders: 5, grabFloor: 50, minDownloadSize: 50, maxDownloadSize: 2 },
    );

    expect(results).toHaveLength(2);
    expect(dropSummary).toEqual({ total: 0, reasons: [] });
  });

  it('counts nothing when size or seeders are missing or zero', () => {
    const { results, dropSummary } = filterAndRankResults(
      [
        makeResult({ title: 'No size', size: undefined }),
        makeResult({ title: 'Zero size', size: 0 }),
        makeResult({ title: 'No seeders', seeders: undefined }),
      ],
      3600,
      { ...base, minSeeders: 5, minDownloadSize: 50, maxDownloadSize: 2 },
    );

    expect(results).toHaveLength(3);
    expect(dropSummary).toEqual({ total: 0, reasons: [] });
  });

  it('never reports below-grab-floor when the book duration is unknown', () => {
    const { results, dropSummary } = filterAndRankResults(
      [makeResult({ title: 'Tiny bitrate', size: 5 * MB })],
      undefined,
      { ...base, grabFloor: 100 },
    );

    expect(results).toHaveLength(1);
    expect(dropSummary.reasons).toEqual([]);
  });

  it('counts a language mismatch but not an undetermined language', () => {
    const { dropSummary } = filterAndRankResults(
      [
        makeResult({ title: 'German edition', language: 'german' }),
        makeResult({ title: 'Unknown language', language: undefined }),
      ],
      3600,
      { ...base, languages: ['english'] },
    );

    expect(dropSummary.total).toBe(1);
    expect(dropSummary.reasons[0]).toEqual({ reason: 'language-mismatch', count: 1, threshold: 'english' });
  });

  it('reports both size gates when one result is under and another over', () => {
    const { dropSummary } = filterAndRankResults(
      [
        makeResult({ title: 'Too small', size: 5 * MB }),
        makeResult({ title: 'Too big', size: 10 * GB }),
      ],
      3600,
      { ...base, minDownloadSize: 50, maxDownloadSize: 5 },
    );

    expect(dropSummary.total).toBe(2);
    expect(dropSummary.reasons).toEqual([
      { reason: 'below-min-size', count: 1, threshold: '50 MB' },
      { reason: 'over-max-size', count: 1, threshold: '5 GB' },
    ]);
  });

  it('attributes reject-word and required-word failures to their own gates', () => {
    const { dropSummary } = filterAndRankResults(
      [
        makeResult({ title: 'German Unabridged' }),
        makeResult({ title: 'Abridged Edition' }),
      ],
      3600,
      { ...base, rejectWords: 'german', requiredWords: 'unabridged' },
    );

    expect(dropSummary.total).toBe(2);
    expect(dropSummary.reasons).toEqual([
      { reason: 'reject-word-match', count: 1 },
      { reason: 'required-word-missing', count: 1 },
    ]);
  });

  it('returns an empty summary when every result survives', () => {
    const { results, dropSummary } = filterAndRankResults(
      [makeResult({ title: 'Keeper', size: 500 * MB })],
      3600,
      { ...base, minDownloadSize: 50, maxDownloadSize: 5 },
    );

    expect(results).toHaveLength(1);
    expect(dropSummary).toEqual({ total: 0, reasons: [] });
  });
});

describe('applyMultiPartFilterAndRank — emptied-set info log (#2325 AC6)', () => {
  const base = { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' };

  // The dominant reason sits after below-min-size in the vocabulary, so only the count ranking names it.
  it('logs once at info with the dominant reason, its threshold, and the per-reason counts', () => {
    const log = createMockLogger();

    applyMultiPartFilterAndRank(
      [
        makeResult({ title: 'Tracker test', size: 5 * MB }),
        makeResult({ title: 'German edition', size: 500 * MB, language: 'german' }),
        makeResult({ title: 'Deutsche Ausgabe', size: 500 * MB, language: 'german' }),
      ],
      3600,
      { ...base, minDownloadSize: 50, languages: ['english'] },
      log,
    );

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      {
        inputCount: 3,
        droppedCount: 3,
        reason: 'language-mismatch',
        threshold: 'english',
        dropCounts: { 'language-mismatch': 2, 'below-min-size': 1 },
      },
      'All search results removed by quality filters',
    );
  });

  it('omits the threshold field when the dominant reason has none (F9)', () => {
    const log = createMockLogger();

    applyMultiPartFilterAndRank(
      [makeResult({ title: 'German Unabridged' })],
      3600,
      { ...base, rejectWords: 'german' },
      log,
    );

    expect(log.info).toHaveBeenCalledTimes(1);
    const fields = vi.mocked(log.info).mock.calls[0]![0] as Record<string, unknown>;
    expect(fields).not.toHaveProperty('threshold');
    expect(fields).toEqual({
      inputCount: 1,
      droppedCount: 1,
      reason: 'reject-word-match',
      dropCounts: { 'reject-word-match': 1 },
    });
  });

  it('does not log at info when only some results are dropped, but still logs the debug line', () => {
    const log = createMockLogger();

    applyMultiPartFilterAndRank(
      [
        makeResult({ title: 'Tracker test', size: 5 * MB }),
        makeResult({ title: 'Real Book', size: 500 * MB }),
      ],
      3600,
      { ...base, minDownloadSize: 50 },
      log,
    );

    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith({ inputCount: 2, outputCount: 1 }, 'Quality gate filtering applied');
  });

  it('does not log at info when the input set was already empty', () => {
    const log = createMockLogger();

    applyMultiPartFilterAndRank([], 3600, { ...base, minDownloadSize: 50 }, log);

    expect(log.info).not.toHaveBeenCalled();
  });
});

describe('searchAndGrabForBook — emptied-set info log reaches the auto-grab path (#2325 AC6)', () => {
  it('logs the quality-filter line and still reports no_results', async () => {
    const log = createMockLogger();
    const indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult({ title: 'Tracker test', size: 5 * MB })])),
    } as unknown as IndexerSearchService;

    const outcome = await searchAndGrabForBook(
      { id: 1, title: 'The Way of Kings' },
      {
        indexerSearchService,
        downloadOrchestrator: { grab: vi.fn() } as unknown as DownloadOrchestrator,
        qualitySettings: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 },
        log,
        blacklistService: {
          getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>() }),
        } as unknown as BlacklistService,
        indexerService: mockIndexer,
        eventHistory: createMockEventHistory(),
      },
    );

    expect(outcome).toEqual({ result: 'no_results' });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ inputCount: 1, droppedCount: 1, reason: 'below-min-size', threshold: '50 MB' }),
      'All search results removed by quality filters',
    );
  });
});

describe('searchAndGrabForBook — entirely-blacklisted info log (#2336 AC4)', () => {
  const BLACKLIST_LINE = 'All search results removed by the blacklist';
  const book = { id: 7, title: 'The Way of Kings' };

  function run(results: SearchResult[], blacklist: { hashes?: string[]; guids?: string[] }, log: FastifyBaseLogger, quality: SearchFilterOptions = defaultQualitySettings) {
    return searchAndGrabForBook(book, {
      indexerSearchService: { searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus(results)) } as unknown as IndexerSearchService,
      downloadOrchestrator: { grab: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as DownloadOrchestrator,
      qualitySettings: quality,
      log,
      blacklistService: {
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
          blacklistedHashes: new Set(blacklist.hashes ?? []),
          blacklistedGuids: new Set(blacklist.guids ?? []),
        }),
      } as unknown as BlacklistService,
      indexerService: mockIndexer,
      eventHistory: createMockEventHistory(),
    });
  }

  it('logs the blacklist line with the book context and still reports no_results', async () => {
    const log = createMockLogger();

    const outcome = await run(
      [makeResult({ infoHash: 'h1' }), makeResult({ infoHash: 'h2' })],
      { hashes: ['h1', 'h2'] },
      log,
    );

    expect(outcome).toEqual({ result: 'no_results' });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: 7,
        title: 'The Way of Kings',
        inputCount: 2,
        droppedCount: 2,
        reason: 'blacklist-match',
        dropCounts: { 'blacklist-match': 2 },
      }),
      BLACKLIST_LINE,
    );
  });

  // The level moved; a fix that adds the info line without retiring the debug one leaves two records.
  it('no longer emits the debug-only line for the same run', async () => {
    const log = createMockLogger();

    await run([makeResult({ infoHash: 'h1' })], { hashes: ['h1'] }, log);

    expect(log.debug).not.toHaveBeenCalledWith(expect.anything(), 'All results blacklisted');
  });

  it('fires for a usenet result blacklisted by guid alone', async () => {
    const log = createMockLogger();

    await run(
      [makeResult({ protocol: 'usenet', guid: 'bad-guid', infoHash: undefined, downloadUrl: 'http://nzb.test/1' })],
      { guids: ['bad-guid'] },
      log,
    );

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ inputCount: 1, droppedCount: 1, reason: 'blacklist-match' }),
      BLACKLIST_LINE,
    );
  });

  it('stays silent when a survivor remains, and grabs it (AC7)', async () => {
    const log = createMockLogger();

    const outcome = await run(
      [makeResult({ infoHash: 'bad', title: 'Blacklisted' }), makeResult({ infoHash: 'good', title: 'Clean' })],
      { hashes: ['bad'] },
      log,
    );

    expect(outcome).toEqual({ result: 'grabbed', title: 'Clean' });
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), BLACKLIST_LINE);
  });

  // AC8: only one empty-set signal per search, and the quality line counts POST-blacklist input.
  it('yields to the quality-filter line when the blacklist drops only some results', async () => {
    const log = createMockLogger();

    await run(
      [
        makeResult({ infoHash: 'bad', title: 'Blacklisted', size: 500 * MB }),
        makeResult({ infoHash: 'small1', title: 'Tiny One', size: 5 * MB }),
        makeResult({ infoHash: 'small2', title: 'Tiny Two', size: 5 * MB }),
      ],
      { hashes: ['bad'] },
      log,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 50 },
    );

    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), BLACKLIST_LINE);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ inputCount: 2, droppedCount: 2, reason: 'below-min-size' }),
      'All search results removed by quality filters',
    );
  });

  it('leaves a genuine answered zero on its existing debug line', async () => {
    const log = createMockLogger();

    await run([], {}, log);

    expect(log.debug).toHaveBeenCalledWith({ bookId: 7, title: 'The Way of Kings' }, 'No results found');
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), BLACKLIST_LINE);
  });

  // The gate short-circuits without consulting the service, so the set can never be emptied here.
  it('stays silent when no result carries an infoHash or a guid', async () => {
    const log = createMockLogger();

    await run([makeResult({ title: 'No Identifiers' })], { hashes: ['h1'] }, log);

    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), BLACKLIST_LINE);
  });
});

describe('postProcessSearchResults — filteredOut wire field (#2325 AC8, AC9)', () => {
  function createSettings(qualityOverrides: Record<string, unknown> = {}, metadataOverrides: Record<string, unknown> = {}): SettingsService {
    const qualityDefaults = { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 0, minDownloadSize: 0, rejectWords: '', requiredWords: '' };
    return {
      get: vi.fn().mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve({ ...qualityDefaults, ...qualityOverrides });
        if (cat === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: [], ...metadataOverrides });
        return Promise.resolve({});
      }),
    } as unknown as SettingsService;
  }

  function createBlacklist(guids: string[] = []): BlacklistService {
    return {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set<string>(),
        blacklistedGuids: new Set(guids),
      }),
    } as unknown as BlacklistService;
  }

  beforeEach(() => {
    mockEnrichUsenet.mockReset();
  });

  it('carries the summary when the gates empty a non-empty raw set', async () => {
    const output = await postProcessSearchResults(
      [makeResult({ title: 'Tracker test', size: 5 * MB })],
      3600,
      createBlacklist(),
      createSettings({ minDownloadSize: 50 }),
      mockIndexer,
      createMockLogger(),
    );

    expect(output.results).toEqual([]);
    expect(output.filteredOut).toEqual({
      total: 1,
      reasons: [{ reason: 'below-min-size', count: 1, threshold: '50 MB' }],
    });
  });

  it('omits the key entirely when nothing was dropped', async () => {
    const output = await postProcessSearchResults(
      [makeResult({ title: 'Real Book', size: 500 * MB })],
      3600,
      createBlacklist(),
      createSettings({ minDownloadSize: 50 }),
      mockIndexer,
      createMockLogger(),
    );

    expect(output.results).toHaveLength(1);
    expect(output).not.toHaveProperty('filteredOut');
  });

  it('merges the blacklist delta with the gate counts (AC9)', async () => {
    const output = await postProcessSearchResults(
      [
        makeResult({ title: 'Blacklisted A', guid: 'blk-1', size: 500 * MB }),
        makeResult({ title: 'Blacklisted B', guid: 'blk-2', size: 500 * MB }),
        makeResult({ title: 'Tracker test', guid: 'clean', size: 5 * MB }),
      ],
      3600,
      createBlacklist(['blk-1', 'blk-2']),
      createSettings({ minDownloadSize: 50 }),
      mockIndexer,
      createMockLogger(),
    );

    expect(output.results).toEqual([]);
    expect(output.filteredOut).toEqual({
      total: 3,
      reasons: [
        { reason: 'blacklist-match', count: 2 },
        { reason: 'below-min-size', count: 1, threshold: '50 MB' },
      ],
    });
  });

  it('reports a wholly blacklisted set with no gate entries', async () => {
    const output = await postProcessSearchResults(
      [
        makeResult({ title: 'Blacklisted A', guid: 'blk-1', size: 500 * MB }),
        makeResult({ title: 'Blacklisted B', guid: 'blk-2', size: 500 * MB }),
        makeResult({ title: 'Blacklisted C', guid: 'blk-3', size: 500 * MB }),
      ],
      3600,
      createBlacklist(['blk-1', 'blk-2', 'blk-3']),
      createSettings(),
      mockIndexer,
      createMockLogger(),
    );

    expect(output.filteredOut).toEqual({ total: 3, reasons: [{ reason: 'blacklist-match', count: 3 }] });
  });

  it('leaves filteredOut absent when only the multi-part filter emptied the set (AC7)', async () => {
    mockEnrichUsenet.mockResolvedValue(undefined);

    const output = await postProcessSearchResults(
      [makeResult({ protocol: 'usenet', title: 'Book Title (01 of 30)', downloadUrl: 'http://nzb.test/1' })],
      3600,
      createBlacklist(),
      createSettings(),
      mockIndexer,
      createMockLogger(),
    );

    expect(output.results).toEqual([]);
    expect(output.unsupportedResults.count).toBe(1);
    expect(output).not.toHaveProperty('filteredOut');
  });
});

/**
 * #2310 — `searchAndGrabForBook` wraps its whole body in one deadline. The timer is a hand-rolled
 * `setTimeout`, so a `globalThis` spy captures it; filtering on the exact budget leaves every other
 * timer in the process real.
 */
describe('#2310 search deadline', () => {
  const book = { id: 1, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };
  const NEVER = <T,>() => new Promise<T>(() => { /* the stalled leaf */ });

  let indexerSearchService: IndexerSearchService;
  let downloadService: DownloadOrchestrator;
  let blacklistService: BlacklistService;
  let eventHistory: EventHistoryService;
  let log: FastifyBaseLogger;
  let armed: Array<{ delay: number; fire: () => void }>;

  function captureDeadlineTimers() {
    const captured: Array<{ delay: number; fire: () => void }> = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number, ...rest: unknown[]) => {
      if (delay !== SEARCH_DEADLINE_MS) return original(fn as never, delay as never, ...rest as never[]);
      captured.push({ delay: delay!, fire: fn });
      const parked = original(() => { /* never fires within a test */ }, 2 ** 30);
      parked.unref();
      return parked;
    }) as never);
    return captured;
  }

  const baseDeps = () => ({
    indexerSearchService, downloadOrchestrator: downloadService, qualitySettings: defaultQualitySettings,
    log, blacklistService, indexerService: mockIndexer, eventHistory,
  });

  beforeEach(() => {
    _resetSearchRegistryForTesting();
    armed = captureDeadlineTimers();
    indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([makeResult()])),
    } as unknown as IndexerSearchService;
    downloadService = { grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }) } as unknown as DownloadOrchestrator;
    blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>() }),
    } as unknown as BlacklistService;
    eventHistory = createMockEventHistory();
    log = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Stalled operations never settle, so their registry slots would leak into later suites.
    _resetSearchRegistryForTesting();
  });

  it('arms exactly one timer for the whole call, with the SEARCH_DEADLINE_MS budget', async () => {
    await searchAndGrabForBook(book, baseDeps());
    expect(armed).toHaveLength(1);
    expect(armed[0]!.delay).toBe(1_500_000);
  });

  describe('every stall class inside the body is bounded, and the caller always sees the canonical error', () => {
    // Each entry stalls a DIFFERENT await inside the raced body; AC3's claim is that the class of
    // leaf does not matter, so one case per class.
    /** `stalledLeafReached` pins WHICH leaf is pending when the deadline fires. */
    async function expectExpiry(deps: Parameters<typeof searchAndGrabForBook>[1], stalledLeafReached: () => void) {
      const running = searchAndGrabForBook(book, deps);
      const settled = vi.fn();
      void running.then(settled, () => { /* asserted below */ });

      await vi.waitFor(stalledLeafReached);
      expect(armed).toHaveLength(1);
      armed[0]!.fire();

      const error = await running.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SearchDeadlineError);
      // The observation point that matters: an expiry is never reported as an answered zero.
      expect(settled).not.toHaveBeenCalled();
      return error as SearchDeadlineError;
    }

    it('a never-settling indexer ladder', async () => {
      vi.mocked(indexerSearchService.searchAllWithStatus).mockImplementation(NEVER);
      const error = await expectExpiry(baseDeps(), () => expect(indexerSearchService.searchAllWithStatus).toHaveBeenCalled());
      expect(error.bookId).toBe(1);
      expect(error.budgetMs).toBe(SEARCH_DEADLINE_MS);
    });

    it('a never-settling local database read (the blacklist gate)', async () => {
      // The gate short-circuits on results with no identifier, so give it one to read.
      vi.mocked(indexerSearchService.searchAllWithStatus).mockResolvedValue(searchStatus([makeResult({ guid: 'g1' })]));
      vi.mocked(blacklistService.getBlacklistedIdentifiers).mockImplementation(NEVER);
      await expectExpiry(baseDeps(), () => expect(blacklistService.getBlacklistedIdentifiers).toHaveBeenCalled());
    });

    it('a never-settling writeFile inside the Blackhole handoff — the originally-filed defect', async () => {
      const blackhole = new BlackholeClient({ watchDir: tmpdir(), protocol: 'torrent' });
      vi.mocked(writeFile).mockImplementation(NEVER);
      downloadService = {
        grab: vi.fn(async () => {
          await blackhole.addDownload({ type: 'magnet-uri', uri: 'magnet:?xt=urn:btih:aaa', infoHash: 'aaa' });
          return { id: 1 } as never;
        }),
      } as unknown as DownloadOrchestrator;

      await expectExpiry(baseDeps(), () => expect(writeFile).toHaveBeenCalled());
      expect(downloadService.grab).toHaveBeenCalledTimes(1);
    });

    it('a never-settling DNS preflight inside the redirect helper — the leg no per-leg timeout bounds', async () => {
      vi.mocked(dnsLookup).mockImplementation(NEVER);
      downloadService = {
        grab: vi.fn(async () => {
          await fetchWithSsrfRedirect('https://indexer.test/getnzb/abc.nzb', {});
          return { id: 1 } as never;
        }),
      } as unknown as DownloadOrchestrator;

      await expectExpiry(baseDeps(), () => expect(dnsLookup).toHaveBeenCalled());
      expect(dnsLookup).toHaveBeenCalled();
    });
  });

  describe('one operation per book', () => {
    it('runs the work once and skips concurrent same-book callers without arming their timers', async () => {
      vi.mocked(indexerSearchService.searchAllWithStatus).mockImplementation(NEVER);

      const first = searchAndGrabForBook(book, baseDeps());
      const second = await searchAndGrabForBook(book, baseDeps());
      const third = await searchAndGrabForBook(book, baseDeps());

      expect(indexerSearchService.searchAllWithStatus).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ result: 'skipped', reason: 'search_already_in_flight' });
      expect(third).toEqual({ result: 'skipped', reason: 'search_already_in_flight' });
      expect(armed).toHaveLength(1);
      expect(log.info).toHaveBeenCalledWith(
        { bookId: 1, title: 'Test Book' },
        'Search skipped — this book already has one in flight',
      );

      armed[0]!.fire();
      await expect(first).rejects.toBeInstanceOf(SearchDeadlineError);
    });

    it('keeps skipping while the abandoned operation is still pending after its deadline', async () => {
      vi.mocked(indexerSearchService.searchAllWithStatus).mockImplementation(NEVER);

      const first = searchAndGrabForBook(book, baseDeps());
      await vi.waitFor(() => expect(armed).toHaveLength(1));
      armed[0]!.fire();
      await expect(first).rejects.toBeInstanceOf(SearchDeadlineError);

      expect(await searchAndGrabForBook(book, baseDeps())).toEqual({ result: 'skipped', reason: 'search_already_in_flight' });
      expect(indexerSearchService.searchAllWithStatus).toHaveBeenCalledTimes(1);
    });

    it('leaves a different book unaffected', async () => {
      vi.mocked(indexerSearchService.searchAllWithStatus).mockImplementationOnce(NEVER);

      void searchAndGrabForBook(book, baseDeps());
      const other = await searchAndGrabForBook({ ...book, id: 2 }, baseDeps());

      expect(other).toEqual({ result: 'grabbed', title: 'Test Book' });
      expect(armed).toHaveLength(2);
    });

    it('frees the slot once the operation settles, so the next call runs normally', async () => {
      expect(await searchAndGrabForBook(book, baseDeps())).toEqual({ result: 'grabbed', title: 'Test Book' });
      expect(await searchAndGrabForBook(book, baseDeps())).toEqual({ result: 'grabbed', title: 'Test Book' });
      expect(indexerSearchService.searchAllWithStatus).toHaveBeenCalledTimes(2);
    });

    it('holds exactly one entry however many further callers arrive', async () => {
      vi.mocked(indexerSearchService.searchAllWithStatus).mockImplementation(NEVER);
      void searchAndGrabForBook(book, baseDeps());

      for (let i = 0; i < 5; i++) {
        expect(await searchAndGrabForBook(book, baseDeps())).toEqual({ result: 'skipped', reason: 'search_already_in_flight' });
      }
      expect(indexerSearchService.searchAllWithStatus).toHaveBeenCalledTimes(1);
      expect(armed).toHaveLength(1);
    });

    it('contributes exactly one admission-lock waiter while a same-book lock holder is stuck', async () => {
      let releaseHolder!: () => void;
      const held = new Promise<void>((resolve) => { releaseHolder = resolve; });
      void withBookAdmissionLock(book.id, () => held);

      const entered = vi.fn();
      downloadService = {
        grab: vi.fn((params: { bookId: number }) => withBookAdmissionLock(params.bookId, async () => {
          entered();
          return { id: 1 } as never;
        })),
      } as unknown as DownloadOrchestrator;

      const first = searchAndGrabForBook(book, baseDeps());
      const skippedA = await searchAndGrabForBook(book, baseDeps());
      const skippedB = await searchAndGrabForBook(book, baseDeps());

      await vi.waitFor(() => expect(downloadService.grab).toHaveBeenCalledTimes(1));
      expect(entered).not.toHaveBeenCalled();
      expect(skippedA).toEqual({ result: 'skipped', reason: 'search_already_in_flight' });
      expect(skippedB).toEqual({ result: 'skipped', reason: 'search_already_in_flight' });

      releaseHolder();
      await expect(first).resolves.toEqual({ result: 'grabbed', title: 'Test Book' });
      expect(entered).toHaveBeenCalledTimes(1);
    });
  });

  describe('grab integrity — abandon, never tear', () => {
    it('rejects the caller while the in-flight grab still runs to completion', async () => {
      let releaseGrab!: () => void;
      const inserted = vi.fn();
      downloadService = {
        grab: vi.fn(async () => {
          await new Promise<void>((resolve) => { releaseGrab = resolve; });
          inserted();
          return { id: 1 } as never;
        }),
      } as unknown as DownloadOrchestrator;

      const running = searchAndGrabForBook(book, baseDeps());
      await vi.waitFor(() => expect(releaseGrab).toBeDefined());
      armed[0]!.fire();

      await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);
      expect(inserted).not.toHaveBeenCalled();

      // Abandoned, not cancelled: the download record still lands after the caller gave up.
      releaseGrab();
      await vi.waitFor(() => expect(inserted).toHaveBeenCalledTimes(1));
    });

    it('never reaches the grab when the deadline fires during the search', async () => {
      vi.mocked(indexerSearchService.searchAllWithStatus).mockImplementation(NEVER);

      const running = searchAndGrabForBook(book, baseDeps());
      await vi.waitFor(() => expect(armed).toHaveLength(1));
      armed[0]!.fire();

      await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);
      expect(downloadService.grab).not.toHaveBeenCalled();
    });

    // AC8's exclusions, pinned so a later widening is a visible contract change. Cancelling a
    // handoff or an enrichment fetch buys nothing the race does not already deliver.
    it('threads no signal into the grab payload or the usenet enrichment', async () => {
      mockEnrichUsenet.mockReset();

      await searchAndGrabForBook(book, baseDeps());

      const payload = vi.mocked(downloadService.grab).mock.calls[0]![0] as unknown as Record<string, unknown>;
      expect(payload).not.toHaveProperty('signal');

      const enrichArgs = mockEnrichUsenet.mock.calls[0]!;
      expect(enrichArgs).toHaveLength(4);
      expect(enrichArgs[3]).not.toHaveProperty('signal');
    });
  });

  describe('signal propagation', () => {
    it('forwards a live, never-aborted signal to the aggregate search leg', async () => {
      await searchAndGrabForBook(book, baseDeps());
      const options = vi.mocked(indexerSearchService.searchAllWithStatus).mock.calls[0]![1] as { signal?: AbortSignal };
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal!.aborted).toBe(false);
    });

    it('aborts the search leg signal at expiry, so an abandoned run issues no further indexer requests', async () => {
      let seen: AbortSignal | undefined;
      vi.mocked(indexerSearchService.searchAllWithStatus).mockImplementation(((_q: string, o?: { signal?: AbortSignal }) => {
        seen = o?.signal;
        return NEVER();
      }) as never);

      const running = searchAndGrabForBook(book, baseDeps());
      await vi.waitFor(() => expect(seen).toBeDefined());
      armed[0]!.fire();
      await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);

      expect(seen!.aborted).toBe(true);
    });

    it('forwards the outer signal to the streaming leg as its own argument', async () => {
      const streaming = {
        searchAllStreaming: vi.fn().mockResolvedValue([makeResult({ indexerId: 10 })]),
        getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
      } as unknown as IndexerSearchService;

      await searchAndGrabForBook(book, {
        ...baseDeps(), indexerSearchService: streaming,
        broadcaster: { emit: vi.fn() } as unknown as EventBroadcasterService,
      });

      const outer = vi.mocked(streaming.searchAllStreaming).mock.calls[0]![4];
      expect(outer).toBeInstanceOf(AbortSignal);
      expect(outer!.aborted).toBe(false);
    });
  });

  describe('the terminal SSE contract on expiry', () => {
    let broadcaster: EventBroadcasterService;
    const emitsOf = (type: string) => vi.mocked(broadcaster.emit).mock.calls.filter((c) => c[0] === type);

    function streamingIndexer(impl?: () => Promise<SearchResult[]>): IndexerSearchService {
      const settle = impl ?? (async () => [makeResult({ indexerId: 10 })]);
      return {
        // onComplete is what makes `succeeded` non-zero, so the ladder reads a real answer.
        searchAllStreaming: vi.fn().mockImplementation(async (_q: string, _o: unknown, _c: unknown, callbacks: { onComplete: (id: number, n: string, r: number, ms: number) => void }) => {
          const results = await settle();
          callbacks.onComplete(10, 'MAM', results.length, 50);
          return results;
        }),
        getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
      } as unknown as IndexerSearchService;
    }

    beforeEach(() => {
      broadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    });

    it('emits exactly one terminal search_complete with outcome timed_out when the ladder expires', async () => {
      const streaming = streamingIndexer(NEVER);
      const running = searchAndGrabForBook(book, { ...baseDeps(), indexerSearchService: streaming, broadcaster });
      await vi.waitFor(() => expect(armed).toHaveLength(1));
      armed[0]!.fire();
      await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);

      expect(emitsOf('search_complete')).toHaveLength(1);
      expect(emitsOf('search_complete')[0]![1]).toEqual({ book_id: 1, total_results: 0, outcome: 'timed_out' });
      expect(emitsOf('search_started')).toHaveLength(1);
    });

    it('emits the same terminal event when the expiry lands after the ladder, during the grab', async () => {
      let releaseGrab!: () => void;
      downloadService = {
        grab: vi.fn(() => new Promise<never>((_, reject) => { releaseGrab = () => reject(new Error('too late')); })),
      } as unknown as DownloadOrchestrator;

      const running = searchAndGrabForBook(book, { ...baseDeps(), indexerSearchService: streamingIndexer(), broadcaster });
      await vi.waitFor(() => expect(releaseGrab).toBeDefined());
      armed[0]!.fire();
      await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);

      expect(emitsOf('search_complete')).toHaveLength(1);
      expect(emitsOf('search_complete')[0]![1]).toMatchObject({ outcome: 'timed_out' });
      releaseGrab();
    });

    it('fences a late grab so an abandoned run cannot flip a timed-out card to grabbed', async () => {
      let releaseGrab!: () => void;
      downloadService = {
        grab: vi.fn(() => new Promise<never>((resolve) => { releaseGrab = resolve as () => void; })),
      } as unknown as DownloadOrchestrator;

      const running = searchAndGrabForBook(book, { ...baseDeps(), indexerSearchService: streamingIndexer(), broadcaster });
      await vi.waitFor(() => expect(releaseGrab).toBeDefined());
      armed[0]!.fire();
      await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);

      releaseGrab();
      await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ bookId: 1 }), 'Auto-grabbed best result'));

      expect(emitsOf('search_grabbed')).toHaveLength(0);
      expect(emitsOf('search_complete')).toHaveLength(1);
      expect(emitsOf('search_complete')[0]![1]).toMatchObject({ outcome: 'timed_out' });
    });

    it('fences a late grab failure too', async () => {
      let failGrab!: () => void;
      downloadService = {
        grab: vi.fn(() => new Promise<never>((_, reject) => { failGrab = () => reject(new Error('client refused')); })),
      } as unknown as DownloadOrchestrator;

      const running = searchAndGrabForBook(book, { ...baseDeps(), indexerSearchService: streamingIndexer(), broadcaster });
      await vi.waitFor(() => expect(failGrab).toBeDefined());
      armed[0]!.fire();
      await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);

      failGrab();
      await vi.waitFor(() => expect(vi.mocked(eventHistory.create)).toHaveBeenCalled());

      expect(emitsOf('search_complete')).toHaveLength(1);
      expect(emitsOf('search_complete')[0]![1]).toMatchObject({ outcome: 'timed_out' });
    });

    it('drops a late per-indexer frame from abandoned ladder work', async () => {
      let emitFrame!: () => void;
      const streaming = {
        searchAllStreaming: vi.fn().mockImplementation((_q: string, _o: unknown, _c: unknown, callbacks: { onComplete: (id: number, n: string, r: number, ms: number) => void; onError: (id: number, n: string, e: string, ms: number) => void }) =>
          new Promise<SearchResult[]>((resolve) => {
            emitFrame = () => {
              callbacks.onComplete(10, 'MAM', 3, 100);
              callbacks.onError(11, 'ABB', 'boom', 100);
              resolve([]);
            };
          })),
        getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
      } as unknown as IndexerSearchService;

      const running = searchAndGrabForBook(book, { ...baseDeps(), indexerSearchService: streaming, broadcaster });
      await vi.waitFor(() => expect(emitFrame).toBeDefined());
      armed[0]!.fire();
      await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);

      emitFrame();
      await vi.waitFor(() => expect(log.debug).toHaveBeenCalledWith(
        { bookId: 1, event: 'search_indexer_complete' }, 'Search event dropped — a terminal event already fired',
      ));
      expect(emitsOf('search_indexer_complete')).toHaveLength(0);
      expect(emitsOf('search_indexer_error')).toHaveLength(0);
    });

    it('leaves the happy path emitting its normal grabbed → complete sequence', async () => {
      await searchAndGrabForBook(book, { ...baseDeps(), indexerSearchService: streamingIndexer(), broadcaster });

      expect(emitsOf('search_grabbed')).toHaveLength(1);
      expect(emitsOf('search_complete')).toHaveLength(1);
      expect(emitsOf('search_complete')[0]![1]).toMatchObject({ outcome: 'grabbed' });
    });

    it('emits nothing when there is no broadcaster', async () => {
      vi.mocked(indexerSearchService.searchAllWithStatus).mockImplementation(NEVER);
      const running = searchAndGrabForBook(book, baseDeps());
      await vi.waitFor(() => expect(armed).toHaveLength(1));
      armed[0]!.fire();

      await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);
    });

    it('still emits the terminal event when the expiry beats search_started', async () => {
      const streaming = {
        searchAllStreaming: vi.fn(),
        getEnabledIndexers: vi.fn().mockImplementation(NEVER),
      } as unknown as IndexerSearchService;

      const running = searchAndGrabForBook(book, { ...baseDeps(), indexerSearchService: streaming, broadcaster });
      await vi.waitFor(() => expect(armed).toHaveLength(1));
      armed[0]!.fire();
      await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);

      expect(emitsOf('search_started')).toHaveLength(0);
      expect(emitsOf('search_complete')).toHaveLength(1);
      expect(emitsOf('search_complete')[0]![1]).toMatchObject({ outcome: 'timed_out' });
    });
  });
});

/**
 * #2310 AC15 — the narrowing of #2304's single-flight wording, driven through the REAL
 * `runImmediateSearch` (the #2304 suites mock it at module level and never fire a deadline, so
 * they do not exercise this).
 */
describe('#2310 AC15 — the immediate-search chain advances past an expired book', () => {
  beforeEach(() => { _resetSearchRegistryForTesting(); });
  afterEach(() => { vi.restoreAllMocks(); _resetSearchRegistryForTesting(); });

  it('starts book 2 after book 1 expires, and book 1\'s indexer leg is left aborted', async () => {
    const armed: Array<() => void> = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number, ...rest: unknown[]) => {
      if (delay !== SEARCH_DEADLINE_MS) return original(fn as never, delay as never, ...rest as never[]);
      armed.push(fn);
      const parked = original(() => { /* never fires */ }, 2 ** 30);
      parked.unref();
      return parked;
    }) as never);

    const signals: Array<AbortSignal | undefined> = [];
    const searchAllWithStatus = vi.fn().mockImplementation((_q: string, options?: { signal?: AbortSignal }) => {
      signals.push(options?.signal);
      // Only the first book stalls; the second answers normally.
      return signals.length === 1 ? new Promise(() => { /* stalled */ }) : Promise.resolve(searchStatus([makeResult()]));
    });

    const log = createMockLogger();
    const deps = {
      indexerSearchService: { searchAllWithStatus } as unknown as IndexerSearchService,
      indexerService: mockIndexer,
      downloadOrchestrator: { grab: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as DownloadOrchestrator,
      settingsService: { get: vi.fn().mockResolvedValue({ ...defaultQualitySettings, languages: [], searchPriority: 'relevance' }) } as unknown as SettingsService,
      blacklistService: {
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>() }),
      } as unknown as BlacklistService,
      eventHistory: createMockEventHistory(),
    };

    const chain = runImmediateSearchChain(
      [{ id: 101, title: 'Stalled Book' }, { id: 102, title: 'Next Book' }],
      deps,
      log,
    );

    await vi.waitFor(() => expect(armed).toHaveLength(1));
    expect(searchAllWithStatus).toHaveBeenCalledTimes(1);
    armed[0]!();

    await chain;

    expect(searchAllWithStatus).toHaveBeenCalledTimes(2);
    // The abandoned run issues no further indexer requests — the #2304 property that mattered.
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 101, budgetMs: SEARCH_DEADLINE_MS }),
      'Search-immediately trigger abandoned at its deadline',
    );
  });
});

describe('gate interaction with the ABB metadata fields (#2365)', () => {
  it('keeps an ABB result that now carries a container format — no gate reads SearchResult.format', () => {
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Murder in the New Forest', indexer: 'AudioBookBay', format: 'm4b' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.format).toBe('m4b');
  });

  it('still drops an ebook-titled result carrying an audio format field — the title is what the gate reads', () => {
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Murder in the New Forest.epub', indexer: 'AudioBookBay', format: 'm4b' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' },
    );
    expect(results).toHaveLength(0);
  });

  it('no longer drops an ABB result for a rejectWords entry naming the uploader', () => {
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Murder in the New Forest', indexer: 'AudioBookBay', author: 'Carol Cole', narrator: 'James MacNaughton' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'greads123' },
    );
    expect(results).toHaveLength(1);
  });

  it('drops that same result when the uploader is the author — the pre-fix shape the gate saw', () => {
    const { results } = filterAndRankResults(
      [makeResult({ title: 'Murder in the New Forest', indexer: 'AudioBookBay', author: 'greads123' })],
      undefined,
      { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'greads123' },
    );
    expect(results).toHaveLength(0);
  });
});

/**
 * #2420 — ABB search results stopped carrying `infoHash`, `seeders`, `leechers` and `size`, and
 * carry `author`/`narrator` only on rows whose markup does. Each of those absences lands on a gate
 * that already has a rule for missing data; what these cases pin is that the rule is the one the
 * rework relies on, and each is paired with a control that a "keeps everything" regression fails.
 *
 * The shape has since moved on: an ABB row whose listing carries `File Size:`/`Language:` info
 * lines now arrives with `size`, `language` and `bitrateKbps` populated, so the absences above are
 * per-row rather than universal. The `parsed listing metadata` block below is the other half —
 * what the gates do once ABB actually feeds them.
 */
describe('#2420 — the ABB result shape through the pipeline', () => {
  const ABB_DETAILS_URL = 'https://audiobookbay.test/audio-books/murder-in-the-new-forest/';
  const ABB_GUID = 'abb:/audio-books/murder-in-the-new-forest/';

  /** A post-#2420 ABB row: sentinel download URL, path-derived guid, no hash, peers or size. */
  function abbResult(overrides: MakeResultOverrides = {}): SearchResult {
    return makeResult({
      title: 'Murder in the New Forest',
      indexer: 'AudioBookBay',
      protocol: 'torrent',
      guid: ABB_GUID,
      downloadUrl: `abb-details://${ABB_DETAILS_URL}`,
      infoHash: undefined,
      seeders: undefined,
      leechers: undefined,
      size: undefined,
      ...overrides,
    });
  }

  describe('absent seeders (AC5)', () => {
    it('keeps a seeder-less ABB result at minSeeders 5 while dropping a 1-seeder peer', () => {
      const { results } = filterAndRankResults(
        [abbResult(), makeResult({ title: 'Other Indexer', indexer: 'torznab', seeders: 1 })],
        undefined,
        { grabFloor: 0, minSeeders: 5, protocolPreference: 'none' },
      );

      expect(results.map((r) => r.title)).toEqual(['Murder in the New Forest']);
    });

    it('keeps both when the gate is disabled at minSeeders 0', () => {
      const { results } = filterAndRankResults(
        [abbResult(), makeResult({ title: 'Other Indexer', indexer: 'torznab', seeders: 1 })],
        undefined,
        { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' },
      );

      expect(results).toHaveLength(2);
    });

    // Jackett fakes Seeders = 1 for ABB; this is what that choice would have cost.
    it('control: a faked seeders:1 WOULD be dropped at minSeeders 5', () => {
      const { results } = filterAndRankResults(
        [abbResult({ seeders: 1 })],
        undefined,
        { grabFloor: 0, minSeeders: 5, protocolPreference: 'none' },
      );

      expect(results).toHaveLength(0);
    });
  });

  describe('absent size (AC6)', () => {
    it('keeps a size-less ABB result under the grab floor while dropping a sized result below it', () => {
      const { results } = filterAndRankResults(
        [abbResult(), makeResult({ title: 'Tiny Sized', indexer: 'torznab', size: 5 * MB })],
        3600,
        { grabFloor: 30, minSeeders: 0, protocolPreference: 'none' },
      );

      expect(results.map((r) => r.title)).toEqual(['Murder in the New Forest']);
    });

    it('keeps a size-less ABB result under minDownloadSize while dropping an undersized result', () => {
      const { results } = filterAndRankResults(
        [abbResult(), makeResult({ title: 'Too Small', indexer: 'torznab', size: 10 * MB })],
        undefined,
        { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', minDownloadSize: 100 },
      );

      expect(results.map((r) => r.title)).toEqual(['Murder in the New Forest']);
    });

    it('keeps a size-less ABB result under maxDownloadSize while dropping an oversized result', () => {
      const { results } = filterAndRankResults(
        [abbResult(), makeResult({ title: 'Too Big', indexer: 'torznab', size: 20 * GB })],
        undefined,
        { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 5 },
      );

      expect(results.map((r) => r.title)).toEqual(['Murder in the New Forest']);
    });
  });

  /**
   * #2504 — the other half of `absent size`: what the gates do once ABB's listing info lines are
   * actually parsed into `size` and `language`. Every drop is paired with the same result kept
   * under a threshold it passes, so no case is satisfiable by "ABB is always dropped" — or kept.
   */
  describe('parsed listing metadata through the gates (#2504)', () => {
    const noGates = { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' } as const;

    it('drops a parsed-size ABB result below minDownloadSize and keeps one above it', () => {
      const options = { ...noGates, minDownloadSize: 100 };

      const under = filterAndRankResults([abbResult({ size: 10 * MB })], undefined, options);
      const over = filterAndRankResults([abbResult({ size: 500 * MB })], undefined, options);

      expect(under.results).toHaveLength(0);
      expect(under.dropSummary.reasons).toEqual([{ reason: 'below-min-size', count: 1, threshold: '100 MB' }]);
      expect(over.results).toHaveLength(1);
      expect(over.dropSummary).toEqual({ total: 0, reasons: [] });
    });

    it('drops a parsed-size ABB result above maxDownloadSize and keeps one below it', () => {
      const options = { ...noGates, maxDownloadSize: 5 };

      const over = filterAndRankResults([abbResult({ size: 20 * GB })], undefined, options);
      const under = filterAndRankResults([abbResult({ size: 500 * MB })], undefined, options);

      expect(over.results).toHaveLength(0);
      expect(over.dropSummary.reasons).toEqual([{ reason: 'over-max-size', count: 1, threshold: '5 GB' }]);
      expect(under.results).toHaveLength(1);
    });

    // The grab floor is MB/hour, so the same byte count passes or fails on the book's duration.
    it('drops a parsed-size ABB result below the grab floor and keeps one above it', () => {
      const options = { ...noGates, grabFloor: 30 };
      const oneHour = 3600;

      const thin = filterAndRankResults([abbResult({ size: 10 * MB })], oneHour, options);
      const fat = filterAndRankResults([abbResult({ size: 500 * MB })], oneHour, options);

      expect(thin.results).toHaveLength(0);
      expect(thin.dropSummary.reasons).toEqual([{ reason: 'below-grab-floor', count: 1, threshold: '30 MB/hour' }]);
      expect(fat.results).toHaveLength(1);
    });

    /** The motivating case: three Jurassic Park rows that differ only by language. */
    it('drops a parsed-language ABB result the operator did not ask for, and keeps an unknown one', () => {
      const options = { ...noGates, languages: ['english'] };

      const spanish = filterAndRankResults([abbResult({ language: 'spanish' })], undefined, options);
      const unknown = filterAndRankResults([abbResult({ language: undefined })], undefined, options);
      const english = filterAndRankResults([abbResult({ language: 'english' })], undefined, options);

      expect(spanish.results).toHaveLength(0);
      expect(spanish.dropSummary.reasons).toEqual([{ reason: 'language-mismatch', count: 1, threshold: 'english' }]);
      // Unknown is not mismatch — the absence tolerance the info-line parse depends on.
      expect(unknown.results).toHaveLength(1);
      expect(english.results).toHaveLength(1);
    });

    // Gates run sequentially over the survivors, so a result failing both is attributed to the
    // first that saw it — the size gates run ahead of the language partition.
    it('attributes a result failing both the size and language gates to the size gate', () => {
      const { results, dropSummary } = filterAndRankResults(
        [
          abbResult({ title: 'Tiny Spanish', size: 10 * MB, language: 'spanish' }),
          abbResult({ title: 'Big Spanish', size: 500 * MB, language: 'spanish' }),
          abbResult({ title: 'Big English', size: 500 * MB, language: 'english' }),
        ],
        undefined,
        { ...noGates, minDownloadSize: 100, languages: ['english'] },
      );

      expect(results.map((r) => r.title)).toEqual(['Big English']);
      expect(dropSummary.reasons).toEqual([
        { reason: 'below-min-size', count: 1, threshold: '100 MB' },
        { reason: 'language-mismatch', count: 1, threshold: 'english' },
      ]);
    });

    /**
     * The guard that keeps `bitrateKbps` display-only. `canonicalCompare` has no bitrate arm and
     * ties on every arm for this pair, and `Array.prototype.sort` is stable, so a comparator
     * returning 0 preserves input order — in BOTH directions. One order alone is vacuous: a
     * bitrate-aware comparator passes whichever order already matches its preferred direction.
     * Observed at `filterAndRankResults` because its `filtered.sort(...)` is the only seam the
     * field would have to travel through to reach ranking.
     */
    it('leaves ranking untouched by bitrate, in both input orders', () => {
      const low = abbResult({ title: 'Low Bitrate', bitrateKbps: 64 });
      const high = abbResult({ title: 'High Bitrate', bitrateKbps: 320 });

      const lowFirst = filterAndRankResults([low, high], undefined, noGates);
      const highFirst = filterAndRankResults([high, low], undefined, noGates);

      expect(lowFirst.results.map((r) => r.title)).toEqual(['Low Bitrate', 'High Bitrate']);
      expect(highFirst.results.map((r) => r.title)).toEqual(['High Bitrate', 'Low Bitrate']);
      expect(lowFirst.dropSummary).toEqual({ total: 0, reasons: [] });
      expect(highFirst.dropSummary).toEqual({ total: 0, reasons: [] });
    });
  });

  /**
   * Both word gates read `author`/`narrator` as match surfaces, so a row that no longer carries an
   * author changes behaviour in BOTH directions. Asserted deliberately here rather than discovered
   * in production.
   */
  describe('absent author on the word gates (AC6)', () => {
    it('requiredWords matching only the author now drops the author-less result', () => {
      const { results } = filterAndRankResults(
        [abbResult(), abbResult({ title: 'Same Title', author: 'Carol Cole' })],
        undefined,
        { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', requiredWords: 'Cole' },
      );

      expect(results.map((r) => r.title)).toEqual(['Same Title']);
    });

    it('rejectWords matching only the author no longer drops the author-less result', () => {
      const { results } = filterAndRankResults(
        [abbResult(), abbResult({ title: 'Same Title', author: 'Carol Cole' })],
        undefined,
        { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: 'Cole' },
      );

      expect(results.map((r) => r.title)).toEqual(['Murder in the New Forest']);
    });
  });

  // `scoreResult` renormalizes by the weight it actually used, so a missing author costs the
  // result nothing rather than scaling its title score by 0.6.
  it('scores a result with no author on title alone, not at 0.6x', () => {
    const context = { title: 'Murder in the New Forest', author: 'Carol Cole' };

    const withoutAuthor = scoreResult({ title: 'Murder in the New Forest' }, context);
    const withAuthor = scoreResult({ title: 'Murder in the New Forest', author: 'Carol Cole' }, context);

    expect(withoutAuthor).toBe(1);
    expect(withoutAuthor).toBe(withAuthor);
  });

  /**
   * A resolve failure at grab time is a new way for `grab` to reject, and the scheduled surface's
   * existing answer to that is `grab_error` on the one selected best result. Pinned here so the
   * lazy-resolution change cannot quietly grow a next-candidate retry it never had.
   */
  it('reports a resolve failure as grab_error and does not try the next-best release', async () => {
    const indexerSearchService = {
      searchAllWithStatus: vi.fn().mockResolvedValue(searchStatus([
        abbResult({ title: 'Best Match' }),
        abbResult({ title: 'Runner Up', guid: `${ABB_GUID}other/`, downloadUrl: `abb-details://${ABB_DETAILS_URL}other/` }),
      ])),
    } as unknown as IndexerSearchService;
    const resolveFailure = new Error('ABB detail fetch failed for https://audiobookbay.test/audio-books/x/: HTTP 500');
    const downloadOrchestrator = {
      grab: vi.fn().mockRejectedValue(resolveFailure),
    } as unknown as DownloadOrchestrator;
    const blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }),
    } as unknown as BlacklistService;

    const result = await searchAndGrabForBook(
      { id: 1, title: 'Murder in the New Forest', duration: 3600, authors: [{ name: 'Carol Cole' }] },
      {
        indexerSearchService,
        downloadOrchestrator,
        qualitySettings: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' },
        log: createMockLogger(),
        blacklistService,
        indexerService: mockIndexer,
        eventHistory: createMockEventHistory(),
      },
    );

    expect(result.result).toBe('grab_error');
    expect(downloadOrchestrator.grab).toHaveBeenCalledTimes(1);
  });

  /** AC7 — the whole blacklist load moves from the hash arm to the guid arm. */
  describe('blacklist identity (AC7)', () => {
    let blacklistService: BlacklistService;

    beforeEach(() => {
      blacklistService = {
        getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
          blacklistedHashes: new Set<string>(),
          blacklistedGuids: new Set<string>(),
        }),
      } as unknown as BlacklistService;
    });

    it('drops an ABB result whose details URL is blacklisted, with the hash set empty', async () => {
      vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
        blacklistedHashes: new Set(),
        blacklistedGuids: new Set([ABB_GUID]),
      });

      const filtered = await filterBlacklistedResults([abbResult()], blacklistService);

      expect(filtered).toHaveLength(0);
      expect(blacklistService.getBlacklistedIdentifiers).toHaveBeenCalledWith([], [ABB_GUID]);
    });

    /**
     * The accepted one-time break: rows written before #2420 carry `guid` = a 40-hex info hash, and
     * an ABB result no longer exposes anything that can match one. Pinned so the consequence is a
     * stated decision rather than a surprise.
     */
    it('does NOT drop an ABB result when only a stale pre-#2420 hash row exists', async () => {
      vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
        blacklistedHashes: new Set(['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0']),
        blacklistedGuids: new Set(['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0']),
      });

      const filtered = await filterBlacklistedResults([abbResult()], blacklistService);

      expect(filtered).toHaveLength(1);
    });
  });
});
