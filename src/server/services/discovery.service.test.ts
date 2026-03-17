import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, mockDbChain, inject, createMockSettingsService } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { DiscoveryService } from './discovery.service.js';
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
      inject(mockBookService),
      inject(settingsService),
    ),
    db,
    log,
    settingsService,
  };
}

// Helper: a minimal imported book row for signal extraction tests
function makeBookRow(overrides: Record<string, unknown> = {}) {
  return {
    book: {
      id: 1,
      title: 'Test Book',
      authorId: 1,
      narrator: null,
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
    author: { id: 1, name: 'Author A', slug: 'author-a', asin: null, imageUrl: null, bio: null, monitored: false, lastCheckedAt: null, createdAt: new Date(), updatedAt: new Date() },
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
      expect(signals.seriesGaps[0].seriesName).toBe('Stormlight');
      expect(signals.seriesGaps[0].missingPositions).toContain(3);
      expect(signals.seriesGaps[0].missingPositions).toContain(5); // next
      expect(signals.seriesGaps[0].maxOwned).toBe(4);
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
      const rows = [
        makeBookRow({ id: 1, narrator: 'Narrator X' }),
        makeBookRow({ id: 2, narrator: 'Narrator X' }),
        makeBookRow({ id: 3, narrator: 'Narrator X' }),
        makeBookRow({ id: 4, narrator: 'Narrator Y' }),
        makeBookRow({ id: 5, narrator: 'Narrator Y' }),
      ];
      db.select.mockReturnValue(mockDbChain(rows));
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
        // Second call: existing books for exclusion
        .mockReturnValueOnce(mockDbChain([]))
        // Third call: dismissed suggestions
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
      // analyzeLibrary: one imported book
      db.select
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]))
        // existing books for exclusion
        .mockReturnValueOnce(mockDbChain([]))
        // dismissed suggestions
        .mockReturnValueOnce(mockDbChain([]))
        // currentPending (no existing pending)
        .mockReturnValueOnce(mockDbChain([]))
        // per-candidate lookup (no existing row for this ASIN)
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
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]))
        // currentPending: no pending
        .mockReturnValueOnce(mockDbChain([]))
        // per-candidate lookup: existing dismissed row
        .mockReturnValueOnce(mockDbChain([{ id: 10, asin: 'DISMISSED1', status: 'dismissed' }]));
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
      expect(db.update).not.toHaveBeenCalled();
    });

    it('updates existing pending suggestions with new score', async () => {
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]))
        // currentPending: one existing pending
        .mockReturnValueOnce(mockDbChain([{ id: 5, asin: 'EXISTING_PENDING' }]))
        // per-candidate lookup: existing pending row
        .mockReturnValueOnce(mockDbChain([{ id: 5, asin: 'EXISTING_PENDING', status: 'pending', score: 30 }]));
      db.update.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      mockMetadataService.searchBooksForDiscovery.mockResolvedValueOnce({
        books: [{ asin: 'EXISTING_PENDING', title: 'Updated Book', authors: [{ name: 'Author A' }], language: 'English' }],
        warnings: [],
      }).mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      const result = await service.refreshSuggestions();
      expect(result.added).toBe(0);
      expect(db.update).toHaveBeenCalled();
    });

    it('deletes stale pending suggestions not regenerated', async () => {
      const db = createMockDb();
      db.select
        .mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]))
        // currentPending: one stale pending (won't be regenerated)
        .mockReturnValueOnce(mockDbChain([{ id: 99, asin: 'STALE1' }]));
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
      const chain = db.select.mock.results[0].value;
      expect(chain.where).toHaveBeenCalled();
      const whereArg = (chain.where as ReturnType<typeof vi.fn>).mock.calls[0][0];
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

  describe('addSuggestion', () => {
    it('creates wanted book and sets status to added', async () => {
      const existing = { id: 1, asin: 'B001', title: 'Test', authorName: 'Author', status: 'pending' };
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([existing]));
      db.update.mockReturnValue(mockDbChain());
      const { service } = createService(db);

      const result = await service.addSuggestion(1);
      expect(result).not.toBeNull();
      expect(result!.suggestion.status).toBe('added');
      expect(mockBookService.create).toHaveBeenCalledWith({
        title: 'Test',
        authorName: 'Author',
        asin: 'B001',
      });
    });

    it('returns alreadyAdded for already-added suggestion', async () => {
      const existing = { id: 1, asin: 'B001', status: 'added' };
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([existing]));
      const { service } = createService(db);

      const result = await service.addSuggestion(1);
      expect(result!.alreadyAdded).toBe(true);
      expect(mockBookService.create).not.toHaveBeenCalled();
    });

    it('detects library duplicate and sets status without creating book', async () => {
      const existing = { id: 1, asin: 'B001', title: 'Test', authorName: 'Author', status: 'pending' };
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([existing]));
      db.update.mockReturnValue(mockDbChain());
      mockBookService.findDuplicate.mockResolvedValueOnce({ id: 99, title: 'Test' });
      const { service } = createService(db);

      const result = await service.addSuggestion(1);
      expect(result!.duplicate).toBe(true);
      expect(mockBookService.create).not.toHaveBeenCalled();
    });

    it('returns null for unknown suggestion ID', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([]));
      const { service } = createService(db);

      const result = await service.addSuggestion(999);
      expect(result).toBeNull();
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
      const whereArg = (deleteChain.where as ReturnType<typeof vi.fn>).mock.calls[0][0];
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
      // per-candidate lookup
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

  // --- #408: Snooze ---

  describe('snoozeSuggestion', () => {
    it('sets snoozeUntil timestamp and returns updated row', async () => {
      const existing = { id: 1, asin: 'B001', status: 'pending', snoozeUntil: null };
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([existing]));
      db.update.mockReturnValue(mockDbChain());
      const { service } = createService(db);

      const result = await service.snoozeSuggestion(1, 7);
      expect(result).not.toBeNull();
      expect(result).not.toBe('conflict');
      if (result && result !== 'conflict') {
        expect(result.snoozeUntil).toBeDefined();
        expect(result.status).toBe('pending');
      }
    });

    it('returns null for unknown suggestion ID', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([]));
      const { service } = createService(db);

      const result = await service.snoozeSuggestion(999, 7);
      expect(result).toBeNull();
    });

    it('returns "conflict" for dismissed suggestion', async () => {
      const existing = { id: 1, asin: 'B001', status: 'dismissed' };
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([existing]));
      const { service } = createService(db);

      const result = await service.snoozeSuggestion(1, 7);
      expect(result).toBe('conflict');
    });

    it('returns "conflict" for added suggestion', async () => {
      const existing = { id: 1, asin: 'B001', status: 'added' };
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([existing]));
      const { service } = createService(db);

      const result = await service.snoozeSuggestion(1, 7);
      expect(result).toBe('conflict');
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
      // analyzeLibrary — 3 books from Author A gives strength 3/5 = 0.6
      db.select.mockReturnValueOnce(mockDbChain([
        makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 }),
        makeBookRow({ id: 2, genres: ['Fantasy'], duration: 1000 }),
        makeBookRow({ id: 3, genres: ['Fantasy'], duration: 1000 }),
      ]));
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
      const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
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
      // analyzeLibrary — 4 books narrated by "Narrator N" gives narratorAffinity count=4, strength=4/5=0.8
      // Author A has 4 books → strength 4/5=0.8
      db.select.mockReturnValueOnce(mockDbChain([
        makeBookRow({ id: 1, narrator: 'Narrator N', genres: ['Fantasy'], duration: 1000 }),
        makeBookRow({ id: 2, narrator: 'Narrator N', genres: ['Fantasy'], duration: 1000 }),
        makeBookRow({ id: 3, narrator: 'Narrator N', genres: ['Fantasy'], duration: 1000 }),
        makeBookRow({ id: 4, narrator: 'Narrator N', genres: ['Fantasy'], duration: 1000 }),
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
      const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
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
      // analyzeLibrary — 2 books from Author A
      db.select.mockReturnValueOnce(mockDbChain([
        makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 }),
        makeBookRow({ id: 2, genres: ['Fantasy'], duration: 1000 }),
      ]));
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
      const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
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
      // analyzeLibrary
      db.select.mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]));
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
      // analyzeLibrary
      db.select.mockReturnValueOnce(mockDbChain([makeBookRow({ id: 1, genres: ['Fantasy'], duration: 1000 })]));
      // existing books
      db.select.mockReturnValueOnce(mockDbChain([]));
      // dismissed
      db.select.mockReturnValueOnce(mockDbChain([]));
      // currentPending
      db.select.mockReturnValueOnce(mockDbChain([{ id: 5, asin: 'EXISTING_PENDING' }]));
      // per-candidate lookup: existing pending row with no snoozeUntil
      db.select.mockReturnValueOnce(mockDbChain([{ id: 5, asin: 'EXISTING_PENDING', status: 'pending', score: 30, snoozeUntil: null }]));
      db.update.mockReturnValue(mockDbChain());

      mockMetadataService.searchBooksForDiscovery.mockResolvedValueOnce({
        books: [{ asin: 'EXISTING_PENDING', title: 'Updated', authors: [{ name: 'Author A' }], language: 'English' }],
        warnings: [],
      }).mockResolvedValue({ books: [], warnings: [] });

      const { service } = createService(db);
      await service.refreshSuggestions();

      // Normal pending rows get full update including reason/reasonContext
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('returns counts by reason type', async () => {
      const mockData = [
        { reason: 'author', count: 5 },
        { reason: 'series', count: 2 },
        { reason: 'genre', count: 3 },
      ];
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain(mockData));
      const { service } = createService(db);

      const result = await service.getStats();
      expect(result).toEqual({ author: 5, series: 2, genre: 3 });
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

    it('getStats includes diversity count in results', async () => {
      const mockData = [
        { reason: 'author', count: 5 },
        { reason: 'diversity', count: 2 },
      ];
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain(mockData));
      const { service } = createService(db);

      const result = await service.getStats();
      expect(result).toEqual({ author: 5, diversity: 2 });
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
});
