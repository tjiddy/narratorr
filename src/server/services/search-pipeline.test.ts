import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSearchQuery, filterAndRankResults, searchAndGrabForBook } from './search-pipeline.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import { DuplicateDownloadError } from './download.service.js';
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

  beforeEach(() => {
    indexerService = {
      searchAll: vi.fn().mockResolvedValue([makeResult()]),
    } as unknown as IndexerService;

    downloadService = {
      grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }),
    } as unknown as DownloadOrchestrator;

    log = createMockLogger();
  });

  const book = { id: 1, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };

  it('returns grabbed result on happy path (search → filter → grab)', async () => {
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ bookId: 1 }));
  });

  it('forwards indexerId from best search result to downloadOrchestrator.grab', async () => {
    indexerService = {
      searchAll: vi.fn().mockResolvedValue([makeResult({ indexerId: 42 })]),
    } as unknown as IndexerService;

    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    expect(downloadService.grab).toHaveBeenCalledWith(
      expect.objectContaining({ indexerId: 42 }),
    );
  });

  it('forwards undefined indexerId when search result has no indexerId', async () => {
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    expect(downloadService.grab).toHaveBeenCalledWith(
      expect.objectContaining({ indexerId: undefined }),
    );
  });

  it('returns no_results when indexers return empty array', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([]);
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'no_results' });
    expect(downloadService.grab).not.toHaveBeenCalled();
  });

  it('returns no_results when all results filtered out by grabFloor', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([makeResult({ size: 100 })]);
    const settings = { ...defaultQualitySettings, grabFloor: 999 };
    const result = await searchAndGrabForBook(book, indexerService, downloadService, settings, log);
    expect(result).toEqual({ result: 'no_results' });
  });

  it('returns no_results when all results filtered out by word lists', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([makeResult({ title: 'bad book' })]);
    const settings = { ...defaultQualitySettings, rejectWords: 'bad' };
    const result = await searchAndGrabForBook(book, indexerService, downloadService, settings, log);
    expect(result).toEqual({ result: 'no_results' });
  });

  it('returns no_results when no result has downloadUrl', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([makeResult({ downloadUrl: undefined })]);
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'no_results' });
  });

  it('treats empty-string downloadUrl as no download URL', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([makeResult({ downloadUrl: '' })]);
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'no_results' });
  });

  it('returns skipped with reason when grab throws "already has an active download"', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(new DuplicateDownloadError('Book already has an active download', 'ACTIVE_DOWNLOAD_EXISTS'));
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'skipped', reason: 'already_has_active_download' });
  });

  // #197 — DuplicateDownloadError instanceof catch (ERR-1)
  it('returns skipped when DuplicateDownloadError is thrown (instanceof check, not string match)', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(new DuplicateDownloadError('Book already has an active download', 'ACTIVE_DOWNLOAD_EXISTS'));
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'skipped', reason: 'already_has_active_download' });
  });

  it('returns skipped when DuplicateDownloadError with PIPELINE_ACTIVE is thrown', async () => {
    vi.mocked(downloadService.grab).mockRejectedValue(new DuplicateDownloadError('Book has pipeline download', 'PIPELINE_ACTIVE'));
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'skipped', reason: 'already_has_active_download' });
  });

  it('returns grab_error when non-DuplicateDownloadError is thrown (not swallowed)', async () => {
    const genericError = new Error('Connection refused');
    vi.mocked(downloadService.grab).mockRejectedValue(genericError);
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'grab_error', error: genericError });
  });

  it('returns grab_error for non-duplicate grab errors', async () => {
    const grabError = new Error('Connection refused');
    vi.mocked(downloadService.grab).mockRejectedValue(grabError);
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'grab_error', error: grabError });
  });

  it('handles book with duration: null', async () => {
    const nullDurationBook = { ...book, duration: null };
    const result = await searchAndGrabForBook(nullDurationBook, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
  });

  it('handles book with duration: undefined', async () => {
    const undefinedDurationBook = { ...book, duration: undefined };
    const result = await searchAndGrabForBook(undefinedDurationBook, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
  });

  it('handles book with duration: 0', async () => {
    const zeroDurationBook = { ...book, duration: 0 };
    const result = await searchAndGrabForBook(zeroDurationBook, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
  });

  it('passes guid from best result to grab()', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([makeResult({ guid: 'nzb-guid-abc' })]);
    await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(downloadService.grab).toHaveBeenCalledWith(
      expect.objectContaining({ guid: 'nzb-guid-abc', bookId: 1 }),
    );
  });

  it('passes undefined guid to grab() when result has no guid', async () => {
    vi.mocked(indexerService.searchAll).mockResolvedValue([makeResult({ guid: undefined })]);
    await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(downloadService.grab).toHaveBeenCalledWith(
      expect.objectContaining({ guid: undefined, bookId: 1 }),
    );
  });

  it('calls buildSearchQuery to construct the query', async () => {
    await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
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
