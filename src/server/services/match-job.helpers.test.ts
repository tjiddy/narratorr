import { describe, it, expect, vi } from 'vitest';
import type { AudioScanResult } from '../../core/utils/audio-scanner.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { MatchCandidate } from './match-job.service.js';

// Spy on cleanTagTitle so a single test can force the empty-cleaned-title path
// (the deriveTagQuery guard at match-job.helpers.ts is otherwise unreachable
// because cleanName falls back to `name.trim()` whenever the pipeline empties).
// The factory passes the actual implementation through, so all other tests run
// against real cleanTagTitle behavior.
vi.mock('../utils/folder-parsing.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/folder-parsing.js')>();
  return { ...actual, cleanTagTitle: vi.fn(actual.cleanTagTitle) };
});

import { cleanTagTitle } from '../utils/folder-parsing.js';
import {
  deriveTagQuery,
  rankResultsCleaned,
  rankResults,
  resolveConfidenceFromDuration,
  parsePublishedYear,
} from './match-job.helpers.js';

// -------- Factories --------

function makeAudioScan(overrides: Partial<AudioScanResult> = {}): AudioScanResult {
  return {
    hasCoverArt: false,
    codec: 'mp3',
    bitrate: 128000,
    sampleRate: 44100,
    channels: 2,
    bitrateMode: 'cbr',
    fileFormat: 'mp3',
    totalDuration: 0,
    totalSize: 0,
    fileCount: 1,
    ...overrides,
  };
}

function makeBook(overrides: Partial<BookMetadata> = {}): BookMetadata {
  return {
    title: 'Sample Title',
    authors: [{ name: 'Sample Author' }],
    ...overrides,
  };
}

// ============================================================================
// deriveTagQuery
// ============================================================================

describe('deriveTagQuery', () => {
  it('returns null when audioResult is null', () => {
    expect(deriveTagQuery(null)).toBeNull();
  });

  it('returns null when tagTitle is undefined', () => {
    const scan = makeAudioScan({ tagAuthor: 'X' });
    expect(deriveTagQuery(scan)).toBeNull();
  });

  it('returns null when tagAuthor is undefined', () => {
    const scan = makeAudioScan({ tagTitle: 'Some Book' });
    expect(deriveTagQuery(scan)).toBeNull();
  });

  it('returns null when tagTitle is whitespace-only', () => {
    const scan = makeAudioScan({ tagTitle: '   ', tagAuthor: 'X' });
    expect(deriveTagQuery(scan)).toBeNull();
  });

  it('returns null when tagAuthor is empty after trim', () => {
    const scan = makeAudioScan({ tagTitle: 'Some Book', tagAuthor: '' });
    expect(deriveTagQuery(scan)).toBeNull();
  });

  it('strips ", Book N" series markers from title via cleanTagTitle', () => {
    const scan = makeAudioScan({ tagTitle: 'Eric: Discworld, Book 9', tagAuthor: 'Terry Pratchett' });
    expect(deriveTagQuery(scan)).toEqual({ title: 'Eric: Discworld', author: 'Terry Pratchett' });
  });

  it('trims surrounding whitespace on both fields', () => {
    const scan = makeAudioScan({ tagTitle: '  Mistborn  ', tagAuthor: '  Brandon Sanderson  ' });
    expect(deriveTagQuery(scan)).toEqual({ title: 'Mistborn', author: 'Brandon Sanderson' });
  });

  it('passes through tagYear when present', () => {
    const scan = makeAudioScan({ tagTitle: 'Mistborn', tagAuthor: 'Brandon Sanderson', tagYear: '2006' });
    expect(deriveTagQuery(scan)).toEqual({ title: 'Mistborn', author: 'Brandon Sanderson', year: '2006' });
  });

  it('omits year field when tagYear is missing', () => {
    const scan = makeAudioScan({ tagTitle: 'Mistborn', tagAuthor: 'Brandon Sanderson' });
    const result = deriveTagQuery(scan);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('year');
  });

  it('omits year field when tagYear is whitespace-only', () => {
    const scan = makeAudioScan({ tagTitle: 'Mistborn', tagAuthor: 'Brandon Sanderson', tagYear: '   ' });
    const result = deriveTagQuery(scan);
    expect(result).not.toHaveProperty('year');
  });

  it('returns null when cleanTagTitle reduces title to empty', () => {
    // Pins the cleanedTitle guard at match-job.helpers.ts:57 — if the guard is
    // removed, deriveTagQuery would return { title: '', author: 'X' } and this
    // test would fail. The mock forces the otherwise-unreachable branch.
    vi.mocked(cleanTagTitle).mockReturnValueOnce('');
    const scan = makeAudioScan({ tagTitle: 'looks-non-empty', tagAuthor: 'X' });
    expect(deriveTagQuery(scan)).toBeNull();
  });
});

// ============================================================================
// rankResultsCleaned
// ============================================================================

describe('rankResultsCleaned', () => {
  it('returns empty array for empty input', () => {
    expect(rankResultsCleaned([], { title: 'X', author: 'Y' })).toEqual([]);
  });

  it('returns single-element array for single result', () => {
    const book = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }] });
    const ranked = rankResultsCleaned([book], { title: 'Mistborn', author: 'Brandon Sanderson' });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.meta).toBe(book);
    expect(ranked[0]!.score).toBeGreaterThan(0.99);
  });

  it('sorts multiple results by descending score', () => {
    const exact = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }] });
    const partial = makeBook({ title: 'Mistborn Trilogy', authors: [{ name: 'Brandon Sanderson' }] });
    const wrong = makeBook({ title: 'Way of Kings', authors: [{ name: 'Brandon Sanderson' }] });

    const ranked = rankResultsCleaned([wrong, partial, exact], { title: 'Mistborn', author: 'Brandon Sanderson' });
    expect(ranked.map(r => r.meta.title)).toEqual(['Mistborn', 'Mistborn Trilogy', 'Way of Kings']);
  });

  it('produces dice = 1.0 for "M O Walsh" tag against Audible "M. O. Walsh" (symmetric author normalization)', () => {
    // Finding 1 — without normalizeNarrator on the result side, raw dice would be ~0.5-0.65
    const book = makeBook({ title: 'My Sunshine Away', authors: [{ name: 'M. O. Walsh' }] });
    const ranked = rankResultsCleaned([book], { title: 'My Sunshine Away', author: 'M O Walsh' });
    expect(ranked[0]!.score).toBeCloseTo(1.0, 5);
  });

  it('produces dice = 1.0 for "J R R Tolkien" tag against Audible "J. R. R. Tolkien"', () => {
    const book = makeBook({ title: 'The Hobbit', authors: [{ name: 'J. R. R. Tolkien' }] });
    const ranked = rankResultsCleaned([book], { title: 'The Hobbit', author: 'J R R Tolkien' });
    expect(ranked[0]!.score).toBeCloseTo(1.0, 5);
  });

  it('uses author-only weight when result.title is undefined', () => {
    const book = makeBook({ title: undefined as unknown as string, authors: [{ name: 'Brandon Sanderson' }] });
    const ranked = rankResultsCleaned([book], { title: 'Mistborn', author: 'Brandon Sanderson' });
    // Author dice = 1.0 normalized by AUTHOR_WEIGHT; full credit since no title context
    expect(ranked[0]!.score).toBeCloseTo(1.0, 5);
  });

  it('uses title-only weight when result.authors is undefined', () => {
    const book = makeBook({ title: 'Mistborn', authors: undefined as unknown as BookMetadata['authors'] });
    const ranked = rankResultsCleaned([book], { title: 'Mistborn', author: 'Brandon Sanderson' });
    // Title dice = 1.0; author missing on result so author weight contributes nothing
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  it('exact-match candidate ranks first among same-prefix volumes (Sandman: Act II disambiguation)', () => {
    const actI = makeBook({ title: 'The Sandman: Act I', authors: [{ name: 'Neil Gaiman' }] });
    const actII = makeBook({ title: 'The Sandman: Act II', authors: [{ name: 'Neil Gaiman' }] });
    const actIII = makeBook({ title: 'The Sandman: Act III', authors: [{ name: 'Neil Gaiman' }] });

    const ranked = rankResultsCleaned([actI, actIII, actII], { title: 'The Sandman: Act II', author: 'Neil Gaiman' });
    expect(ranked[0]!.meta.title).toBe('The Sandman: Act II');
  });
});

// ============================================================================
// rankResultsCleaned — year tiebreaker (Finding 3)
// ============================================================================

describe('rankResultsCleaned year tiebreaker', () => {
  it('promotes year-matching candidate when dice scores are tied and tagYear is provided', () => {
    // Three Mistborn-shaped candidates with different publishedDates
    const a = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2008-04-15' });
    const b = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2006-07-17' });
    const c = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2017-11-02' });

    const ranked = rankResultsCleaned([a, b, c], { title: 'Mistborn', author: 'Brandon Sanderson', year: '2006' });
    expect(ranked[0]!.meta.publishedDate).toBe('2006-07-17');
  });

  it('falls through to pure dice ordering when tagYear is undefined', () => {
    const a = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2008-04-15' });
    const b = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2006-07-17' });

    const ranked = rankResultsCleaned([a, b], { title: 'Mistborn', author: 'Brandon Sanderson' });
    // Tied scores; tiebreaker doesn't fire — input order is preserved by stable sort
    expect(ranked[0]!.meta.publishedDate).toBe('2008-04-15');
  });

  it('does not fire tiebreaker when scores differ by more than 0.001', () => {
    // exact-title candidate has higher score than partial-title; year shouldn't override
    const exactWrongYear = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2008' });
    const partialRightYear = makeBook({ title: 'Mistborn Trilogy', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2006' });

    const ranked = rankResultsCleaned([partialRightYear, exactWrongYear], { title: 'Mistborn', author: 'Brandon Sanderson', year: '2006' });
    // Pure-dice winner stays — exact title beats partial regardless of year
    expect(ranked[0]!.meta.title).toBe('Mistborn');
  });

  it('preserves stable ordering when no tied candidate matches tagYear', () => {
    const a = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2008' });
    const b = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2010' });

    const ranked = rankResultsCleaned([a, b], { title: 'Mistborn', author: 'Brandon Sanderson', year: '2006' });
    // No candidate matches 2006 — neither gets promoted; input order preserved
    expect(ranked[0]!.meta.publishedDate).toBe('2008');
  });
});

// ============================================================================
// rankResults (Pass 2 / filename-derived) — folder-year tiebreaker behavior
// ============================================================================

describe('rankResults', () => {
  it('promotes folder-year-matching candidate when dice scores are tied', () => {
    const matching = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2006-07-17' });
    const nonMatching = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2008-04-15' });

    const candidate: MatchCandidate = {
      path: '/audiobooks/Mistborn (2006)',
      title: 'Mistborn',
      author: 'Brandon Sanderson',
    };
    const ranked = rankResults([nonMatching, matching], candidate);
    expect(ranked[0]!.meta.publishedDate).toBe('2006-07-17');
  });

  it('preserves input order when tied and both candidates match folder year', () => {
    const a = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2006-07-17' });
    const b = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2006-12-01' });

    const candidate: MatchCandidate = {
      path: '/audiobooks/Mistborn (2006)',
      title: 'Mistborn',
      author: 'Brandon Sanderson',
    };
    const ranked = rankResults([a, b], candidate);
    expect(ranked[0]!.meta.publishedDate).toBe('2006-07-17');
    expect(ranked[1]!.meta.publishedDate).toBe('2006-12-01');
  });

  it('skips tiebreaker when folder year is not extractable', () => {
    const a = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2008-04-15' });
    const b = makeBook({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }], publishedDate: '2006-07-17' });

    const candidate: MatchCandidate = {
      path: '/audiobooks/Mistborn',
      title: 'Mistborn',
      author: 'Brandon Sanderson',
    };
    const ranked = rankResults([a, b], candidate);
    // No folder year — input order survives stable sort
    expect(ranked[0]!.meta.publishedDate).toBe('2008-04-15');
  });
});

// ============================================================================
// resolveConfidenceFromDuration
// ============================================================================

describe('resolveConfidenceFromDuration', () => {
  const topMeta = makeBook({ duration: 600 });

  it('returns medium when duration is undefined', () => {
    const result = resolveConfidenceFromDuration([{ meta: topMeta, score: 0.9 }], undefined);
    expect(result).toEqual({ confidence: 'medium', reason: expect.stringContaining('no duration data') });
  });

  it('returns medium when duration is zero', () => {
    const result = resolveConfidenceFromDuration([{ meta: topMeta, score: 0.9 }], 0);
    expect(result.confidence).toBe('medium');
  });

  it('returns medium "cannot verify" when top result has no duration', () => {
    const noDuration = makeBook();
    const result = resolveConfidenceFromDuration([{ meta: noDuration, score: 0.9 }], 600);
    expect(result).toEqual({ confidence: 'medium', reason: expect.stringContaining('cannot verify') });
  });

  it('returns high when duration matches within strict threshold (5%) and score < combined gate', () => {
    // duration 605, expected 600 → distance = 5/600 ≈ 0.0083 — under strict 5%
    const result = resolveConfidenceFromDuration([{ meta: makeBook({ duration: 600 }), score: 0.85 }], 605);
    expect(result).toEqual({ confidence: 'high' });
  });

  it('returns medium duration mismatch when distance exceeds strict threshold and score < combined gate', () => {
    // duration 700, expected 600 → distance = 100/600 ≈ 0.167 — over 5% (and 15%)
    const result = resolveConfidenceFromDuration([{ meta: makeBook({ duration: 600 }), score: 0.85 }], 700);
    expect(result.confidence).toBe('medium');
    expect(result.reason).toContain('Duration mismatch');
  });

  it('uses relaxed threshold (15%) when score >= combined gate (0.95)', () => {
    // distance 10% — fails strict 5% but passes relaxed 15%
    const result = resolveConfidenceFromDuration([{ meta: makeBook({ duration: 600 }), score: 0.96 }], 660);
    expect(result).toEqual({ confidence: 'high' });
  });

  it('uses strict threshold (5%) when score < combined gate', () => {
    // distance 10% — fails strict 5%; score below gate so relaxed isn't applied
    const result = resolveConfidenceFromDuration([{ meta: makeBook({ duration: 600 }), score: 0.94 }], 660);
    expect(result.confidence).toBe('medium');
  });
});

// ============================================================================
// parsePublishedYear
// ============================================================================

describe('parsePublishedYear', () => {
  it('returns undefined for undefined input', () => {
    expect(parsePublishedYear(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parsePublishedYear('')).toBeUndefined();
  });

  it('extracts year from ISO date', () => {
    expect(parsePublishedYear('2011-06-14')).toBe(2011);
  });

  it('extracts year from "Month YYYY" format', () => {
    expect(parsePublishedYear('June 2011')).toBe(2011);
  });

  it('extracts first 4-digit run from compound strings', () => {
    expect(parsePublishedYear('circa 1923')).toBe(1923);
  });

  it('returns undefined when no 4-digit run is present', () => {
    expect(parsePublishedYear('no year here')).toBeUndefined();
  });
});
