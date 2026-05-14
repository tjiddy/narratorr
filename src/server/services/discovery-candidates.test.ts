import { describe, it, expect, vi } from 'vitest';
import {
  toScoredCandidate,
  scoreCandidate,
  isEligibleCandidate,
  queryAuthorCandidates,
  querySeriesCandidates,
  queryGenreCandidates,
  queryNarratorCandidates,
  queryDiversityCandidates,
  type CandidateContext,
  type ScoredCandidate,
} from './discovery-candidates.js';
import type { LibrarySignals } from './discovery.service.js';
import type { BookMetadata } from '../../core/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { MetadataService } from './metadata.service.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

function makeBook(overrides: Partial<BookMetadata> = {}): BookMetadata {
  return {
    title: 'Test Book',
    authors: [{ name: 'Author One', asin: 'A001' }],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CandidateContext> = {}): CandidateContext {
  return {
    languages: ['english'],
    existingAsins: new Set<string>(),
    existingTitleAuthors: [],
    dismissedAsins: new Set<string>(),
    maxPerAuthor: 5,
    signals: { authorAffinity: new Map(), genreDistribution: new Map(), seriesGaps: [], narratorAffinity: new Map(), durationStats: null },
    warnings: [],
    multipliers: { author: 1, series: 1, genre: 1, narrator: 1, diversity: 1 },
    ...overrides,
  };
}

describe('toScoredCandidate', () => {
  it('maps book.authors[0]?.asin to authorAsin field', () => {
    const book = makeBook({ authors: [{ name: 'Joe', asin: 'ASIN123' }] });
    const result = toScoredCandidate(book, 'author', 'test', 80);
    expect(result.authorAsin).toBe('ASIN123');
    expect(result.authorName).toBe('Joe');
  });

  it('sets authorAsin to undefined when author has no ASIN', () => {
    const book = makeBook({ authors: [{ name: 'Joe' }] });
    const result = toScoredCandidate(book, 'author', 'test', 80);
    expect(result.authorAsin).toBeUndefined();
    expect(result.authorName).toBe('Joe');
  });

  it('sets authorName to Unknown and authorAsin to undefined when book has no authors', () => {
    const book = makeBook({ authors: [] });
    const result = toScoredCandidate(book, 'genre', 'test', 60);
    expect(result.authorName).toBe('Unknown');
    expect(result.authorAsin).toBeUndefined();
  });

  // #1097 — canonical primary-series preference
  it('emits seriesPrimary.name as seriesName when both seriesPrimary and a different series[0] exist', () => {
    const book = makeBook({
      seriesPrimary: { name: 'The Stormlight Archive', position: 1 },
      series: [{ name: 'The Cosmere', position: 5 }, { name: 'The Stormlight Archive', position: 1 }],
    });
    const result = toScoredCandidate(book, 'series', 'test', 80);
    expect(result.seriesName).toBe('The Stormlight Archive');
    expect(result.seriesPosition).toBe(1);
  });

  it('falls back to series[0] when seriesPrimary is absent (Audible-only candidate)', () => {
    const book = makeBook({
      series: [{ name: 'Discworld', position: 3 }],
    });
    const result = toScoredCandidate(book, 'author', 'test', 80);
    expect(result.seriesName).toBe('Discworld');
    expect(result.seriesPosition).toBe(3);
  });

  it('returns undefined series fields when both seriesPrimary and series are absent', () => {
    const book = makeBook({});
    const result = toScoredCandidate(book, 'author', 'test', 80);
    expect(result.seriesName).toBeUndefined();
    expect(result.seriesPosition).toBeUndefined();
  });
});

describe('scoreCandidate — #1097 canonical primary-series scoring', () => {
  function makeSignals(overrides: Partial<LibrarySignals> = {}): LibrarySignals {
    return {
      authorAffinity: new Map(),
      genreDistribution: new Map(),
      seriesGaps: [],
      narratorAffinity: new Map(),
      durationStats: null,
      ...overrides,
    };
  }

  it('scores against seriesPrimary when it matches the gap, even when series[0] is an unrelated universe-series', () => {
    const book = makeBook({
      asin: 'B001',
      // series[0] is the broader universe; series[1] / seriesPrimary is the real book series
      series: [{ name: 'The Cosmere', position: 5 }, { name: 'The Stormlight Archive', position: 2 }],
      seriesPrimary: { name: 'The Stormlight Archive', position: 2 },
    });
    const signals = makeSignals({
      seriesGaps: [{ seriesName: 'The Stormlight Archive', authorName: 'Sanderson', missingPositions: [2], nextPosition: 2, maxOwned: 1 }],
    });
    const score = scoreCandidate(book, 'series', 1.0, signals);
    const baseline = scoreCandidate(makeBook({ asin: 'B001' }), 'series', 1.0, signals);
    // The +20 series-gap bonus applies because seriesPrimary matched
    expect(score).toBeGreaterThanOrEqual(baseline + 20);
  });

  it('treats seriesPrimary.position === 0 as valid (not falsy-coerced)', () => {
    const book = makeBook({
      asin: 'B001',
      seriesPrimary: { name: 'Sample', position: 0 },
      series: [{ name: 'Unrelated', position: 9 }],
    });
    const signals = makeSignals({
      seriesGaps: [{ seriesName: 'Sample', authorName: 'A', missingPositions: [0], nextPosition: 0, maxOwned: 0 }],
    });
    const score = scoreCandidate(book, 'series', 1.0, signals);
    const baseline = scoreCandidate(makeBook({ asin: 'B001' }), 'series', 1.0, signals);
    expect(score).toBeGreaterThanOrEqual(baseline + 20);
  });
});

describe('querySeriesCandidates — #1099 primary-first admission + article-equivalence', () => {
  const stormlightGap = { seriesName: 'The Stormlight Archive', authorName: 'Sanderson', missingPositions: [2], nextPosition: 2, maxOwned: 1 };

  function makeSignals(gaps = [stormlightGap]): LibrarySignals {
    return { authorAffinity: new Map(), genreDistribution: new Map(), seriesGaps: gaps, narratorAffinity: new Map(), durationStats: null };
  }

  function makeDeps(books: BookMetadata[]) {
    const log = createMockLogger();
    const metadataService = inject<MetadataService>({
      searchBooksForDiscovery: vi.fn().mockResolvedValue({ books, warnings: [] }),
    });
    return { metadataService, log: inject<FastifyBaseLogger>(log) };
  }

  async function runQuery(books: BookMetadata[], gaps = [stormlightGap]) {
    const map = new Map<string, ScoredCandidate>();
    await querySeriesCandidates(makeDeps(books), makeSignals(gaps), makeCtx(), map);
    return map;
  }

  it('excludes candidate when seriesPrimary disagrees, even if a secondary series[] entry matches the gap', async () => {
    const book = makeBook({
      asin: 'B001', language: 'english',
      seriesPrimary: { name: 'The Cosmere', position: 5 },
      series: [{ name: 'The Cosmere', position: 5 }, { name: 'The Stormlight Archive', position: 2 }],
    });
    const map = await runQuery([book]);
    expect(map.has('B001')).toBe(false);
  });

  it('admits candidate when seriesPrimary matches the gap and surfaces the primary position in the reason', async () => {
    const book = makeBook({
      asin: 'B002', language: 'english',
      seriesPrimary: { name: 'The Stormlight Archive', position: 2 },
      series: [{ name: 'The Cosmere', position: 5 }, { name: 'The Stormlight Archive', position: 2 }],
    });
    const map = await runQuery([book]);
    expect(map.has('B002')).toBe(true);
    expect(map.get('B002')?.reasonContext).toContain('The Stormlight Archive');
  });

  // Deletion-proof regression guard for the reason-position source: if the reason
  // callback regressed to read from `series[]` (the pre-#1099 shape), it would
  // find the secondary at position 2, which equals `nextPosition` and renders no
  // parenthetical. Forcing the matched-primary position to a value that differs
  // from `nextPosition` makes the position observable in the rendered string.
  it("reads the matched canonical primary position (not a secondary series[] entry) into the reason text", async () => {
    const book = makeBook({
      asin: 'B009', language: 'english',
      // Primary at position 3 — in missingPositions but ≠ nextPosition, so the
      // callback should append "(position 3)" to the reason text.
      seriesPrimary: { name: 'The Stormlight Archive', position: 3 },
      // Secondary at position 2 — equal to nextPosition, so a regressed callback
      // reading the secondary would render NO parenthetical.
      series: [{ name: 'The Cosmere', position: 5 }, { name: 'The Stormlight Archive', position: 2 }],
    });
    const gap = { seriesName: 'Stormlight Archive', authorName: 'Sanderson', missingPositions: [2, 3], nextPosition: 2, maxOwned: 1 };
    const map = await runQuery([book], [gap]);
    expect(map.get('B009')?.reasonContext).toBe('Next in Stormlight Archive — you have books 1-1 (position 3)');
  });

  it('falls back to series[] when seriesPrimary is absent (Audible-only candidate)', async () => {
    const book = makeBook({
      asin: 'B003', language: 'english',
      series: [{ name: 'The Stormlight Archive', position: 2 }],
    });
    const map = await runQuery([book]);
    expect(map.has('B003')).toBe(true);
  });

  it('admits via leading-article equivalence (gap without article, primary with article)', async () => {
    const book = makeBook({
      asin: 'B004', language: 'english',
      seriesPrimary: { name: 'The Stormlight Archive', position: 2 },
    });
    const articleStrippedGap = { ...stormlightGap, seriesName: 'Stormlight Archive' };
    const map = await runQuery([book], [articleStrippedGap]);
    expect(map.has('B004')).toBe(true);
  });

  it('admits via leading-article equivalence in fallback branch (no seriesPrimary)', async () => {
    const book = makeBook({
      asin: 'B005', language: 'english',
      series: [{ name: 'The Stormlight Archive', position: 2 }],
    });
    const articleStrippedGap = { ...stormlightGap, seriesName: 'Stormlight Archive' };
    const map = await runQuery([book], [articleStrippedGap]);
    expect(map.has('B005')).toBe(true);
  });

  it('admits via punctuation normalization (Kingkiller-Chronicle vs The Kingkiller Chronicle)', async () => {
    const book = makeBook({
      asin: 'B006', language: 'english',
      seriesPrimary: { name: 'The Kingkiller Chronicle', position: 1 },
    });
    const kingkillerGap = { seriesName: 'Kingkiller-Chronicle', authorName: 'Rothfuss', missingPositions: [1], nextPosition: 1, maxOwned: 0 };
    const map = await runQuery([book], [kingkillerGap]);
    expect(map.has('B006')).toBe(true);
  });

  it('excludes a true cross-series mismatch even under loose normalization', async () => {
    const book = makeBook({
      asin: 'B007', language: 'english',
      seriesPrimary: { name: 'The Cosmere', position: 5 },
    });
    const articleStrippedGap = { ...stormlightGap, seriesName: 'Stormlight Archive' };
    const map = await runQuery([book], [articleStrippedGap]);
    expect(map.has('B007')).toBe(false);
  });
});

describe('seriesGapBonus (via scoreCandidate) — #1099 primary-first scoring', () => {
  function makeSignalsLocal(overrides: Partial<LibrarySignals> = {}): LibrarySignals {
    return {
      authorAffinity: new Map(),
      genreDistribution: new Map(),
      seriesGaps: [],
      narratorAffinity: new Map(),
      durationStats: null,
      ...overrides,
    };
  }

  it('does NOT award the bonus when seriesPrimary disagrees with the gap (secondary series[] entry would-have matched)', () => {
    const book = makeBook({
      asin: 'B001',
      seriesPrimary: { name: 'The Cosmere', position: 5 },
      series: [{ name: 'The Cosmere', position: 5 }, { name: 'The Stormlight Archive', position: 2 }],
    });
    const signals = makeSignalsLocal({
      seriesGaps: [{ seriesName: 'The Stormlight Archive', authorName: 'Sanderson', missingPositions: [2], nextPosition: 2, maxOwned: 1 }],
    });
    const score = scoreCandidate(book, 'series', 1.0, signals);
    const baseline = scoreCandidate(makeBook({ asin: 'B001' }), 'series', 1.0, signals);
    expect(score).toBeLessThan(baseline + 20);
  });

  it('awards the bonus when the gap matches seriesPrimary via leading-article equivalence', () => {
    const book = makeBook({
      asin: 'B001',
      seriesPrimary: { name: 'The Stormlight Archive', position: 2 },
    });
    const signals = makeSignalsLocal({
      seriesGaps: [{ seriesName: 'Stormlight Archive', authorName: 'Sanderson', missingPositions: [2], nextPosition: 2, maxOwned: 1 }],
    });
    const score = scoreCandidate(book, 'series', 1.0, signals);
    const baseline = scoreCandidate(makeBook({ asin: 'B001' }), 'series', 1.0, signals);
    expect(score).toBeGreaterThanOrEqual(baseline + 20);
  });

  it('awards the bonus in the fallback branch (no seriesPrimary, series[] carries the target)', () => {
    const book = makeBook({
      asin: 'B001',
      series: [{ name: 'The Stormlight Archive', position: 2 }],
    });
    const signals = makeSignalsLocal({
      seriesGaps: [{ seriesName: 'Stormlight Archive', authorName: 'Sanderson', missingPositions: [2], nextPosition: 2, maxOwned: 1 }],
    });
    const score = scoreCandidate(book, 'series', 1.0, signals);
    const baseline = scoreCandidate(makeBook({ asin: 'B001' }), 'series', 1.0, signals);
    expect(score).toBeGreaterThanOrEqual(baseline + 20);
  });

  it('does NOT award the bonus when a secondary series[] entry matches the gap but seriesPrimary disagrees', () => {
    const book = makeBook({
      asin: 'B001',
      seriesPrimary: { name: 'The Cosmere', position: 5 },
      series: [{ name: 'The Cosmere', position: 5 }, { name: 'The Stormlight Archive', position: 2 }],
    });
    const signals = makeSignalsLocal({
      seriesGaps: [{ seriesName: 'Stormlight Archive', authorName: 'Sanderson', missingPositions: [2], nextPosition: 2, maxOwned: 1 }],
    });
    const score = scoreCandidate(book, 'series', 1.0, signals);
    const baseline = scoreCandidate(makeBook({ asin: 'B001' }), 'series', 1.0, signals);
    expect(score).toBeLessThan(baseline + 20);
  });
});

describe('isEligibleCandidate — language filtering', () => {
  it('accepts book whose language matches one of configured languages', () => {
    const book = makeBook({ asin: 'B001', language: 'english' });
    const ctx = makeCtx({ languages: ['english', 'french'] });
    expect(isEligibleCandidate(book, ctx)).toBe(true);
  });

  it('rejects book whose language matches none of configured languages', () => {
    const book = makeBook({ asin: 'B001', language: 'german' });
    const ctx = makeCtx({ languages: ['english', 'french'] });
    expect(isEligibleCandidate(book, ctx)).toBe(false);
  });

  it('rejects book with null language even when languages are configured', () => {
    const book = makeBook({ asin: 'B001' });
    const ctx = makeCtx({ languages: ['english'] });
    expect(isEligibleCandidate(book, ctx)).toBe(false);
  });

  it('accepts any book with a language when languages array is empty (no filtering)', () => {
    const book = makeBook({ asin: 'B001', language: 'japanese' });
    const ctx = makeCtx({ languages: [] });
    expect(isEligibleCandidate(book, ctx)).toBe(true);
  });

  it('rejects book with null language when languages array is empty', () => {
    const book = makeBook({ asin: 'B001' });
    const ctx = makeCtx({ languages: [] });
    expect(isEligibleCandidate(book, ctx)).toBe(false);
  });

  it('performs case-insensitive language comparison', () => {
    const book = makeBook({ asin: 'B001', language: 'English' });
    const ctx = makeCtx({ languages: ['english'] });
    expect(isEligibleCandidate(book, ctx)).toBe(true);
  });
});

describe('provider-failure warning shape', () => {
  function makeDeps(rejectWith: Error) {
    const log = createMockLogger();
    const metadataService = inject<MetadataService>({
      searchBooksForDiscovery: vi.fn().mockRejectedValue(rejectWith),
    });
    return { deps: { metadataService, log: inject<FastifyBaseLogger>(log) }, log };
  }

  it('queryAuthorCandidates logs canonical serialized warning when provider fails', async () => {
    const { deps, log } = makeDeps(new Error('author provider down'));
    const signals = {
      authorAffinity: new Map([['Sanderson', { name: 'Sanderson', count: 3, strength: 0.6 }]]),
      genreDistribution: new Map(),
      seriesGaps: [],
      narratorAffinity: new Map(),
      durationStats: null,
    };
    await queryAuthorCandidates(deps, signals, makeCtx(), new Map<string, ScoredCandidate>());
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'author provider down', type: 'Error' }) }),
      'Discovery: author query failed for Sanderson',
    );
  });

  it('querySeriesCandidates logs canonical serialized warning when provider fails', async () => {
    const { deps, log } = makeDeps(new Error('series provider down'));
    const signals = {
      authorAffinity: new Map(),
      genreDistribution: new Map(),
      seriesGaps: [{ seriesName: 'Stormlight', authorName: 'Sanderson', missingPositions: [2], nextPosition: 2, maxOwned: 1 }],
      narratorAffinity: new Map(),
      durationStats: null,
    };
    await querySeriesCandidates(deps, signals, makeCtx(), new Map<string, ScoredCandidate>());
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'series provider down', type: 'Error' }) }),
      'Discovery: series query failed for Stormlight',
    );
  });

  it('queryGenreCandidates logs canonical serialized warning when provider fails', async () => {
    const { deps, log } = makeDeps(new Error('genre provider down'));
    const signals = {
      authorAffinity: new Map(),
      genreDistribution: new Map([['Fantasy', 10]]),
      seriesGaps: [],
      narratorAffinity: new Map(),
      durationStats: null,
    };
    await queryGenreCandidates(deps, signals, makeCtx(), new Map<string, ScoredCandidate>());
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'genre provider down', type: 'Error' }) }),
      'Discovery: genre query failed for Fantasy',
    );
  });

  it('queryNarratorCandidates logs canonical serialized warning when provider fails', async () => {
    const { deps, log } = makeDeps(new Error('narrator provider down'));
    const signals = {
      authorAffinity: new Map(),
      genreDistribution: new Map(),
      seriesGaps: [],
      narratorAffinity: new Map([['Kramer', 4]]),
      durationStats: null,
    };
    await queryNarratorCandidates(deps, signals, makeCtx(), new Map<string, ScoredCandidate>());
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'narrator provider down', type: 'Error' }) }),
      'Discovery: narrator query failed for Kramer',
    );
  });

  it('queryDiversityCandidates logs canonical serialized warning when provider fails', async () => {
    const { deps, log } = makeDeps(new Error('diversity provider down'));
    const signals = {
      authorAffinity: new Map(),
      genreDistribution: new Map(),
      seriesGaps: [],
      narratorAffinity: new Map(),
      durationStats: null,
    };
    await queryDiversityCandidates(deps, signals, makeCtx());
    expect(log.warn).toHaveBeenCalled();
    const call = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) =>
      typeof c[1] === 'string' && c[1].startsWith('Discovery: diversity query failed for '),
    );
    expect(call).toBeDefined();
    expect(call![0]).toEqual(expect.objectContaining({
      error: expect.objectContaining({ message: 'diversity provider down', type: 'Error' }),
    }));
  });
});
