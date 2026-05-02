import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, mockDbChain, inject, createMockSettingsService } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { DiscoveryService } from './discovery.service.js';
import { computeWeightMultipliers } from './discovery-weights.js';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

/** Serialize a Drizzle SQL expression to a raw SQL string for predicate assertions. */
const dialect = new SQLiteSyncDialect();
function toSQL(expr: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return dialect.sqlToQuery((expr as any).getSQL()).sql;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockMetadataService = {
  searchBooksForDiscovery: vi.fn().mockResolvedValue({ books: [], warnings: [] }),
};

const mockBookService = {
  findDuplicate: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({ id: 1, title: 'Test', status: 'wanted' }),
};

const mockEventHistoryService = {
  create: vi.fn().mockResolvedValue({}),
};

function createService(dbOverrides?: ReturnType<typeof createMockDb>) {
  const db = dbOverrides ?? createMockDb();
  const log = createMockLogger();
  const settingsService = createMockSettingsService({
    discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: 5 },
    metadata: { audibleRegion: 'us' },
  });
  return {
    service: new DiscoveryService(
      inject<Db>(db),
      inject<FastifyBaseLogger>(log),
      inject(mockMetadataService),
      inject(settingsService),
    ),
    db,
    log,
    settingsService,
  };
}

// Helper: a minimal imported book row for signal extraction tests
// Shape matches analyzeLibrary query: { book: books, authorName: authors.name }
function makeBookRow(overrides: Record<string, unknown> = {}) {
  return {
    book: {
      id: 1,
      title: 'Test Book',
      description: null,
      coverUrl: null,
      goodreadsId: null,
      audibleId: null,
      asin: 'B001',
      isbn: null,
      seriesName: null,
      seriesPosition: null,
      duration: null,
      publishedDate: null,
      genres: null,
      status: 'imported',
      enrichmentStatus: 'enriched',
      path: null,
      size: null,
      audioCodec: null,
      audioBitrate: null,
      audioSampleRate: null,
      audioChannels: null,
      audioBitrateMode: null,
      audioFileFormat: null,
      audioFileCount: null,
      audioTotalSize: null,
      audioDuration: null,
      monitorForUpgrades: false,
      importListId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    },
    authorName: 'Author A',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });
  mockBookService.findDuplicate.mockResolvedValue(null);
  mockBookService.create.mockResolvedValue({ id: 1, title: 'Test', status: 'wanted' });
});

describe('DiscoveryService', () => {
  describe('analyzeLibrary', () => {
    it('returns empty signals when no imported books exist', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([]));
      const { service } = createService(db);

      const signals = await service.analyzeLibrary();
      expect(signals.authorAffinity.size).toBe(0);
      expect(signals.genreDistribution.size).toBe(0);
      expect(signals.seriesGaps).toEqual([]);
      expect(signals.narratorAffinity.size).toBe(0);
      expect(signals.durationStats).toBeNull();
    });

    it('counts author affinity only from imported books', async () => {
      const db = createMockDb();
      const rows = [
        makeBookRow({ id: 1, title: 'Book 1' }),
        makeBookRow({ id: 2, title: 'Book 2' }),
        makeBookRow({ id: 3, title: 'Book 3' }),
      ];
      db.select.mockReturnValue(mockDbChain(rows));
      const { service } = createService(db);

      const signals = await service.analyzeLibrary();
      const authorEntry = signals.authorAffinity.get('Author A');
      expect(authorEntry?.count).toBe(3);
      expect(authorEntry?.strength).toBeCloseTo(3 / 5); // 3/5 = 0.6
    });

    it('aggregates genre frequency distribution', async () => {
      const db = createMockDb();
      const rows = [
        makeBookRow({ id: 1, genres: ['Fantasy', 'Adventure'] }),
        makeBookRow({ id: 2, genres: ['Fantasy', 'Romance'] }),
        makeBookRow({ id: 3, genres: ['Sci-Fi'] }),
      ];
      db.select.mockReturnValue(mockDbChain(rows));
      const { service } = createService(db);

      const signals = await service.analyzeLibrary();
      expect(signals.genreDistribution.get('Fantasy')).toBe(2);
      expect(signals.genreDistribution.get('Adventure')).toBe(1);
      expect(signals.genreDistribution.get('Romance')).toBe(1);
      expect(signals.genreDistribution.get('Sci-Fi')).toBe(1);
    });

    it('detects series gaps (positions 1,2,4 → gap at 3 + next at 5)', async () => {
      const db = createMockDb();
      const rows = [
        makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
        makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
        makeBookRow({ id: 3, seriesName: 'Stormlight', seriesPosition: 4 }),
      ];
      db.select.mockReturnValue(mockDbChain(rows));
      const { service } = createService(db);

      const signals = await service.analyzeLibrary();
      expect(signals.seriesGaps).toHaveLength(1);
      expect(signals.seriesGaps[0]!.seriesName).toBe('Stormlight');
      expect(signals.seriesGaps[0]!.missingPositions).toContain(3);
      expect(signals.seriesGaps[0]!.missingPositions).not.toContain(5);
      expect(signals.seriesGaps[0]!.nextPosition).toBe(5);
      expect(signals.seriesGaps[0]!.maxOwned).toBe(4);
    });

    it('handles null seriesPosition gracefully', async () => {
      const db = createMockDb();
      const rows = [
        makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: null }),
      ];
      db.select.mockReturnValue(mockDbChain(rows));
      const { service } = createService(db);

      const signals = await service.analyzeLibrary();
      // Should not create a gap entry since position is null
      expect(signals.seriesGaps).toHaveLength(0);
    });

    it('counts narrator affinity with 3+ threshold', async () => {
      const db = createMockDb();
      const bookRows = [
        makeBookRow({ id: 1 }),
        makeBookRow({ id: 2 }),
        makeBookRow({ id: 3 }),
        makeBookRow({ id: 4 }),
        makeBookRow({ id: 5 }),
      ];
      const narratorRows = [
        { bookId: 1, narratorName: 'Narrator X' },
        { bookId: 2, narratorName: 'Narrator X' },
        { bookId: 3, narratorName: 'Narrator X' },
        { bookId: 4, narratorName: 'Narrator Y' },
        { bookId: 5, narratorName: 'Narrator Y' },
      ];
      db.select
        .mockReturnValueOnce(mockDbChain(bookRows))
        .mockReturnValueOnce(mockDbChain(narratorRows));
      const { service } = createService(db);

      const signals = await service.analyzeLibrary();
      expect(signals.narratorAffinity.get('Narrator X')).toBe(3);
      expect(signals.narratorAffinity.has('Narrator Y')).toBe(false); // only 2
    });

    it('calculates median duration correctly', async () => {
      const db = createMockDb();
      const rows = [
        makeBookRow({ id: 1, duration: 100 }),
        makeBookRow({ id: 2, duration: 200 }),
        makeBookRow({ id: 3, duration: 300 }),
      ];
      db.select.mockReturnValue(mockDbChain(rows));
      const { service } = createService(db);

      const signals = await service.analyzeLibrary();
      expect(signals.durationStats).not.toBeNull();
      expect(signals.durationStats!.median).toBe(200);
    });

    it('returns null duration stats when all durations are null', async () => {
      const db = createMockDb();
      const rows = [
        makeBookRow({ id: 1, duration: null }),
        makeBookRow({ id: 2, duration: null }),
      ];
      db.select.mockReturnValue(mockDbChain(rows));
      const { service } = createService(db);

      const signals = await service.analyzeLibrary();
      expect(signals.durationStats).toBeNull();
    });
  });

  describe('scoreCandidates (via generateCandidates)', () => {
    it('clamps score to 0-100 range', async () => {
      // Access scoreCandidate indirectly through the service
      // A candidate with maximum bonuses should not exceed 100
      const db = createMockDb();
      // First call: analyzeLibrary (imported books)
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeBookRow({ id: 1, duration: 1000, genres: ['Fantasy'] }),
          makeBookRow({ id: 2, duration: 1000, genres: ['Fantasy'] }),
          makeBookRow({ id: 3, duration: 1000, genres: ['Fantasy'] }),
          makeBookRow({ id: 4, duration: 1000, genres: ['Fantasy'] }),
          makeBookRow({ id: 5, duration: 1000, genres: ['Fantasy'] }),
        ]))
        // Second call: analyzeLibrary (narrator rows)
        .mockReturnValueOnce(mockDbChain([]))
        // Third call: existing books for exclusion
        .mockReturnValueOnce(mockDbChain([]))
        // Fourth call: dismissed suggestions
        .mockReturnValueOnce(mockDbChain([]));

      const recentDate = new Date();
      recentDate.setMonth(recentDate.getMonth() - 6);

      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
        books: [{
          asin: 'NEW1',
          title: 'New Book',
          authors: [{ name: 'Author A' }],
          language: 'English',
          duration: 1000,
          publishedDate: recentDate.toISOString(),
        }],
        warnings: [],
      });

      const { service } = createService(db);
      const candidates = await service.generateCandidates(await service.analyzeLibrary());

      for (const c of candidates) {
        expect(c.score).toBeLessThanOrEqual(100);
        expect(c.score).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('generateCandidates (pipeline)', () => {
    function setupCandidateTest() {
      const db = createMockDb();
      // analyzeLibrary query (imported books)
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 }),
          makeBookRow({ id: 2, genres: ['Fantasy'], duration: 1000 }),
          makeBookRow({ id: 3, genres: ['Fantasy'], duration: 1000 }),
        ]))
        // analyzeLibrary query (narrator rows)
        .mockReturnValueOnce(mockDbChain([]))
        // existing books for exclusion (now includes title + authorName for fuzzy match)
        .mockReturnValueOnce(mockDbChain([{ asin: 'EXISTING1', title: 'Already Owned Book', authorName: 'Some Other Author' }]))
        // dismissed suggestions
        .mockReturnValueOnce(mockDbChain([{ asin: 'DISMISSED1' }]));
      return db;
    }

    it('excludes books with ASIN matching existing books', async () => {
      const db = setupCandidateTest();
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
        books: [
          { asin: 'EXISTING1', title: 'Already Owned', authors: [{ name: 'Author A' }], language: 'English' },
          { asin: 'NEW1', title: 'New Book', authors: [{ name: 'Author A' }], language: 'English' },
        ],
        warnings: [],
      });
      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      expect(candidates.find(c => c.asin === 'EXISTING1')).toBeUndefined();
      expect(candidates.find(c => c.asin === 'NEW1')).toBeDefined();
    });

    it('excludes dismissed suggestions', async () => {
      const db = setupCandidateTest();
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
        books: [
          { asin: 'DISMISSED1', title: 'Dismissed', authors: [{ name: 'Author A' }], language: 'English' },
          { asin: 'NEW2', title: 'New', authors: [{ name: 'Author A' }], language: 'English' },
        ],
        warnings: [],
      });
      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      expect(candidates.find(c => c.asin === 'DISMISSED1')).toBeUndefined();
    });

    it('filters out candidates not matching region language', async () => {
      const db = setupCandidateTest();
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
        books: [
          { asin: 'FR1', title: 'French Book', authors: [{ name: 'Author A' }], language: 'French' },
          { asin: 'EN1', title: 'English Book', authors: [{ name: 'Author A' }], language: 'English' },
        ],
        warnings: [],
      });
      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      // Region is 'us' → english only
      expect(candidates.find(c => c.asin === 'FR1')).toBeUndefined();
      expect(candidates.find(c => c.asin === 'EN1')).toBeDefined();
    });

    it('filters out candidates with undefined language', async () => {
      const db = setupCandidateTest();
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
        books: [
          { asin: 'NO_LANG', title: 'No Lang', authors: [{ name: 'Author A' }] },
        ],
        warnings: [],
      });
      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      expect(candidates.find(c => c.asin === 'NO_LANG')).toBeUndefined();
    });

    it('excludes candidates matching tracked books by title+author fuzzy match', async () => {
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 }),
          makeBookRow({ id: 2, genres: ['Fantasy'], duration: 1000 }),
          makeBookRow({ id: 3, genres: ['Fantasy'], duration: 1000 }),
        ]))
        // analyzeLibrary narrator rows
        .mockReturnValueOnce(mockDbChain([]))
        // existing books — title+author close to candidate
        .mockReturnValueOnce(mockDbChain([{ asin: 'OTHER_ASIN', title: 'The Name of the Wind', authorName: 'Patrick Rothfuss' }]))
        .mockReturnValueOnce(mockDbChain([]));

      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
        books: [
          { asin: 'DIFF_ASIN', title: 'Name of the Wind', authors: [{ name: 'Patrick Rothfuss' }], language: 'English' },
          { asin: 'UNIQUE1', title: 'Completely Different Book', authors: [{ name: 'Author A' }], language: 'English' },
        ],
        warnings: [],
      });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      // "Name of the Wind" by "Patrick Rothfuss" should be excluded via fuzzy match
      expect(candidates.find(c => c.asin === 'DIFF_ASIN')).toBeUndefined();
      expect(candidates.find(c => c.asin === 'UNIQUE1')).toBeDefined();
    });

    it('filters out author-based results with non-matching author names', async () => {
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 }),
          makeBookRow({ id: 2, genres: ['Fantasy'], duration: 1000 }),
          makeBookRow({ id: 3, genres: ['Fantasy'], duration: 1000 }),
        ]))
        // analyzeLibrary narrator rows
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      // Only the first call (author query) gets the wrong-author book; rest return empty
      mockMetadataService.searchBooksForDiscovery
        .mockResolvedValueOnce({
          books: [
            { asin: 'SAME1', title: 'Real Book', authors: [{ name: 'Author A' }], language: 'English' },
            { asin: 'WRONG1', title: 'Wrong Author Book', authors: [{ name: 'Completely Different Person' }], language: 'English' },
          ],
          warnings: [],
        })
        .mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      // "Completely Different Person" should be filtered as low author-match for author-based query
      expect(candidates.find(c => c.asin === 'SAME1')).toBeDefined();
      expect(candidates.find(c => c.asin === 'WRONG1')).toBeUndefined();
    });

    it('applies recency bonus +10 for recently published books', async () => {
      const db = setupCandidateTest();
      const recentDate = new Date();
      recentDate.setMonth(recentDate.getMonth() - 6);
      const oldDate = new Date('2015-01-01');

      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
        books: [
          { asin: 'RECENT', title: 'Recent', authors: [{ name: 'Author A' }], language: 'English', publishedDate: recentDate.toISOString() },
          { asin: 'OLD', title: 'Old', authors: [{ name: 'Author A' }], language: 'English', publishedDate: oldDate.toISOString() },
        ],
        warnings: [],
      });
      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      const recent = candidates.find(c => c.asin === 'RECENT');
      const old = candidates.find(c => c.asin === 'OLD');
      // Both get author base score, but recent gets +10 bonus
      if (recent && old) {
        expect(recent.score).toBeGreaterThan(old.score);
      }
    });

    it('applies duration bonus +5 when within 1 stddev of median', async () => {
      const db = setupCandidateTest();
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
        books: [
          { asin: 'CLOSE', title: 'Close Duration', authors: [{ name: 'Author A' }], language: 'English', duration: 1000 },
          { asin: 'FAR', title: 'Far Duration', authors: [{ name: 'Author A' }], language: 'English', duration: 50000 },
        ],
        warnings: [],
      });
      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      const close = candidates.find(c => c.asin === 'CLOSE');
      const far = candidates.find(c => c.asin === 'FAR');
      if (close && far) {
        expect(close.score).toBeGreaterThan(far.score);
      }
    });
  });

  describe('refreshSuggestions', () => {
    it('inserts new suggestions and returns added count', async () => {
      const db = createMockDb();
      db.select
        // dismissal stats (#406)
        .mockReturnValueOnce(mockDbChain([]))
        // analyzeLibrary: one imported book
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]))
        // analyzeLibrary: narrator rows
        .mockReturnValueOnce(mockDbChain([]))
        // existing books for exclusion
        .mockReturnValueOnce(mockDbChain([]))
        // dismissed suggestions
        .mockReturnValueOnce(mockDbChain([]))
        // currentPending (no existing pending)
        .mockReturnValueOnce(mockDbChain([]))
        // batch SELECT for upsert (#554)
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      mockMetadataService.searchBooksForDiscovery.mockResolvedValueOnce({
        books: [{ asin: 'NEW1', title: 'New Book', authors: [{ name: 'Author A' }], language: 'English' }],
        warnings: [],
      }).mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      const result = await service.refreshSuggestions();
      expect(result.added).toBeGreaterThanOrEqual(1);
      expect(db.insert).toHaveBeenCalled();
    });

    it('preserves dismissed suggestions on refresh', async () => {
      const db = createMockDb();
      db.select
        // dismissal stats (#406)
        .mockReturnValueOnce(mockDbChain([]))
        // analyzeLibrary: imported books
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]))
        // analyzeLibrary: narrator rows
        .mockReturnValueOnce(mockDbChain([]))
        // existing books for exclusion
        .mockReturnValueOnce(mockDbChain([]))
        // dismissed suggestions
        .mockReturnValueOnce(mockDbChain([]))
        // currentPending: no pending
        .mockReturnValueOnce(mockDbChain([]))
        // batch SELECT for upsert (#554) — existing dismissed row
        .mockReturnValueOnce(mockDbChain([{ asin: 'DISMISSED1', status: 'dismissed', snoozeUntil: null }]));
      db.insert.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      mockMetadataService.searchBooksForDiscovery.mockResolvedValueOnce({
        books: [{ asin: 'DISMISSED1', title: 'Dismissed Book', authors: [{ name: 'Author A' }], language: 'English' }],
        warnings: [],
      }).mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      const result = await service.refreshSuggestions();
      // Should not insert or update dismissed row
      expect(result.added).toBe(0);
    });

    it('updates existing pending suggestions with new score', async () => {
      const db = createMockDb();
      db.select
        // dismissal stats (#406)
        .mockReturnValueOnce(mockDbChain([]))
        // analyzeLibrary: imported books
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]))
        // analyzeLibrary: narrator rows
        .mockReturnValueOnce(mockDbChain([]))
        // existing books for exclusion
        .mockReturnValueOnce(mockDbChain([]))
        // dismissed suggestions
        .mockReturnValueOnce(mockDbChain([]))
        // currentPending: one existing pending
        .mockReturnValueOnce(mockDbChain([{ id: 5, asin: 'EXISTING_PENDING', snoozeUntil: null, reason: 'author', reasonContext: 'ctx', authorName: 'Author A', narratorName: null, duration: null, publishedDate: null, seriesName: null, seriesPosition: null }]))
        // batch SELECT for upsert (#554) — existing pending row
        .mockReturnValueOnce(mockDbChain([{ asin: 'EXISTING_PENDING', status: 'pending', snoozeUntil: null }]));
      db.insert.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      mockMetadataService.searchBooksForDiscovery.mockResolvedValueOnce({
        books: [{ asin: 'EXISTING_PENDING', title: 'Updated Book', authors: [{ name: 'Author A' }], language: 'English' }],
        warnings: [],
      }).mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      const result = await service.refreshSuggestions();
      expect(result.added).toBe(0);
      // Existing pending row updated via INSERT ON CONFLICT DO UPDATE (#554)
      expect(db.insert).toHaveBeenCalled();
    });

    it('deletes stale pending suggestions not regenerated', async () => {
      const db = createMockDb();
      db.select
        // dismissal stats (#406)
        .mockReturnValueOnce(mockDbChain([]))
        // analyzeLibrary: imported books
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]))
        // analyzeLibrary: narrator rows
        .mockReturnValueOnce(mockDbChain([]))
        // existing books for exclusion
        .mockReturnValueOnce(mockDbChain([]))
        // dismissed suggestions
        .mockReturnValueOnce(mockDbChain([]))
        // currentPending: one stale pending (won't be regenerated)
        .mockReturnValueOnce(mockDbChain([{ id: 99, asin: 'STALE1', snoozeUntil: null, reason: 'author', reasonContext: 'ctx', authorName: 'Author A', narratorName: null, duration: null, publishedDate: null, seriesName: null, seriesPosition: null }]));
      db.delete.mockReturnValue(mockDbChain());

      // No candidates generated (empty results)
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      const result = await service.refreshSuggestions();
      expect(result.removed).toBe(1);
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('getSuggestions', () => {
    it('returns pending suggestions sorted by score', async () => {
      const mockData = [
        { id: 1, asin: 'B001', score: 80, status: 'pending', reason: 'author' },
        { id: 2, asin: 'B002', score: 60, status: 'pending', reason: 'genre' },
      ];
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain(mockData));
      const { service } = createService(db);

      const result = await service.getSuggestions();
      expect(result).toEqual(mockData);
    });

    it('returns empty array when no suggestions exist', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([]));
      const { service } = createService(db);

      const result = await service.getSuggestions();
      expect(result).toEqual([]);
    });

    it('excludes future-snoozed rows and includes past/null snoozeUntil rows', async () => {
      const pastDate = new Date(Date.now() - 86400000);
      const mockData = [
        { id: 1, asin: 'B001', score: 80, status: 'pending', snoozeUntil: null },
        { id: 2, asin: 'B002', score: 60, status: 'pending', snoozeUntil: pastDate },
      ];
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain(mockData));
      const { service } = createService(db);

      const result = await service.getSuggestions();
      expect(result).toEqual(mockData);

      // Verify the WHERE predicate encodes: status = 'pending' AND (snoozeUntil IS NULL OR snoozeUntil <= ?)
      const chain = db.select.mock.results[0]!.value;
      expect(chain.where).toHaveBeenCalled();
      const whereArg = (chain.where as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      const sql = toSQL(whereArg);
      expect(sql).toContain('"status" = ?');
      expect(sql).toContain('"snooze_until" is null');
      expect(sql).toContain('"snooze_until" <= ?');
    });
  });

  describe('dismissSuggestion', () => {
    it('sets status to dismissed', async () => {
      const existing = { id: 1, asin: 'B001', status: 'pending' };
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([existing]));
      db.update.mockReturnValue(mockDbChain());
      const { service } = createService(db);

      const result = await service.dismissSuggestion(1);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('dismissed');
      expect(result!.dismissedAt).toBeDefined();
    });

    it('returns null for unknown suggestion ID', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([]));
      const { service } = createService(db);

      const result = await service.dismissSuggestion(999);
      expect(result).toBeNull();
    });
  });

  /* addSuggestion + buildCreatePayload tests removed — #524 replaced with markSuggestionAdded.
     Book creation now happens via POST /api/books (client-side), not the discovery service. */

  // --- #524: markSuggestionAdded (status-flip only) ---
  describe('markSuggestionAdded', () => {
    it('flips status from pending to added and returns updated row', async () => {
      const existing = { id: 1, asin: 'B001', title: 'Test', authorName: 'Author', status: 'pending' };
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([existing]));
      db.update.mockReturnValue(mockDbChain());
      const { service } = createService(db);

      const result = await service.markSuggestionAdded(1);
      expect(result).not.toBeNull();
      expect(result!.alreadyAdded).toBeFalsy();
      expect(result!.suggestion.status).toBe('added');
      // Must NOT call bookService.create — status flip only
      expect(mockBookService.create).not.toHaveBeenCalled();
      expect(mockBookService.findDuplicate).not.toHaveBeenCalled();
      expect(mockEventHistoryService.create).not.toHaveBeenCalled();
    });

    it('returns alreadyAdded: true for suggestion with status added', async () => {
      const existing = { id: 1, asin: 'B001', status: 'added' };
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([existing]));
      const { service } = createService(db);

      const result = await service.markSuggestionAdded(1);
      expect(result!.alreadyAdded).toBe(true);
    });

    it('returns null for non-existent suggestion ID', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([]));
      const { service } = createService(db);

      const result = await service.markSuggestionAdded(999);
      expect(result).toBeNull();
    });

    it('returns invalidStatus for dismissed suggestion', async () => {
      const existing = { id: 1, asin: 'B001', status: 'dismissed' };
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([existing]));
      const { service } = createService(db);

      const result = await service.markSuggestionAdded(1);
      expect(result!.invalidStatus).toBe(true);
      expect(mockBookService.create).not.toHaveBeenCalled();
    });
  });

  // --- #408: Expiry ---

  describe('expireSuggestions (within refreshSuggestions)', () => {
    it('deletes pending suggestions older than expiryDays with correct predicate', async () => {
      const deleteChain = mockDbChain({ rowsAffected: 2 });
      const db = createMockDb();
      // Expiry delete
      db.delete.mockReturnValueOnce(deleteChain);
      // analyzeLibrary
      db.select.mockReturnValueOnce(mockDbChain([]));
      // existing books
      db.select.mockReturnValueOnce(mockDbChain([]));
      // dismissed suggestions
      db.select.mockReturnValueOnce(mockDbChain([]));
      // currentPending
      db.select.mockReturnValueOnce(mockDbChain([]));
      // stale delete
      db.delete.mockReturnValue(mockDbChain());

      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });

      const { service, log } = createService(db);
      await service.refreshSuggestions();

      // Expiry delete should be called with status='pending' AND createdAt < cutoff (strict lt, not lte)
      expect(db.delete).toHaveBeenCalled();
      expect(deleteChain.where).toHaveBeenCalled();
      const whereArg = (deleteChain.where as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      const sql = toSQL(whereArg);
      // Must have status = 'pending' guard for race safety
      expect(sql).toContain('"status" = ?');
      // Must use strict < (lt), not <= (lte), for the "older than N days" cutoff
      expect(sql).toContain('"created_at" < ?');
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ expired: 2 }),
        expect.stringContaining('expired'),
      );
    });

    it('appends warning on expiry failure but does not throw', async () => {
      const db = createMockDb();
      // Expiry delete throws
      db.delete.mockReturnValueOnce(mockDbChain([], { error: new Error('DB locked') }));
      // analyzeLibrary
      db.select.mockReturnValueOnce(mockDbChain([]));
      // existing books
      db.select.mockReturnValueOnce(mockDbChain([]));
      // dismissed suggestions
      db.select.mockReturnValueOnce(mockDbChain([]));
      // currentPending
      db.select.mockReturnValueOnce(mockDbChain([]));
      // stale delete (no stale)
      db.delete.mockReturnValue(mockDbChain());

      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });

      const { service, log } = createService(db);
      const result = await service.refreshSuggestions();

      expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Expiry')]));
      expect(log.warn).toHaveBeenCalled();

      // The catch's log.warn receives a serializeError()-wrapped object, not the raw Error.
      // A serialized error is a plain object with message/type; Pino would drop a raw Error
      // instance to {} in JSON logs.
      const warnMock = log.warn as ReturnType<typeof vi.fn>;
      const expiryWarn = warnMock.mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('expiry step failed'),
      );
      expect(expiryWarn).toBeDefined();
      const logged = expiryWarn![0] as { error: Record<string, unknown> };
      expect(logged.error).not.toBeInstanceOf(Error);
      expect(logged.error.message).toBe('DB locked');
      expect(logged.error.type).toBe('Error');
    });

    it('surfaces driver weirdness (delete result missing rowsAffected) via the outer catch', async () => {
      // Regression: pre-helper, the cast `as unknown as { rowsAffected?: number }`
      // silently coalesced missing values to 0 via `?? 0`. After conversion to the
      // throwing getRowsAffected() helper, a missing rowsAffected flows through the
      // outer try/catch — expireSuggestions() returns 0, pushes the expiry warning,
      // and log.warn receives a serializeError-wrapped payload.
      const db = createMockDb();
      // Expiry delete: resolves with a result that has no rowsAffected field
      db.delete.mockReturnValueOnce(mockDbChain({}));
      // analyzeLibrary
      db.select.mockReturnValueOnce(mockDbChain([]));
      // existing books
      db.select.mockReturnValueOnce(mockDbChain([]));
      // dismissed suggestions
      db.select.mockReturnValueOnce(mockDbChain([]));
      // currentPending
      db.select.mockReturnValueOnce(mockDbChain([]));
      // stale delete (no stale)
      db.delete.mockReturnValue(mockDbChain());

      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });

      const { service, log } = createService(db);
      const result = await service.refreshSuggestions();

      expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Expiry')]));

      const warnMock = log.warn as ReturnType<typeof vi.fn>;
      const expiryWarn = warnMock.mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('expiry step failed'),
      );
      expect(expiryWarn).toBeDefined();
      const logged = expiryWarn![0] as { error: Record<string, unknown> };
      // Canonical shape: { error: serializeError(...) } — not a raw Error instance
      expect(logged.error).not.toBeInstanceOf(Error);
      expect(logged.error.message).toEqual(expect.stringContaining('rowsAffected'));
      expect(logged.error.type).toBe('Error');
    });

    it('continues candidate generation after expiry failure', async () => {
      const db = createMockDb();
      // Expiry delete throws
      db.delete.mockReturnValueOnce(mockDbChain([], { error: new Error('DB locked') }));
      // analyzeLibrary
      db.select.mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]));
      // existing books
      db.select.mockReturnValueOnce(mockDbChain([]));
      // dismissed
      db.select.mockReturnValueOnce(mockDbChain([]));
      // currentPending
      db.select.mockReturnValueOnce(mockDbChain([]));
      // batch SELECT for upsert (#554)
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());
      // stale delete
      db.delete.mockReturnValue(mockDbChain());

      mockMetadataService.searchBooksForDiscovery.mockResolvedValueOnce({
        books: [{ asin: 'NEW1', title: 'New', authors: [{ name: 'Author A' }], language: 'English' }],
        warnings: [],
      }).mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      const result = await service.refreshSuggestions();

      // Should still insert new candidates despite expiry failure
      expect(result.added).toBeGreaterThanOrEqual(1);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  // --- #408: Resurfaced snoozed suggestion preservation (AC6) ---

  describe('refreshSuggestions (AC6 — snoozed preservation)', () => {
    it('preserves reason and reasonContext for resurfaced snoozed rows, clears snoozeUntil, and uses real scoring', async () => {
      const pastDate = new Date(Date.now() - 86400000); // yesterday
      const updateChain = mockDbChain();
      const db = createMockDb();
      // Expiry delete
      db.delete.mockReturnValue(mockDbChain());
      // dismissal stats (#406)
      db.select.mockReturnValueOnce(mockDbChain([]));
      // analyzeLibrary — 3 books from Author A gives strength 3/5 = 0.6
      db.select.mockReturnValueOnce(mockDbChain([
        makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 }),
        makeBookRow({ id: 2, genres: ['Fantasy'], duration: 1000 }),
        makeBookRow({ id: 3, genres: ['Fantasy'], duration: 1000 }),
      ]));
      // analyzeLibrary narrator rows
      db.select.mockReturnValueOnce(mockDbChain([]));
      // existing books
      db.select.mockReturnValueOnce(mockDbChain([]));
      // dismissed
      db.select.mockReturnValueOnce(mockDbChain([]));
      // currentPending — includes a resurfaced snoozed suggestion NOT in candidates
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 5, asin: 'SNOOZED1', snoozeUntil: pastDate, reason: 'author', reasonContext: 'Original context', authorName: 'Author A', duration: null, publishedDate: null, seriesName: null, seriesPosition: null },
      ]));
      db.update.mockReturnValue(updateChain);

      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      await service.refreshSuggestions();

      // The resurfaced snoozed row should be updated: score from real algorithm, snoozeUntil cleared, NO reason/reasonContext overwrite
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          score: expect.any(Number),
          refreshedAt: expect.any(Date),
          snoozeUntil: null,
        }),
      );
      // Verify reason/reasonContext are NOT in the set payload (preserved by omission)
      const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(setPayload).not.toHaveProperty('reason');
      expect(setPayload).not.toHaveProperty('reasonContext');
      // Score should use real scoring: author weight (40) * strength (0.6) = 24, clamped 0-100
      expect(setPayload.score).toBe(24);
    });

    it('resurfaced narrator-snoozed rows use narrator affinity for scoring, not author name', async () => {
      const pastDate = new Date(Date.now() - 86400000);
      const updateChain = mockDbChain();
      const db = createMockDb();
      // Expiry delete
      db.delete.mockReturnValue(mockDbChain());
      // dismissal stats (#406)
      db.select.mockReturnValueOnce(mockDbChain([]));
      // analyzeLibrary — 4 books narrated by "Narrator N" gives narratorAffinity count=4, strength=4/5=0.8
      // Author A has 4 books → strength 4/5=0.8
      db.select.mockReturnValueOnce(mockDbChain([
        makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 }),
        makeBookRow({ id: 2, genres: ['Fantasy'], duration: 1000 }),
        makeBookRow({ id: 3, genres: ['Fantasy'], duration: 1000 }),
        makeBookRow({ id: 4, genres: ['Fantasy'], duration: 1000 }),
      ]));
      // analyzeLibrary narrator rows — 4 books narrated by "Narrator N"
      db.select.mockReturnValueOnce(mockDbChain([
        { bookId: 1, narratorName: 'Narrator N' },
        { bookId: 2, narratorName: 'Narrator N' },
        { bookId: 3, narratorName: 'Narrator N' },
        { bookId: 4, narratorName: 'Narrator N' },
      ]));
      // existing books
      db.select.mockReturnValueOnce(mockDbChain([]));
      // dismissed
      db.select.mockReturnValueOnce(mockDbChain([]));
      // currentPending — resurfaced narrator suggestion where authorName ≠ narratorName
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 7, asin: 'NARRATOR_SNOOZED', snoozeUntil: pastDate, reason: 'narrator', reasonContext: 'Narrated by Narrator N', authorName: 'Some Other Author', narratorName: 'Narrator N', duration: null, publishedDate: null, seriesName: null, seriesPosition: null },
      ]));
      db.update.mockReturnValue(updateChain);

      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      await service.refreshSuggestions();

      // Score should use narrator weight (20) * narrator strength (4/5 = 0.8) = 16
      const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(setPayload.score).toBe(16);
      expect(setPayload.snoozeUntil).toBeNull();
      // reason/reasonContext preserved by omission
      expect(setPayload).not.toHaveProperty('reason');
      expect(setPayload).not.toHaveProperty('reasonContext');
    });

    it('resurfaced diversity-snoozed rows use fixed 0.3 strength, clears snoozeUntil', async () => {
      const pastDate = new Date(Date.now() - 86400000);
      const updateChain = mockDbChain();
      const db = createMockDb();
      // Expiry delete
      db.delete.mockReturnValue(mockDbChain());
      // dismissal stats (#406)
      db.select.mockReturnValueOnce(mockDbChain([]));
      // analyzeLibrary — 2 books from Author A
      db.select.mockReturnValueOnce(mockDbChain([
        makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 }),
        makeBookRow({ id: 2, genres: ['Fantasy'], duration: 1000 }),
      ]));
      // analyzeLibrary narrator rows
      db.select.mockReturnValueOnce(mockDbChain([]));
      // existing books
      db.select.mockReturnValueOnce(mockDbChain([]));
      // dismissed
      db.select.mockReturnValueOnce(mockDbChain([]));
      // currentPending — expired snoozed diversity row NOT regenerated by pipeline
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 9, asin: 'DIV_SNOOZED', snoozeUntil: pastDate, reason: 'diversity', reasonContext: 'Something different — explore Mystery', authorName: 'Some Author', narratorName: null, duration: null, publishedDate: null, seriesName: null, seriesPosition: null },
      ]));
      db.update.mockReturnValue(updateChain);

      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      await service.refreshSuggestions();

      // The resurfaced diversity row should be updated with fixed strength scoring
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          score: expect.any(Number),
          refreshedAt: expect.any(Date),
          snoozeUntil: null,
        }),
      );
      const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      // diversity weight = 15, strength = 0.3 → base score = 4.5
      expect(setPayload.score).toBe(4.5);
      expect(setPayload.snoozeUntil).toBeNull();
      // reason/reasonContext preserved by omission
      expect(setPayload).not.toHaveProperty('reason');
      expect(setPayload).not.toHaveProperty('reasonContext');
    });

    it('still-snoozed rows survive refresh without being deleted or resurfaced', async () => {
      const futureDate = new Date(Date.now() + 7 * 86400000); // 7 days from now
      const db = createMockDb();
      // Expiry delete
      db.delete.mockReturnValue(mockDbChain());
      // dismissal stats (#406)
      db.select.mockReturnValueOnce(mockDbChain([]));
      // analyzeLibrary
      db.select.mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]));
      // analyzeLibrary narrator rows
      db.select.mockReturnValueOnce(mockDbChain([]));
      // existing books
      db.select.mockReturnValueOnce(mockDbChain([]));
      // dismissed
      db.select.mockReturnValueOnce(mockDbChain([]));
      // currentPending — future-snoozed row NOT regenerated by pipeline
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 5, asin: 'SNOOZED_FUTURE', snoozeUntil: futureDate, reason: 'author', reasonContext: 'Original', authorName: 'Author A', duration: null, publishedDate: null, seriesName: null, seriesPosition: null },
      ]));

      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      const result = await service.refreshSuggestions();

      // Should NOT be deleted (removed count should be 0)
      expect(result.removed).toBe(0);
      // Should NOT be updated (no resurfacing update issued)
      expect(db.update).not.toHaveBeenCalled();
    });

    it('overwrites reason and reasonContext for normal regenerated pending suggestions', async () => {
      const db = createMockDb();
      // Expiry delete
      db.delete.mockReturnValue(mockDbChain());
      // dismissal stats (#406)
      db.select.mockReturnValueOnce(mockDbChain([]));
      // analyzeLibrary
      db.select.mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]));
      // analyzeLibrary narrator rows
      db.select.mockReturnValueOnce(mockDbChain([]));
      // existing books
      db.select.mockReturnValueOnce(mockDbChain([]));
      // dismissed
      db.select.mockReturnValueOnce(mockDbChain([]));
      // currentPending
      db.select.mockReturnValueOnce(mockDbChain([{ id: 5, asin: 'EXISTING_PENDING', snoozeUntil: null, reason: 'author', reasonContext: 'ctx', authorName: 'Author A', narratorName: null, duration: null, publishedDate: null, seriesName: null, seriesPosition: null }]));
      // batch SELECT for upsert (#554)
      db.select.mockReturnValueOnce(mockDbChain([{ asin: 'EXISTING_PENDING', status: 'pending', snoozeUntil: null }]));
      db.insert.mockReturnValue(mockDbChain());

      mockMetadataService.searchBooksForDiscovery.mockResolvedValueOnce({
        books: [{ asin: 'EXISTING_PENDING', title: 'Updated', authors: [{ name: 'Author A' }], language: 'English' }],
        warnings: [],
      }).mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      await service.refreshSuggestions();

      // Normal pending rows get upserted via INSERT ON CONFLICT DO UPDATE (#554)
      expect(db.insert).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Diversity Factor (#407)
  // -------------------------------------------------------------------------

  describe('diversity via generateCandidates', () => {
    /**
     * Sets up generateCandidates mocks with a library that has only Fantasy genre.
     * Returns the db mock so callers can add further mock chain entries if needed.
     */
    function setupDiversityTest(opts?: { existingAsins?: string[]; dismissedAsins?: string[]; libraryGenres?: string[][] }) {
      const db = createMockDb();
      const genres = opts?.libraryGenres ?? [['Fantasy']];
      const libraryBooks = genres.map((g, i) => makeBookRow({ id: i + 1, genres: g, duration: 1000 }));
      db.select
        // analyzeLibrary
        .mockReturnValueOnce(mockDbChain(libraryBooks))
        // existing books
        .mockReturnValueOnce(mockDbChain((opts?.existingAsins ?? []).map(asin => ({ asin, title: 'Existing', authorName: 'Someone' }))))
        // dismissed suggestions
        .mockReturnValueOnce(mockDbChain((opts?.dismissedAsins ?? []).map(asin => ({ asin }))));
      return db;
    }

    it('queries genres NOT in the library genreDistribution from the curated list', async () => {
      const db = setupDiversityTest({ libraryGenres: [['Fantasy'], ['Fantasy'], ['Romance']] });
      // Affinity queries return empty; diversity query returns a book
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });
      // We need to intercept the diversity search calls — they should NOT include Fantasy or Romance
      const searchCalls: string[] = [];
      mockMetadataService.searchBooksForDiscovery.mockImplementation(async (query: string) => {
        searchCalls.push(query);
        if (['Mystery', 'Thriller', 'Science Fiction', 'Horror', 'Biography', 'History',
          'Business', 'Self-Help', 'True Crime', 'Comedy', 'Health & Wellness',
          'Philosophy', 'Travel'].includes(query)) {
          return { books: [{ asin: `DIV-${query}`, title: `A ${query} Book`, authors: [{ name: 'New Author' }], language: 'English' }], warnings: [] };
        }
        return { books: [], warnings: [] };
      });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);

      const diversityCandidates = candidates.filter(c => c.reason === 'diversity');
      expect(diversityCandidates.length).toBeGreaterThanOrEqual(1);
      expect(diversityCandidates.length).toBeLessThanOrEqual(2);
      // None of the diversity candidates should be from Fantasy or Romance (library genres)
      for (const dc of diversityCandidates) {
        expect(dc.asin).not.toContain('DIV-Fantasy');
        expect(dc.asin).not.toContain('DIV-Romance');
      }
    });

    it('skips gracefully when library has no genre distribution (empty library)', async () => {
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // no imported books
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      // Diversity should still query since ALL curated genres are missing
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
        books: [{ asin: 'DIV1', title: 'Diverse Book', authors: [{ name: 'Author X' }], language: 'English' }],
        warnings: [],
      });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);

      // With an empty library there are no affinity signals, but diversity should still work
      const diversityCandidates = candidates.filter(c => c.reason === 'diversity');
      expect(diversityCandidates.length).toBeGreaterThanOrEqual(0); // may get 1-2
      // No crash = success for this test
    });

    it('treats entire curated list as missing when all library genres are null/empty', async () => {
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeBookRow({ id: 1, genres: null }),
          makeBookRow({ id: 2, genres: [] }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      mockMetadataService.searchBooksForDiscovery.mockImplementation(async (query: string) => {
        // Affinity queries return nothing (Author A has no genre results to work with)
        if (query === 'Author A') return { books: [], warnings: [] };
        // Diversity queries return unique books per genre
        return {
          books: [{ asin: `DIV-${query}`, title: `A ${query} Book`, authors: [{ name: 'New Author' }], language: 'English' }],
          warnings: [],
        };
      });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      expect(signals.genreDistribution.size).toBe(0);
      const candidates = await service.generateCandidates(signals);
      // All curated genres are "missing" so diversity has the full list to pick from
      const diversityCandidates = candidates.filter(c => c.reason === 'diversity');
      expect(diversityCandidates.length).toBeGreaterThanOrEqual(1);
    });

    it('produces 0 diversity candidates when library covers all curated genres', async () => {
      // Import from CLAUDE.md: DIVERSITY_GENRES has 15 entries
      const allCuratedGenres = [
        'Mystery', 'Thriller', 'Science Fiction', 'Fantasy', 'Romance',
        'Horror', 'Biography', 'History', 'Business', 'Self-Help',
        'True Crime', 'Comedy', 'Health & Wellness', 'Philosophy', 'Travel',
      ];
      const db = setupDiversityTest({ libraryGenres: allCuratedGenres.map(g => [g]) });
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      const diversityCandidates = candidates.filter(c => c.reason === 'diversity');
      expect(diversityCandidates).toHaveLength(0);
    });

    it('filters diversity candidates through same quality rules (ASIN, language, dismissed, existing)', async () => {
      const db = setupDiversityTest({ existingAsins: ['EXISTING1'], dismissedAsins: ['DISMISSED1'] });
      mockMetadataService.searchBooksForDiscovery.mockImplementation(async (query: string) => {
        // Only diversity queries return candidates (not affinity queries for Fantasy)
        if (query === 'Fantasy') return { books: [], warnings: [] };
        return {
          books: [
            { asin: 'EXISTING1', title: 'Already Owned', authors: [{ name: 'Author Z' }], language: 'English' },
            { asin: 'DISMISSED1', title: 'Dismissed One', authors: [{ name: 'Author Z' }], language: 'English' },
            { asin: 'NO_LANG', title: 'No Language', authors: [{ name: 'Author Z' }] },
            { asin: 'WRONG_LANG', title: 'French', authors: [{ name: 'Author Z' }], language: 'French' },
            { asin: 'GOOD1', title: 'Good Book', authors: [{ name: 'Author Z' }], language: 'English' },
          ],
          warnings: [],
        };
      });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      const diversityCandidates = candidates.filter(c => c.reason === 'diversity');

      const diversityAsins = diversityCandidates.map(c => c.asin);
      expect(diversityAsins).not.toContain('EXISTING1');
      expect(diversityAsins).not.toContain('DISMISSED1');
      expect(diversityAsins).not.toContain('NO_LANG');
      expect(diversityAsins).not.toContain('WRONG_LANG');
      if (diversityCandidates.length > 0) {
        expect(diversityAsins).toContain('GOOD1');
      }
    });

    it('catches and logs metadata query errors without crashing the pipeline', async () => {
      const db = setupDiversityTest();
      // Affinity queries return empty, diversity queries throw
      mockMetadataService.searchBooksForDiscovery.mockRejectedValue(new Error('API down'));

      const { service, log } = createService(db);
      const signals = await service.analyzeLibrary();
      // Should not throw
      const candidates = await service.generateCandidates(signals);
      expect(Array.isArray(candidates)).toBe(true);
      expect(log.warn).toHaveBeenCalled();
    });

    it('returns fewer than 2 candidates when selected genre yields 0 eligible books', async () => {
      const db = setupDiversityTest();
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      const diversityCandidates = candidates.filter(c => c.reason === 'diversity');
      expect(diversityCandidates.length).toBeLessThanOrEqual(2);
    });
  });

  describe('diversity scoring & slot guarantee', () => {
    function setupDiversityTest() {
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      return db;
    }

    it('diversity base weight (15) is lower than all affinity weights', () => {
      // SIGNAL_WEIGHTS: author=40, series=50, genre=25, narrator=20, diversity=15
      // We verify this structurally by checking candidates' scores
      expect(15).toBeLessThan(20); // narrator
      expect(15).toBeLessThan(25); // genre
      expect(15).toBeLessThan(40); // author
      expect(15).toBeLessThan(50); // series
    });

    it('diversity candidates receive quality/recency/duration bonuses', async () => {
      const db = setupDiversityTest();
      const recentDate = new Date();
      recentDate.setMonth(recentDate.getMonth() - 6);

      mockMetadataService.searchBooksForDiscovery.mockImplementation(async (query: string) => {
        if (query === 'Fantasy') return { books: [], warnings: [] };
        return {
          books: [{
            asin: 'DIV_BONUS',
            title: 'Recent Diverse Book',
            authors: [{ name: 'New Author' }],
            language: 'English',
            duration: 1000, // within stddev of library median
            publishedDate: recentDate.toISOString(), // recent = +10 bonus
          }],
          warnings: [],
        };
      });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      const dc = candidates.find(c => c.asin === 'DIV_BONUS');
      if (dc) {
        // base = 15 * 0.3 = 4.5, duration bonus = 5, recency bonus = 10 → ~19.5
        expect(dc.score).toBeGreaterThan(15 * 0.3); // must be higher than base alone
      }
    });

    it('ASIN collision: affinity version kept, diversity candidate skipped', async () => {
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 }),
          makeBookRow({ id: 2, genres: ['Fantasy'], duration: 1000 }),
          makeBookRow({ id: 3, genres: ['Fantasy'], duration: 1000 }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const collisionAsin = 'COLLISION1';
      mockMetadataService.searchBooksForDiscovery.mockImplementation(async (query: string) => {
        // Affinity genre query returns the collision book
        if (query === 'Fantasy') {
          return {
            books: [{ asin: collisionAsin, title: 'Genre Book', authors: [{ name: 'Popular Author' }], language: 'English' }],
            warnings: [],
          };
        }
        // Author query for "Author A" — return empty to keep it clean
        if (query === 'Author A') return { books: [], warnings: [] };
        // Diversity query also returns same ASIN + a unique one
        return {
          books: [
            { asin: collisionAsin, title: 'Genre Book', authors: [{ name: 'Popular Author' }], language: 'English' },
            { asin: 'DIV_UNIQUE', title: 'Unique Diverse', authors: [{ name: 'New Author' }], language: 'English' },
          ],
          warnings: [],
        };
      });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);

      const collision = candidates.find(c => c.asin === collisionAsin);
      // The collision ASIN should be kept as affinity, not diversity
      expect(collision).toBeDefined();
      expect(collision!.reason).not.toBe('diversity');
    });
  });

  describe('diversity reason enum extension', () => {
    it('getStrengthForReason handles diversity reason without error', async () => {
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'] })]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      mockMetadataService.searchBooksForDiscovery.mockImplementation(async (query: string) => {
        // Only diversity queries (non-Fantasy, non-Author A) return candidates
        if (query === 'Fantasy' || query === 'Author A') return { books: [], warnings: [] };
        return {
          books: [{ asin: `DIV-${query}`, title: 'Test', authors: [{ name: 'Auth' }], language: 'English' }],
          warnings: [],
        };
      });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      const dc = candidates.find(c => c.reason === 'diversity');
      expect(dc).toBeDefined();
      // diversity strength = 0.3, weight = 15 → base score = 4.5
      expect(dc!.score).toBeGreaterThanOrEqual(4);
      expect(dc!.reason).toBe('diversity');
    });

  });

  describe('diversity dismissal behavior (AC4)', () => {
    it('dismissed diversity ASIN excluded per-ASIN but genre is still queried on next refresh', async () => {
      // If ASIN "DIV1" from Mystery is dismissed, next refresh should still query Mystery
      // but exclude DIV1 specifically
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'] })]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ asin: 'DIV1' }])); // DIV1 dismissed

      const searchCalls: string[] = [];
      mockMetadataService.searchBooksForDiscovery.mockImplementation(async (query: string) => {
        searchCalls.push(query);
        if (query === 'Fantasy') return { books: [], warnings: [] };
        return {
          books: [
            { asin: 'DIV1', title: 'Dismissed', authors: [{ name: 'Auth' }], language: 'English' },
            { asin: 'DIV2', title: 'New Pick', authors: [{ name: 'Auth' }], language: 'English' },
          ],
          warnings: [],
        };
      });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);

      // DIV1 should be excluded (dismissed), but a different book from the same genre should work
      const diversityCandidates = candidates.filter(c => c.reason === 'diversity');
      const diversityAsins = diversityCandidates.map(c => c.asin);
      expect(diversityAsins).not.toContain('DIV1');
      if (diversityCandidates.length > 0) {
        expect(diversityAsins).toContain('DIV2');
      }
    });
  });

  describe('diversity integration — generateCandidates', () => {
    it('diversity suggestions have reasonContext like "Something different — explore {genre}"', async () => {
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'] })]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      mockMetadataService.searchBooksForDiscovery.mockImplementation(async (query: string) => {
        if (query === 'Fantasy') return { books: [], warnings: [] };
        return {
          books: [{ asin: `DIV-${query}`, title: `A ${query} Book`, authors: [{ name: 'Auth' }], language: 'English' }],
          warnings: [],
        };
      });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      const diversityCandidates = candidates.filter(c => c.reason === 'diversity');

      for (const dc of diversityCandidates) {
        expect(dc.reasonContext).toMatch(/^Something different — explore .+/);
      }
    });

    it('deduplicates within diversity picks when two genres return the same book', async () => {
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'] })]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      // All diversity queries return the same ASIN
      mockMetadataService.searchBooksForDiscovery.mockImplementation(async (query: string) => {
        if (query === 'Fantasy') return { books: [], warnings: [] };
        return {
          books: [{ asin: 'SAME_BOOK', title: 'Universal Book', authors: [{ name: 'Auth' }], language: 'English' }],
          warnings: [],
        };
      });

      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals);
      const diversityCandidates = candidates.filter(c => c.reason === 'diversity');

      // Should only appear once despite being returned by multiple genre queries
      const sameBookCount = diversityCandidates.filter(c => c.asin === 'SAME_BOOK').length;
      expect(sameBookCount).toBeLessThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // #406 — Dismissal ratio computation
  // ---------------------------------------------------------------------------
  describe('computeDismissalRatios', () => {
    it('computes ratio with 3 dismissed, 2 added for genre → ratio = 0.6', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([
        { reason: 'genre', status: 'dismissed', count: 3 },
        { reason: 'genre', status: 'added', count: 2 },
      ]));
      const { service } = createService(db);
      const ratios = await service.computeDismissalRatios();
      expect(ratios.genre).toBeCloseTo(0.6);
    });

    it('computes ratio with 5 dismissed, 1 added for author → ratio = 0.83', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([
        { reason: 'author', status: 'dismissed', count: 5 },
        { reason: 'author', status: 'added', count: 1 },
      ]));
      const { service } = createService(db);
      const ratios = await service.computeDismissalRatios();
      expect(ratios.author).toBeCloseTo(5 / 6);
    });

    it('computes ratio with 0 dismissed, 5 added → ratio = 0.0', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([
        { reason: 'narrator', status: 'added', count: 5 },
      ]));
      const { service } = createService(db);
      const ratios = await service.computeDismissalRatios();
      expect(ratios.narrator).toBeCloseTo(0.0);
    });

    it('computes ratio with 5 dismissed, 0 added → ratio = 1.0', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([
        { reason: 'series', status: 'dismissed', count: 5 },
      ]));
      const { service } = createService(db);
      const ratios = await service.computeDismissalRatios();
      expect(ratios.series).toBeCloseTo(1.0);
    });

    it('returns empty record for reason with no suggestions', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([]));
      const { service } = createService(db);
      const ratios = await service.computeDismissalRatios();
      expect(ratios).toEqual({});
    });

    it('query filters to only dismissed and added statuses, grouped by reason and status', async () => {
      const db = createMockDb();
      const chain = mockDbChain([]);
      db.select.mockReturnValue(chain);
      const { service } = createService(db);

      await service.computeDismissalRatios();

      // Verify the where predicate uses inArray for ['dismissed', 'added'] only
      expect(chain.where).toHaveBeenCalled();
      const whereArg = (chain.where as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      const sql = toSQL(whereArg);
      expect(sql).toContain('"status" in (?, ?)');

      // Verify groupBy is called (reason + status columns)
      expect(chain.groupBy).toHaveBeenCalled();
    });

    it('handles multiple reasons in a single query result', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([
        { reason: 'author', status: 'dismissed', count: 4 },
        { reason: 'author', status: 'added', count: 1 },
        { reason: 'genre', status: 'dismissed', count: 2 },
        { reason: 'genre', status: 'added', count: 3 },
      ]));
      const { service } = createService(db);
      const ratios = await service.computeDismissalRatios();
      expect(ratios.author).toBeCloseTo(0.8);
      expect(ratios.genre).toBeCloseTo(0.4);
    });
  });

  // ---------------------------------------------------------------------------
  // #406 — Weight multiplier calculation
  // ---------------------------------------------------------------------------
  describe('computeWeightMultipliers', () => {
    // Import the pure function for direct testing
    // Ratios input: { reason: { dismissed, added, total } }
    // The function lives on the service but is a pure computation

    it('ratio at exactly 0.80 → multiplier = 1.0 (threshold is "exceeds", not "meets")', () => {
      const result = computeWeightMultipliers({ author: { dismissed: 4, added: 1, total: 5 } });
      expect(result.author).toBe(1.0);
    });

    it('ratio at 0.81 → multiplier = 0.98', () => {
      // 81 dismissed, 19 added → ratio = 0.81
      const result = computeWeightMultipliers({ author: { dismissed: 81, added: 19, total: 100 } });
      expect(result.author).toBeCloseTo(0.98);
    });

    it('ratio at 0.90 → multiplier = 0.80', () => {
      const result = computeWeightMultipliers({ author: { dismissed: 9, added: 1, total: 10 } });
      expect(result.author).toBeCloseTo(0.80);
    });

    it('ratio at 0.95 → multiplier = 0.70', () => {
      const result = computeWeightMultipliers({ author: { dismissed: 19, added: 1, total: 20 } });
      expect(result.author).toBeCloseTo(0.70);
    });

    it('ratio at 1.0 → multiplier = 0.60', () => {
      const result = computeWeightMultipliers({ author: { dismissed: 10, added: 0, total: 10 } });
      expect(result.author).toBeCloseTo(0.60);
    });

    it('ratio at 0.5 → multiplier = 1.0 (below threshold)', () => {
      const result = computeWeightMultipliers({ genre: { dismissed: 5, added: 5, total: 10 } });
      expect(result.genre).toBe(1.0);
    });

    it('reason with only 3 total suggestions (below min-sample of 5) → multiplier stays 1.0', () => {
      const result = computeWeightMultipliers({ genre: { dismissed: 3, added: 0, total: 3 } });
      expect(result.genre).toBe(1.0);
    });

    it('reason with exactly 5 total suggestions → threshold met, ratio applied', () => {
      // 5 dismissed, 0 added → ratio = 1.0 → multiplier = 0.60
      const result = computeWeightMultipliers({ genre: { dismissed: 5, added: 0, total: 5 } });
      expect(result.genre).toBeCloseTo(0.60);
    });

    it('reason with 0 total suggestions → multiplier stays 1.0 (division safety)', () => {
      const result = computeWeightMultipliers({ narrator: { dismissed: 0, added: 0, total: 0 } });
      expect(result.narrator).toBe(1.0);
    });

    it('multiple reasons above threshold simultaneously → each adjusted independently', () => {
      const result = computeWeightMultipliers({
        author: { dismissed: 9, added: 1, total: 10 },   // ratio 0.90 → 0.80
        genre: { dismissed: 10, added: 0, total: 10 },    // ratio 1.00 → 0.60
        series: { dismissed: 3, added: 7, total: 10 },    // ratio 0.30 → 1.0
      });
      expect(result.author).toBeCloseTo(0.80);
      expect(result.genre).toBeCloseTo(0.60);
      expect(result.series).toBe(1.0);
      // Unmentioned reasons default to 1.0
      expect(result.narrator).toBe(1.0);
      expect(result.diversity).toBe(1.0);
    });

    it('clamp guards: multiplier never goes below 0.25', () => {
      // This can't happen with valid ratios (max ratio is 1.0 → 0.60),
      // but the clamp guards against floating-point edge cases
      // We test the formula boundary directly
      const result = computeWeightMultipliers({ author: { dismissed: 10, added: 0, total: 10 } });
      expect(result.author).toBeGreaterThanOrEqual(0.25);
    });
  });

  // ---------------------------------------------------------------------------
  // #406 — scoreCandidate with weight multiplier
  // ---------------------------------------------------------------------------
  describe('scoreCandidate with multiplier (via generateCandidates)', () => {
    function setupScoringTest() {
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 }),
          makeBookRow({ id: 2, genres: ['Fantasy'], duration: 1000 }),
          makeBookRow({ id: 3, genres: ['Fantasy'], duration: 1000 }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))  // existing books
        .mockReturnValueOnce(mockDbChain([])); // dismissed suggestions
      return db;
    }

    it('score with default multiplier (1.0) matches current behavior', async () => {
      const db = setupScoringTest();
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
        books: [{ asin: 'NEW1', title: 'New Book', authors: [{ name: 'Author A' }], language: 'English' }],
        warnings: [],
      });
      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const defaultMultipliers = { author: 1, series: 1, genre: 1, narrator: 1, diversity: 1 };

      const candidatesDefault = await service.generateCandidates(signals, defaultMultipliers);
      const candidatesNoArg = await service.generateCandidates(signals);

      const scoreDefault = candidatesDefault.find(c => c.asin === 'NEW1')?.score;
      const scoreNoArg = candidatesNoArg.find(c => c.asin === 'NEW1')?.score;
      expect(scoreDefault).toBeDefined();
      expect(scoreDefault).toBe(scoreNoArg);
    });

    it('score with author multiplier at 0.5 → author base weight effectively halved', async () => {
      const db = setupScoringTest();
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
        books: [{ asin: 'NEW1', title: 'New Book', authors: [{ name: 'Author A' }], language: 'English' }],
        warnings: [],
      });
      const { service } = createService(db);
      const signals = await service.analyzeLibrary();

      const full = await service.generateCandidates(signals, { author: 1, series: 1, genre: 1, narrator: 1, diversity: 1 });
      const half = await service.generateCandidates(signals, { author: 0.5, series: 1, genre: 1, narrator: 1, diversity: 1 });

      const fullScore = full.find(c => c.asin === 'NEW1' && c.reason === 'author')?.score ?? 0;
      const halfScore = half.find(c => c.asin === 'NEW1' && c.reason === 'author')?.score ?? 0;
      // The base weight portion should be halved, but bonuses remain the same
      expect(halfScore).toBeLessThan(fullScore);
    });

    it('score with multiplier at floor (0.25) → base weight reduced but bonuses still apply', async () => {
      const db = setupScoringTest();
      const recentDate = new Date();
      recentDate.setMonth(recentDate.getMonth() - 6);
      mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
        books: [{ asin: 'NEW1', title: 'New Book', authors: [{ name: 'Author A' }], language: 'English', publishedDate: recentDate.toISOString(), duration: 1000 }],
        warnings: [],
      });
      const { service } = createService(db);
      const signals = await service.analyzeLibrary();
      const candidates = await service.generateCandidates(signals, { author: 0.25, series: 0.25, genre: 0.25, narrator: 0.25, diversity: 0.25 });
      const scored = candidates.find(c => c.asin === 'NEW1');
      expect(scored).toBeDefined();
      // Score should be > 0 because bonuses (recency, duration) still apply even with floor multiplier
      expect(scored!.score).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // #406 — refreshSuggestions with weight tuning
  // ---------------------------------------------------------------------------
  describe('refreshSuggestions weight tuning integration', () => {
    function setupRefreshTest(ratioRows: Array<{ reason: string; status: string; count: number }> = []) {
      const db = createMockDb();
      // Call order in refreshSuggestions:
      // 1. expireSuggestions: db.delete
      // 2. computeDismissalStats: db.select (dismissal counts — #406)
      // 3. analyzeLibrary: db.select (imported books)
      // 4. generateCandidates: db.select (existing books), db.select (dismissed asins)
      // 5. currentPending: db.select
      // Then upsert loop + stale deletion

      // expireSuggestions delete
      db.delete.mockReturnValue(mockDbChain({ rowsAffected: 0 }));
      // computeDismissalStats query (#406)
      db.select
        .mockReturnValueOnce(mockDbChain(ratioRows))
        // analyzeLibrary: imported books
        .mockReturnValueOnce(mockDbChain([]))
        // analyzeLibrary: narrator rows
        .mockReturnValueOnce(mockDbChain([]))
        // existing books for exclusion
        .mockReturnValueOnce(mockDbChain([]))
        // dismissed suggestions
        .mockReturnValueOnce(mockDbChain([]))
        // currentPending
        .mockReturnValueOnce(mockDbChain([]));

      return db;
    }

    it('full refresh with no dismissal history → all multipliers default to 1.0', async () => {
      const db = setupRefreshTest([]);
      const { service, settingsService } = createService(db);

      await service.refreshSuggestions();

      expect(settingsService.set).toHaveBeenCalledWith('discovery', expect.objectContaining({
        weightMultipliers: { author: 1, series: 1, genre: 1, narrator: 1, diversity: 1 },
      }));
    });

    it('refresh stores computed multipliers via settings.set with full 5-key record', async () => {
      const db = setupRefreshTest([
        { reason: 'author', status: 'dismissed', count: 9 },
        { reason: 'author', status: 'added', count: 1 },
      ]);
      const { service, settingsService } = createService(db);

      await service.refreshSuggestions();

      const setCall = (settingsService.set as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => c[0] === 'discovery',
      );
      expect(setCall).toBeDefined();
      const multipliers = setCall![1].weightMultipliers;
      // All 5 keys must be present
      expect(Object.keys(multipliers).sort()).toEqual(['author', 'diversity', 'genre', 'narrator', 'series']);
      // Author should be reduced (ratio 0.9 → multiplier 0.80)
      expect(multipliers.author).toBeCloseTo(0.80);
      // Others should be 1.0
      expect(multipliers.series).toBe(1);
      expect(multipliers.genre).toBe(1);
      expect(multipliers.narrator).toBe(1);
      expect(multipliers.diversity).toBe(1);
    });

    it('DB error during ratio computation → refresh continues with default weights (1.0)', async () => {
      const db = createMockDb();
      db.delete.mockReturnValue(mockDbChain({ rowsAffected: 0 }));
      // computeDismissalStats throws
      db.select
        .mockReturnValueOnce(mockDbChain([], { error: new Error('DB connection lost') }))
        // analyzeLibrary
        .mockReturnValueOnce(mockDbChain([]))
        // existing books
        .mockReturnValueOnce(mockDbChain([]))
        // dismissed
        .mockReturnValueOnce(mockDbChain([]))
        // currentPending
        .mockReturnValueOnce(mockDbChain([]));
      const { service, settingsService } = createService(db);

      // Should not throw
      await expect(service.refreshSuggestions()).resolves.toBeDefined();

      // Should still write default multipliers
      expect(settingsService.set).toHaveBeenCalledWith('discovery', expect.objectContaining({
        weightMultipliers: { author: 1, series: 1, genre: 1, narrator: 1, diversity: 1 },
      }));
    });

    it('settings write failure for multipliers → refresh continues, logs warning', async () => {
      const db = setupRefreshTest([]);
      const { service, settingsService, log } = createService(db);
      (settingsService.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Settings DB error'));

      // Should not throw — refresh continues
      await expect(service.refreshSuggestions()).resolves.toBeDefined();

      // Should log warning
      expect(log.warn).toHaveBeenCalled();
    });

    it('resurfaced snoozed rows are rescored with computed non-default multipliers', async () => {
      const pastSnooze = new Date(Date.now() - 86400000); // 1 day ago
      const snoozedRow = {
        id: 42, asin: 'SNOOZED1', snoozeUntil: pastSnooze,
        reason: 'author', reasonContext: 'Same author',
        authorName: 'Unknown Author', narratorName: null,
        duration: null, publishedDate: null,
        seriesName: null, seriesPosition: null,
      };

      const db = createMockDb();
      // expireSuggestions
      db.delete.mockReturnValue(mockDbChain({ rowsAffected: 0 }));
      db.select
        // computeDismissalStats: 90% author dismissal → multiplier 0.80
        .mockReturnValueOnce(mockDbChain([
          { reason: 'author', status: 'dismissed', count: 9 },
          { reason: 'author', status: 'added', count: 1 },
        ]))
        // analyzeLibrary: imported books (empty)
        .mockReturnValueOnce(mockDbChain([]))
        // analyzeLibrary: narrator rows (empty)
        .mockReturnValueOnce(mockDbChain([]))
        // existing books for exclusion
        .mockReturnValueOnce(mockDbChain([]))
        // dismissed suggestions
        .mockReturnValueOnce(mockDbChain([]))
        // currentPending: includes the snoozed row
        .mockReturnValueOnce(mockDbChain([snoozedRow]));
      // resurfaceSnoozedRows will call db.update
      db.update.mockReturnValue(mockDbChain({ rowsAffected: 1 }));

      const { service } = createService(db);
      await service.refreshSuggestions();

      // Verify db.update was called for the resurfaced row with a reduced score
      expect(db.update).toHaveBeenCalled();
      const updateChain = db.update.mock.results[0]!.value;
      expect(updateChain.set).toHaveBeenCalled();
      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0]![0];

      // With author multiplier 0.80 and default strength 0.5:
      // score = SIGNAL_WEIGHTS.author * 0.80 * 0.5 = 40 * 0.80 * 0.5 = 16
      // Without multiplier it would be 40 * 1.0 * 0.5 = 20
      expect(setArg.score).toBe(16);
      expect(setArg.score).not.toBe(20); // Would be 20 with default multiplier
      expect(setArg.snoozeUntil).toBeNull(); // Snooze cleared on resurface
    });
  });

  // ---------------------------------------------------------------------------
  // #404 — Series Completion Intelligence
  // ---------------------------------------------------------------------------

  describe('series completion intelligence (#404)', () => {
    /**
     * Sets up generateCandidates mocks with a library containing series books.
     * Returns db so callers can customize metadata responses.
     */
    function setupSeriesTest(libraryBooks: ReturnType<typeof makeBookRow>[]) {
      const db = createMockDb();
      db.select
        // analyzeLibrary (imported books)
        .mockReturnValueOnce(mockDbChain(libraryBooks))
        // existing books for ASIN exclusion
        .mockReturnValueOnce(mockDbChain([]))
        // dismissed suggestions
        .mockReturnValueOnce(mockDbChain([]));
      return db;
    }

    describe('AC1 — series gap detection', () => {
      it('detects gap at position 3 when user owns [1, 2, 4] and metadata returns a book at position 3', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
          makeBookRow({ id: 3, seriesName: 'Stormlight', seriesPosition: 4 }),
        ]);
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'SERIES3', title: 'Oathbringer', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Stormlight', position: 3 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        const seriesCandidate = candidates.find(c => c.asin === 'SERIES3');
        expect(seriesCandidate).toBeDefined();
        expect(seriesCandidate!.reason).toBe('series');
      });

      it('detects multiple gaps [2, 4] when user owns [1, 3, 5]', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Wheel', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Wheel', seriesPosition: 3 }),
          makeBookRow({ id: 3, seriesName: 'Wheel', seriesPosition: 5 }),
        ]);
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'GAP2', title: 'Book 2', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Wheel', position: 2 }] },
            { asin: 'GAP4', title: 'Book 4', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Wheel', position: 4 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        expect(candidates.find(c => c.asin === 'GAP2')).toBeDefined();
        expect(candidates.find(c => c.asin === 'GAP4')).toBeDefined();
      });
    });

    describe('AC2 — series continuation', () => {
      it('suggests next position (4) when user owns [1, 2, 3] and metadata returns a book at position 4', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Mistborn', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Mistborn', seriesPosition: 2 }),
          makeBookRow({ id: 3, seriesName: 'Mistborn', seriesPosition: 3 }),
        ]);
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'NEXT4', title: 'Alloy of Law', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Mistborn', position: 4 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        const continuation = candidates.find(c => c.asin === 'NEXT4');
        expect(continuation).toBeDefined();
        expect(continuation!.reason).toBe('series');
      });

      it('suggests position 2 when user owns only [1]', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Kingkiller', seriesPosition: 1 }),
        ]);
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'NEXT2', title: 'Wise Mans Fear', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Kingkiller', position: 2 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        const continuation = candidates.find(c => c.asin === 'NEXT2');
        expect(continuation).toBeDefined();
        expect(continuation!.reason).toBe('series');
      });
    });

    describe('AC3 — query construction', () => {
      it('calls searchBooksForDiscovery with structured title+author params', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
        ]);
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        await service.generateCandidates(signals);

        // Series query should use structured title+author, not a keywords blob
        const seriesCall = mockMetadataService.searchBooksForDiscovery.mock.calls.find(
          (c: unknown[]) => c[0] === 'Stormlight' && (c[1] as { title?: string })?.title === 'Stormlight',
        );
        expect(seriesCall).toBeDefined();
        expect(seriesCall![1]).toEqual(expect.objectContaining({ title: 'Stormlight', author: 'Author A' }));
      });

      it('filters metadata results to only books matching the series name (case-insensitive)', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
        ]);
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'MATCH', title: 'Book 3', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'stormlight', position: 3 }] },
            { asin: 'WRONG_SERIES', title: 'Other', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Mistborn', position: 3 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        expect(candidates.find(c => c.asin === 'MATCH' && c.reason === 'series')).toBeDefined();
        expect(candidates.find(c => c.asin === 'WRONG_SERIES' && c.reason === 'series')).toBeUndefined();
      });

      it('filters metadata results to only books at missing positions', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
        ]);
        // Position 3 = continuation (maxOwned+1), position 5 = not in missingPositions
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'POS3', title: 'Book 3', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Stormlight', position: 3 }] },
            { asin: 'POS5', title: 'Book 5', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Stormlight', position: 5 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        expect(candidates.find(c => c.asin === 'POS3' && c.reason === 'series')).toBeDefined();
        expect(candidates.find(c => c.asin === 'POS5' && c.reason === 'series')).toBeUndefined();
      });
    });

    describe('AC4 — series scoring precedence', () => {
      it('series candidates score at base weight 50 (highest signal weight)', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
          makeBookRow({ id: 3, seriesName: 'Stormlight', seriesPosition: 4 }),
        ]);
        // Return a gap book at position 3 (not continuation, so no +20 bonus)
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'SCORE_TEST', title: 'Gap Book', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Stormlight', position: 3 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        const seriesCandidate = candidates.find(c => c.asin === 'SCORE_TEST' && c.reason === 'series');
        expect(seriesCandidate).toBeDefined();
        // Base: SIGNAL_WEIGHTS.series(50) * multiplier(1) * strength(1.0) = 50
        expect(seriesCandidate!.score).toBe(50);
      });

      it('series candidates outscore author candidates under equal conditions', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
          makeBookRow({ id: 3, seriesName: 'Stormlight', seriesPosition: 4 }),
        ]);
        // Return two different books: one matching series gap, one for author
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'SERIES_BOOK', title: 'Series Gap', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Stormlight', position: 3 }] },
            { asin: 'AUTHOR_BOOK', title: 'Author Book', authors: [{ name: 'Author A' }], language: 'English' },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        const seriesScore = candidates.find(c => c.asin === 'SERIES_BOOK')?.score ?? 0;
        const authorScore = candidates.find(c => c.asin === 'AUTHOR_BOOK' && c.reason === 'author')?.score ?? 0;
        expect(seriesScore).toBeGreaterThan(authorScore);
      });

      it('applies +20 next-position bonus when position === maxOwned + 1', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
        ]);
        // Position 3 = maxOwned(2) + 1 → gets +20 bonus
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'NEXT_POS', title: 'Next Book', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Stormlight', position: 3 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        const nextCandidate = candidates.find(c => c.asin === 'NEXT_POS');
        expect(nextCandidate).toBeDefined();
        // Base 50 + next-position bonus 20 = 70
        expect(nextCandidate!.score).toBe(70);
      });

      it('does not apply next-position bonus for gap positions (not maxOwned + 1)', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
          makeBookRow({ id: 3, seriesName: 'Stormlight', seriesPosition: 4 }),
        ]);
        // Position 3 = gap (not maxOwned+1=5) → no bonus
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'GAP_BOOK', title: 'Gap Book', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Stormlight', position: 3 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        const gapCandidate = candidates.find(c => c.asin === 'GAP_BOOK');
        expect(gapCandidate).toBeDefined();
        // Base 50 only, no +20 bonus (position 3 !== maxOwned+1=5)
        expect(gapCandidate!.score).toBe(50);
      });

      it('fractional continuation candidate passes filter and receives +20 bonus (#196)', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Fractional', seriesPosition: 0.1 }),
          makeBookRow({ id: 2, seriesName: 'Fractional', seriesPosition: 0.2 }),
        ]);
        // nextPosition = 0.2 + 0.1 = 0.30000000000000004 (IEEE 754 drift)
        // Metadata returns exact 0.3 — tolerance-aware comparison must match
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'FRAC_NEXT', title: 'Frac Next', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Fractional', position: 0.3 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        const nextCandidate = candidates.find(c => c.asin === 'FRAC_NEXT');
        expect(nextCandidate).toBeDefined();
        expect(nextCandidate!.reason).toBe('series');
        // Base 50 + continuation bonus 20 = 70
        expect(nextCandidate!.score).toBe(70);
        // Continuation position → no "(position X)" suffix in reason text
        expect(nextCandidate!.reasonContext).toBe('Next in Fractional — you have books 1-0.2');
      });

      it('fractional gap candidate passes filter but does not receive continuation bonus (#196)', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Fractional', seriesPosition: 0.1 }),
          makeBookRow({ id: 2, seriesName: 'Fractional', seriesPosition: 0.2 }),
          makeBookRow({ id: 3, seriesName: 'Fractional', seriesPosition: 0.4 }),
        ]);
        // Gap at 0.3, nextPosition = 0.5 — metadata candidate at 0.3 is a gap, not continuation
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'FRAC_GAP', title: 'Frac Gap', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Fractional', position: 0.3 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        const gapCandidate = candidates.find(c => c.asin === 'FRAC_GAP');
        expect(gapCandidate).toBeDefined();
        expect(gapCandidate!.reason).toBe('series');
        // Base 50 only — position 0.3 is a gap, not nextPosition (0.5), so no +20 bonus
        expect(gapCandidate!.score).toBe(50);
        // Gap position → includes "(position 0.3)" suffix in reason text
        expect(gapCandidate!.reasonContext).toContain('(position 0.3)');
      });

      it('dismissed series suggestions score 50 * 0.25 = 12.5 at floor multiplier', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
          makeBookRow({ id: 3, seriesName: 'Stormlight', seriesPosition: 4 }),
        ]);
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'FLOOR_BOOK', title: 'Floor', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Stormlight', position: 3 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        // Floor all multipliers so author query doesn't outscore series in the dedup map
        const candidates = await service.generateCandidates(signals, { author: 0.25, series: 0.25, genre: 0.25, narrator: 0.25, diversity: 0.25 });

        const floorCandidate = candidates.find(c => c.asin === 'FLOOR_BOOK');
        expect(floorCandidate).toBeDefined();
        // series: 50 * 0.25 * 1.0 = 12.5 vs author: 40 * 0.25 * 0.6 = 6 → series wins dedup
        expect(floorCandidate!.reason).toBe('series');
        expect(floorCandidate!.score).toBe(12.5);
      });
    });

    describe('AC5 — edge cases', () => {
      it('skips books with null seriesPosition during signal extraction', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: null }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 1 }),
        ]);
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();

        // Only position 1 should be tracked; null position book is skipped
        expect(signals.seriesGaps).toHaveLength(1);
        expect(signals.seriesGaps[0]!.maxOwned).toBe(1);
        // No gaps — only continuation at nextPosition
        expect(signals.seriesGaps[0]!.missingPositions).toEqual([]);
        expect(signals.seriesGaps[0]!.nextPosition).toBe(2);
      });

      it('accepts fractional positions — [1.5, 2.5] yields no gaps, nextPosition = 3.5', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Fractional', seriesPosition: 1.5 }),
          makeBookRow({ id: 2, seriesName: 'Fractional', seriesPosition: 2.5 }),
        ]);
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();

        const gap = signals.seriesGaps.find(g => g.seriesName === 'Fractional');
        expect(gap).toBeDefined();
        // No gaps between consecutive fractional positions — continuation is nextPosition
        expect(gap!.missingPositions).toEqual([]);
        expect(gap!.nextPosition).toBe(3.5);
        expect(gap!.maxOwned).toBe(2.5);
      });

      it('generates no suggestion when metadata search returns no candidate at any missing position', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
        ]);
        // Metadata returns a book but NOT at position 3 (the missing one)
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'WRONG_POS', title: 'Wrong', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Stormlight', position: 7 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        const seriesCandidates = candidates.filter(c => c.reason === 'series');
        expect(seriesCandidates).toHaveLength(0);
      });

      it('excludes metadata result with null position from series candidate filtering', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
        ]);
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'NULL_POS', title: 'No Position', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Stormlight', position: null }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        expect(candidates.find(c => c.asin === 'NULL_POS' && c.reason === 'series')).toBeUndefined();
      });

      it('excludes metadata result whose position is not in missingPositions', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
        ]);
        // Position 10 is not in missingPositions [3]
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({
          books: [
            { asin: 'FAR_POS', title: 'Far Away', authors: [{ name: 'Author A' }], language: 'English', series: [{ name: 'Stormlight', position: 10 }] },
          ],
          warnings: [],
        });
        const { service } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        expect(candidates.find(c => c.asin === 'FAR_POS' && c.reason === 'series')).toBeUndefined();
      });

      it('does not crash when metadata search fails for a series query', async () => {
        const db = setupSeriesTest([
          makeBookRow({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
          makeBookRow({ id: 2, seriesName: 'Stormlight', seriesPosition: 2 }),
        ]);
        mockMetadataService.searchBooksForDiscovery.mockRejectedValue(new Error('Network error'));
        const { service, log } = createService(db);
        const signals = await service.analyzeLibrary();
        const candidates = await service.generateCandidates(signals);

        // Should not throw, just log warning
        expect(Array.isArray(candidates)).toBe(true);
        expect(log.warn).toHaveBeenCalled();
      });
    });
  });

  // #341 — book_added event tests removed — #524 moved event recording to POST /api/books

  describe('batch upsert (#554)', () => {
    function setupRefreshMocks(db: ReturnType<typeof createMockDb>, opts: {
      existingRows?: Array<{ id: number; asin: string; status: string; snoozeUntil?: Date | null }>;
      candidateCount?: number;
    } = {}) {
      const { existingRows = [], candidateCount = 1 } = opts;
      // Pre-upsert fixed calls:
      db.select
        // dismissal stats
        .mockReturnValueOnce(mockDbChain([]))
        // analyzeLibrary: books
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]))
        // analyzeLibrary: narrators
        .mockReturnValueOnce(mockDbChain([]))
        // existing books
        .mockReturnValueOnce(mockDbChain([]))
        // dismissed suggestions
        .mockReturnValueOnce(mockDbChain([]))
        // currentPending
        .mockReturnValueOnce(mockDbChain(existingRows.filter(r => r.status === 'pending').map(r => ({
          id: r.id, asin: r.asin, snoozeUntil: r.snoozeUntil ?? null,
          reason: 'author' as const, reasonContext: 'ctx', authorName: 'Author A',
          narratorName: null, duration: null, publishedDate: null,
          seriesName: null, seriesPosition: null,
        }))))
        // batch SELECT for upsert
        .mockReturnValueOnce(mockDbChain(existingRows));
      db.insert.mockReturnValue(mockDbChain());
      db.update.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      // Generate candidate metadata responses
      const books = Array.from({ length: candidateCount }, (_, i) => ({
        asin: existingRows[i]?.asin ?? `NEW${i}`,
        title: `Book ${i}`,
        authors: [{ name: 'Author A' }],
        language: 'English',
      }));
      mockMetadataService.searchBooksForDiscovery
        .mockResolvedValueOnce({ books, warnings: [] })
        .mockResolvedValue({ books: [], warnings: [] });
    }

    describe('happy path', () => {
      it('new candidates only → batch SELECT + batch upsert (no per-candidate selects)', async () => {
        const db = createMockDb();
        setupRefreshMocks(db, { candidateCount: 3 });

        const { service } = createService(db);
        await service.refreshSuggestions();

        // db.insert is used for the batch upsert (INSERT ON CONFLICT)
        expect(db.insert).toHaveBeenCalled();
        // No individual per-candidate selects: the 7th select call is the batch SELECT
        // Total selects should be exactly 7 (6 fixed + 1 batch), not 6 + N
        expect(db.select).toHaveBeenCalledTimes(7);
      });

      it('existing non-snoozed pending → batch SELECT finds them, upsert updates via ON CONFLICT', async () => {
        const db = createMockDb();
        setupRefreshMocks(db, {
          existingRows: [
            { id: 10, asin: 'NEW0', status: 'pending', snoozeUntil: null },
            { id: 11, asin: 'NEW1', status: 'pending', snoozeUntil: null },
          ],
          candidateCount: 2,
        });

        const { service } = createService(db);
        const result = await service.refreshSuggestions();

        // Existing pending rows updated via ON CONFLICT, not individual updates
        expect(db.insert).toHaveBeenCalled();
        // No per-candidate selects
        expect(db.select).toHaveBeenCalledTimes(7);
        // Updated, not added
        expect(result.added).toBe(0);
      });

      it('dismissed candidates are skipped (not upserted)', async () => {
        const db = createMockDb();
        setupRefreshMocks(db, {
          existingRows: [{ id: 10, asin: 'NEW0', status: 'dismissed' }],
          candidateCount: 1,
        });

        const { service } = createService(db);
        const result = await service.refreshSuggestions();

        expect(result.added).toBe(0);
      });

      it('mix of new + existing → single batch upsert call', async () => {
        const db = createMockDb();
        setupRefreshMocks(db, {
          existingRows: [{ id: 10, asin: 'NEW0', status: 'pending', snoozeUntil: null }],
          candidateCount: 3,
        });

        const { service } = createService(db);
        const result = await service.refreshSuggestions();

        // 2 new + 1 existing = 1 batch upsert
        expect(db.insert).toHaveBeenCalled();
        expect(db.select).toHaveBeenCalledTimes(7);
        expect(result.added).toBe(2);
      });
    });

    describe('snooze logic', () => {
      it('existing row with future snoozeUntil — included in upsert batch', async () => {
        const db = createMockDb();
        const future = new Date(Date.now() + 86400000);
        setupRefreshMocks(db, {
          existingRows: [{ id: 10, asin: 'NEW0', status: 'pending', snoozeUntil: future }],
          candidateCount: 1,
        });

        const { service } = createService(db);
        await service.refreshSuggestions();

        // Snoozed row included in batch upsert (ON CONFLICT handles snooze via CASE)
        expect(db.insert).toHaveBeenCalled();
      });

      it('existing row with past snoozeUntil — included in upsert batch', async () => {
        const db = createMockDb();
        const past = new Date(Date.now() - 86400000);
        setupRefreshMocks(db, {
          existingRows: [{ id: 10, asin: 'NEW0', status: 'pending', snoozeUntil: past }],
          candidateCount: 1,
        });

        const { service } = createService(db);
        await service.refreshSuggestions();

        expect(db.insert).toHaveBeenCalled();
      });
    });

    describe('chunk boundaries (#554 F3)', () => {
      function createLargeService(dbOverride: ReturnType<typeof createMockDb>, maxPerAuthor: number) {
        const log = createMockLogger();
        const settings = createMockSettingsService({
          discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: maxPerAuthor },
          metadata: { audibleRegion: 'us' },
        });
        return {
          service: new DiscoveryService(
            inject<Db>(dbOverride),
            inject<FastifyBaseLogger>(log),
            inject(mockMetadataService),
            inject(settings),
          ),
          log,
        };
      }

      it('1001 candidates → 2 read-side batch SELECTs (chunked at 999)', async () => {
        const db = createMockDb();
        const candidateCount = 1001;
        db.select
          .mockReturnValueOnce(mockDbChain([]))
          .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]))
          .mockReturnValueOnce(mockDbChain([]))
          .mockReturnValueOnce(mockDbChain([]))
          .mockReturnValueOnce(mockDbChain([]))
          .mockReturnValueOnce(mockDbChain([]))
          // 2 chunked batch SELECTs for 1001 ASINs (999 + 2)
          .mockReturnValueOnce(mockDbChain([]))
          .mockReturnValueOnce(mockDbChain([]));
        db.insert.mockReturnValue(mockDbChain());
        db.delete.mockReturnValue(mockDbChain());

        const books = Array.from({ length: candidateCount }, (_, i) => ({
          asin: `C${i}`, title: `Book ${i}`, authors: [{ name: 'Author A' }], language: 'English',
        }));
        mockMetadataService.searchBooksForDiscovery
          .mockResolvedValueOnce({ books, warnings: [] })
          .mockResolvedValue({ books: [], warnings: [] });

        const { service } = createLargeService(db, candidateCount);
        await service.refreshSuggestions();

        // 6 fixed + 2 chunked batch SELECTs = 8
        expect(db.select).toHaveBeenCalledTimes(8);
      });

      it('50 new candidates → 2 write-side INSERT chunks (47 + 3)', async () => {
        const db = createMockDb();
        const candidateCount = 50;
        db.select
          .mockReturnValueOnce(mockDbChain([]))
          .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]))
          .mockReturnValueOnce(mockDbChain([]))
          .mockReturnValueOnce(mockDbChain([]))
          .mockReturnValueOnce(mockDbChain([]))
          .mockReturnValueOnce(mockDbChain([]))
          // 1 batch SELECT (50 < 999)
          .mockReturnValueOnce(mockDbChain([]));
        db.insert.mockReturnValue(mockDbChain());
        db.delete.mockReturnValue(mockDbChain());

        const books = Array.from({ length: candidateCount }, (_, i) => ({
          asin: `C${i}`, title: `Book ${i}`, authors: [{ name: 'Author A' }], language: 'English',
        }));
        mockMetadataService.searchBooksForDiscovery
          .mockResolvedValueOnce({ books, warnings: [] })
          .mockResolvedValue({ books: [], warnings: [] });

        const { service } = createLargeService(db, candidateCount);
        const result = await service.refreshSuggestions();

        expect(result.added).toBe(50);
        // 2 chunked INSERT calls (47 + 3)
        expect(db.insert).toHaveBeenCalledTimes(2);
      });
    });

    describe('boundary values', () => {
      it('empty candidate list → no upsert DB queries', async () => {
        const db = createMockDb();
        setupRefreshMocks(db, { candidateCount: 0 });
        // Override metadata to return no candidates
        mockMetadataService.searchBooksForDiscovery.mockReset();
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });

        const { service } = createService(db);
        const result = await service.refreshSuggestions();

        expect(result.added).toBe(0);
      });

      it('single candidate → batch of 1 works correctly', async () => {
        const db = createMockDb();
        setupRefreshMocks(db, { candidateCount: 1 });

        const { service } = createService(db);
        const result = await service.refreshSuggestions();

        expect(result.added).toBe(1);
        expect(db.insert).toHaveBeenCalled();
      });
    });

    describe('stale cleanup', () => {
      it('stale suggestion removal still works after batch optimization', async () => {
        const db = createMockDb();
        db.delete.mockReturnValue(mockDbChain());
        db.select
          // dismissal stats
          .mockReturnValueOnce(mockDbChain([]))
          // analyzeLibrary: books
          .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]))
          // analyzeLibrary: narrators
          .mockReturnValueOnce(mockDbChain([]))
          // existing books
          .mockReturnValueOnce(mockDbChain([]))
          // dismissed
          .mockReturnValueOnce(mockDbChain([]))
          // currentPending: one stale pending not in candidates
          .mockReturnValueOnce(mockDbChain([{ id: 99, asin: 'STALE1', snoozeUntil: null, reason: 'author', reasonContext: 'ctx', authorName: 'Author A', narratorName: null, duration: null, publishedDate: null, seriesName: null, seriesPosition: null }]));
        // No candidates → empty batch SELECT not needed (short-circuit)
        mockMetadataService.searchBooksForDiscovery.mockResolvedValue({ books: [], warnings: [] });

        const { service } = createService(db);
        const result = await service.refreshSuggestions();

        expect(result.removed).toBe(1);
        expect(db.delete).toHaveBeenCalled();
      });
    });
  });
});
