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
        makeBookMetadata({ title: 'Book A', providerId: undefined, duration: 300 }),
        makeBookMetadata({ title: 'Book B', providerId: undefined, duration: 400 }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('medium');
    });
  });

  describe('runtime disambiguation', () => {
    it('promotes to high confidence when best match duration within 5%', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 minutes
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'Book A', providerId: 'p1' }),
        makeBookMetadata({ title: 'Book B', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 610 }) // 1.67% off
        .mockResolvedValueOnce({ asin: 'A2', duration: 800 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('high');
      expect(result.bestMatch!.title).toBe('Book A');
      expect(result.alternatives).toHaveLength(1);
    });

    it('stays medium confidence when best match duration exceeds 5% threshold', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'Book A', providerId: 'p1' }),
        makeBookMetadata({ title: 'Book B', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 650 }) // 8.3% off
        .mockResolvedValueOnce({ asin: 'A2', duration: 700 }); // 16.7% off

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('medium');
      expect(result.bestMatch!.title).toBe('Book A');
    });

    it('sorts alternatives by duration distance', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000, // 600 min
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'Far', providerId: 'p1' }),
        makeBookMetadata({ title: 'Close', providerId: 'p2' }),
        makeBookMetadata({ title: 'Mid', providerId: 'p3' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 900 }) // Far: 50% off
        .mockResolvedValueOnce({ asin: 'A2', duration: 590 }) // Close: 1.7% off
        .mockResolvedValueOnce({ asin: 'A3', duration: 700 }); // Mid: 16.7% off

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.bestMatch!.title).toBe('Close');
      expect(result.alternatives[0].title).toBe('Mid');
      expect(result.alternatives[1].title).toBe('Far');
    });

    it('includes candidates without duration in alternatives after sorted ones', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'With Duration', providerId: 'p1' }),
        makeBookMetadata({ title: 'No Duration', providerId: undefined }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        asin: 'A1',
        duration: 600,
      });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.bestMatch!.title).toBe('With Duration');
      expect(result.alternatives.some(a => a.title === 'No Duration')).toBe(true);
    });

    it('converts audio seconds to minutes correctly', async () => {
      // 90 seconds = 2 minutes (rounded)
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 90,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'Short Book', providerId: 'p1' }),
        makeBookMetadata({ title: 'Long Book', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 2 }) // exact match at 2 min
        .mockResolvedValueOnce({ asin: 'A2', duration: 100 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('high');
      expect(result.bestMatch!.title).toBe('Short Book');
    });

    it('skips duration disambiguation when audio scan returns zero duration', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 0,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'Book A', providerId: undefined, duration: 300 }),
        makeBookMetadata({ title: 'Book B', providerId: undefined, duration: 400 }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('medium');
      expect(result.bestMatch!.title).toBe('Book A');
    });

    it('falls through to medium when all detailed results have no duration', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'Book A', providerId: undefined }),
        makeBookMetadata({ title: 'Book B', providerId: undefined }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('medium');
      expect(result.bestMatch!.title).toBe('Book A');
    });
  });

  describe('search query construction', () => {
    it('uses "title author" when author is provided', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([{ path: '/books/x', title: 'Dune', author: 'Frank Herbert' }]);
      await waitForJob(service, id);

      expect(metadataService.searchBooks).toHaveBeenCalledWith('Dune Frank Herbert');
    });

    it('uses title only when author is not provided', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([{ path: '/books/x', title: 'Dune' }]);
      await waitForJob(service, id);

      expect(metadataService.searchBooks).toHaveBeenCalledWith('Dune');
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
      const searchResult = makeBookMetadata({ title: 'Fallback Book', providerId: 'prov-1' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([searchResult]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('API down'),
      );

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result.confidence).toBe('high');
      expect(result.bestMatch!.title).toBe('Fallback Book');
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

    it('only fetches details for top 5 results', async () => {
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

      expect(metadataService.getBook).toHaveBeenCalledTimes(5);
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
        makeBookMetadata({ title: 'Book A', providerId: 'p1' }),
        makeBookMetadata({ title: 'Book B', providerId: 'p2' }),
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
        makeBookMetadata({ title: 'Book A', providerId: 'p1' }),
        makeBookMetadata({ title: 'Book B', providerId: 'p2' }),
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
      expect(metadataService.searchBooks).toHaveBeenCalledWith('');
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
});
