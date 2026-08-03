import { describe, it, expect } from 'vitest';
import { mergeBookData, resolveDisplayedFields } from './helpers.js';
import { bookStatusConfig } from '@/lib/status';
import { createMockBook } from '@/__tests__/factories';
import type { BookStatus, ClearableBookField } from '@shared/schemas.js';

describe('mergeBookData', () => {
  describe('status palette flow-through', () => {
    it('returns updated dot class for wanted status', () => {
      const book = createMockBook({ status: 'wanted' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.wanted!.dotClass);
    });

    it('returns updated dot class for searching status', () => {
      const book = createMockBook({ status: 'searching' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.searching!.dotClass);
    });

    it('returns updated dot class for downloading status', () => {
      const book = createMockBook({ status: 'downloading' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.downloading!.dotClass);
    });

    it('returns updated dot class for importing status', () => {
      const book = createMockBook({ status: 'importing' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.importing!.dotClass);
    });

    it('returns updated dot class for imported status', () => {
      const book = createMockBook({ status: 'imported' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.imported!.dotClass);
    });

    it('returns updated dot class for missing status', () => {
      const book = createMockBook({ status: 'missing' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.missing!.dotClass);
    });

    it('returns updated dot class for failed status', () => {
      const book = createMockBook({ status: 'failed' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.failed!.dotClass);
    });

    it('returns bar class for each status', () => {
      const book = createMockBook({ status: 'imported' });
      const result = mergeBookData(book);
      expect(result.statusBarClass).toBe(bookStatusConfig.imported!.barClass);
    });

    // #1447 (S2d) — the `?? bookStatusConfig.wanted` masking fallback was removed.
    // bookStatusConfig is now drift-guarded to set-equal BOOK_STATUSES, so every
    // canonical status resolves first-class; an off-enum value surfaces the drift
    // (throws) instead of being silently masked as "Wanted".
    it('surfaces an off-enum status instead of masking it as wanted', () => {
      const book = createMockBook({ status: 'nonexistent' as unknown as BookStatus });
      expect(() => mergeBookData(book)).toThrow(/missing entry for "nonexistent"/);
    });
  });

  describe('metaDots duration formatting', () => {
    it('includes formatted duration in metaDots from library book', () => {
      const book = createMockBook({ duration: 90 });
      const result = mergeBookData(book);
      expect(result.metaDots).toContain('1h 30m');
    });

    it('falls back to metadata duration when library book has none', () => {
      const book = createMockBook({ duration: null });
      const result = mergeBookData(book, { duration: 60 });
      expect(result.metaDots).toContain('1h');
    });

    it('excludes duration from metaDots when both sources are null', () => {
      const book = createMockBook({ duration: null });
      const result = mergeBookData(book, {});
      expect(result.metaDots.some((d: string) => /\d+[hm]/.test(d))).toBe(false);
    });
  });

  describe('metaDots publish year', () => {
    it('extracts year from a full ISO publishedDate', () => {
      const book = createMockBook({ publishedDate: '2010-08-31' });
      const result = mergeBookData(book);
      expect(result.metaDots).toContain('2010');
    });

    it('uses a bare 4-digit publishedDate as-is', () => {
      const book = createMockBook({ publishedDate: '2010' });
      const result = mergeBookData(book);
      expect(result.metaDots).toContain('2010');
    });

    it('omits year when publishedDate is null', () => {
      const book = createMockBook({ publishedDate: null });
      const result = mergeBookData(book);
      expect(result.metaDots).not.toContain('2010');
      expect(result.metaDots.some((d) => /^\d{4}$/.test(d))).toBe(false);
    });

    it('omits year when publishedDate is empty string', () => {
      const book = createMockBook({ publishedDate: '' });
      const result = mergeBookData(book);
      expect(result.metaDots.some((d) => /^\d{4}$/.test(d))).toBe(false);
    });

    it('omits year and renders no placeholder for unparseable values', () => {
      for (const value of ['invalid', '99', 'abc-de']) {
        const book = createMockBook({ publishedDate: value });
        const result = mergeBookData(book);
        expect(result.metaDots.some((d) => /^\d{4}$/.test(d))).toBe(false);
        const joined = result.metaDots.join(' · ');
        expect(joined).not.toMatch(/Unknown|NaN|Invalid Date/);
      }
    });

    it('falls back to metadataBook.publishedDate when library record is null', () => {
      const book = createMockBook({ publishedDate: null });
      const result = mergeBookData(book, { publishedDate: '2007-01-01' });
      expect(result.metaDots).toContain('2007');
    });

    it('falls back to metadataBook.publishedDate when library record is empty string', () => {
      const book = createMockBook({ publishedDate: '' });
      const result = mergeBookData(book, { publishedDate: '2007-01-01' });
      expect(result.metaDots).toContain('2007');
    });

    it('orders metaDots as series · duration · year · publisher when all are present', () => {
      const book = createMockBook({
        seriesName: 'The Stormlight Archive',
        seriesPosition: 1,
        duration: 872,
        publishedDate: '2010-08-31',
      });
      const result = mergeBookData(book, { publisher: 'Tor Books' });
      expect(result.metaDots).toEqual(['The Stormlight Archive #1', '14h 32m', '2010', 'Tor Books']);
    });

    it('orders metaDots as duration · year · publisher when no series is present', () => {
      const book = createMockBook({
        seriesName: null,
        seriesPosition: null,
        duration: 1708,
        publishedDate: '2007-06-12',
      });
      const result = mergeBookData(book, { publisher: 'Little, Brown & Company' });
      expect(result.metaDots).toEqual(['28h 28m', '2007', 'Little, Brown & Company']);
    });
  });

  // #1097 — metadata fallback prefers seriesPrimary over series[0]
  describe('canonical primary-series preference (#1097)', () => {
    it('prefers metadataBook.seriesPrimary over metadataBook.series[0] when library has no series', () => {
      const book = createMockBook({ seriesName: null, seriesPosition: null });
      const result = mergeBookData(book, {
        seriesPrimary: { name: 'The Stormlight Archive', position: 2 },
        series: [
          { name: 'Cosmere', position: 5 },
          { name: 'The Stormlight Archive', position: 2 },
        ],
      });
      expect(result.metaDots).toContain('The Stormlight Archive #2');
      expect(result.metaDots.some((d) => /Cosmere/.test(d))).toBe(false);
    });

    it('falls back to metadataBook.series[0] when seriesPrimary is absent', () => {
      const book = createMockBook({ seriesName: null, seriesPosition: null });
      const result = mergeBookData(book, {
        series: [{ name: 'Discworld', position: 9 }],
      });
      expect(result.metaDots).toContain('Discworld #9');
    });
  });

  // #1614 — subtitle/publisher are stored columns; the library row wins and the
  // provider value is only a fallback (so they survive a provider-lookup failure).
  describe('stored subtitle/publisher precedence (#1614)', () => {
    it('reads subtitle from the library book when set', () => {
      const book = createMockBook({ subtitle: 'Stored Subtitle' });
      const result = mergeBookData(book, { subtitle: 'Provider Subtitle' });
      expect(result.subtitle).toBe('Stored Subtitle');
    });

    it('falls back to the provider subtitle when the library subtitle is null', () => {
      const book = createMockBook({ subtitle: null });
      const result = mergeBookData(book, { subtitle: 'Provider Subtitle' });
      expect(result.subtitle).toBe('Provider Subtitle');
    });

    it('renders the stored subtitle even when no provider metadata is available', () => {
      const book = createMockBook({ subtitle: 'Stored Subtitle' });
      const result = mergeBookData(book, null);
      expect(result.subtitle).toBe('Stored Subtitle');
    });

    it('reads publisher from the library book when set', () => {
      const book = createMockBook({ publisher: 'Stored Publisher' });
      const result = mergeBookData(book, { publisher: 'Provider Publisher' });
      expect(result.metaDots).toContain('Stored Publisher');
      expect(result.metaDots).not.toContain('Provider Publisher');
    });

    it('falls back to the provider publisher when the library publisher is null', () => {
      const book = createMockBook({ publisher: null });
      const result = mergeBookData(book, { publisher: 'Provider Publisher' });
      expect(result.metaDots).toContain('Provider Publisher');
    });

    it('renders the stored publisher even when no provider metadata is available', () => {
      const book = createMockBook({ publisher: 'Stored Publisher' });
      const result = mergeBookData(book, null);
      expect(result.metaDots).toContain('Stored Publisher');
    });
  });
});

// ─── #2069: the operator's explicit clears suppress the provider fallback ───
describe('resolveDisplayedFields / mergeBookData — user-cleared fields (#2069)', () => {
  const providerMeta = {
    subtitle: 'Provider Subtitle',
    description: 'Provider description',
    publisher: 'Tor Books',
    publishedDate: '2010-08-31',
    genres: ['Fantasy', 'Epic'],
    seriesPrimary: { name: 'The Stormlight Archive', position: 2 },
    series: [{ name: 'Cosmere', position: 5 }],
  };

  /** A book whose stored clearable columns are all empty — provider-only display. */
  function providerOnlyBook(userClearedFields?: ClearableBookField[]) {
    return createMockBook({
      seriesName: null, seriesPosition: null, subtitle: null, description: null,
      publisher: null, publishedDate: null, genres: null,
      ...(userClearedFields ? { userClearedFields } : {}),
    });
  }

  describe('AC21 — nothing changes for a book that was never cleared', () => {
    it.each([
      ['absent', undefined],
      ['empty', [] as ClearableBookField[]],
    ])('%s userClearedFields resolves every field from the provider', (_label, cleared) => {
      const book = providerOnlyBook(cleared as ClearableBookField[] | undefined);
      const displayed = resolveDisplayedFields(book, providerMeta);

      expect(displayed).toEqual({
        seriesName: 'The Stormlight Archive',
        seriesPosition: 2,
        subtitle: 'Provider Subtitle',
        description: 'Provider description',
        publisher: 'Tor Books',
        publishedDate: '2010-08-31',
        genres: ['Fantasy', 'Epic'],
      });
      expect(mergeBookData(book, providerMeta).metaDots).toContain('The Stormlight Archive #2');
    });
  });

  describe('AC18 — a tombstone resolves to nothing, per field', () => {
    it('seriesName suppresses the header series dot AND its position (the pair rule)', () => {
      const book = providerOnlyBook(['seriesName']);
      const displayed = resolveDisplayedFields(book, providerMeta);

      expect(displayed.seriesName).toBeUndefined();
      expect(displayed.seriesPosition).toBeUndefined();

      const merged = mergeBookData(book, providerMeta);
      expect(merged.metaDots.some((d) => /Stormlight|Cosmere/.test(d))).toBe(false);
      // Untouched neighbours still render.
      expect(merged.metaDots).toContain('2010');
      expect(merged.metaDots).toContain('Tor Books');
    });

    it.each([
      ['subtitle', 'subtitle'],
      ['description', 'description'],
      ['publisher', 'publisher'],
      ['publishedDate', 'publishedDate'],
      ['genres', 'genres'],
    ] as const)('%s suppresses only its own fallback', (_label, field) => {
      const displayed = resolveDisplayedFields(providerOnlyBook([field]), providerMeta);

      expect(displayed[field]).toBeUndefined();
      // Every sibling still resolves in the same call.
      for (const other of ['subtitle', 'description', 'publisher', 'publishedDate', 'genres'] as const) {
        if (other !== field) expect(displayed[other]).toBeDefined();
      }
      expect(displayed.seriesName).toBe('The Stormlight Archive');
    });

    it('a publisher tombstone drops the publisher dot but keeps year and series', () => {
      const merged = mergeBookData(providerOnlyBook(['publisher']), providerMeta);
      expect(merged.metaDots).not.toContain('Tor Books');
      expect(merged.metaDots).toContain('2010');
      expect(merged.metaDots).toContain('The Stormlight Archive #2');
    });

    it('a publishedDate tombstone drops the year dot only', () => {
      const merged = mergeBookData(providerOnlyBook(['publishedDate']), providerMeta);
      expect(merged.metaDots).not.toContain('2010');
      expect(merged.metaDots).toContain('Tor Books');
    });

    it('description/genres/subtitle tombstones flow through mergeBookData', () => {
      const merged = mergeBookData(providerOnlyBook(['description', 'genres', 'subtitle']), providerMeta);
      expect(merged.description).toBeUndefined();
      expect(merged.genres).toBeUndefined();
      expect(merged.subtitle).toBeUndefined();
    });
  });

  describe('AC18 — the || / ?? asymmetry is preserved by construction', () => {
    it.each(['description', 'seriesName', 'publisher', 'publishedDate', 'subtitle'] as const)(
      'a stored empty string on %s still falls through to the provider value',
      (field) => {
        const book = createMockBook({
          seriesName: null, seriesPosition: null, subtitle: null, description: null,
          publisher: null, publishedDate: null, genres: null,
          [field]: '',
        });
        expect(resolveDisplayedFields(book, providerMeta)[field]).toBe(
          field === 'seriesName' ? 'The Stormlight Archive' : providerMeta[field as 'subtitle'],
        );
      },
    );

    it('a stored genres: [] OVERRIDES the provider list and does not fall through', () => {
      const book = createMockBook({ genres: [] });
      expect(resolveDisplayedFields(book, providerMeta).genres).toEqual([]);
    });

    it('seriesPosition prefers pickPrimarySeries over series[0]', () => {
      const displayed = resolveDisplayedFields(providerOnlyBook(), providerMeta);
      expect(displayed.seriesName).toBe('The Stormlight Archive');
      expect(displayed.seriesPosition).toBe(2);
    });

    it('seriesPosition resolves only when seriesName does', () => {
      const book = createMockBook({ seriesName: null, seriesPosition: 7 });
      expect(resolveDisplayedFields(book, null).seriesName).toBeUndefined();
      expect(resolveDisplayedFields(book, null).seriesPosition).toBeUndefined();
    });
  });

  it('the header and the modal baseline derive from ONE call, so they cannot disagree', () => {
    // Consistency guard: a future divergence between what the header hides and what
    // the modal pre-fills fails here rather than shipping.
    const book = providerOnlyBook(['seriesName', 'publisher']);
    const displayed = resolveDisplayedFields(book, providerMeta);
    const merged = mergeBookData(book, providerMeta);

    expect(displayed.seriesName).toBeUndefined();
    expect(merged.metaDots.some((d) => /Stormlight/.test(d))).toBe(false);
    expect(displayed.publisher).toBeUndefined();
    expect(merged.metaDots).not.toContain('Tor Books');
    expect(displayed.publishedDate).toBe('2010-08-31');
    expect(merged.metaDots).toContain('2010');
  });
});
