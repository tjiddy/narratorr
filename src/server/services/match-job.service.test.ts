import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { MatchJobService, type MatchCandidate } from './match-job.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { MetadataService } from './metadata.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';

// Mock audio scanner
vi.mock('../../core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn().mockResolvedValue(null),
}));

// Mock crypto.randomUUID for deterministic job IDs
vi.mock('node:crypto', () => ({
  randomUUID: vi.fn().mockReturnValue('test-job-id'),
}));

import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { randomUUID } from 'node:crypto';

// -------- Helpers --------

function makeBookMetadata(overrides: Partial<BookMetadata> = {}): BookMetadata {
  return {
    title: 'The Way of Kings',
    authors: [{ name: 'Brandon Sanderson' }],
    ...overrides,
  };
}

function createMockMetadataService(): MetadataService {
  return inject<MetadataService>({
    searchBooks: vi.fn().mockResolvedValue([]),
    getBook: vi.fn().mockResolvedValue(null),
    search: vi.fn(),
    searchAuthors: vi.fn(),
    searchSeries: vi.fn(),
    getAuthor: vi.fn(),
    getAuthorBooks: vi.fn(),
    getSeries: vi.fn(),
    configure: vi.fn(),
    test: vi.fn(),
  });
}

/** Flush microtask queue so async job work completes */
function flushPromises(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 50));
}

/** Wait for a job to reach a terminal status */
async function waitForJob(service: MatchJobService, id: string, maxMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const status = service.getJob(id);
    if (!status || status.status === 'completed' || status.status === 'cancelled') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const sampleCandidate: MatchCandidate = {
  path: '/audiobooks/The Way of Kings',
  title: 'The Way of Kings',
  author: 'Brandon Sanderson',
};

// -------- Tests --------

describe('MatchJobService', () => {
  let service: MatchJobService;
  let metadataService: ReturnType<typeof createMockMetadataService>;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    log = createMockLogger();
    metadataService = createMockMetadataService();
    service = new MatchJobService(metadataService, inject<FastifyBaseLogger>(log));
    (randomUUID as ReturnType<typeof vi.fn>).mockReturnValue('test-job-id');
  });

  describe('createJob', () => {
    it('returns a job ID and logs creation', () => {
      const id = service.createJob([sampleCandidate]);
      expect(id).toBe('test-job-id');
      expect(log.info).toHaveBeenCalledWith(
        { jobId: 'test-job-id', bookCount: 1 },
        'Match job created',
      );
    });

    it('job starts in matching status', () => {
      const id = service.createJob([sampleCandidate]);
      const status = service.getJob(id);
      expect(status).not.toBeNull();
      expect(status!.status).toBe('matching');
      expect(status!.total).toBe(1);
      expect(status!.matched).toBe(0);
    });

    it('creates separate jobs with unique IDs', () => {
      (randomUUID as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce('id-1')
        .mockReturnValueOnce('id-2');

      const id1 = service.createJob([sampleCandidate]);
      const id2 = service.createJob([sampleCandidate]);
      expect(id1).toBe('id-1');
      expect(id2).toBe('id-2');
      expect(service.getJob('id-1')).not.toBeNull();
      expect(service.getJob('id-2')).not.toBeNull();
    });
  });

  describe('getJob', () => {
    it('returns null for unknown job ID', () => {
      expect(service.getJob('nonexistent')).toBeNull();
    });

    it('returns a snapshot (not a live reference) of results', async () => {
      const meta = makeBookMetadata({ providerId: undefined });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([meta]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const status1 = service.getJob(id);
      const status2 = service.getJob(id);
      expect(status1!.results).toEqual(status2!.results);
      expect(status1!.results).not.toBe(status2!.results);
    });
  });

  describe('cancelJob', () => {
    it('returns false for unknown job ID', () => {
      expect(service.cancelJob('nonexistent')).toBe(false);
    });

    it('cancels an existing job and logs it', () => {
      const id = service.createJob([sampleCandidate]);
      const result = service.cancelJob(id);
      expect(result).toBe(true);
      expect(log.info).toHaveBeenCalledWith({ jobId: id }, 'Match job cancelled');

      const status = service.getJob(id);
      expect(status!.status).toBe('cancelled');
    });

    it('cancellation prevents further book matching', async () => {
      const books: MatchCandidate[] = Array.from({ length: 20 }, (_, i) => ({
        path: `/audiobooks/book-${i}`,
        title: `Book ${i}`,
      }));

      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        // Small delay to give cancellation a chance
        await new Promise(resolve => setTimeout(resolve, 5));
        return [];
      });

      const id = service.createJob(books);
      // Cancel immediately
      service.cancelJob(id);

      await waitForJob(service, id);

      const status = service.getJob(id)!;
      expect(status.status).toBe('cancelled');
    });
  });

  describe('TTL cleanup', () => {
    it('removes job after TTL expires', async () => {
      vi.useFakeTimers();
      try {
        const meta = makeBookMetadata({ providerId: undefined });
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([meta]);

        const id = service.createJob([sampleCandidate]);

        // Manually advance time in small increments to flush microtasks
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(1);
        }

        expect(service.getJob(id)).not.toBeNull();
        expect(service.getJob(id)!.status).toBe('completed');

        // Advance 10 minutes (TTL)
        vi.advanceTimersByTime(10 * 60 * 1000);

        expect(service.getJob(id)).toBeNull();
        expect(log.debug).toHaveBeenCalledWith(
          { jobId: id },
          'Match job expired and removed',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('job is still accessible before TTL expires', async () => {
      vi.useFakeTimers();
      try {
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const id = service.createJob([sampleCandidate]);
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(1);
        }

        // Advance 9 minutes — should still be there
        vi.advanceTimersByTime(9 * 60 * 1000);
        expect(service.getJob(id)).not.toBeNull();

        // Advance past 10 minutes total
        vi.advanceTimersByTime(2 * 60 * 1000);
        expect(service.getJob(id)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('job lifecycle', () => {
    it('transitions from matching → completed when all books processed', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([sampleCandidate]);
      expect(service.getJob(id)!.status).toBe('matching');

      await waitForJob(service, id);

      const status = service.getJob(id)!;
      expect(status.status).toBe('completed');
      expect(status.matched).toBe(1);
    });

    it('handles empty book list', async () => {
      const id = service.createJob([]);
      await waitForJob(service, id);

      const status = service.getJob(id)!;
      expect(status.status).toBe('completed');
      expect(status.total).toBe(0);
      expect(status.matched).toBe(0);
      expect(status.results).toEqual([]);
    });

    it('logs summary on completion', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'test-job-id',
          total: 1,
          cancelled: false,
        }),
        'Match job finished',
      );
    });
  });

  describe('confidence scoring', () => {
    it('returns none confidence when no search results', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('none');
      expect(result.bestMatch).toBeNull();
      expect(result.alternatives).toEqual([]);
    });

    it('returns high confidence for single search result', async () => {
      const meta = makeBookMetadata({ providerId: 'asin-123' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([meta]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue({
        asin: 'B123',
        duration: 600,
      });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('high');
      expect(result.bestMatch).toBeTruthy();
      expect(result.alternatives).toEqual([]);
    });

    it('returns medium confidence for multiple results without duration data', async () => {
      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: undefined }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('medium');
      expect(result.bestMatch).toEqual(results[0]);
      expect(result.alternatives).toEqual([results[1]]);
    });

    it('returns medium confidence when no audio duration available and multiple results', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined, duration: 300 }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: undefined, duration: 400 }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('medium');
    });

    it('considers all search results, not just the first few (DCC regression)', async () => {
      // Simulates Audible returning the correct match at position 8 of 10
      const candidate: MatchCandidate = {
        path: '/audiobooks/Matt Dinniman/Dungeon Crawler Carl/01 - Dungeon Crawler Carl',
        title: 'Dungeon Crawler Carl',
        author: 'Matt Dinniman',
      };

      // 7 wrong results followed by the correct one
      const wrongResults = Array.from({ length: 7 }, (_, i) =>
        makeBookMetadata({
          title: `Wrong Book ${i + 1}`,
          authors: [{ name: 'Matt Dinniman' }],
          providerId: `wrong-${i}`,
        }),
      );
      const correctResult = makeBookMetadata({
        title: 'Dungeon Crawler Carl',
        authors: [{ name: 'Matt Dinniman' }],
        providerId: 'correct-asin',
      });
      const allResults = [...wrongResults, correctResult];

      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(allResults);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.bestMatch!.title).toBe('Dungeon Crawler Carl');
      expect(result.confidence).not.toBe('none');
    });
  });

  describe('runtime disambiguation', () => {
    it('promotes to high confidence when best match duration within 5%', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 minutes
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Unabridged)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 610 }) // 1.67% off
        .mockResolvedValueOnce({ asin: 'A2', duration: 800 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('high');
      expect(result.bestMatch!.title).toBe('The Way of Kings');
      expect(result.alternatives).toHaveLength(1);
    });

    it('stays medium confidence when best match duration exceeds strict 5% threshold (low score)', async () => {
      // Use a candidate with slightly different title to get a combined score < 0.95
      const weakCandidate: MatchCandidate = {
        path: '/audiobooks/Doctor Sleep',
        title: 'Doctor Sleep',
        author: 'Stephen King',
      };

      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'Doctor Sleep: A Novel', authors: [{ name: 'Stephen King' }], providerId: 'p1' }),
        makeBookMetadata({ title: 'Doctor Sleep (Unabridged)', authors: [{ name: 'Stephen King' }], providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 650 }) // 8.3% off — exceeds strict 5%
        .mockResolvedValueOnce({ asin: 'A2', duration: 700 });

      const id = service.createJob([weakCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('medium');
      expect(result.bestMatch!.title).toBe('Doctor Sleep: A Novel');
    });

    it('preserves similarity-ranked order — duration does not override winner', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 min
        files: [],
      });

      // "The Way of Kings" is best similarity match, even though "Completely Different" has closer duration
      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'Completely Different Book', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 900 }) // 50% off — but better similarity
        .mockResolvedValueOnce({ asin: 'A2', duration: 600 }); // exact match — but worse similarity

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      // Similarity winner is bestMatch, not duration winner
      expect(result.bestMatch!.title).toBe('The Way of Kings');
    });

    it('includes all results in alternatives after similarity-ranked bestMatch', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings Companion', providerId: undefined }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        asin: 'A1',
        duration: 600,
      });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.bestMatch!.title).toBe('The Way of Kings');
      expect(result.alternatives).toHaveLength(1);
      expect(result.alternatives[0].title).toBe('The Way of Kings Companion');
    });

    it('converts audio seconds to minutes for duration confidence', async () => {
      // 90 seconds = 2 minutes (rounded)
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 90,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 2 }) // exact match at 2 min
        .mockResolvedValueOnce({ asin: 'A2', duration: 100 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      // Duration of top similarity result matches → high confidence
      expect(result.confidence).toBe('high');
      expect(result.bestMatch!.title).toBe('The Way of Kings');
    });

    it('skips duration disambiguation when audio scan returns zero duration', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 0,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined, duration: 300 }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: undefined, duration: 400 }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('medium');
      expect(result.bestMatch!.title).toBe('The Way of Kings');
    });

    it('falls through to medium when all detailed results have no duration', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined }),
        makeBookMetadata({ title: 'The Way of Kings (Unabridged)', providerId: undefined }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('medium');
      expect(result.bestMatch!.title).toBe('The Way of Kings');
    });
  });

  describe('search query construction', () => {
    it('uses "title author" query with structured options when author is provided', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([{ path: '/books/x', title: 'Dune', author: 'Frank Herbert' }]);
      await waitForJob(service, id);

      expect(metadataService.searchBooks).toHaveBeenCalledWith('Dune Frank Herbert', {
        title: 'Dune',
        author: 'Frank Herbert',
      });
    });

    it('uses title only query with structured options when author is not provided', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([{ path: '/books/x', title: 'Dune' }]);
      await waitForJob(service, id);

      expect(metadataService.searchBooks).toHaveBeenCalledWith('Dune', {
        title: 'Dune',
        author: undefined,
      });
    });
  });

  describe('detail fetching', () => {
    it('fetches detail for results with providerId but no asin', async () => {
      const searchResult = makeBookMetadata({ title: 'Book', providerId: 'prov-1' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([searchResult]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue({
        asin: 'B001',
        duration: 500,
      });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      expect(metadataService.getBook).toHaveBeenCalledWith('prov-1');
    });

    it('does not fetch detail for results that already have asin', async () => {
      const searchResult = makeBookMetadata({
        title: 'Book',
        providerId: 'prov-1',
        asin: 'already-has-asin',
      });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([searchResult]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      expect(metadataService.getBook).not.toHaveBeenCalled();
    });

    it('does not fetch detail for results without providerId', async () => {
      const searchResult = makeBookMetadata({ title: 'Book', providerId: undefined });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([searchResult]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      expect(metadataService.getBook).not.toHaveBeenCalled();
    });

    it('falls back to search result when detail fetch fails', async () => {
      const searchResult = makeBookMetadata({ title: 'The Way of Kings', providerId: 'prov-1' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([searchResult]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('API down'),
      );

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('high');
      expect(result.bestMatch!.title).toBe('The Way of Kings');
    });

    it('falls back to search result when detail fetch returns null', async () => {
      const searchResult = makeBookMetadata({ title: 'Null Detail', providerId: 'prov-1' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([searchResult]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.bestMatch!.title).toBe('Null Detail');
    });

    it('fetches details for all search results', async () => {
      const results = Array.from({ length: 8 }, (_, i) =>
        makeBookMetadata({ title: `Book ${i}`, providerId: `prov-${i}` }),
      );
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue({
        asin: 'X',
        duration: 100,
      });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      expect(metadataService.getBook).toHaveBeenCalledTimes(8);
    });

    it('merges detail into search result preserving original title', async () => {
      const searchResult = makeBookMetadata({ title: 'Original Title', providerId: 'prov-1' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([searchResult]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue({
        title: 'Different Title From Detail',
        asin: 'B001',
        duration: 500,
      });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.bestMatch!.title).toBe('Original Title');
      expect(result.bestMatch!.asin).toBe('B001');
    });
  });

  describe('error handling', () => {
    it('returns none confidence with error message when search throws', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network failure'),
      );

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('none');
      expect(result.bestMatch).toBeNull();
      expect(result.error).toBe('Network failure');
    });

    it('handles non-Error thrown values', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockRejectedValue('string error');

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.error).toBe('Unknown error');
    });

    it('continues matching other books when one fails', async () => {
      const books: MatchCandidate[] = [
        { path: '/books/fail', title: 'Fail Book' },
        { path: '/books/succeed', title: 'Succeed Book' },
      ];

      (metadataService.searchBooks as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Boom'))
        .mockResolvedValueOnce([]);

      const id = service.createJob(books);
      await waitForJob(service, id);

      const status = service.getJob(id)!;
      expect(status.status).toBe('completed');
      expect(status.matched).toBe(2);
      const errResult = status.results.find(r => r.path === '/books/fail');
      const okResult = status.results.find(r => r.path === '/books/succeed');
      expect(errResult!.error).toBe('Boom');
      expect(okResult!.confidence).toBe('none');
      expect(okResult!.error).toBeUndefined();
    });

    it('proceeds without duration when audio scan throws', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('ffprobe not found'),
      );
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeBookMetadata({ providerId: undefined }),
      ]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('high');
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ path: sampleCandidate.path }),
        'Audio scan failed \u2014 proceeding without duration',
      );
    });
  });

  describe('concurrency', () => {
    it('limits concurrent matching to 5', async () => {
      let concurrentCount = 0;
      let maxConcurrent = 0;

      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        // Small real delay to let concurrency build up
        await new Promise(resolve => setTimeout(resolve, 20));
        concurrentCount--;
        return [];
      });

      const books: MatchCandidate[] = Array.from({ length: 15 }, (_, i) => ({
        path: `/books/book-${i}`,
        title: `Book ${i}`,
      }));

      const id = service.createJob(books);
      await waitForJob(service, id, 5000);

      expect(maxConcurrent).toBeLessThanOrEqual(5);
      expect(maxConcurrent).toBeGreaterThan(1);
    });
  });

  describe('multiple books in single job', () => {
    it('processes all books and reports correct totals', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const books: MatchCandidate[] = [
        { path: '/books/a', title: 'Book A' },
        { path: '/books/b', title: 'Book B', author: 'Author B' },
        { path: '/books/c', title: 'Book C' },
      ];

      const id = service.createJob(books);
      await waitForJob(service, id);

      const status = service.getJob(id)!;
      expect(status.status).toBe('completed');
      expect(status.total).toBe(3);
      expect(status.matched).toBe(3);
      expect(status.results).toHaveLength(3);
    });

    it('each book gets its own result with correct path', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const books: MatchCandidate[] = [
        { path: '/books/a', title: 'Book A' },
        { path: '/books/b', title: 'Book B' },
      ];

      const id = service.createJob(books);
      await waitForJob(service, id);

      const paths = service.getJob(id)!.results.map(r => r.path);
      expect(paths).toContain('/books/a');
      expect(paths).toContain('/books/b');
    });
  });

  describe('edge cases', () => {
    it('handles exact 5% duration threshold as high confidence (inclusive)', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 min
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Unabridged)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 630 }) // exactly 5%
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      // Fixed: "within 5%" is inclusive (<=), so exact 5% gets high confidence
      expect(result.confidence).toBe('high');
    });

    it('handles just under 5% threshold as high confidence', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 min
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 629 }) // 4.83%
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('high');
    });

    it('handles book with empty string title', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([{ path: '/books/empty', title: '' }]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('none');
      expect(metadataService.searchBooks).toHaveBeenCalledWith('', {
        title: '',
        author: undefined,
      });
    });

    it('detail fetch stops on cancellation', async () => {
      const results = Array.from({ length: 5 }, (_, i) =>
        makeBookMetadata({ title: `Book ${i}`, providerId: `prov-${i}` }),
      );
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      let getBookCalls = 0;
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        getBookCalls++;
        if (getBookCalls === 1) {
          service.cancelJob('test-job-id');
        }
        return { asin: 'X', duration: 100 };
      });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      // fetchDetails checks cancelled between each iteration, so after first call
      // triggers cancel, subsequent iterations should break
      expect(getBookCalls).toBeLessThanOrEqual(2);
    });

    it('polling mid-job shows incremental progress', async () => {
      let resolveFirst!: (v: BookMetadata[]) => void;
      let resolveSecond!: (v: BookMetadata[]) => void;

      (metadataService.searchBooks as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(new Promise<BookMetadata[]>(r => { resolveFirst = r; }))
        .mockReturnValueOnce(new Promise<BookMetadata[]>(r => { resolveSecond = r; }));

      const books: MatchCandidate[] = [
        { path: '/books/a', title: 'Book A' },
        { path: '/books/b', title: 'Book B' },
      ];

      const id = service.createJob(books);

      // Initially no results
      expect(service.getJob(id)!.matched).toBe(0);

      // Resolve first book
      resolveFirst([]);
      await flushPromises();

      expect(service.getJob(id)!.matched).toBe(1);
      expect(service.getJob(id)!.status).toBe('matching');

      // Resolve second book
      resolveSecond([]);
      await flushPromises();

      // May need a bit more time for the done flag
      await waitForJob(service, id);
      expect(service.getJob(id)!.matched).toBe(2);
      expect(service.getJob(id)!.status).toBe('completed');
    });
  });

  // ── #335 Tiered duration threshold based on combined score ──────────────
  describe('tiered duration threshold (#335)', () => {
    it('high combined score (1.0) + duration within 15% → confidence high', async () => {
      // sampleCandidate: "The Way of Kings" by "Brandon Sanderson" → score 1.0
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 min
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 660 }) // 10% off — within 15% relaxed
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('high');
    });

    it('high combined score (1.0) + duration at exactly 15% boundary → confidence high (inclusive)', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 min
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 690 }) // exactly 15%
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('high');
    });

    it('high combined score (1.0) + duration at 16% → confidence medium', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 min
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 696 }) // 16% off
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('medium');
    });

    it('low combined score (0.8) + duration within 5% → confidence high (existing behavior)', async () => {
      // Use a candidate with slightly different title to lower score below 0.95
      const weakCandidate: MatchCandidate = {
        path: '/audiobooks/Doctor Sleep',
        title: 'Doctor Sleep',
        author: 'Stephen King',
      };

      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 min
        files: [],
      });

      // "Doctor Sleep" search returns results with somewhat different title
      const results = [
        makeBookMetadata({ title: 'Doctor Sleep: A Novel', authors: [{ name: 'Stephen King' }], providerId: 'p1' }),
        makeBookMetadata({ title: 'Doctor Sleep (Unabridged)', authors: [{ name: 'Stephen King' }], providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 620 }) // 3.3% off — within strict 5%
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([weakCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('high');
    });

    it('low combined score + duration at 6% → confidence medium (strict threshold applies)', async () => {
      const weakCandidate: MatchCandidate = {
        path: '/audiobooks/Doctor Sleep',
        title: 'Doctor Sleep',
        author: 'Stephen King',
      };

      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 min
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'Doctor Sleep: A Novel', authors: [{ name: 'Stephen King' }], providerId: 'p1' }),
        makeBookMetadata({ title: 'Doctor Sleep (Unabridged)', authors: [{ name: 'Stephen King' }], providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 640 }) // 6.7% off — exceeds strict 5%
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([weakCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('medium');
    });

    it('perfect title + mismatched author (combined ≈ 0.6) + 10% duration → medium', async () => {
      // Perfect title match but wrong author → combined score well below 0.95
      const candidate: MatchCandidate = {
        path: '/audiobooks/The Way of Kings',
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
      };

      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 min
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', authors: [{ name: 'Completely Different Person' }], providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings Guide', authors: [{ name: 'Completely Different Person' }], providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 660 }) // 10% off — within relaxed 15% but score < 0.95
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      // Score ≈ 0.6 (title 1.0 * 0.6 + author ~0.0 * 0.4), strict 5% applies → 10% exceeds → medium
      expect(result.confidence).toBe('medium');
    });
  });

  // ── #229 Observability — elapsed time ───────────────────────────────────
  describe('elapsed time (#229)', () => {
    it('match job completion log includes elapsedMs field', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'test-job-id', elapsedMs: expect.any(Number) }),
        'Match job finished',
      );
    });

    it('cancelled match job completion log still includes elapsedMs', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return [];
      });

      const id = service.createJob([sampleCandidate]);
      service.cancelJob(id);
      await waitForJob(service, id);
      // Allow the async run() to flush its final log after cancellation
      await flushPromises();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'test-job-id', cancelled: true, elapsedMs: expect.any(Number) }),
        'Match job finished',
      );
    });
  });

  describe('result scoring integration', () => {
    it('re-ranks results by scoreResult() before selection', async () => {
      // Provider returns "Wrong Book" first, but "The Way of Kings" matches better
      const results = [
        makeBookMetadata({ title: 'Completely Wrong Book', providerId: undefined }),
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      // Re-ranking puts "The Way of Kings" first due to higher score
      expect(result.bestMatch!.title).toBe('The Way of Kings');
    });

    it('title similarity < 50% on top result sets confidence to none', async () => {
      const results = [
        makeBookMetadata({ title: 'Totally Different Book', providerId: undefined }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('none');
      expect(result.bestMatch!.title).toBe('Totally Different Book');
    });

    it('title similarity exactly 50% sets confidence to medium (boundary)', async () => {
      // Use two similar-ish titles that produce ~50% similarity
      // "Way Kings" vs "The Way of Kings" — enough overlap to reach ~50%
      const candidate: MatchCandidate = { path: '/books/test', title: 'Way Kings', author: 'Sanderson' };
      const results = [
        makeBookMetadata({ title: 'Way Kings Edition', providerId: undefined }),
        makeBookMetadata({ title: 'Way Kings Reprint', providerId: undefined }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      // With similar titles, confidence should be medium (not none)
      expect(result.confidence).toBe('medium');
    });

    it('title similarity > 50% with author match gives medium or high confidence', async () => {
      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: undefined }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(['medium', 'high']).toContain(result.confidence);
    });

    it('duration still promotes to high when ≤ 5% threshold with scoring', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Other)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 610 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 800 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('high');
    });

    it('low title score with duration match still returns none if title < 50%', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'Unrelated Book', providerId: 'p1' }),
        makeBookMetadata({ title: 'Another Unrelated', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 600 }) // exact match
        .mockResolvedValueOnce({ asin: 'A2', duration: 800 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('none');
    });

    it('similarity winner stays bestMatch even when worse-scoring result has closer duration', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 min
        files: [],
      });

      // "The Way of Kings" has higher similarity to candidate than "Ready Player One"
      // But "Ready Player One" has closer duration
      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'Ready Player One', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 900 }) // 50% off — worse duration
        .mockResolvedValueOnce({ asin: 'A2', duration: 601 }); // ~0.2% off — better duration

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      // Similarity winner remains bestMatch — duration does NOT override selection
      expect(result.bestMatch!.title).toBe('The Way of Kings');
      // Duration of bestMatch (900 vs 600) is 50% off → medium confidence
      expect(result.confidence).toBe('medium');
    });
  });

  describe('year tiebreaker', () => {
    it('extracts year from basename and uses as tiebreaker for equal scores', async () => {
      const candidate: MatchCandidate = {
        path: '/audiobooks/The Way of Kings 2010',
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
      };

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined, publishedDate: '2015-01-01' }),
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined, publishedDate: '2010-08-31' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      // Year tiebreaker prefers the 2010 match
      expect(result.bestMatch!.publishedDate).toBe('2010-08-31');
    });

    it('extracts year from parenthesized year in path', async () => {
      const candidate: MatchCandidate = {
        path: '/audiobooks/The Way of Kings (2010)',
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
      };

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined, publishedDate: '2015-01-01' }),
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined, publishedDate: '2010-08-31' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.bestMatch!.publishedDate).toBe('2010-08-31');
    });

    it('no year in path — tiebreaker skipped, uses score ordering', async () => {
      const candidate: MatchCandidate = {
        path: '/audiobooks/The Way of Kings',
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
      };

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined, publishedDate: '2010-01-01' }),
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined, publishedDate: '2015-01-01' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      // Without year, first result by score (they're equal, so order preserved)
      expect(result.bestMatch!.publishedDate).toBe('2010-01-01');
    });

    it('different scores — higher score wins regardless of year', async () => {
      const candidate: MatchCandidate = {
        path: '/audiobooks/The Way of Kings 2015',
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
      };

      const results = [
        makeBookMetadata({ title: 'Totally Different Book', providerId: undefined, publishedDate: '2015-01-01' }),
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined, publishedDate: '2010-01-01' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      // Higher score wins even though year matches the other result
      expect(result.bestMatch!.title).toBe('The Way of Kings');
    });
  });

  describe('structured search params', () => {
    it('sends structured title and author via options when parsed data available', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      expect(metadataService.searchBooks).toHaveBeenCalledWith(
        'The Way of Kings Brandon Sanderson',
        { title: 'The Way of Kings', author: 'Brandon Sanderson' },
      );
    });

    it('sends only title via options when no author parsed', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([{ path: '/books/x', title: 'Dune' }]);
      await waitForJob(service, id);

      expect(metadataService.searchBooks).toHaveBeenCalledWith('Dune', {
        title: 'Dune',
        author: undefined,
      });
    });
  });

  // ── #415 Match confidence reason ──────────────────────────────────────
  describe('match confidence reason (#415)', () => {
    describe('reason populated for medium confidence', () => {
      it('duration exceeds strict threshold (>5%) with score < 0.95 → reason includes "Duration mismatch" with scanned and expected hours', async () => {
        const weakCandidate: MatchCandidate = {
          path: '/audiobooks/Doctor Sleep',
          title: 'Doctor Sleep',
          author: 'Stephen King',
        };
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 36000, // 600 min
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'Doctor Sleep: A Novel', authors: [{ name: 'Stephen King' }], providerId: 'p1' }),
          makeBookMetadata({ title: 'Doctor Sleep (Unabridged)', authors: [{ name: 'Stephen King' }], providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 650 }) // 8.3% off — exceeds strict 5%
          .mockResolvedValueOnce({ asin: 'A2', duration: 700 });

        const id = service.createJob([weakCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('medium');
        expect(result.reason).toBeDefined();
        expect(result.reason).toContain('Duration mismatch');
        // 600 min = 10.0 hrs scanned; 650 min = 10.8 hrs expected
        expect(result.reason).toContain('10.0');
        expect(result.reason).toContain('10.8');
      });

      it('duration exceeds relaxed threshold (>15%) with score ≥ 0.95 → reason includes "Duration mismatch" with both values', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 36000, // 600 min
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 696 }) // 16% off
          .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('medium');
        expect(result.reason).toBeDefined();
        expect(result.reason).toContain('Duration mismatch');
        // 600 min = 10.0 hrs scanned; 696 min = 11.6 hrs expected
        expect(result.reason).toContain('10.0');
        expect(result.reason).toContain('11.6');
      });

      it('multiple results with no duration data (scanned duration null) → reason is "Multiple results — no duration data to disambiguate"', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
          .mockResolvedValueOnce({ asin: 'A2', duration: 800 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('medium');
        expect(result.reason).toBe('Multiple results — no duration data to disambiguate');
      });

      it('multiple results with zero scanned duration → reason uses no-duration-data path, not "0.0hrs"', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 0,
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
          .mockResolvedValueOnce({ asin: 'A2', duration: 800 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('medium');
        expect(result.reason).toBe('Multiple results — no duration data to disambiguate');
        expect(result.reason).not.toContain('0.0');
      });

      it('multiple results, top result lacks duration but scanned duration exists → reason is "Best match missing duration — cannot verify"', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 36000, // 600 min
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        // Top result has NO duration, second result does
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1' }) // no duration
          .mockResolvedValueOnce({ asin: 'A2', duration: 800 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('medium');
        expect(result.reason).toBe('Best match missing duration — cannot verify');
      });

      it('duration just over strict threshold (5.1%) with score < 0.95 → medium confidence with duration-mismatch reason', async () => {
        const weakCandidate: MatchCandidate = {
          path: '/audiobooks/Doctor Sleep',
          title: 'Doctor Sleep',
          author: 'Stephen King',
        };
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 60000, // 1000 min
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'Doctor Sleep: A Novel', authors: [{ name: 'Stephen King' }], providerId: 'p1' }),
          makeBookMetadata({ title: 'Doctor Sleep (Unabridged)', authors: [{ name: 'Stephen King' }], providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 1051 }) // 5.1% off
          .mockResolvedValueOnce({ asin: 'A2', duration: 1200 });

        const id = service.createJob([weakCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('medium');
        expect(result.reason).toContain('Duration mismatch');
      });

      it('duration just over relaxed threshold (15.1%) with score ≥ 0.95 → medium confidence with duration-mismatch reason', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 60000, // 1000 min
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 1151 }) // 15.1% off
          .mockResolvedValueOnce({ asin: 'A2', duration: 1300 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('medium');
        expect(result.reason).toContain('Duration mismatch');
      });
    });

    describe('reason NOT populated for high/none confidence', () => {
      it('single result with high confidence → reason is undefined', async () => {
        const meta = makeBookMetadata({ providerId: 'asin-123' });
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([meta]);
        (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue({ asin: 'B123', duration: 600 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('high');
        expect(result.reason).toBeUndefined();
      });

      it('no search results (none confidence) → reason is undefined', async () => {
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('none');
        expect(result.reason).toBeUndefined();
      });

      it('title similarity below 50% floor (none confidence) → reason is undefined', async () => {
        const results = [
          makeBookMetadata({ title: 'Completely Different Book', providerId: 'p1' }),
          makeBookMetadata({ title: 'Another Unrelated Book', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1' })
          .mockResolvedValueOnce({ asin: 'A2' });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('none');
        expect(result.reason).toBeUndefined();
      });

      it('error during matching (none confidence with error field) → reason is undefined', async () => {
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API failure'));

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('none');
        expect(result.error).toBe('API failure');
        expect(result.reason).toBeUndefined();
      });

      it('duration at exactly 5.0% strict threshold (inclusive <=) → high confidence, no reason', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 36000, // 600 min
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Unabridged)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 630 }) // exactly 5%
          .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('high');
        expect(result.reason).toBeUndefined();
      });

      it('duration at exactly 15.0% relaxed threshold with high score (inclusive <=) → high confidence, no reason', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 36000, // 600 min
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 690 }) // exactly 15%
          .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('high');
        expect(result.reason).toBeUndefined();
      });
    });

    describe('duration conversion in reason string', () => {
      it('converts minutes to hours correctly in reason string (e.g., 2229 min → 37.2 hrs)', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 2229 * 60, // 2229 min in seconds
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 2730 }) // ~22% off from 2229
          .mockResolvedValueOnce({ asin: 'A2', duration: 3000 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result.confidence).toBe('medium');
        expect(result.reason).toContain('37.1');
        expect(result.reason).toContain('45.5');
      });
    });
  });

  describe('matchSingleBook swap retry (issue #426)', () => {
    it.todo('returns match when first search succeeds — no swap');
    it.todo('retries with swapped author/title on zero results');
    it.todo('does not swap when author is absent');
    it.todo('returns none confidence when both searches return empty');
    it.todo('applies title similarity threshold to swap-retry results');
    it.todo('swap retry error does not crash job');
  });
});
