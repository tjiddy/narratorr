import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSearchQuery, filterAndRankResults, searchAndGrabForBook } from './search-pipeline.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
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
    expect(buildSearchQuery({ title: 'The Way of Kings', author: { name: 'Brandon Sanderson' } }))
      .toBe('The Way of Kings Brandon Sanderson');
  });

  it('returns title only when book has no author object', () => {
    expect(buildSearchQuery({ title: 'The Way of Kings' }))
      .toBe('The Way of Kings');
  });

  it('returns title only when author is null', () => {
    expect(buildSearchQuery({ title: 'The Way of Kings', author: null }))
      .toBe('The Way of Kings');
  });

  it('returns title only when author.name is undefined', () => {
    expect(buildSearchQuery({ title: 'The Way of Kings', author: { name: undefined } as unknown as { name: string } }))
      .toBe('The Way of Kings');
  });

  it('returns author only when title is empty string', () => {
    expect(buildSearchQuery({ title: '', author: { name: 'Brandon Sanderson' } }))
      .toBe('Brandon Sanderson');
  });

  it('returns empty string when both title and author are missing', () => {
    expect(buildSearchQuery({ title: '', author: null }))
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

  const book = { id: 1, title: 'Test Book', duration: 3600, author: { name: 'Author' } };

  it('returns grabbed result on happy path (search → filter → grab)', async () => {
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'grabbed', title: 'Test Book' });
    expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining({ bookId: 1 }));
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
    vi.mocked(downloadService.grab).mockRejectedValue(new Error('Book already has an active download'));
    const result = await searchAndGrabForBook(book, indexerService, downloadService, defaultQualitySettings, log);
    expect(result).toEqual({ result: 'skipped', reason: 'already_has_active_download' });
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

  it('filters torrent with undefined seeders when minSeeders is 1', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: undefined })], undefined, 0, 1, 'none');
    expect(results).toHaveLength(0);
  });

  it('passes torrent with 0 seeders when minSeeders is 0 (filter disabled)', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'torrent', seeders: 0 })], undefined, 0, 0, 'none');
    expect(results).toHaveLength(1);
  });

  it('passes usenet result regardless of seeders when minSeeders is 1', () => {
    const { results } = filterAndRankResults([makeResult({ protocol: 'usenet', seeders: undefined })], undefined, 0, 1, 'none');
    expect(results).toHaveLength(1);
  });
});
