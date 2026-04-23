import { describe, it, expect, vi } from 'vitest';
import {
  toScoredCandidate,
  isEligibleCandidate,
  queryAuthorCandidates,
  querySeriesCandidates,
  queryGenreCandidates,
  queryNarratorCandidates,
  queryDiversityCandidates,
  type CandidateContext,
  type ScoredCandidate,
} from './discovery-candidates.js';
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
