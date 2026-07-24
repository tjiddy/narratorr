import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { AudioScanResult } from '../../core/utils/audio-scanner.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { MatchCandidate, MatchResult } from './match-job.service.js';
import type * as FolderParsing from '../utils/folder-parsing.js';
import { pickPrimarySeries } from '../../shared/pick-primary-series.js';

// Spy on cleanTagTitle so a single test can force the empty-cleaned-title path
// (the deriveTagQuery guard at match-job.helpers.ts is otherwise unreachable
// because cleanName falls back to `name.trim()` whenever the pipeline empties).
// The factory passes the actual implementation through, so all other tests run
// against real cleanTagTitle behavior.
vi.mock('../utils/folder-parsing.js', async (importActual) => {
  const actual = await importActual<typeof FolderParsing>();
  return { ...actual, cleanTagTitle: vi.fn(actual.cleanTagTitle) };
});

import { cleanTagTitle } from '../utils/folder-parsing.js';
import {
  applyNarratorCap,
  cleanTagAuthor,
  deriveTagQuery,
  isDurationVerified,
  narratorMismatchReason,
  rankResultsCleaned,
  rankResults,
  positionTiebreak,
  durationTiebreak,
  resolveConfidenceFromDuration,
  resolveSingleResultConfidence,
  parsePublishedYear,
  tagTitleScore,
  type NarratorCapContext,
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

/** Resolve a book's primary-series position the same way the ranker does. */
function pickPos(meta: BookMetadata): number | undefined {
  return pickPrimarySeries(meta)?.position;
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

  it('carries tagSeriesPosition into seriesPosition when present (#1849)', () => {
    const scan = makeAudioScan({ tagTitle: 'Fablehaven', tagAuthor: 'Brandon Mull', tagSeriesPosition: 1 });
    expect(deriveTagQuery(scan)).toEqual({ title: 'Fablehaven', author: 'Brandon Mull', seriesPosition: 1 });
  });

  it('preserves a genuine tagSeriesPosition of 0 (#1849/#1028 — not swallowed by ||)', () => {
    const scan = makeAudioScan({ tagTitle: 'Fablehaven', tagAuthor: 'Brandon Mull', tagSeriesPosition: 0 });
    expect(deriveTagQuery(scan)).toEqual({ title: 'Fablehaven', author: 'Brandon Mull', seriesPosition: 0 });
  });

  it('omits seriesPosition when the scan has no tagSeriesPosition', () => {
    const scan = makeAudioScan({ tagTitle: 'Fablehaven', tagAuthor: 'Brandon Mull' });
    const result = deriveTagQuery(scan);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('seriesPosition');
  });

  it('returns null when cleanTagTitle reduces title to empty', () => {
    // Pins the cleaned-title guard: resolveTagSearchTitle returns `cleanedTitle
    // || null`, so deriveTagQuery's `if (!searchTitle) return null` fires. If the
    // guard is removed, deriveTagQuery would return { title: '', author: 'X' }
    // and this test would fail. The mock forces the otherwise-unreachable branch.
    vi.mocked(cleanTagTitle).mockReturnValueOnce('');
    const scan = makeAudioScan({ tagTitle: 'looks-non-empty', tagAuthor: 'X' });
    expect(deriveTagQuery(scan)).toBeNull();
  });

  it('strips trailing "(audio)" suffix from tagAuthor before search (#1030)', () => {
    const scan = makeAudioScan({ tagTitle: 'Dune', tagAuthor: 'Frank Herbert (audio)' });
    expect(deriveTagQuery(scan)).toEqual({ title: 'Dune', author: 'Frank Herbert' });
  });

  it('returns null when tagAuthor is paren-only (cleans to empty) (#1030)', () => {
    const scan = makeAudioScan({ tagTitle: 'X', tagAuthor: '(Various)' });
    expect(deriveTagQuery(scan)).toBeNull();
  });

  // ── #1650 generic title-tag fallback ──────────────────────────────
  describe('#1650 generic title-tag → album fallback', () => {
    it('substitutes the album when a ", Book N" prefix differs from a usable album (headline)', () => {
      // `Shattered Sea, Book 1` cleans to series-name prefix `Shattered Sea`;
      // album `Half a King` is the real title → search on the album.
      const scan = makeAudioScan({
        tagTitle: 'Shattered Sea, Book 1',
        tagAlbum: 'Half a King',
        tagAuthor: 'Joe Abercrombie',
        tagYear: '2014',
      });
      expect(deriveTagQuery(scan)).toEqual({ title: 'Half a King', author: 'Joe Abercrombie', year: '2014' });
    });

    it('uses the album for a bare placeholder title when a usable album exists', () => {
      const scan = makeAudioScan({ tagTitle: 'Book 1', tagAlbum: 'Half a King', tagAuthor: 'Joe Abercrombie' });
      expect(deriveTagQuery(scan)).toEqual({ title: 'Half a King', author: 'Joe Abercrombie' });
    });

    it('returns null for a bare placeholder title with no usable album (falls through to Pass 2)', () => {
      const scan = makeAudioScan({ tagTitle: 'Book 1', tagAuthor: 'Joe Abercrombie' });
      expect(deriveTagQuery(scan)).toBeNull();
    });

    it('treats "<series-kw>, Book N" as a bare placeholder', () => {
      const scan = makeAudioScan({ tagTitle: 'Series, Book 1', tagAlbum: 'Half a King', tagAuthor: 'Joe Abercrombie' });
      expect(deriveTagQuery(scan)).toEqual({ title: 'Half a King', author: 'Joe Abercrombie' });
    });

    it('preserves a legitimate ", Book N" title when the cleaned album equals it', () => {
      const scan = makeAudioScan({ tagTitle: 'The Hobbit, Book 1', tagAlbum: 'The Hobbit', tagAuthor: 'J.R.R. Tolkien' });
      expect(deriveTagQuery(scan)).toEqual({ title: 'The Hobbit', author: 'J.R.R. Tolkien' });
    });

    it('preserves a legitimate ", Book N" title when there is no usable album', () => {
      const scan = makeAudioScan({ tagTitle: 'The Hobbit, Book 1', tagAuthor: 'J.R.R. Tolkien' });
      expect(deriveTagQuery(scan)).toEqual({ title: 'The Hobbit', author: 'J.R.R. Tolkien' });
    });

    it('does NOT substitute the album for a normal title (no series marker) even when album differs', () => {
      // No `, Book N` marker → the album-difference rule never fires; the title stands.
      const scan = makeAudioScan({ tagTitle: 'Half a King', tagAlbum: 'Shattered Sea', tagAuthor: 'Joe Abercrombie' });
      expect(deriveTagQuery(scan)).toEqual({ title: 'Half a King', author: 'Joe Abercrombie' });
    });

    it('does NOT substitute a bare-volume-marker album for a legitimate ", Book N" title (#1652 item 6)', () => {
      // `The Hobbit, Book 1` has a series marker and the album `Book 5` differs,
      // so the pre-guard rule would have picked the junk album. The new
      // `!isPureVolumeMarker(rawAlbum)` guard rejects it → the title stands.
      const scan = makeAudioScan({ tagTitle: 'The Hobbit, Book 1', tagAlbum: 'Book 5', tagAuthor: 'J.R.R. Tolkien' });
      expect(deriveTagQuery(scan)).toEqual({ title: 'The Hobbit', author: 'J.R.R. Tolkien' });
    });

    it('still prefers a usable album over a pure-volume-marker title (#1652 item 6 — existing behavior preserved)', () => {
      const scan = makeAudioScan({ tagTitle: 'Series, Book 1', tagAlbum: 'Half a King', tagAuthor: 'Joe Abercrombie' });
      expect(deriveTagQuery(scan)).toEqual({ title: 'Half a King', author: 'Joe Abercrombie' });
    });
  });
});

// ============================================================================
// cleanTagAuthor (#1030)
// ============================================================================

describe('cleanTagAuthor', () => {
  it('strips trailing "(audio)" suffix', () => {
    expect(cleanTagAuthor('Frank Herbert (audio)')).toBe('Frank Herbert');
  });

  it('strips trailing "(audio)" from multi-author strings', () => {
    expect(cleanTagAuthor('Brian Herbert & Keven J. Anderson (audio)')).toBe(
      'Brian Herbert & Keven J. Anderson',
    );
  });

  it('preserves embedded mid-string parens', () => {
    expect(cleanTagAuthor('Robert (Bob) Smith')).toBe('Robert (Bob) Smith');
  });

  it('leaves already-clean authors unchanged', () => {
    expect(cleanTagAuthor('Brandon Sanderson')).toBe('Brandon Sanderson');
  });

  it('strips paren-only author to empty string', () => {
    expect(cleanTagAuthor('(Various)')).toBe('');
  });

  it('strips trailing "(Read by ...)" narrator credit', () => {
    expect(cleanTagAuthor('Stephen King (Read by Stephen King)')).toBe('Stephen King');
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

  // #1655 F1 — the 5B placeholder denylist lives at the comparison layer, NOT in
  // normalizeNarrator. So tag-author scoring (a DIRECT normalizeNarrator caller)
  // is unaffected: a placeholder-looking author value is NOT zeroed.
  it('does NOT zero a placeholder-looking author value ("Author") — 5B is comparison-only', () => {
    const book = makeBook({ title: 'Some Memoir', authors: [{ name: 'Author' }] });
    const ranked = rankResultsCleaned([book], { title: 'Some Memoir', author: 'Author' });
    // If the denylist had leaked into normalizeNarrator, the author dice would be
    // 0 (empty vs empty) and the score would drop to the title-only weight.
    expect(ranked[0]!.score).toBeCloseTo(1.0, 5);
  });

  it('#1655 5A: a "Read by …" / diacritic author normalizes without regression in tag-author scoring', () => {
    const book = makeBook({ title: 'Memoir', authors: [{ name: 'Thérèse Plummer' }] });
    const ranked = rankResultsCleaned([book], { title: 'Memoir', author: 'Therese Plummer' });
    expect(ranked[0]!.score).toBeCloseTo(1.0, 5);
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
// tagTitleScore — multi-form composition against series[]
// ============================================================================

describe('tagTitleScore', () => {
  it('returns dice on title alone when result has no series[]', () => {
    const meta = makeBook({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }] });
    expect(tagTitleScore('Brave New World', meta)).toBeCloseTo(1.0, 5);
  });

  it('Eric shape — composes title + ": " + series.name and recovers dice = 1.0', () => {
    const meta = makeBook({ title: 'Eric', series: [{ name: 'Discworld' }] });
    expect(tagTitleScore('Eric: Discworld', meta)).toBeCloseTo(1.0, 5);
  });

  it('series-prefix colon (Mistborn shape) — composes series.name + ": " + title', () => {
    const meta = makeBook({ title: 'The Final Empire', series: [{ name: 'Mistborn' }] });
    expect(tagTitleScore('Mistborn: The Final Empire', meta)).toBeCloseTo(1.0, 5);
  });

  it('dash-form composition title - series (Imagine Me shape)', () => {
    const meta = makeBook({ title: 'Imagine Me', series: [{ name: 'Shatter Me' }] });
    // Best composed candidate `Imagine Me - Shatter Me` vs input `Imagine Me - Shatter Me Series`
    // (the trailing " Series" word produces some bigram variance — ~0.86 dice — well above the 0.5 floor)
    expect(tagTitleScore('Imagine Me - Shatter Me Series', meta)).toBeGreaterThan(0.8);
  });

  it('series-prefix dash — composes series.name + " - " + title (deletion-proof for `series - title`)', () => {
    // Input matches ONLY the series-prefix dash form. The four other candidates
    // ("Eric", "Eric: Discworld", "Eric - Discworld", "Discworld: Eric") all
    // score below 1.0 against "Discworld - Eric"; deleting the `series - title`
    // candidate from tagTitleScore would drop this test's score to ≈ 0.83.
    const meta = makeBook({ title: 'Eric', series: [{ name: 'Discworld' }] });
    expect(tagTitleScore('Discworld - Eric', meta)).toBeCloseTo(1.0, 5);
  });

  // #1097 — when seriesPrimary is absent, composition still uses series[0] (Audible-only fallback)
  it('falls back to series[0] when seriesPrimary is absent', () => {
    const meta = makeBook({
      title: 'Mistborn',
      series: [{ name: 'Cosmere' }, { name: 'Mistborn Era 1' }],
    });
    // No seriesPrimary → composition uses series[0] (Cosmere); series[1] is ignored
    expect(tagTitleScore('Cosmere: Mistborn', meta)).toBeCloseTo(1.0, 5);
    expect(tagTitleScore('Mistborn Era 1: Mistborn', meta)).toBeLessThan(
      tagTitleScore('Cosmere: Mistborn', meta),
    );
  });

  // #1097 — canonical primary-series preference over series[0]
  it('prefers seriesPrimary over series[0] when both are present (Stormlight in a Cosmere-prefixed series[])', () => {
    const meta = makeBook({
      title: 'The Way of Kings',
      series: [
        { name: 'Cosmere', position: 4 },
        { name: 'The Stormlight Archive', position: 1 },
      ],
      seriesPrimary: { name: 'The Stormlight Archive', position: 1 },
    });
    // Pre-#1097 the composition would have used series[0] (Cosmere); the canonical
    // Stormlight-shaped input now scores 1.0 because seriesPrimary wins.
    expect(tagTitleScore('The Stormlight Archive: The Way of Kings', meta)).toBeCloseTo(1.0, 5);
    // And it beats the matching-series[0] composition
    expect(tagTitleScore('The Stormlight Archive: The Way of Kings', meta)).toBeGreaterThan(
      tagTitleScore('Cosmere: The Way of Kings', meta),
    );
  });

  it('includes "series: title, Book N" when series[0].position is set', () => {
    const meta = makeBook({ title: 'The Final Empire', series: [{ name: 'Mistborn', position: 1 }] });
    // The position-form candidate exists; verify the Math.max picks it for matching input
    expect(tagTitleScore('Mistborn: The Final Empire, Book 1', meta)).toBeCloseTo(1.0, 5);
  });

  it('treats series[0].position === 0 as a valid value, not falsy-skipped', () => {
    const meta = makeBook({ title: 'Prelude', series: [{ name: 'Sample', position: 0 }] });
    // If `if (seriesPos)` were used (falsy check), position 0 would be excluded.
    // Guard is `seriesPos !== undefined`, so the position-form candidate is built.
    expect(tagTitleScore('Sample: Prelude, Book 0', meta)).toBeCloseTo(1.0, 5);
  });

  it('handles fractional positions in stringification', () => {
    const meta = makeBook({ title: 'Story', series: [{ name: 'Saga', position: 1.5 }] });
    expect(tagTitleScore('Saga: Story, Book 1.5', meta)).toBeCloseTo(1.0, 5);
  });

  it('falls back to title alone when series[0].name is empty string', () => {
    const meta = makeBook({ title: 'Standalone', series: [{ name: '' }] });
    // Empty-name candidate filters out; only the bare title candidate exists.
    expect(tagTitleScore('Standalone', meta)).toBeCloseTo(1.0, 5);
  });

  it('falls back to title alone when series[] is empty', () => {
    const meta = makeBook({ title: 'Standalone', series: [] });
    expect(tagTitleScore('Standalone', meta)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 (NOT -Infinity) when title is undefined and series has no name', () => {
    // Pins AC7 — Math.max(...[]) returns -Infinity in JS. Without the explicit
    // `scores.length > 0 ? Math.max(...scores) : 0` guard, this test would
    // return -Infinity and silently pass any floor check downstream.
    const meta = makeBook({ title: undefined as unknown as string, series: [] });
    expect(tagTitleScore('Anything', meta)).toBe(0);
  });

  it('handles result.title === series[0].name (duplicate composed strings) without distortion', () => {
    const meta = makeBook({ title: 'Discworld', series: [{ name: 'Discworld' }] });
    expect(tagTitleScore('Discworld', meta)).toBeCloseTo(1.0, 5);
  });

  it('strips publisher decoration from result.title before composition', () => {
    const meta = makeBook({ title: 'The Last Hero (Full Audiobook)', series: [{ name: 'Discworld' }] });
    expect(tagTitleScore('The Last Hero: Discworld', meta)).toBeCloseTo(1.0, 5);
  });

  it('strips decoration from series.name before composition', () => {
    const meta = makeBook({ title: 'Eric', series: [{ name: 'Discworld [Bonus]' }] });
    expect(tagTitleScore('Eric: Discworld', meta)).toBeCloseTo(1.0, 5);
  });
});

// ============================================================================
// rankResultsCleaned — multi-form scoring with series[]
// ============================================================================

describe('rankResultsCleaned multi-form', () => {
  it('Eric shape — promotes series-composed candidate above title-only', () => {
    const eric = makeBook({ title: 'Eric', series: [{ name: 'Discworld' }], authors: [{ name: 'Terry Pratchett' }] });
    const wrong = makeBook({ title: 'Going Postal', series: [{ name: 'Discworld' }], authors: [{ name: 'Terry Pratchett' }] });
    const ranked = rankResultsCleaned([wrong, eric], { title: 'Eric: Discworld', author: 'Terry Pratchett' });
    expect(ranked[0]!.meta.title).toBe('Eric');
  });

  it('passes the 0.5 title floor for an Eric-shape that single-form dice would fail', () => {
    // Pre-#1007 single-form: cleanTagTitle("Eric") vs "Eric: Discworld" ≈ 0.4 — fails 0.5 floor.
    // With multi-form: composed "Eric: Discworld" vs input "Eric: Discworld" = 1.0 — title score easily passes.
    const eric = makeBook({ title: 'Eric', series: [{ name: 'Discworld' }], authors: [{ name: 'Terry Pratchett' }] });
    const ranked = rankResultsCleaned([eric], { title: 'Eric: Discworld', author: 'Terry Pratchett' });
    expect(ranked[0]!.score).toBeGreaterThan(0.6);
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
// positionTiebreak — shared comparator (#1849)
// ============================================================================

describe('positionTiebreak', () => {
  const p1 = makeBook({ series: [{ name: 'Fablehaven', position: 1 }] });
  const p2 = makeBook({ series: [{ name: 'Fablehaven', position: 2 }] });
  const noPos = makeBook({ series: [{ name: 'Fablehaven' }] });
  const noSeries = makeBook({ series: [] });

  it('returns 0 (no-op) when wanted is undefined', () => {
    expect(positionTiebreak(p1, p2, undefined)).toBe(0);
  });

  it('ranks the position-matching candidate ahead (negative → a first)', () => {
    expect(positionTiebreak(p1, p2, 1)).toBeLessThan(0);
    expect(positionTiebreak(p2, p1, 1)).toBeGreaterThan(0);
  });

  it('respects a genuine position 0 via === (#1028)', () => {
    const p0 = makeBook({ series: [{ name: 'Fablehaven', position: 0 }] });
    expect(positionTiebreak(p0, p1, 0)).toBeLessThan(0);
  });

  it('prefers the canonical seriesPrimary over series[0] (#1088/#1097)', () => {
    const primary1 = makeBook({
      series: [{ name: 'Cosmere', position: 4 }],
      seriesPrimary: { name: 'Stormlight', position: 1 },
    });
    expect(positionTiebreak(primary1, p2, 1)).toBeLessThan(0);
  });

  it('treats a candidate with no position as a non-match (ties another non-match, never throws)', () => {
    expect(positionTiebreak(noPos, noSeries, 1)).toBe(0);
    // A non-match loses only to a genuine match
    expect(positionTiebreak(noPos, p1, 1)).toBeGreaterThan(0);
    expect(positionTiebreak(p1, noPos, 1)).toBeLessThan(0);
  });

  it('two matching positions tie (returns 0)', () => {
    const anotherP1 = makeBook({ series: [{ name: 'Other', position: 1 }] });
    expect(positionTiebreak(p1, anotherP1, 1)).toBe(0);
  });
});

// ============================================================================
// Position-agreement tiebreaker in the rankers (#1849)
// ============================================================================

describe('rankResults position tiebreaker', () => {
  const fablehaven1 = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 1 }] });
  const fablehaven2 = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 2 }] });

  it('Fablehaven regression: wanted position 1 makes the position-1 candidate bestMatch', () => {
    const candidate: MatchCandidate = { path: '/audiobooks/01 - Fablehaven', title: 'Fablehaven', author: 'Brandon Mull', seriesPosition: 1 };
    // Provider returned #2 first; the tiebreaker must promote #1.
    const ranked = rankResults([fablehaven2, fablehaven1], candidate);
    expect(pickPos(ranked[0]!.meta)).toBe(1);
  });

  it('the disagreeing candidate is not penalized beyond losing the tiebreak', () => {
    const candidate: MatchCandidate = { path: '/audiobooks/01 - Fablehaven', title: 'Fablehaven', author: 'Brandon Mull', seriesPosition: 1 };
    const ranked = rankResults([fablehaven2, fablehaven1], candidate);
    // Both still present; #2 simply drops to second.
    expect(pickPos(ranked[1]!.meta)).toBe(2);
  });

  it('respects wanted position 0 (#1028)', () => {
    const p0 = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 0 }] });
    const candidate: MatchCandidate = { path: '/audiobooks/00 - Fablehaven', title: 'Fablehaven', author: 'Brandon Mull', seriesPosition: 0 };
    const ranked = rankResults([fablehaven1, p0], candidate);
    expect(pickPos(ranked[0]!.meta)).toBe(0);
  });

  it('wanted position absent → falls through to the folder-year tiebreaker unchanged', () => {
    const a = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 2 }], publishedDate: '2008' });
    const b = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 1 }], publishedDate: '2006' });
    // No seriesPosition on the candidate; folder year 2006 must still decide.
    const candidate: MatchCandidate = { path: '/audiobooks/Fablehaven (2006)', title: 'Fablehaven', author: 'Brandon Mull' };
    const ranked = rankResults([a, b], candidate);
    expect(ranked[0]!.meta.publishedDate).toBe('2006');
  });

  it('position tie → falls through to the folder-year tiebreaker', () => {
    // Both share position 1, so position no-ops; folder year 2006 breaks it.
    const a = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 1 }], publishedDate: '2008' });
    const b = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 1 }], publishedDate: '2006' });
    const candidate: MatchCandidate = { path: '/audiobooks/Fablehaven (2006)', title: 'Fablehaven', author: 'Brandon Mull', seriesPosition: 1 };
    const ranked = rankResults([a, b], candidate);
    expect(ranked[0]!.meta.publishedDate).toBe('2006');
  });

  it('candidate missing a position is neutral: does not win, does not demote below another non-match, does not throw', () => {
    const noPos = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven' }], publishedDate: '2008' });
    const alsoNoPos = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven' }], publishedDate: '2006' });
    const candidate: MatchCandidate = { path: '/audiobooks/Fablehaven', title: 'Fablehaven', author: 'Brandon Mull', seriesPosition: 1 };
    // Neither matches wanted=1 → position no-ops, no year → stable input order.
    const ranked = rankResults([noPos, alsoNoPos], candidate);
    expect(ranked[0]!.meta.publishedDate).toBe('2008');
    expect(ranked[1]!.meta.publishedDate).toBe('2006');
  });
});

describe('rankResultsCleaned position tiebreaker', () => {
  const fablehaven1 = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 1 }] });
  const fablehaven2 = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 2 }] });

  it('wanted position promotes the agreeing candidate on a score tie', () => {
    const ranked = rankResultsCleaned([fablehaven2, fablehaven1], { title: 'Fablehaven', author: 'Brandon Mull', seriesPosition: 1 });
    expect(pickPos(ranked[0]!.meta)).toBe(1);
  });

  it('respects wanted position 0 (#1028)', () => {
    const p0 = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 0 }] });
    const ranked = rankResultsCleaned([fablehaven1, p0], { title: 'Fablehaven', author: 'Brandon Mull', seriesPosition: 0 });
    expect(pickPos(ranked[0]!.meta)).toBe(0);
  });

  it('position tiebreaker runs before the year tiebreaker', () => {
    // #1 has the WRONG year, #2 has the right year. Position must still win.
    const p1WrongYear = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 1 }], publishedDate: '2008' });
    const p2RightYear = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 2 }], publishedDate: '2006' });
    const ranked = rankResultsCleaned([p2RightYear, p1WrongYear], { title: 'Fablehaven', author: 'Brandon Mull', year: '2006', seriesPosition: 1 });
    expect(pickPos(ranked[0]!.meta)).toBe(1);
  });

  it('wanted position absent → year tiebreaker still decides (unchanged behavior)', () => {
    const a = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 2 }], publishedDate: '2008' });
    const b = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 1 }], publishedDate: '2006' });
    const ranked = rankResultsCleaned([a, b], { title: 'Fablehaven', author: 'Brandon Mull', year: '2006' });
    expect(ranked[0]!.meta.publishedDate).toBe('2006');
  });

  it('position tie → falls through to the year tiebreaker', () => {
    const a = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 1 }], publishedDate: '2008' });
    const b = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 1 }], publishedDate: '2006' });
    const ranked = rankResultsCleaned([a, b], { title: 'Fablehaven', author: 'Brandon Mull', year: '2006', seriesPosition: 1 });
    expect(ranked[0]!.meta.publishedDate).toBe('2006');
  });

  it('candidate missing a position is neutral among non-matches (no throw, no demotion)', () => {
    const noPos = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven' }], publishedDate: '2008' });
    const alsoNoPos = makeBook({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven' }], publishedDate: '2006' });
    const ranked = rankResultsCleaned([noPos, alsoNoPos], { title: 'Fablehaven', author: 'Brandon Mull', seriesPosition: 1 });
    expect(ranked[0]!.meta.publishedDate).toBe('2008');
    expect(ranked[1]!.meta.publishedDate).toBe('2006');
  });
});

// ============================================================================
// durationTiebreak — shared edition comparator (#1882)
// ============================================================================

describe('durationTiebreak', () => {
  // Provider `duration` is MINUTES; scanned seconds is SECONDS. Dogs of War:
  // 598min (9h58m) = 35,880s, Δ56s ≤ 240 → verified; 568min (9h28m) = 34,080s,
  // Δ1,856s → not verified. Scanned = 35,936s.
  const SCANNED = 35_936;
  const agree = makeBook({ duration: 598 });
  const disagree = makeBook({ duration: 568 });
  const missing = makeBook({ duration: undefined });
  const zero = makeBook({ duration: 0 });

  it('invalid scannedSeconds (undefined) → 0 for any two candidates', () => {
    expect(durationTiebreak(agree, disagree, undefined)).toBe(0);
  });

  it('invalid scannedSeconds (0) → 0', () => {
    expect(durationTiebreak(agree, disagree, 0)).toBe(0);
  });

  it('invalid scannedSeconds (negative) → 0', () => {
    expect(durationTiebreak(agree, disagree, -100)).toBe(0);
  });

  it('valid scan: the agreeing candidate sorts first (negative → a first, positive swapped)', () => {
    expect(durationTiebreak(agree, disagree, SCANNED)).toBeLessThan(0);
    expect(durationTiebreak(disagree, agree, SCANNED)).toBeGreaterThan(0);
  });

  it('verified beats a missing-duration candidate (missing folds into non-verified, case 2)', () => {
    expect(durationTiebreak(agree, missing, SCANNED)).toBeLessThan(0);
    expect(durationTiebreak(missing, agree, SCANNED)).toBeGreaterThan(0);
  });

  it('verified beats a zero-duration candidate', () => {
    expect(durationTiebreak(agree, zero, SCANNED)).toBeLessThan(0);
  });

  it('both candidates agree → 0 (stable, case 3)', () => {
    const alsoAgree = makeBook({ duration: 599 }); // 35,940s, Δ4s ≤ 240 → verified
    expect(durationTiebreak(agree, alsoAgree, SCANNED)).toBe(0);
  });

  it('both candidates disagree → 0', () => {
    const alsoDisagree = makeBook({ duration: 777 }); // 46,620s → not verified
    expect(durationTiebreak(disagree, alsoDisagree, SCANNED)).toBe(0);
  });

  it('two non-verified candidates (one missing, one present-but-off) → 0 (case 4, absence never demotes)', () => {
    expect(durationTiebreak(missing, disagree, SCANNED)).toBe(0);
    expect(durationTiebreak(disagree, missing, SCANNED)).toBe(0);
  });

  it('introduces no new duration primitive: delegates entirely to isDurationVerified', () => {
    // A candidate exactly on the 240s band edge verifies via withinDurationTolerance
    // (inclusive) with no re-derived conversion in the tiebreak itself.
    const edge = makeBook({ duration: 600 }); // 36,000s vs 36,240s scanned → Δ240 ≤ 240 → verified
    const off = makeBook({ duration: 600 });
    expect(durationTiebreak(edge, makeBook({ duration: undefined }), 36_240)).toBeLessThan(0);
    expect(durationTiebreak(edge, off, 36_240)).toBe(0);
  });
});

// ============================================================================
// Duration-agreement tiebreaker in the rankers (#1882) — Dogs of War
// ============================================================================

describe('rankResults duration tiebreaker', () => {
  // Same title/author/narrators, different runtimes: text score is tied, so
  // duration must decide. Scanned 35,936s → 598min edition verifies.
  const edition568 = makeBook({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], duration: 568 });
  const edition598 = makeBook({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], duration: 598 });
  const SCANNED = 35_936;

  it('promotes the duration-agreeing (9h58m) sibling when text scores are tied', () => {
    // Provider returned the wrong 9h28m sibling first.
    const candidate: MatchCandidate = { path: '/audiobooks/Dogs of War', title: 'Dogs of War', author: 'Adrian Tchaikovsky' };
    const ranked = rankResults([edition568, edition598], candidate, SCANNED);
    expect(ranked[0]!.meta.duration).toBe(598);
  });

  it('does NOT flip a clearly better text-score winner (duration is only a tiebreaker)', () => {
    // The 568 edition has the RIGHT title, the 598 edition a clearly worse one.
    const strongText = makeBook({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], duration: 568 });
    const weakText = makeBook({ title: 'Cats of Peace', authors: [{ name: 'Adrian Tchaikovsky' }], duration: 598 });
    const candidate: MatchCandidate = { path: '/audiobooks/Dogs of War', title: 'Dogs of War', author: 'Adrian Tchaikovsky' };
    const ranked = rankResults([strongText, weakText], candidate, SCANNED);
    // Duration agrees with the weak-text candidate, but the score gap exceeds
    // the 0.001 epsilon → the stronger text match stays first.
    expect(ranked[0]!.meta.title).toBe('Dogs of War');
  });

  it('no scanned duration → order unchanged (comparator no-ops)', () => {
    const candidate: MatchCandidate = { path: '/audiobooks/Dogs of War', title: 'Dogs of War', author: 'Adrian Tchaikovsky' };
    const ranked = rankResults([edition568, edition598], candidate);
    expect(ranked[0]!.meta.duration).toBe(568);
  });

  it('no candidate durations → order unchanged', () => {
    const a = makeBook({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }] });
    const b = makeBook({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }] });
    const candidate: MatchCandidate = { path: '/audiobooks/Dogs of War', title: 'Dogs of War', author: 'Adrian Tchaikovsky' };
    const ranked = rankResults([a, b], candidate, SCANNED);
    expect(ranked[0]!.meta).toBe(a);
  });

  it('neither candidate agrees → order unchanged', () => {
    const a = makeBook({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], duration: 100 });
    const b = makeBook({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], duration: 200 });
    const candidate: MatchCandidate = { path: '/audiobooks/Dogs of War', title: 'Dogs of War', author: 'Adrian Tchaikovsky' };
    const ranked = rankResults([a, b], candidate, SCANNED);
    expect(ranked[0]!.meta).toBe(a);
  });

  it('both candidates agree → stable (input order preserved)', () => {
    const a = makeBook({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], duration: 598 });
    const b = makeBook({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], duration: 599 });
    const candidate: MatchCandidate = { path: '/audiobooks/Dogs of War', title: 'Dogs of War', author: 'Adrian Tchaikovsky' };
    const ranked = rankResults([a, b], candidate, SCANNED);
    expect(ranked[0]!.meta).toBe(a);
  });

  it('position tiebreaker runs BEFORE duration: position-matching candidate wins even if the other agrees on duration', () => {
    // #1 has a disagreeing duration; #2 agrees. Position wanted=1 must still win.
    const p1Disagree = makeBook({ title: 'Series', authors: [{ name: 'A' }], series: [{ name: 'Series', position: 1 }], duration: 568 });
    const p2Agree = makeBook({ title: 'Series', authors: [{ name: 'A' }], series: [{ name: 'Series', position: 2 }], duration: 598 });
    const candidate: MatchCandidate = { path: '/audiobooks/Series', title: 'Series', author: 'A', seriesPosition: 1 };
    const ranked = rankResults([p2Agree, p1Disagree], candidate, SCANNED);
    expect(pickPos(ranked[0]!.meta)).toBe(1);
  });

  it('position tie → duration decides, ahead of the year tiebreaker', () => {
    // Both position 1; the year-wrong candidate agrees on duration → duration wins.
    const yearWrongAgrees = makeBook({ title: 'S', authors: [{ name: 'A' }], series: [{ name: 'S', position: 1 }], publishedDate: '2008', duration: 598 });
    const yearRightDisagrees = makeBook({ title: 'S', authors: [{ name: 'A' }], series: [{ name: 'S', position: 1 }], publishedDate: '2006', duration: 568 });
    const candidate: MatchCandidate = { path: '/audiobooks/S (2006)', title: 'S', author: 'A', seriesPosition: 1 };
    const ranked = rankResults([yearRightDisagrees, yearWrongAgrees], candidate, SCANNED);
    expect(ranked[0]!.meta.duration).toBe(598);
  });
});

describe('rankResultsCleaned duration tiebreaker', () => {
  const edition568 = makeBook({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], duration: 568 });
  const edition598 = makeBook({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], duration: 598 });
  const SCANNED = 35_936;
  const tagQuery = { title: 'Dogs of War', author: 'Adrian Tchaikovsky' };

  it('promotes the duration-agreeing (9h58m) sibling when text scores are tied', () => {
    const ranked = rankResultsCleaned([edition568, edition598], tagQuery, SCANNED);
    expect(ranked[0]!.meta.duration).toBe(598);
  });

  it('does NOT flip a clearly better text-score winner', () => {
    const strongText = makeBook({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], duration: 568 });
    const weakText = makeBook({ title: 'Cats of Peace', authors: [{ name: 'Adrian Tchaikovsky' }], duration: 598 });
    const ranked = rankResultsCleaned([strongText, weakText], tagQuery, SCANNED);
    expect(ranked[0]!.meta.title).toBe('Dogs of War');
  });

  it('scannedSeconds omitted → order unchanged (backward-compatible callers)', () => {
    const ranked = rankResultsCleaned([edition568, edition598], tagQuery);
    expect(ranked[0]!.meta.duration).toBe(568);
  });

  it('zero scanned duration (tag path no-signal) → order unchanged', () => {
    const ranked = rankResultsCleaned([edition568, edition598], tagQuery, 0);
    expect(ranked[0]!.meta.duration).toBe(568);
  });

  it('position tiebreaker runs BEFORE duration', () => {
    const p1Disagree = makeBook({ title: 'Series', authors: [{ name: 'A' }], series: [{ name: 'Series', position: 1 }], duration: 568 });
    const p2Agree = makeBook({ title: 'Series', authors: [{ name: 'A' }], series: [{ name: 'Series', position: 2 }], duration: 598 });
    const ranked = rankResultsCleaned([p2Agree, p1Disagree], { title: 'Series', author: 'A', seriesPosition: 1 }, SCANNED);
    expect(pickPos(ranked[0]!.meta)).toBe(1);
  });

  it('position tie → duration decides, ahead of the year tiebreaker', () => {
    const yearWrongAgrees = makeBook({ title: 'S', authors: [{ name: 'A' }], series: [{ name: 'S', position: 1 }], publishedDate: '2008', duration: 598 });
    const yearRightDisagrees = makeBook({ title: 'S', authors: [{ name: 'A' }], series: [{ name: 'S', position: 1 }], publishedDate: '2006', duration: 568 });
    const ranked = rankResultsCleaned([yearRightDisagrees, yearWrongAgrees], { title: 'S', author: 'A', year: '2006', seriesPosition: 1 }, SCANNED);
    expect(ranked[0]!.meta.duration).toBe(598);
  });
});

// ============================================================================
// resolveConfidenceFromDuration
// ============================================================================

describe('resolveConfidenceFromDuration', () => {
  // meta.duration is MINUTES; the second arg is unrounded scanned SECONDS (#1850).
  const topMeta = makeBook({ duration: 60 }); // 60min → 3600s

  it('returns medium when scanned seconds is undefined', () => {
    const result = resolveConfidenceFromDuration([{ meta: topMeta }], undefined);
    expect(result).toEqual({ confidence: 'medium', reason: expect.stringContaining('no duration data'), reasonKind: 'no-duration-data' });
  });

  it('returns medium when scanned seconds is zero', () => {
    const result = resolveConfidenceFromDuration([{ meta: topMeta }], 0);
    expect(result.confidence).toBe('medium');
  });

  it('returns medium "cannot verify" when top result has no duration', () => {
    const noDuration = makeBook();
    const result = resolveConfidenceFromDuration([{ meta: noDuration }], 3600);
    expect(result).toEqual({ confidence: 'medium', reason: expect.stringContaining('cannot verify'), reasonKind: 'missing-duration' });
  });

  it('returns high when scanned seconds is within the 90s band', () => {
    // provider 60min → 3600s; scanned 3650s → Δ50s — inside 90s
    const result = resolveConfidenceFromDuration([{ meta: makeBook({ duration: 60 }) }], 3650);
    expect(result).toEqual({ confidence: 'high' });
  });

  it('returns medium duration mismatch when the gap exceeds the band', () => {
    // provider 60min → 3600s; scanned 3900s → Δ300s — beyond 240s
    const result = resolveConfidenceFromDuration([{ meta: makeBook({ duration: 60 }) }], 3900);
    expect(result.confidence).toBe('medium');
    expect(result.reason).toContain('Duration mismatch');
    expect(result.reasonKind).toBe('duration-mismatch');
  });

  it('does not relax on long books — a 30h book 5min off is medium, no score tier rescues it', () => {
    // provider 1800min (30h) → 108000s; scanned 108300s → Δ300s. The old relaxed
    // 15% band (≈4.5h) would have blessed this as high; the absolute 90s band does not.
    const result = resolveConfidenceFromDuration([{ meta: makeBook({ duration: 1800 }) }], 108300);
    expect(result.confidence).toBe('medium');
    expect(result.reason).toContain('Duration mismatch');
  });

  it('multi-result mismatch reason uses the shared FLOOR formatter on both sides (F1)', () => {
    // Discriminates floor from round on the SCANNED side of the line-166 reason:
    // provider 1789min → 107340s (29h 49m); scanned 107620s → Δ280s beyond 240s.
    // 107620s floors to 29h 53m (round-based formatting would render 29h 54m), so
    // this exact-string assertion fails if line 166 ever reverts to round semantics.
    const result = resolveConfidenceFromDuration([{ meta: makeBook({ duration: 1789 }) }], 107620);
    expect(result.confidence).toBe('medium');
    expect(result.reason).toBe('Duration mismatch — scanned 29h 53m vs expected 29h 49m');
  });
});

// ============================================================================
// isDurationVerified (#1266/#1850) — single absolute 90s band, no score tier
// ============================================================================

describe('isDurationVerified', () => {
  it('returns false when scanned seconds is undefined', () => {
    expect(isDurationVerified(makeBook({ duration: 60 }), undefined)).toBe(false);
  });

  it('returns false when scanned seconds is zero', () => {
    expect(isDurationVerified(makeBook({ duration: 60 }), 0)).toBe(false);
  });

  it('returns false when meta duration is missing', () => {
    expect(isDurationVerified(makeBook(), 3600)).toBe(false);
  });

  it('returns false when meta duration is zero', () => {
    expect(isDurationVerified(makeBook({ duration: 0 }), 3600)).toBe(false);
  });

  it('returns true within the 90s band', () => {
    // provider 60min → 3600s; scanned 3650s → Δ50s
    expect(isDurationVerified(makeBook({ duration: 60 }), 3650)).toBe(true);
  });

  it('returns true at exactly 240s (inclusive boundary)', () => {
    // provider 60min → 3600s; scanned 3840s → Δ240s
    expect(isDurationVerified(makeBook({ duration: 60 }), 3840)).toBe(true);
  });

  it('returns false beyond the 240s band', () => {
    // provider 60min → 3600s; scanned 3900s → Δ300s
    expect(isDurationVerified(makeBook({ duration: 60 }), 3900)).toBe(false);
  });

  it('compares in seconds — a sub-minute delta near a minute boundary verifies (no rounding inflation)', () => {
    // scanned 3650s vs provider 3600s → Δ50s verifies. Under the old rounded-minutes
    // compare, 3650s rounds to 61min and presented as an apparent 1-min delta.
    expect(isDurationVerified(makeBook({ duration: 60 }), 3650)).toBe(true);
  });

  it('does not relax for long books — a 30h book 5min off is not verified', () => {
    // provider 1800min → 108000s; scanned 108300s → Δ300s. No score gate exists to widen this.
    expect(isDurationVerified(makeBook({ duration: 1800 }), 108300)).toBe(false);
  });

  it('same-edition regression: 34.5h book Δ69s → verified', () => {
    // provider 2070min → 124200s; scanned 124269s → Δ69s (the evidence-set max)
    expect(isDurationVerified(makeBook({ duration: 2070 }), 124269)).toBe(true);
  });

  it('same-edition regression: 13.7h book Δ68s → verified', () => {
    // provider 822min → 49320s; scanned 49388s → Δ68s
    expect(isDurationVerified(makeBook({ duration: 822 }), 49388)).toBe(true);
  });
});

// ============================================================================
// resolveSingleResultConfidence (#1821/#1850) — RAW single-result contract, no cap
// ============================================================================

describe('resolveSingleResultConfidence', () => {
  it('both present + beyond 90s → medium with mismatch reason (hours from seconds/minutes)', () => {
    // scanned 33360s (9.3hrs) vs candidate 807min (13.4hrs) — the Fablehaven case
    const result = resolveSingleResultConfidence(makeBook({ duration: 807 }), 33360);
    expect(result.confidence).toBe('medium');
    expect(result.reason).toBe('Duration mismatch — scanned 9h 16m vs expected 13h 27m');
    expect(result.reasonKind).toBe('duration-mismatch');
  });

  it('both present + within 90s → high, no reason', () => {
    // provider 60min → 3600s; scanned 3650s → Δ50s
    const result = resolveSingleResultConfidence(makeBook({ duration: 60 }), 3650);
    expect(result.confidence).toBe('high');
    expect(result.reason).toBeUndefined();
    expect(result.reasonKind).toBeUndefined();
  });

  it('scanned seconds missing → high, no reason (absent data does not demote)', () => {
    const result = resolveSingleResultConfidence(makeBook({ duration: 60 }), undefined);
    expect(result.confidence).toBe('high');
    expect(result.reason).toBeUndefined();
    expect(result.reasonKind).toBeUndefined();
  });

  it('scanned seconds zero → high, no reason', () => {
    const result = resolveSingleResultConfidence(makeBook({ duration: 60 }), 0);
    expect(result.confidence).toBe('high');
    expect(result.reason).toBeUndefined();
  });

  it('candidate meta.duration missing → high, no reason', () => {
    const result = resolveSingleResultConfidence(makeBook(), 3600);
    expect(result.confidence).toBe('high');
    expect(result.reason).toBeUndefined();
  });

  it('candidate meta.duration zero → high, no reason', () => {
    const result = resolveSingleResultConfidence(makeBook({ duration: 0 }), 3600);
    expect(result.confidence).toBe('high');
    expect(result.reason).toBeUndefined();
  });

  it('beyond 90s → medium with reason (hours math)', () => {
    // provider 660min (11.0hrs) → 39600s; scanned 36000s (10.0hrs) → Δ3600s
    const result = resolveSingleResultConfidence(makeBook({ duration: 660 }), 36000);
    expect(result.confidence).toBe('medium');
    expect(result.reason).toBe('Duration mismatch — scanned 10h 0m vs expected 11h 0m');
  });

  it('mismatch reason renders h:mm via the shared floor formatter', () => {
    // provider 1789min → 107340s; scanned 107620s → Δ280s beyond 240s. Historical
    // note: at the old 90s band a flagged mismatch could render identically at
    // one-decimal hours ("29.8hrs vs 29.8hrs"); at a 240s band any mismatch is
    // ≥4min (≥0.067h) so that collision is impossible — h:mm stays for readability
    // and this test now pins the FLOOR semantic (107620s → 29h 53m; round → 29h 54m).
    const result = resolveSingleResultConfidence(makeBook({ duration: 1789 }), 107620);
    expect(result.confidence).toBe('medium');
    expect(result.reason).toBe('Duration mismatch — scanned 29h 53m vs expected 29h 49m');
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

// ============================================================================
// narratorMismatchReason (#1650/#1652) — direct units
// ============================================================================

describe('narratorMismatchReason', () => {
  it('returns null when the file narrator has no signal (absent / empty / whitespace)', () => {
    expect(narratorMismatchReason(undefined, ['Jane Doe'])).toBeNull();
    expect(narratorMismatchReason('', ['Jane Doe'])).toBeNull();
    expect(narratorMismatchReason('   ', ['Jane Doe'])).toBeNull();
  });

  it('returns null when the edition has no usable narrators (undefined / empty / blank)', () => {
    expect(narratorMismatchReason('Jane Doe', undefined)).toBeNull();
    expect(narratorMismatchReason('Jane Doe', [])).toBeNull();
    expect(narratorMismatchReason('Jane Doe', ['   '])).toBeNull();
  });

  it('returns null for punctuation-only narrators — the #1652 headline (no spurious cap)', () => {
    // Lone hyphen file tag vs lone period edition: both normalize to empty, so
    // this is "no signal", NOT a mismatch — the old looser guard capped it.
    expect(narratorMismatchReason('-', ['.'])).toBeNull();
  });

  it('returns null for a spelling variant at or above the 0.8 threshold (no cap)', () => {
    expect(narratorMismatchReason('Juliet Stevenson', ['Juliette Stevenson'])).toBeNull();
  });

  it('returns a reason string naming both sides on a genuine mismatch', () => {
    const reason = narratorMismatchReason('Jane Doe', ['John Smith']);
    expect(reason).toContain('Narrator mismatch');
    expect(reason).toContain('Jane Doe');
    expect(reason).toContain('John Smith');
  });

  // The complete #1655 UAT false-positive fixture: each was a high-confidence
  // library-import match wrongly capped to Review by tag noise. After hardening,
  // every one must return null (no reason emitted → no cap → stays high).
  describe('#1655 UAT false-positive fixture — all 8 resolve null (no cap)', () => {
    const fixture: Array<[book: string, tag: string, edition: string[]]> = [
      ['Zero Hour', 'R. C. Bray', ['R.C. Bray']],
      ["Death's End", 'Read by: P. J. Ochlan', ['P. J. Ochlan']],
      ['To Kill a Mockingbird', 'Read By Sissy Spacek', ['Sissy Spacek']],
      ["The Farseer: Assassin's Apprentice", 'Narrated by Paul Boehmer', ['Paul Boehmer']],
      ['Storm Front', 'James Marsters (Spike from Buffy The Vampire Slayer)', ['James Marsters']],
      ['Shelter Mountain', 'Therese Plummer', ['Thérèse Plummer']],
      ['Hyperion', 'Multiple Readers', ['Marc Vietor', 'Allyson Johnson', 'Kevin Pariseau', 'Jay Snyder', 'Victor Bevine']],
      ['1776', 'Author', ['David McCullough']],
    ];
    it.each(fixture)('%s — tag "%s" no longer caps', (_book, tag, edition) => {
      expect(narratorMismatchReason(tag, edition)).toBeNull();
    });
  });

  it('control: a genuinely different real narrator still returns a reason (real catch preserved)', () => {
    const reason = narratorMismatchReason('Scott Brick', ['R.C. Bray']);
    expect(reason).toContain('Narrator mismatch');
    expect(reason).toContain('Scott Brick');
    expect(reason).toContain('R.C. Bray');
  });
});

// ============================================================================
// applyNarratorCap (#1650/#1652) — direct units (with cap-log context)
// ============================================================================

describe('applyNarratorCap', () => {
  function makeCtx(overrides: Partial<NarratorCapContext> = {}): { ctx: NarratorCapContext; log: { info: ReturnType<typeof vi.fn> } } {
    const log = { info: vi.fn() };
    const ctx: NarratorCapContext = {
      log: log as unknown as FastifyBaseLogger,
      matchSource: 'filename-single',
      durationVerified: false,
      ...overrides,
    };
    return { ctx, log };
  }

  function makeResult(overrides: Partial<MatchResult> = {}): MatchResult {
    return {
      path: '/audiobooks/Book',
      confidence: 'high',
      bestMatch: makeBook({ narrators: ['Michael York'] }),
      alternatives: [],
      ...overrides,
    };
  }

  it('returns a null-bestMatch result untouched (no cap, no log)', () => {
    const { ctx, log } = makeCtx();
    const result = makeResult({ confidence: 'high', bestMatch: null });
    expect(applyNarratorCap(result, makeAudioScan({ tagNarrator: 'Adriel Brandt' }), ctx)).toBe(result);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('returns a non-high result untouched — no-op, never promotes (no log)', () => {
    const { ctx, log } = makeCtx();
    const result = makeResult({ confidence: 'medium', reason: 'Duration mismatch — ...' });
    const out = applyNarratorCap(result, makeAudioScan({ tagNarrator: 'Adriel Brandt' }), ctx);
    expect(out).toBe(result);
    expect(out.confidence).toBe('medium');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('caps high → medium with a reason on a genuine mismatch, and logs once with context', () => {
    const { ctx, log } = makeCtx({ matchSource: 'exact', durationVerified: true });
    const result = makeResult({ confidence: 'high', bestMatch: makeBook({ title: 'Brave New World', narrators: ['Michael York'], asin: 'B002V1BVK4' }) });
    const out = applyNarratorCap(result, makeAudioScan({ tagNarrator: 'Adriel Brandt' }), ctx);

    expect(out.confidence).toBe('medium');
    expect(out.reason).toContain('Narrator mismatch');
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        matchSource: 'exact',
        durationVerified: true,
        fileNarrator: 'Adriel Brandt',
        editionNarrators: ['Michael York'],
      }),
      expect.stringContaining('Narrator wrong-edition cap fired'),
    );
  });

  it('leaves a high match with a matching narrator untouched (no cap, no log)', () => {
    const { ctx, log } = makeCtx();
    const result = makeResult({ confidence: 'high', bestMatch: makeBook({ narrators: ['Michael York'] }) });
    const out = applyNarratorCap(result, makeAudioScan({ tagNarrator: 'Michael York' }), ctx);
    expect(out).toBe(result);
    expect(out.confidence).toBe('high');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('leaves a high result untouched when there is no narrator signal (no cap, no log)', () => {
    const { ctx, log } = makeCtx();
    const result = makeResult({ confidence: 'high', bestMatch: makeBook({ narrators: ['Michael York'] }) });
    const out = applyNarratorCap(result, makeAudioScan(), ctx); // no tagNarrator
    expect(out).toBe(result);
    expect(log.info).not.toHaveBeenCalled();
  });
});
