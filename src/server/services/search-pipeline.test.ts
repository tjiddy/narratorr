import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSearchQuery, buildNarratorPriority, filterAndRankResults, filterBlacklistedResults, searchAndGrabForBook } from './search-pipeline.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { BlacklistService } from './blacklist.service.js';
import { DuplicateDownloadError } from './download.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '../../core/index.js';

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

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Test Book',
    protocol: 'torrent',
    indexer: 'test',
    seeders: 10,
    size: 500 * 1024 * 1024,
    downloadUrl: 'magnet:?xt=urn:btih:aaa',
    ...overrides,
  };
}

const defaultQualitySettings = {
  grabFloor: 0,
  minSeeders: 1,
  protocolPreference: 'none',
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
});

describe('searchAndGrabForBook', () => {
  let indexerService: IndexerService;
  let downloadService: DownloadOrchestrator;
  let log: FastifyBaseLogger;
  let blacklistService: BlacklistService;

  beforeEach(() => {
    indexerService = {
      searchAll: vi.fn().mockResolvedValue([makeResult()]),
    } as unknown as IndexerService;

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

  it('returns grabbed result on happy path (search → filter → grab)', async () => {
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ bookId: 1 }));
  });

  it('forwards indexerId from best search result to downloadOrchestrator.grab', async () => {
    indexerService = {
      searchAll: vi.fn().mockResolvedValue([makeResult({ indexerId: 42 })]),
    } as unknown as IndexerService;

    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    expect(downloadService.grab).toHaveBeenCalledWith(
      expect.objectContaining({ indexerId: 42 }),
    );
  });

  it('omits indexerId when search result has no indexerId', async () => {
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    const grabCall = vi.mocked(downloadService.grab).mock.calls[0][0];
    expect(grabCall).not.toHaveProperty('indexerId');
  });

  it('returns no_results when indexers return empty array', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([]);
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
  });

  it('returns no_results when all results filtered out by grabFloor', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([makeResult({ size: 100 })]);
    const settings = { ...defaultQualitySettings, grabFloor: 999 };
    const result = await searchAndGrabForBook(book, indexerService, downloadService, settings, log, blacklistService);
    expect(result).toEqual({ result: 'no_results' });
  });

  it('returns no_results when all results filtered out by word lists', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([makeResult({ title: 'bad book' })]);
    const settings = { ...defaultQualitySettings, rejectWords: 'bad' };
    const result = await searchAndGrabForBook(book, indexerService, downloadService, settings, log, blacklistService);
    expect(result).toEqual({ result: 'no_results' });
  });

  it('returns no_results when no result has downloadUrl', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([makeResult({ downloadUrl: undefined })]);
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'no_results' });
  });

  it('treats empty-string downloadUrl as no download URL', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([makeResult({ downloadUrl: '' })]);
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'no_results' });
  });

  it('returns skipped with reason when grab throws "already has an active download"', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(new DuplicateDownloadError('Book already has an active download', 'ACTIVE_DOWNLOAD_EXISTS'));
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'skipped', reason: 'already_has_active_download' });
  });

  // #197 — DuplicateDownloadError instanceof catch (ERR-1)
  it('returns skipped when DuplicateDownloadError is thrown (instanceof check, not string match)', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(new DuplicateDownloadError('Book already has an active download', 'ACTIVE_DOWNLOAD_EXISTS'));
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'skipped', reason: 'already_has_active_download' });
  });

  it('returns skipped when DuplicateDownloadError with PIPELINE_ACTIVE is thrown', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(new DuplicateDownloadError('Book has pipeline download', 'PIPELINE_ACTIVE'));
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'skipped', reason: 'already_has_active_download' });
  });

  it('returns grab_error when non-DuplicateDownloadError is thrown (not swallowed)', async () => {
    const genericError = new Error('Connection refused');
    vi.mocked(downloadService.grab).mockRejectedValue(genericError);
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'grab_error', error: genericError });
  });

  it('returns grab_error for non-duplicate grab errors', async () => {
    const grabError = new Error('Connection refused');
    vi.mocked(downloadService.grab).mockRejectedValue(grabError);
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'grab_error', error: grabError });
  });

  it('handles book with duration: null', async () => {
    const nullDurationBook = { ...book, duration: null };
    const result = await searchAndGrabForBook(nullDurationBook, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
  });

  it('handles book with duration: undefined', async () => {
    const undefinedDurationBook = { ...book, duration: undefined };
    const result = await searchAndGrabForBook(undefinedDurationBook, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
  });

  it('handles book with duration: 0', async () => {
    const zeroDurationBook = { ...book, duration: 0 };
    const result = await searchAndGrabForBook(zeroDurationBook, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
  });

  it('passes guid from best result to grab()', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([makeResult({ guid: 'nzb-guid-abc' })]);
    await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(downloadService.grab).toHaveBeenCalledWith(
      expect.objectContaining({ guid: 'nzb-guid-abc', bookId: 1 }),
    );
  });

  it('passes undefined guid to grab() when result has no guid', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([makeResult({ guid: undefined })]);
    await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(downloadService.grab).toHaveBeenCalledWith(
      expect.objectContaining({ guid: undefined, bookId: 1 }),
    );
  });

  it('calls buildSearchQuery to construct the query', async () => {
    await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(indexerService.searchAll).toHaveBeenCalledWith('Test Book Author', expect.any(Object));
  });
});

describe('filterAndRankResults — ebook format filtering', () => {
  const base = { bookDuration: undefined as number | undefined, grabFloor: 0, minSeeders: 0, protocolPreference: 'none' };

  it('filters result with only EPUB in title', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune EPUB' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(results).toHaveLength(0);
  });

  it('filters result with only PDF in title', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune PDF' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(results).toHaveLength(0);
  });

  it('filters result with only MOBI in title', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune MOBI' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(results).toHaveLength(0);
  });

  it('filters result with only AZW3 in title', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune AZW3' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(results).toHaveLength(0);
  });

  it('passes result with no ebook keywords in title', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune Audiobook M4B' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(results).toHaveLength(1);
  });

  it('passes result with EPUB and M4B (mixed format)', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune EPUB M4B' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(results).toHaveLength(1);
  });

  it('passes result with EPUB and MP3 (mixed format)', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune EPUB MP3' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(results).toHaveLength(1);
  });

  it('passes result with EPUB and AAC (mixed format)', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune EPUB AAC' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(results).toHaveLength(1);
  });

  it('filter is case-insensitive (epub, pdf, mobi, azw3)', () => {
    const epubLower = filterAndRankResults([makeResult({ title: 'dune.epub.2023' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    const pdfMixed = filterAndRankResults([makeResult({ title: 'Dune.Pdf' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    const mobiLower = filterAndRankResults([makeResult({ title: 'DUNE.mobi' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(epubLower.results).toHaveLength(0);
    expect(pdfMixed.results).toHaveLength(0);
    expect(mobiLower.results).toHaveLength(0);
  });

  it('uses rawTitle for matching when present, ignoring title', () => {
    const { results } = filterAndRankResults(
      [makeResult({ rawTitle: 'dune.epub.2023', title: 'Dune' })],
      base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference,
    );
    expect(results).toHaveLength(0);
  });

  it('falls back to title when rawTitle is absent', () => {
    const { results } = filterAndRankResults(
      [makeResult({ rawTitle: undefined, title: 'Dune EPUB' })],
      base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference,
    );
    expect(results).toHaveLength(0);
  });

  it('filters underscore-separated ebook-only titles (scene-style)', () => {
    const epub = filterAndRankResults([makeResult({ title: 'Dune_EPUB' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    const pdf = filterAndRankResults([makeResult({ title: 'Author.Title_PDF_2023' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(epub.results).toHaveLength(0);
    expect(pdf.results).toHaveLength(0);
  });

  it('passes underscore-separated mixed-format title (ebook + audio)', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune_EPUB_M4B' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(results).toHaveLength(1);
  });

  it('passes result with EPUB and FLAC (mixed format)', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune EPUB FLAC' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(results).toHaveLength(1);
  });

  it('passes result with EPUB and OGG (mixed format)', () => {
    const { results } = filterAndRankResults([makeResult({ title: 'Dune EPUB OGG' })], base.bookDuration, base.grabFloor, base.minSeeders, base.protocolPreference);
    expect(results).toHaveLength(1);
  });
});

describe('filterAndRankResults — minSeeders default', () => {
  it('filters torrent with 0 seeders when minSeeders is 1 (new default)', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: 0 })], undefined, 0, 1, 'none');
    expect(results).toHaveLength(0);
  });

  it('passes torrent with 1 seeder when minSeeders is 1', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: 1 })], undefined, 0, 1, 'none');
    expect(results).toHaveLength(1);
  });

  it('passes torrent with undefined seeders when minSeeders is 1 (unknown ≠ zero)', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: undefined })], undefined, 0, 1, 'none');
    expect(results).toHaveLength(1);
  });

  it('passes torrent with null seeders when minSeeders is 1 (unknown ≠ zero)', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: null as unknown as undefined })], undefined, 0, 1, 'none');
    expect(results).toHaveLength(1);
  });

  it('passes torrent with 0 seeders when minSeeders is 0 (filter disabled)', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: 0 })], undefined, 0, 0, 'none');
    expect(results).toHaveLength(1);
  });

  it('passes torrent with seeders above threshold', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: 5 })], undefined, 0, 3, 'none');
    expect(results).toHaveLength(1);
  });

  it('filters torrent with seeders below threshold', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: 2 })], undefined, 0, 3, 'none');
    expect(results).toHaveLength(0);
  });

  it('mixed: undefined seeders survives while 0 seeders is filtered', () => {
    const { results } = filterAndRankResults([
      makeResult({ title: 'ABB Result', protocol: 'torrent', seeders: undefined }),
      makeResult({ title: 'Dead Torrent', protocol: 'torrent', seeders: 0 }),
    ], undefined, 0, 1, 'none');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('ABB Result');
  });

  it('passes usenet result regardless of seeders when minSeeders is 1', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'usenet', seeders: undefined })], undefined, 0, 1, 'none');
    expect(results).toHaveLength(1);
  });
});

describe('canonicalCompare — grabs tiebreaker (#272)', () => {
  it('higher grabs wins when matchScore, MB/hr, protocol, and language are equal', () => {
    const a = makeResult({ matchScore: 0.9, grabs: 1000, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, grabs: 100, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].grabs).toBe(1000);
    expect(results[1].grabs).toBe(100);
  });

  it('title similarity (matchScore > 0.1 diff) beats grabs', () => {
    const a = makeResult({ matchScore: 0.9, grabs: 10 });
    const b = makeResult({ matchScore: 0.5, grabs: 10000 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].matchScore).toBe(0.9);
  });

  it('MB/hr quality beats grabs', () => {
    // a has better MB/hr, b has better grabs
    const a = makeResult({ matchScore: 0.9, size: 1000 * 1024 * 1024, grabs: 10, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, size: 100 * 1024 * 1024, grabs: 10000, seeders: 5 });
    const { results } = filterAndRankResults([b, a], 3600, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].grabs).toBe(10); // higher MB/hr wins
  });

  it('grabs=undefined on one result, grabs=1000 on other → result with grabs wins', () => {
    const a = makeResult({ matchScore: 0.9, grabs: 1000, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, grabs: undefined, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].grabs).toBe(1000);
  });

  it('both grabs=undefined → falls through to seeders tiebreaker', () => {
    const a = makeResult({ matchScore: 0.9, grabs: undefined, seeders: 20 });
    const b = makeResult({ matchScore: 0.9, grabs: undefined, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].seeders).toBe(20);
  });

  it('Math.log10(grabs+1) normalization: 10 vs 100 grabs produces meaningful difference', () => {
    // log10(11) ≈ 1.04, log10(101) ≈ 2.00 → clear separation
    const a = makeResult({ matchScore: 0.9, grabs: 100, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, grabs: 10, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].grabs).toBe(100);
    expect(results[1].grabs).toBe(10);
  });

  it('grabs=0 → Math.log10(1)=0, lowest-popularity, not treated as missing', () => {
    const a = makeResult({ matchScore: 0.9, grabs: 100, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, grabs: 0, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].grabs).toBe(100);
    expect(results[1].grabs).toBe(0);
  });
});

describe('canonicalCompare — language tier (#272)', () => {
  it('language mismatch ranks below matching-language result within same tier', () => {
    const match = makeResult({ matchScore: 0.9, language: 'english', seeders: 5 });
    const mismatch = makeResult({ matchScore: 0.9, language: 'german', seeders: 5 });
    const { results } = filterAndRankResults([mismatch, match], undefined, 0, 0, 'none', undefined, undefined, ['english']);
    expect(results[0].language).toBe('english');
  });

  it('language mismatch ranks below unknown-language result (absence ≠ mismatch)', () => {
    const unknown = makeResult({ matchScore: 0.9, language: undefined, seeders: 5, title: 'Unknown' });
    const mismatch = makeResult({ matchScore: 0.9, language: 'german', seeders: 5, title: 'German' });
    const { results } = filterAndRankResults([mismatch, unknown], undefined, 0, 0, 'none', undefined, undefined, ['english']);
    // mismatch is filtered out, only unknown remains
    expect(results).toHaveLength(1);
    expect(results[0].language).toBeUndefined();
  });

  it('result with no language field → no penalty applied', () => {
    const noLang = makeResult({ matchScore: 0.9, seeders: 10, title: 'No Lang' });
    const withLang = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, title: 'With Lang' });
    const { results } = filterAndRankResults([withLang, noLang], undefined, 0, 0, 'none', undefined, undefined, ['english']);
    // Both pass filtering — noLang has no language (pass through), withLang matches
    expect(results[0].seeders).toBe(10); // higher seeders wins as tiebreaker
  });

  it('language tier does not cross 0.1 matchScore gate (title similarity wins)', () => {
    const highScore = makeResult({ matchScore: 0.9, language: 'english', seeders: 5 });
    const lowScore = makeResult({ matchScore: 0.5, language: 'english', seeders: 5 });
    const { results } = filterAndRankResults([lowScore, highScore], undefined, 0, 0, 'none', undefined, undefined, ['english']);
    expect(results[0].matchScore).toBe(0.9); // higher title match wins
  });

  it('empty languages array → no language penalty applied to any result', () => {
    const german = makeResult({ matchScore: 0.9, language: 'german', seeders: 10, title: 'German' });
    const english = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, title: 'English' });
    const { results } = filterAndRankResults([english, german], undefined, 0, 0, 'none', undefined, undefined, []);
    // No language preference → falls through to grabs/seeders
    expect(results[0].seeders).toBe(10);
  });

  it('language match ranks equal to unknown-language result', () => {
    const match = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, title: 'Match' });
    const unknown = makeResult({ matchScore: 0.9, language: undefined, seeders: 10, title: 'Unknown' });
    const { results } = filterAndRankResults([match, unknown], undefined, 0, 0, 'none', undefined, undefined, ['english']);
    // Both are non-mismatch → tiebreaker is grabs/seeders (unknown has more seeders)
    expect(results[0].seeders).toBe(10);
  });
});

describe('filterAndRankResults — grabs tiebreaker (#272)', () => {
  it('auto-search selects higher-grabs result when title scores are equal', () => {
    const popular = makeResult({ matchScore: 0.9, grabs: 5000, seeders: 5, title: 'Popular' });
    const niche = makeResult({ matchScore: 0.9, grabs: 50, seeders: 5, title: 'Niche' });
    const { results } = filterAndRankResults([niche, popular], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].title).toBe('Popular');
  });
});

describe('canonicalCompare — language array', () => {
  it('no penalty when result language matches any selected language — both kept', () => {
    const english = makeResult({ matchScore: 0.9, language: 'english', seeders: 5 });
    const spanish = makeResult({ matchScore: 0.9, language: 'spanish', seeders: 10 });
    const { results } = filterAndRankResults([english, spanish], undefined, 0, 0, 'none', undefined, undefined, ['english', 'spanish']);
    // Both match → both kept, english first (primary), spanish second
    expect(results).toHaveLength(2);
    expect(results[0].language).toBe('english'); // primary language
    expect(results[1].language).toBe('spanish');
  });

  it('penalty when result language does not match any selected language', () => {
    const match = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, title: 'Match' });
    const mismatch = makeResult({ matchScore: 0.9, language: 'french', seeders: 10, title: 'Mismatch' });
    const { results } = filterAndRankResults([mismatch, match], undefined, 0, 0, 'none', undefined, undefined, ['english', 'spanish']);
    // french is filtered out
    expect(results).toHaveLength(1);
    expect(results[0].language).toBe('english');
  });

  it('no penalty when result has no language (pass through)', () => {
    const noLang = makeResult({ matchScore: 0.9, seeders: 10, title: 'No Lang' });
    const match = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, title: 'Match' });
    const { results } = filterAndRankResults([match, noLang], undefined, 0, 0, 'none', undefined, undefined, ['english']);
    expect(results).toHaveLength(2);
    expect(results[0].seeders).toBe(10); // noLang passes through with higher seeders
  });

  it('no penalty when languages array is empty (filtering disabled)', () => {
    const french = makeResult({ matchScore: 0.9, language: 'french', seeders: 10 });
    const german = makeResult({ matchScore: 0.9, language: 'german', seeders: 5 });
    const { results } = filterAndRankResults([german, french], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results).toHaveLength(2); // all pass through
  });

  it('first entry used as primary for sort ranking — primary language outranks secondary', () => {
    const english = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, grabs: 100, title: 'English' });
    const spanish = makeResult({ matchScore: 0.9, language: 'spanish', seeders: 5, grabs: 100, title: 'Spanish' });
    const { results } = filterAndRankResults([spanish, english], undefined, 0, 0, 'none', undefined, undefined, ['english', 'spanish']);
    // English is primary (first entry) → ranks above Spanish
    expect(results[0].language).toBe('english');
    expect(results[1].language).toBe('spanish');
  });

  it('primary language tiebreaker does not apply with single language', () => {
    const english = makeResult({ matchScore: 0.9, language: 'english', seeders: 5, grabs: 100 });
    const noLang = makeResult({ matchScore: 0.9, seeders: 5, grabs: 100, title: 'No Lang' });
    const { results } = filterAndRankResults([noLang, english], undefined, 0, 0, 'none', undefined, undefined, ['english']);
    // Both match (english + unknown) — no sub-tier needed, stable order
    expect(results).toHaveLength(2);
  });
});

describe('filterAndRankResults — language filtering', () => {
  it('excludes results with explicit non-matching language', () => {
    const french = makeResult({ language: 'french', title: 'French Book' });
    const english = makeResult({ language: 'english', title: 'English Book' });
    const { results } = filterAndRankResults([french, english], undefined, 0, 0, 'none', undefined, undefined, ['english']);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('English Book');
  });

  it('includes results matching any selected language', () => {
    const spanish = makeResult({ language: 'spanish', title: 'Spanish Book' });
    const english = makeResult({ language: 'english', title: 'English Book' });
    const { results } = filterAndRankResults([spanish, english], undefined, 0, 0, 'none', undefined, undefined, ['english', 'spanish']);
    expect(results).toHaveLength(2);
  });

  it('passes through results with undefined language', () => {
    const noLang = makeResult({ language: undefined, title: 'Unknown Lang' });
    const { results } = filterAndRankResults([noLang], undefined, 0, 0, 'none', undefined, undefined, ['english']);
    expect(results).toHaveLength(1);
  });

  it('passes through results with empty string language', () => {
    const emptyLang = makeResult({ language: '', title: 'Empty Lang' });
    const { results } = filterAndRankResults([emptyLang], undefined, 0, 0, 'none', undefined, undefined, ['english']);
    expect(results).toHaveLength(1);
  });

  it('no filtering when languages array is empty', () => {
    const french = makeResult({ language: 'french' });
    const { results } = filterAndRankResults([french], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results).toHaveLength(1);
  });

  it('normalizes language comparison to lowercase', () => {
    const upper = makeResult({ language: 'English', title: 'Upper' });
    const { results } = filterAndRankResults([upper], undefined, 0, 0, 'none', undefined, undefined, ['english']);
    expect(results).toHaveLength(1);
  });
});

// ============================================================================
// #392 — Search progress SSE emission via broadcaster
// ============================================================================

describe('#392 searchAndGrabForBook with broadcaster', () => {
  let indexerService: IndexerService;
  let downloadService: DownloadOrchestrator;
  let broadcaster: EventBroadcasterService;
  let blacklistService: BlacklistService;
  let log: FastifyBaseLogger;

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

    log = createMockLogger();

    downloadService = {
      grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }),
    } as unknown as DownloadOrchestrator;

    // Default: searchAllStreaming returns results and invokes onComplete callback
    indexerService = {
      searchAllStreaming: vi.fn().mockImplementation(
        async (_query: string, _options: unknown, _controllers: Map<number, AbortController>, callbacks: { onComplete: (id: number, name: string, count: number, ms: number) => void }) => {
          callbacks.onComplete(10, 'MAM', 1, 500);
          return [makeResult({ indexerId: 10 })];
        },
      ),
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
    } as unknown as IndexerService;
  });

  describe('search_started emission', () => {
    it('emits search_started with correct indexer list before querying', async () => {
      await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
      expect(broadcaster.emit).toHaveBeenCalledWith('search_started', {
        book_id: 1,
        book_title: 'Test Book',
        indexers: [{ id: 10, name: 'MAM' }],
      });
    });

    it('emits search_started even when no enabled indexers (empty list)', async () => {
      vi.mocked(indexerService.getEnabledIndexers).mockResolvedValue([]);
      vi.mocked(indexerService.searchAllStreaming).mockResolvedValue([]);
      await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
      expect(broadcaster.emit).toHaveBeenCalledWith('search_started', {
        book_id: 1,
        book_title: 'Test Book',
        indexers: [],
      });
    });
  });

  describe('per-indexer events', () => {
    it('emits search_indexer_complete with results_found and elapsed_ms for each successful indexer', async () => {
      await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
      expect(broadcaster.emit).toHaveBeenCalledWith('search_indexer_complete', {
        book_id: 1,
        indexer_id: 10,
        indexer_name: 'MAM',
        results_found: 1,
        elapsed_ms: 500,
      });
    });

    it('emits search_indexer_error with error message and elapsed_ms when indexer throws', async () => {
      vi.mocked(indexerService.searchAllStreaming).mockImplementation(
        async (_q, _o, _c, callbacks) => {
          callbacks.onError(10, 'MAM', 'timeout', 30000);
          return [];
        },
      );
      await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
      expect(broadcaster.emit).toHaveBeenCalledWith('search_indexer_error', {
        book_id: 1,
        indexer_id: 10,
        indexer_name: 'MAM',
        error: 'timeout',
        elapsed_ms: 30000,
      });
    });

    it('emits search_indexer_complete with results_found: 0 for indexer returning empty results', async () => {
      vi.mocked(indexerService.searchAllStreaming).mockImplementation(
        async (_q, _o, _c, callbacks) => {
          callbacks.onComplete(10, 'MAM', 0, 200);
          return [];
        },
      );
      await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
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
      await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
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
      // search_grabbed must come before search_complete
      const grabbedIdx = emitCalls.indexOf(grabbedCall!);
      const completeIdx = emitCalls.indexOf(completeCall!);
      expect(grabbedIdx).toBeLessThan(completeIdx);
    });

    it('emits search_complete with outcome no_results when raw results are empty', async () => {
      vi.mocked(indexerService.searchAllStreaming).mockResolvedValue([]);
      vi.mocked(indexerService.getEnabledIndexers).mockResolvedValue([]);
      await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
      expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', {
        book_id: 1,
        total_results: 0,
        outcome: 'no_results',
      });
    });

    it('emits search_complete with outcome no_results when all results filtered out', async () => {
      vi.mocked(indexerService.searchAllStreaming).mockImplementation(
        async (_q, _o, _c, callbacks) => {
          callbacks.onComplete(10, 'MAM', 1, 300);
          return [makeResult({ size: 100 })];
        },
      );
      const settings = { ...defaultQualitySettings, grabFloor: 999 };
      await searchAndGrabForBook(book, indexerService, downloadService, settings, log, blacklistService, broadcaster);
      expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', expect.objectContaining({
        outcome: 'no_results',
      }));
      expect(broadcaster.emit).not.toHaveBeenCalledWith('search_grabbed', expect.anything());
    });

    it('emits search_complete with outcome skipped on DuplicateDownloadError (not search_grabbed)', async () => {
      vi.mocked(downloadService.grab).mockRejectedValue(new DuplicateDownloadError('Active download exists', 'ACTIVE_DOWNLOAD_EXISTS'));
      await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
      expect(broadcaster.emit).not.toHaveBeenCalledWith('search_grabbed', expect.anything());
      expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', expect.objectContaining({
        outcome: 'skipped',
      }));
    });

    it('emits search_complete with outcome grab_error on generic grab error', async () => {
      vi.mocked(downloadService.grab).mockRejectedValue(new Error('Connection refused'));
      await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
      expect(broadcaster.emit).not.toHaveBeenCalledWith('search_grabbed', expect.anything());
      expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', expect.objectContaining({
        outcome: 'grab_error',
      }));
    });

    it('total_results in search_complete sums across all indexers', async () => {
      vi.mocked(indexerService.getEnabledIndexers).mockResolvedValue([{ id: 10, name: 'MAM' }, { id: 20, name: 'ABB' }]);
      vi.mocked(indexerService.searchAllStreaming).mockImplementation(
        async (_q, _o, _c, callbacks) => {
          callbacks.onComplete(10, 'MAM', 3, 500);
          callbacks.onComplete(20, 'ABB', 2, 800);
          return [makeResult({ indexerId: 10 }), makeResult({ indexerId: 10 }), makeResult({ indexerId: 10 }), makeResult({ indexerId: 20 }), makeResult({ indexerId: 20 })];
        },
      );
      await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
      expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', expect.objectContaining({
        total_results: 5,
      }));
    });
  });

  describe('backwards compatibility', () => {
    it('no events emitted when broadcaster is not provided', async () => {
      // Use searchAll mock since without broadcaster, the function should still work
      indexerService = {
        searchAll: vi.fn().mockResolvedValue([makeResult()]),
      } as unknown as IndexerService;
      const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
      expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
      // No broadcaster passed — should not throw
    });
  });

  describe('fire-and-forget safety', () => {
    it('broadcaster.emit() throwing does not break search pipeline', async () => {
      vi.mocked(broadcaster.emit).mockImplementation(() => { throw new Error('SSE write failed'); });
      const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
      expect(result.result).toBe('grabbed');
    });

    it('search still returns correct result when broadcaster fails', async () => {
      vi.mocked(broadcaster.emit).mockImplementation(() => { throw new Error('SSE write failed'); });
      vi.mocked(indexerService.searchAllStreaming).mockResolvedValue([]);
      vi.mocked(indexerService.getEnabledIndexers).mockResolvedValue([]);
      const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
      expect(result).toEqual({ result: 'no_results' });
    });
  });
});

describe('canonicalCompare — indexer priority tiebreaker (#394)', () => {
  it('lower indexerPriority wins when all higher tiers are equal', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 10, grabs: 50, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 50, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].indexerPriority).toBe(10);
    expect(results[1].indexerPriority).toBe(50);
  });

  it('missing indexerPriority (undefined) treated as Infinity — loses to any defined priority', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 50, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: undefined, grabs: 50, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].indexerPriority).toBe(50);
    expect(results[1].indexerPriority).toBeUndefined();
  });

  it('equal indexerPriority falls through to grabs tier', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 1000, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 10, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].grabs).toBe(1000);
    expect(results[1].grabs).toBe(10);
  });

  it('priority tier does NOT override matchScore', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 99 });
    const b = makeResult({ matchScore: 0.5, indexerPriority: 1 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].matchScore).toBe(0.9);
  });

  it('priority tier does NOT override protocol preference', () => {
    const a = makeResult({ matchScore: 0.9, protocol: 'torrent', indexerPriority: 99 });
    const b = makeResult({ matchScore: 0.9, protocol: 'usenet', indexerPriority: 1 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'torrent', undefined, undefined, []);
    expect(results[0].protocol).toBe('torrent');
  });

  it('priority tier does NOT override MB/hr when duration is known', () => {
    // a has better MB/hr (larger size = higher bitrate), b has better priority
    const a = makeResult({ matchScore: 0.9, size: 1000 * 1024 * 1024, indexerPriority: 99, grabs: 50, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, size: 100 * 1024 * 1024, indexerPriority: 1, grabs: 50, seeders: 5 });
    const { results } = filterAndRankResults([b, a], 3600, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].indexerPriority).toBe(99); // higher MB/hr wins despite worse priority
  });

  it('priority tier does NOT override language tier', () => {
    // a matches preferred language, b has better priority
    const a = makeResult({ matchScore: 0.9, language: 'english', indexerPriority: 99, grabs: 50, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, language: 'german', indexerPriority: 1, grabs: 50, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, ['english']);
    expect(results[0].language).toBe('english'); // language match wins despite worse priority
  });

  it('priority 1 (best) vs priority 100 (worst) — 1 wins', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 1, grabs: 50, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: 100, grabs: 50, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].indexerPriority).toBe(1);
  });

  it('priority 50 vs priority 50 — falls through to grabs', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 500, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 5, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].grabs).toBe(500);
  });

  it('both undefined — falls through to grabs (Infinity === Infinity)', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: undefined, grabs: 800, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: undefined, grabs: 10, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].grabs).toBe(800);
  });

  it('one undefined vs one defined — defined value wins', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 100, grabs: 50, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: undefined, grabs: 50, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].indexerPriority).toBe(100);
  });
});

describe('filterAndRankResults — indexer priority integration (#394)', () => {
  it('results from indexer with priority 10 rank above priority 50 when all other factors equal', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 10, grabs: 50, seeders: 5, indexer: 'MAM' });
    const b = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 50, seeders: 5, indexer: 'Torznab' });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    expect(results[0].indexer).toBe('MAM');
    expect(results[1].indexer).toBe('Torznab');
  });

  it('all indexers sharing same priority produces identical ordering to current behavior', () => {
    const a = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 1000, seeders: 5 });
    const b = makeResult({ matchScore: 0.9, indexerPriority: 50, grabs: 10, seeders: 5 });
    const { results } = filterAndRankResults([b, a], undefined, 0, 0, 'none', undefined, undefined, []);
    // With equal priority, falls through to grabs — higher grabs wins
    expect(results[0].grabs).toBe(1000);
    expect(results[1].grabs).toBe(10);
  });
});

// #406 — Shared blacklist filter helper
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
    expect(filtered[0].title).toBe('Clean');
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
});

// #406 — Blacklist filtering in searchAndGrabForBook (non-broadcaster)
describe('#406 searchAndGrabForBook blacklist filtering', () => {
  const book = { id: 1, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };
  let indexerService: IndexerService;
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
    indexerService = { searchAll: vi.fn().mockResolvedValue([blacklisted, clean]) } as unknown as IndexerService;
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['bad']),
      blacklistedGuids: new Set(),
    });

    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result.result).toBe('grabbed');
    // Grabbed the clean result, not the blacklisted one with higher seeders
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ title: 'Clean' }));
  });

  it('returns no_results when all results are blacklisted — non-broadcaster path', async () => {
    indexerService = { searchAll: vi.fn().mockResolvedValue([makeResult({ infoHash: 'h1' }), makeResult({ infoHash: 'h2' })]) } as unknown as IndexerService;
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['h1', 'h2']),
      blacklistedGuids: new Set(),
    });

    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
  });

  it('grabs only clean results when mix of blacklisted and clean — non-broadcaster path', async () => {
    const clean = makeResult({ guid: 'good-guid', title: 'Clean' });
    const blacklisted = makeResult({ guid: 'bad-guid', title: 'Blacklisted' });
    indexerService = { searchAll: vi.fn().mockResolvedValue([blacklisted, clean]) } as unknown as IndexerService;
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(),
      blacklistedGuids: new Set(['bad-guid']),
    });

    await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService);
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ title: 'Clean' }));
    expect(downloadService.grab).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Blacklisted' }));
  });
});

// #406 — Blacklist filtering in searchAndGrabForBook (broadcaster)
describe('#406 searchAndGrabForBook blacklist filtering with broadcaster', () => {
  const book = { id: 1, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };
  let indexerService: IndexerService;
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
    indexerService = {
      searchAllStreaming: vi.fn().mockImplementation(async (_q: string, _o: unknown, _c: Map<number, AbortController>, callbacks: { onComplete: (id: number, name: string, count: number, ms: number) => void }) => {
        callbacks.onComplete(10, 'MAM', 2, 500);
        return [blacklisted, clean];
      }),
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
    } as unknown as IndexerService;
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['bad']),
      blacklistedGuids: new Set(),
    });

    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
    expect(result.result).toBe('grabbed');
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ title: 'Clean' }));
  });

  it('returns no_results when all results are blacklisted — broadcaster path', async () => {
    indexerService = {
      searchAllStreaming: vi.fn().mockImplementation(async (_q: string, _o: unknown, _c: Map<number, AbortController>, callbacks: { onComplete: (id: number, name: string, count: number, ms: number) => void }) => {
        callbacks.onComplete(10, 'MAM', 2, 500);
        return [makeResult({ infoHash: 'h1', indexerId: 10 }), makeResult({ infoHash: 'h2', indexerId: 10 })];
      }),
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
    } as unknown as IndexerService;
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(['h1', 'h2']),
      blacklistedGuids: new Set(),
    });

    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(broadcaster.emit).toHaveBeenCalledWith('search_complete', expect.objectContaining({ outcome: 'no_results' }));
  });

  it('grabs only clean results when mix of blacklisted and clean — broadcaster path', async () => {
    const clean = makeResult({ guid: 'good-guid', title: 'Clean', indexerId: 10 });
    const blacklisted = makeResult({ guid: 'bad-guid', title: 'Blacklisted', indexerId: 10 });
    indexerService = {
      searchAllStreaming: vi.fn().mockImplementation(async (_q: string, _o: unknown, _c: Map<number, AbortController>, callbacks: { onComplete: (id: number, name: string, count: number, ms: number) => void }) => {
        callbacks.onComplete(10, 'MAM', 2, 500);
        return [blacklisted, clean];
      }),
      getEnabledIndexers: vi.fn().mockResolvedValue([{ id: 10, name: 'MAM' }]),
    } as unknown as IndexerService;
    vi.mocked(blacklistService.getBlacklistedIdentifiers).mockResolvedValue({
      blacklistedHashes: new Set(),
      blacklistedGuids: new Set(['bad-guid']),
    });

    await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log, blacklistService, broadcaster);
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ title: 'Clean' }));
  });
});

describe('filterAndRankResults — narrator priority', () => {
  // Helper: for a 10-hour book (36000s), size for target MB/hr = mbhr * 10 * 1024 * 1024
  const BOOK_DURATION = 36000; // 10 hours
  function sizeForMbhr(mbhr: number) { return Math.round(mbhr * 10 * 1024 * 1024); }

  const narratorPriority = { bookNarrators: ['Kevin R. Free'] };

  describe('narrator-match tier in canonicalCompare', () => {
    it('narrator-match result beats non-match when priority is accuracy (Fair vs Good quality)', () => {
      const fairMatch = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(79), matchScore: 0.9 });
      const goodNoMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(80), matchScore: 0.9 });
      const { results } = filterAndRankResults([goodNoMatch, fairMatch], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], narratorPriority);
      expect(results[0].narrator).toBe('Kevin R. Free');
    });

    it('narrator-match with 29 MB/hr does NOT beat non-match — below quality floor', () => {
      const lowMatch = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(29), matchScore: 0.9 });
      const goodNoMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9 });
      const { results } = filterAndRankResults([lowMatch, goodNoMatch], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], narratorPriority);
      expect(results[0].narrator).toBe('Someone Else');
    });

    it('narrator-match with exactly 30 MB/hr beats non-match — meets Low tier floor', () => {
      const lowMatch = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(30), matchScore: 0.9 });
      const goodNoMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9 });
      const { results } = filterAndRankResults([goodNoMatch, lowMatch], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], narratorPriority);
      expect(results[0].narrator).toBe('Kevin R. Free');
    });

    it('two narrator-matched results sorted by quality (higher quality wins)', () => {
      const fairMatch = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(79), matchScore: 0.9, title: 'A' });
      const goodMatch = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(200), matchScore: 0.9, title: 'B' });
      const { results } = filterAndRankResults([fairMatch, goodMatch], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], narratorPriority);
      expect(results[0].title).toBe('B');
    });

    it('two non-matched results sorted by quality as today (no change)', () => {
      const fair = makeResult({ narrator: 'Someone', size: sizeForMbhr(79), matchScore: 0.9, title: 'A' });
      const good = makeResult({ narrator: 'Other', size: sizeForMbhr(200), matchScore: 0.9, title: 'B' });
      const { results } = filterAndRankResults([fair, good], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], narratorPriority);
      expect(results[0].title).toBe('B');
    });

    it('unknown quality narrator-match beats known Good quality non-match', () => {
      // No size = unknown quality, should still be eligible for narrator boost
      const unknownMatch = makeResult({ narrator: 'Kevin R. Free', size: undefined, matchScore: 0.9, title: 'Match' });
      const goodNoMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9, title: 'NoMatch' });
      // Duration unknown path
      const { results } = filterAndRankResults([goodNoMatch, unknownMatch], undefined, 0, 1, 'none', undefined, undefined, [], narratorPriority);
      expect(results[0].title).toBe('Match');
    });

    it('match-score gate: score delta > 0.1 overrides narrator tier', () => {
      const lowScoreMatch = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(200), matchScore: 0.6 });
      const highScoreNoMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.8 });
      const { results } = filterAndRankResults([lowScoreMatch, highScoreNoMatch], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], narratorPriority);
      expect(results[0].narrator).toBe('Someone Else');
    });
  });

  describe('narratorPriority parameter behavior', () => {
    it('omitting narratorPriority preserves exact current ranking (regression)', () => {
      const fair = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(79), matchScore: 0.9, title: 'Fair' });
      const good = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9, title: 'Good' });
      // No narratorPriority param — should rank by quality
      const { results } = filterAndRankResults([fair, good], BOOK_DURATION, 0, 1, 'none');
      expect(results[0].title).toBe('Good');
    });

    it('empty bookNarrators array disables narrator tier', () => {
      const fair = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(79), matchScore: 0.9, title: 'Fair' });
      const good = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9, title: 'Good' });
      const { results } = filterAndRankResults([fair, good], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], { bookNarrators: [] });
      expect(results[0].title).toBe('Good');
    });

    it('undefined SearchResult.narrator treated as non-match (no crash)', () => {
      const noNarrator = makeResult({ size: sizeForMbhr(200), matchScore: 0.9, title: 'NoNarr' });
      const withNarrator = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(79), matchScore: 0.9, title: 'WithNarr' });
      const { results } = filterAndRankResults([noNarrator, withNarrator], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], narratorPriority);
      expect(results[0].title).toBe('WithNarr');
    });
  });

  describe('fuzzy narrator matching in scoring', () => {
    it('normalized names match via diceCoefficient >= 0.8', () => {
      // "Kevin R. Free" normalizes to "kevin r free" — exact match after normalization
      const match = makeResult({ narrator: 'Kevin R Free', size: sizeForMbhr(79), matchScore: 0.9 });
      const noMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9 });
      const { results } = filterAndRankResults([noMatch, match], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], { bookNarrators: ['Kevin R. Free'] });
      expect(results[0].narrator).toBe('Kevin R Free');
    });

    it('different person similar name below 0.8 threshold is not boosted', () => {
      const falseMatch = makeResult({ narrator: 'Mark Kramer', size: sizeForMbhr(79), matchScore: 0.9, title: 'False' });
      const good = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9, title: 'Good' });
      const { results } = filterAndRankResults([falseMatch, good], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], { bookNarrators: ['Michael Kramer'] });
      expect(results[0].title).toBe('Good');
    });

    it('multi-value result narrator tokenized before matching', () => {
      const multiNarr = makeResult({ narrator: 'Travis Baldree, Jeff Hays', size: sizeForMbhr(79), matchScore: 0.9 });
      const good = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9 });
      const { results } = filterAndRankResults([good, multiNarr], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], { bookNarrators: ['Travis Baldree'] });
      expect(results[0].narrator).toBe('Travis Baldree, Jeff Hays');
    });

    it('multi-narrator book uses max pairwise score', () => {
      const match = makeResult({ narrator: 'Kate Reading', size: sizeForMbhr(79), matchScore: 0.9 });
      const noMatch = makeResult({ narrator: 'Someone Else', size: sizeForMbhr(200), matchScore: 0.9 });
      const { results } = filterAndRankResults([noMatch, match], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], { bookNarrators: ['Michael Kramer', 'Kate Reading'] });
      expect(results[0].narrator).toBe('Kate Reading');
    });
  });

  describe('fallback behavior', () => {
    it('priority accuracy with zero narrator matches falls back to quality ranking', () => {
      const fair = makeResult({ narrator: 'Nobody Match', size: sizeForMbhr(79), matchScore: 0.9, title: 'Fair' });
      const good = makeResult({ narrator: 'Also Nobody', size: sizeForMbhr(200), matchScore: 0.9, title: 'Good' });
      const { results } = filterAndRankResults([fair, good], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], { bookNarrators: ['Specific Narrator'] });
      expect(results[0].title).toBe('Good');
    });

    it('priority accuracy with no book narrators falls back to quality ranking', () => {
      const fair = makeResult({ narrator: 'Kevin R. Free', size: sizeForMbhr(79), matchScore: 0.9, title: 'Fair' });
      const good = makeResult({ narrator: 'Someone', size: sizeForMbhr(200), matchScore: 0.9, title: 'Good' });
      const { results } = filterAndRankResults([fair, good], BOOK_DURATION, 0, 1, 'none', undefined, undefined, [], { bookNarrators: [] });
      expect(results[0].title).toBe('Good');
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
