import { describe, it, expect, beforeEach, vi } from 'vitest';
const { ffmpegState } = vi.hoisted(() => ({ ffmpegState: { resolves: true } }));
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, resolveFfmpegPath: () => Promise.resolve(ffmpegState.resolves ? '/usr/bin/ffmpeg' : null) };
});

import { createMockLogger, inject } from '../__tests__/helpers.js';
import { MatchJobService, capConfidence, type MatchCandidate, type MatchResult } from './match-job.service.js';
import { RECORDING_REVIEW_REASON } from './match-job.helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookService } from './book.service.js';
import type { BookMetadata } from '@core/metadata/index.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';

vi.mock('@core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn().mockResolvedValue(null),
}));

// #2292 routes every match through the OPF ASIN rung, so without this the fixture paths below
// would reach the real filesystem. `null` — no sidecar — is the production behaviour every test
// in this file assumes; the rung's own cases live in match-job.service.opf-asin.test.ts.
vi.mock('../utils/opf-reader.js', () => ({
  readOpfMetadata: vi.fn().mockResolvedValue(null),
}));

// Preserve crypto.randomBytes: auth.service builds DUMMY_SALT during transitive import.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, randomUUID: vi.fn().mockReturnValue('test-job-id') };
});

import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { readOpfMetadata } from '../utils/opf-reader.js';
import { randomUUID } from 'node:crypto';

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
    // The API represents no usable chapter runtime as `{}`.
    getChapterRuntimeSeconds: vi.fn().mockResolvedValue({}),
    search: vi.fn(),
    searchSeries: vi.fn(),
    getAuthor: vi.fn(),
    getAuthorBooks: vi.fn(),
    getSeries: vi.fn(),
    configure: vi.fn(),
    test: vi.fn(),
  });
}

function createMockBookService(): BookService {
  return inject<BookService>({
    findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null }),
  });
}

function flushPromises(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 50));
}

async function waitForJob(service: MatchJobService, id: string, maxMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const status = service.getJob(id);
    if (!status || status.status === 'completed' || status.status === 'cancelled' || status.status === 'failed') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const sampleCandidate: MatchCandidate = {
  path: '/audiobooks/The Way of Kings',
  title: 'The Way of Kings',
  author: 'Brandon Sanderson',
};

describe('MatchJobService', () => {
  let service: MatchJobService;
  let metadataService: ReturnType<typeof createMockMetadataService>;
  let log: ReturnType<typeof createMockLogger>;
  let settingsService: SettingsService;
  let bookService: BookService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish the no-sidecar default: an undefined resolution would break the rung everywhere.
    vi.mocked(readOpfMetadata).mockResolvedValue(null);
    log = createMockLogger();
    metadataService = createMockMetadataService();
    settingsService = inject<SettingsService>({ get: vi.fn().mockResolvedValue({ ffmpegPath: '' }) });
    bookService = createMockBookService();
    service = new MatchJobService(metadataService, inject<FastifyBaseLogger>(log), settingsService, bookService);
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
        await new Promise(resolve => setTimeout(resolve, 5));
        return [];
      });

      const id = service.createJob(books);
      service.cancelJob(id);

      await waitForJob(service, id);

      const status = service.getJob(id)!;
      expect(status.status).toBe('cancelled');
    });
  });

  describe('TTL cleanup', () => {
    it('removes job after TTL expires', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const meta = makeBookMetadata({ providerId: undefined });
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([meta]);

        const id = service.createJob([sampleCandidate]);

        // Advance in small increments to flush microtasks without reaching the TTL.
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(1);
        }

        expect(service.getJob(id)).not.toBeNull();
        expect(service.getJob(id)!.status).toBe('completed');

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
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const id = service.createJob([sampleCandidate]);
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(1);
        }

        vi.advanceTimersByTime(9 * 60 * 1000);
        expect(service.getJob(id)).not.toBeNull();

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

  describe('terminalization (#1864)', () => {
    it('injected top-level run() crash → status failed with error, retained results, logged', async () => {
      // Promise.allSettled rejection is the only top-level escape point.
      const spy = vi.spyOn(Promise, 'allSettled').mockRejectedValueOnce(new Error('orchestration boom'));
      try {
        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const status = service.getJob(id)!;
        expect(status.status).toBe('failed');
        expect(status.error).toBe('orchestration boom');
        expect(Array.isArray(status.results)).toBe(true);
        expect(log.error).toHaveBeenCalledWith(
          expect.objectContaining({ jobId: 'test-job-id' }),
          'Match job failed unexpectedly',
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('a poll of a failed job still returns it (not gone) until TTL', async () => {
      const spy = vi.spyOn(Promise, 'allSettled').mockRejectedValueOnce(new Error('boom'));
      try {
        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);
        const status = service.getJob(id);
        expect(status).not.toBeNull();
        expect(status!.status).toBe('failed');
      } finally {
        spy.mockRestore();
      }
    });

    it('failed job schedules cleanup exactly once (removed after TTL)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const spy = vi.spyOn(Promise, 'allSettled').mockRejectedValueOnce(new Error('boom'));
      try {
        const id = service.createJob([sampleCandidate]);
        for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);
        expect(service.getJob(id)!.status).toBe('failed');

        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(service.getJob(id)).toBeNull();
        expect(log.debug).toHaveBeenCalledWith({ jobId: id }, 'Match job expired and removed');
        const removals = (log.debug as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[1] === 'Match job expired and removed');
        expect(removals).toHaveLength(1);
      } finally {
        spy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('completion-then-cancel stays completed (first terminal wins)', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);
      expect(service.getJob(id)!.status).toBe('completed');

      expect(service.cancelJob(id)).toBe(false);
      expect(service.getJob(id)!.status).toBe('completed');
    });

    it('cancel-then-completion stays cancelled (first terminal wins)', async () => {
      const books: MatchCandidate[] = Array.from({ length: 20 }, (_, i) => ({ path: `/b-${i}`, title: `B${i}` }));
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return [];
      });
      const id = service.createJob(books);
      expect(service.cancelJob(id)).toBe(true);
      await waitForJob(service, id);
      expect(service.getJob(id)!.status).toBe('cancelled');
    });

    it('failure-then-cancel stays failed (terminal is immutable)', async () => {
      const spy = vi.spyOn(Promise, 'allSettled').mockRejectedValueOnce(new Error('boom'));
      try {
        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);
        expect(service.getJob(id)!.status).toBe('failed');
        expect(service.cancelJob(id)).toBe(false);
        expect(service.getJob(id)!.status).toBe('failed');
      } finally {
        spy.mockRestore();
      }
    });

    it('failure-then-completion stays failed with the original error, results, and a single cleanup (F7)', async () => {
      // run() records failure but resolves, so createJob still attempts completion.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const spy = vi.spyOn(Promise, 'allSettled').mockRejectedValueOnce(new Error('orchestration boom'));
      try {
        const id = service.createJob([sampleCandidate]);
        // Flush both terminalization attempts.
        for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);

        const status = service.getJob(id)!;
        expect(status.status).toBe('failed');
        expect(status.error).toBe('orchestration boom');
        expect(Array.isArray(status.results)).toBe(true);

        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(service.getJob(id)).toBeNull();
        const removals = (log.debug as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[1] === 'Match job expired and removed');
        expect(removals).toHaveLength(1);
      } finally {
        spy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe('cancelJob boolean semantics (#1864 F11)', () => {
    it('returns true only on the matching→cancelled transition', () => {
      const id = service.createJob([sampleCandidate]);
      expect(service.getJob(id)!.status).toBe('matching');
      expect(service.cancelJob(id)).toBe(true);
      expect(service.getJob(id)!.status).toBe('cancelled');
    });

    it('returns false for an already-cancelled (terminal) job', () => {
      const id = service.createJob([sampleCandidate]);
      expect(service.cancelJob(id)).toBe(true);
      expect(service.cancelJob(id)).toBe(false);
    });

    it('returns false for a completed (terminal) job', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);
      expect(service.cancelJob(id)).toBe(false);
    });

    it('does not log the cancel line for a missing or terminal job', () => {
      service.cancelJob('nonexistent');
      const id = service.createJob([sampleCandidate]);
      service.cancelJob(id);
      (log.info as ReturnType<typeof vi.fn>).mockClear();
      service.cancelJob(id);
      expect(log.info).not.toHaveBeenCalledWith({ jobId: id }, 'Match job cancelled');
    });
  });

  describe('confidence scoring', () => {
    it('returns none confidence when no search results', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('none');
      expect(result!.bestMatch).toBeNull();
      expect(result!.alternatives).toEqual([]);
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
      expect(result!.confidence).toBe('high');
      expect(result!.bestMatch).toBeTruthy();
      expect(result!.alternatives).toEqual([]);
    });

    it('post-match: flags a resolved match that findDuplicate reports as owned (#1662)', async () => {
      // Candidate lacks author; only the resolved match supplies duplicate keys.
      const meta = makeBookMetadata({ title: 'Tehanu', authors: [{ name: 'Ursula K. Le Guin' }], asin: 'B01G9EPERE', providerId: 'p1' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([meta]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue({ asin: 'B01G9EPERE', duration: 600 });
      // A file-holding incumbent: #2435 made "holds a file" the axis this arm turns on, and this
      // case is about a book already sitting in the library.
      (bookService.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue({ verdict: 'same-recording', book: { id: 421, title: 'Tehanu', path: '/library/Le Guin/Tehanu' }, hasIncumbent: true });

      const id = service.createJob([{ path: '/downloads/01 Tehanu.m4b', title: 'Tehanu' }]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0]!;
      expect(result.isDuplicate).toBe(true);
      expect(result.existingBookId).toBe(421);
      expect(result.duplicateReason).toBe('slug');
      expect(result.recordingVerdict).toBe('same-recording');
      expect(bookService.findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Tehanu', authors: meta.authors, asin: 'B01G9EPERE' }));
    });

    it('post-match: a review verdict sets reviewReason but NOT isDuplicate (#1711)', async () => {
      const meta = makeBookMetadata({ title: 'Tehanu', authors: [{ name: 'Ursula K. Le Guin' }], asin: 'B01G9EPERE', providerId: 'p1' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([meta]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue({ asin: 'B01G9EPERE', duration: 600 });
      (bookService.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue({ verdict: 'review', book: { id: 77, title: 'Tehanu' }, hasIncumbent: true });

      const id = service.createJob([{ path: '/downloads/01 Tehanu.m4b', title: 'Tehanu' }]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0]!;
      expect(result.isDuplicate).toBeUndefined();
      expect(result.reviewReason).toBeDefined();
      expect(result.existingBookId).toBe(77);
      expect(result.recordingVerdict).toBe('review');
    });

    // Machine recordingReviewReason is logged; reviewReason remains human-facing text.
    it('post-match: normalizes bestMatch.formatType into findDuplicate; review keeps the human reviewReason text (#1728 F2)', async () => {
      const meta = makeBookMetadata({ title: 'Tehanu', authors: [{ name: 'Ursula K. Le Guin' }], asin: 'B01G9EPERE', providerId: 'p1', formatType: 'Abridged' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([meta]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue({ asin: 'B01G9EPERE', duration: 600 });
      (bookService.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue({ verdict: 'review', book: { id: 88, title: 'Tehanu' }, hasIncumbent: true, recordingReviewReason: 'production-type-mismatch' });

      const id = service.createJob([{ path: '/downloads/01 Tehanu.m4b', title: 'Tehanu' }]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0]!;
      expect(bookService.findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ productionType: 'abridged' }));
      expect(result.recordingVerdict).toBe('review');
      expect(result.reviewReason).toBe(RECORDING_REVIEW_REASON);
      expect(result.reviewReason).not.toBe('production-type-mismatch');
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ recordingReviewReason: 'production-type-mismatch', existingBookId: 88 }),
        'Post-match recording review required',
      );
    });

    it('post-match: a bestMatch with no formatType passes NO productionType to findDuplicate (#1728 F2 unchanged)', async () => {
      const meta = makeBookMetadata({ title: 'Tehanu', authors: [{ name: 'Ursula K. Le Guin' }], asin: 'B01G9EPERE', providerId: 'p1' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([meta]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue({ asin: 'B01G9EPERE', duration: 600 });
      (bookService.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false });

      const id = service.createJob([{ path: '/downloads/01 Tehanu.m4b', title: 'Tehanu' }]);
      await waitForJob(service, id);

      expect(bookService.findDuplicate).toHaveBeenCalledTimes(1);
      expect((bookService.findDuplicate as ReturnType<typeof vi.fn>).mock.calls[0]![0]).not.toHaveProperty('productionType');
    });

    it('post-match: a different-recording WITH an incumbent → recordingVerdict, no isDuplicate (#1712 keep-both, new version of owned title)', async () => {
      const meta = makeBookMetadata({ title: 'Tehanu', authors: [{ name: 'Ursula K. Le Guin' }], asin: 'B01G9EPERE', providerId: 'p1' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([meta]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue({ asin: 'B01G9EPERE', duration: 600 });
      (bookService.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: true });

      const id = service.createJob([{ path: '/downloads/01 Tehanu.m4b', title: 'Tehanu' }]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0]!;
      expect(result.isDuplicate).toBeUndefined();
      expect(result.reviewReason).toBeUndefined();
      expect(result.recordingVerdict).toBe('different-recording');
    });

    it('post-match: a different-recording with NO incumbent (brand-new book) is left unflagged (#1712)', async () => {
      const meta = makeBookMetadata({ providerId: 'p1' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([meta]);
      (bookService.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0]!;
      expect(result.isDuplicate).toBeUndefined();
      expect(result.existingBookId).toBeUndefined();
      expect(result.recordingVerdict).toBeUndefined();
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
      expect(result!.confidence).toBe('medium');
      expect(result!.bestMatch).toEqual(results[0]);
      expect(result!.alternatives).toEqual([results[1]]);
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
      expect(result!.confidence).toBe('medium');
    });

    it('considers all search results, not just the first few (DCC regression)', async () => {
      const candidate: MatchCandidate = {
        path: '/audiobooks/Matt Dinniman/Dungeon Crawler Carl/01 - Dungeon Crawler Carl',
        title: 'Dungeon Crawler Carl',
        author: 'Matt Dinniman',
      };

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
      expect(result!.bestMatch!.title).toBe('Dungeon Crawler Carl');
      expect(result!.confidence).not.toBe('none');
    });
  });

  describe('runtime disambiguation', () => {
    it('promotes to high confidence when best match duration within the 90s band', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36050, // 600min + 50s
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Unabridged)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 800 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('high');
      expect(result!.bestMatch!.title).toBe('The Way of Kings');
      expect(result!.alternatives).toHaveLength(1);
    });

    it('stays medium confidence when best match duration exceeds strict 5% threshold (low score)', async () => {
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
        .mockResolvedValueOnce({ asin: 'A1', duration: 650 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 700 });

      const id = service.createJob([weakCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('medium');
      expect(result!.bestMatch!.title).toBe('Doctor Sleep: A Novel');
    });

    it('preserves similarity-ranked order — duration does not override winner', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'Completely Different Book', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 900 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 600 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.bestMatch!.title).toBe('The Way of Kings');
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
      expect(result!.bestMatch!.title).toBe('The Way of Kings');
      expect(result!.alternatives).toHaveLength(1);
      expect(result!.alternatives[0]!.title).toBe('The Way of Kings Companion');
    });

    it('converts audio seconds to minutes for duration confidence', async () => {
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
        .mockResolvedValueOnce({ asin: 'A1', duration: 2 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 100 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('high');
      expect(result!.bestMatch!.title).toBe('The Way of Kings');
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
      expect(result!.confidence).toBe('medium');
      expect(result!.bestMatch!.title).toBe('The Way of Kings');
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
      expect(result!.confidence).toBe('medium');
      expect(result!.bestMatch!.title).toBe('The Way of Kings');
    });
  });

  // reasonKind avoids display-text parsing; scannedSeconds must survive every positive-runtime exit (#1929).
  describe('#1929 scannedSeconds + reasonKind threading (filename path)', () => {
    it('multi-result duration-mismatch top exposes scannedSeconds + reasonKind:duration-mismatch', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 36000, files: [] });
      const results = [
        makeBookMetadata({ title: 'Doctor Sleep: A Novel', authors: [{ name: 'Stephen King' }], providerId: 'p1' }),
        makeBookMetadata({ title: 'Doctor Sleep (Unabridged)', authors: [{ name: 'Stephen King' }], providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 650 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 700 });

      const id = service.createJob([{ path: '/audiobooks/Doctor Sleep', title: 'Doctor Sleep', author: 'Stephen King' }]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0]!;
      expect(result.confidence).toBe('medium');
      expect(result.reasonKind).toBe('duration-mismatch');
      expect(result.reason).toContain('Duration mismatch');
      expect(result.scannedSeconds).toBe(36000);
    });

    it('multi-result duration-verified high exposes scannedSeconds and NO reasonKind', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 36050, files: [] });
      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Unabridged)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 800 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0]!;
      expect(result.confidence).toBe('high');
      expect(result.scannedSeconds).toBe(36050);
      expect(result.reasonKind).toBeUndefined();
    });

    it('no-search-results none result still carries scannedSeconds (no reasonKind)', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 36000, files: [] });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0]!;
      expect(result.confidence).toBe('none');
      expect(result.scannedSeconds).toBe(36000);
      expect(result.reasonKind).toBeUndefined();
    });

    it('title-floor none result still carries scannedSeconds', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 36000, files: [] });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
      ]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue({ asin: 'A1', duration: 600 });

      const id = service.createJob([{ path: '/audiobooks/xyz', title: 'Zzzqqq Nonsense Title', author: 'Nobody' }]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0]!;
      expect(result.confidence).toBe('none');
      expect(result.scannedSeconds).toBe(36000);
    });

    it('error/catch none result still carries scannedSeconds', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 36000, files: [] });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('provider exploded'));

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0]!;
      expect(result.confidence).toBe('none');
      expect(result.error).toBeDefined();
      expect(result.scannedSeconds).toBe(36000);
    });

    it('a scan with no positive runtime leaves scannedSeconds absent', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 0, files: [] });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0]!;
      expect(result.scannedSeconds).toBeUndefined();
    });
  });

  // Single-result filename matches need runtime corroboration after the Fablehaven false positive (#1821).
  describe('#1821 single-result runtime corroboration (filename path)', () => {
    it('Fablehaven repro — single 9h16m audio matched to a 13h27m record → medium + mismatch reason', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 556 * 60, files: [] });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1', duration: 807 }),
      ]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('medium');
      expect(result!.reason).toBe('Duration mismatch — scanned 9h 16m vs expected 13h 27m');
    });

    it('single result within runtime tolerance → high (no regression to correct matches)', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 36050, files: [] });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1', duration: 600 }),
      ]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('high');
      expect(result!.reason).toBeUndefined();
    });

    it('single result with NO scanned duration → high (uncapped path, absent data does not demote)', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 0, files: [] });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1', duration: 807 }),
      ]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('high');
      expect(result!.reason).toBeUndefined();
    });

    it('single result with candidate missing provider duration → high (absent data does not demote)', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 556 * 60, files: [] });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
      ]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('high');
      expect(result!.reason).toBeUndefined();
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
      expect(result!.confidence).toBe('high');
      expect(result!.bestMatch!.title).toBe('The Way of Kings');
    });

    it('falls back to search result when detail fetch returns null', async () => {
      const searchResult = makeBookMetadata({ title: 'Null Detail', providerId: 'prov-1' });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([searchResult]);
      (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.bestMatch!.title).toBe('Null Detail');
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
      expect(result!.bestMatch!.title).toBe('Original Title');
      expect(result!.bestMatch!.asin).toBe('B001');
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
      expect(result!.confidence).toBe('none');
      expect(result!.bestMatch).toBeNull();
      expect(result!.error).toBe('Network failure');
    });

    it('returns stringified value for non-Error thrown values', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockRejectedValue('string error');

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.error).toBe('string error');
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
      expect(result!.confidence).toBe('high');
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ path: sampleCandidate.path }),
        'Audio scan failed \u2014 proceeding without duration',
      );
    });

    it('passes derived ffprobePath and diagnostic callbacks to scanAudioDirectory when ffmpegPath is configured', async () => {
      (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({ ffmpegPath: '/usr/bin/ffmpeg' });
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 3600 });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeBookMetadata({ providerId: undefined }),
      ]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      expect(scanAudioDirectory).toHaveBeenCalledWith(
        sampleCandidate.path,
        { skipCover: true, ffprobePath: '/usr/bin/ffprobe', onWarn: expect.any(Function), onDebug: expect.any(Function) },
      );

      const options = vi.mocked(scanAudioDirectory).mock.calls[0]![1]!;
      options.onWarn!('warn-msg', { warnPayload: 1 });
      expect(log.warn).toHaveBeenCalledWith({ warnPayload: 1 }, 'warn-msg');
      options.onDebug!('debug-msg', { debugPayload: 2 });
      expect(log.debug).toHaveBeenCalledWith({ debugPayload: 2 }, 'debug-msg');
    });

    it('passes ffprobePath as undefined when ffmpeg is not detected', async () => {
      ffmpegState.resolves = false;
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 3600 });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeBookMetadata({ providerId: undefined }),
      ]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      expect(scanAudioDirectory).toHaveBeenCalledWith(
        sampleCandidate.path,
        { skipCover: true, ffprobePath: undefined, onWarn: expect.any(Function), onDebug: expect.any(Function) },
      );
      ffmpegState.resolves = true;
    });

    it('passes ffprobePath as undefined when ffmpeg detection returns null (variant)', async () => {
      ffmpegState.resolves = false;
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 3600 });
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeBookMetadata({ providerId: undefined }),
      ]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      expect(scanAudioDirectory).toHaveBeenCalledWith(
        sampleCandidate.path,
        { skipCover: true, ffprobePath: undefined, onWarn: expect.any(Function), onDebug: expect.any(Function) },
      );
      ffmpegState.resolves = true;
    });
  });

  describe('concurrency', () => {
    it('limits concurrent matching to 5', async () => {
      let concurrentCount = 0;
      let maxConcurrent = 0;

      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
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
    it('handles exact 90s duration delta as high confidence (inclusive)', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36090,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Unabridged)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('high');
    });

    it('handles just under 90s delta as high confidence', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36080,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('high');
    });

    it('handles book with empty string title', async () => {
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = service.createJob([{ path: '/books/empty', title: '' }]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('none');
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

      expect(getBookCalls).toBeLessThanOrEqual(2);
    });

    // Cancellation here takes the distinct empty-scored exit, which must retain scannedSeconds.
    it('empty-scored (cancellation) none exit still carries positive scannedSeconds (#1929)', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 36000, files: [] });
      const results = Array.from({ length: 5 }, (_, i) =>
        makeBookMetadata({ title: `Book ${i}`, providerId: `prov-${i}` }),
      );
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        service.cancelJob('test-job-id');
        return results;
      });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);
      // Allow the cancelled result to settle.
      await flushPromises();

      const result = service.getJob(id)!.results[0]!;
      expect(result.confidence).toBe('none');
      expect(result.bestMatch).toBeNull();
      expect(metadataService.getBook).not.toHaveBeenCalled();
      expect(result.scannedSeconds).toBe(36000);
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

      expect(service.getJob(id)!.matched).toBe(0);

      resolveFirst([]);
      await flushPromises();

      expect(service.getJob(id)!.matched).toBe(1);
      expect(service.getJob(id)!.status).toBe('matching');

      resolveSecond([]);
      await flushPromises();

      await waitForJob(service, id);
      expect(service.getJob(id)!.matched).toBe(2);
      expect(service.getJob(id)!.status).toBe('completed');
    });
  });

  // One score-independent 90s band replaced the relative score tiers (#1850).
  describe('absolute duration band (#1850)', () => {
    it('high combined score (1.0) + duration within 90s → confidence high', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36050,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('high');
    });

    it('high combined score (1.0) — no relaxation: a 30h book 5min off → medium (the #335 tier removal)', async () => {
      // The retired 15% tier allowed ~4.5h on a 30h book; score no longer widens tolerance.
      const longCandidate: MatchCandidate = {
        path: '/audiobooks/The Way of Kings',
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
      };
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 108300,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 1800 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 2400 });

      const id = service.createJob([longCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('medium');
      expect(result!.reason).toContain('Duration mismatch');
    });

    it('high combined score (1.0) + duration just beyond the band → confidence medium', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36300,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('medium');
    });

    it('low combined score + duration within 90s → confidence high (band is score-independent)', async () => {
      const weakCandidate: MatchCandidate = {
        path: '/audiobooks/Doctor Sleep',
        title: 'Doctor Sleep',
        author: 'Stephen King',
      };

      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36060,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'Doctor Sleep: A Novel', authors: [{ name: 'Stephen King' }], providerId: 'p1' }),
        makeBookMetadata({ title: 'Doctor Sleep (Unabridged)', authors: [{ name: 'Stephen King' }], providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([weakCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('high');
    });

    it('low combined score + duration beyond 90s → confidence medium', async () => {
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
        .mockResolvedValueOnce({ asin: 'A1', duration: 640 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

      const id = service.createJob([weakCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('medium');
    });
  });

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
      await flushPromises();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'test-job-id', cancelled: true, elapsedMs: expect.any(Number) }),
        'Match job finished',
      );
    });
  });

  describe('result scoring integration', () => {
    it('re-ranks results by scoreResult() before selection', async () => {
      const results = [
        makeBookMetadata({ title: 'Completely Wrong Book', providerId: undefined }),
        makeBookMetadata({ title: 'The Way of Kings', providerId: undefined }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.bestMatch!.title).toBe('The Way of Kings');
    });

    it('title similarity < 50% on top result sets confidence to none', async () => {
      const results = [
        makeBookMetadata({ title: 'Totally Different Book', providerId: undefined }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('none');
      expect(result!.bestMatch!.title).toBe('Totally Different Book');
    });

    it('title similarity exactly 50% sets confidence to medium (boundary)', async () => {
      // Similar-ish titles keep the fixture near 50% similarity without reaching high confidence.
      const candidate: MatchCandidate = { path: '/books/test', title: 'Way Kings', author: 'Sanderson' };
      const results = [
        makeBookMetadata({ title: 'Way Kings Edition', providerId: undefined }),
        makeBookMetadata({ title: 'Way Kings Reprint', providerId: undefined }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('medium');
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
      expect(['medium', 'high']).toContain(result!.confidence);
    });

    it('duration still promotes to high when within the 90s band with scoring', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36050,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'The Way of Kings (Other)', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 800 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('high');
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
        .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 800 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('none');
    });

    it('similarity winner stays bestMatch even when worse-scoring result has closer duration', async () => {
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
        totalDuration: 36000,
        files: [],
      });

      const results = [
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        makeBookMetadata({ title: 'Ready Player One', providerId: 'p2' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'A1', duration: 900 })
        .mockResolvedValueOnce({ asin: 'A2', duration: 601 });

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.bestMatch!.title).toBe('The Way of Kings');
      expect(result!.confidence).toBe('medium');
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
      expect(result!.bestMatch!.publishedDate).toBe('2010-08-31');
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
      expect(result!.bestMatch!.publishedDate).toBe('2010-08-31');
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
      expect(result!.bestMatch!.publishedDate).toBe('2010-01-01');
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
      expect(result!.bestMatch!.title).toBe('The Way of Kings');
    });
  });

  // Direct ranking tests cannot catch the folder caller dropping seriesPosition (#1849).
  describe('position tiebreaker (folder pass, #1849)', () => {
    it('selects the position-matching entry as bestMatch on a same-title series tie', async () => {
      const candidate: MatchCandidate = {
        path: '/audiobooks/Fablehaven/01 - Fablehaven',
        title: 'Fablehaven',
        author: 'Brandon Mull',
        seriesPosition: 1,
      };
      const results = [
        makeBookMetadata({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], providerId: undefined, series: [{ name: 'Fablehaven', position: 2 }], asin: 'B2' }),
        makeBookMetadata({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], providerId: undefined, series: [{ name: 'Fablehaven', position: 1 }], asin: 'B1' }),
      ];
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.bestMatch!.asin).toBe('B1');
      expect(pickPrimarySeries(result!.bestMatch!)?.position).toBe(1);
    });
  });

  // Direct ranking tests cannot catch the folder caller dropping scanned seconds (#1882).
  describe('duration tiebreaker (folder pass, #1882)', () => {
    it('Dogs of War — selects the 9h58m sibling and verifies high on a same-title edition tie', async () => {
      // 35,936s is 56s from 598min but 1,856s from 568min; provider orders 568min first.
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ totalDuration: 35_936, files: [] });
      const candidate: MatchCandidate = {
        path: '/audiobooks/Dogs of War',
        title: 'Dogs of War',
        author: 'Adrian Tchaikovsky',
      };
      (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeBookMetadata({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], providerId: 'p1' }),
        makeBookMetadata({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], providerId: 'p2' }),
      ]);
      (metadataService.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ asin: 'B0FFH568', duration: 568 })
        .mockResolvedValueOnce({ asin: 'B0BT2T598', duration: 598 });

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.bestMatch!.asin).toBe('B0BT2T598');
      expect(result!.bestMatch!.duration).toBe(598);
      expect(result!.confidence).toBe('high');
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

  describe('match confidence reason (#415)', () => {
    describe('reason populated for medium confidence', () => {
      it('duration beyond the 90s band (weak title score) → reason includes "Duration mismatch" with scanned and expected hours', async () => {
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
          .mockResolvedValueOnce({ asin: 'A1', duration: 650 })
          .mockResolvedValueOnce({ asin: 'A2', duration: 700 });

        const id = service.createJob([weakCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('medium');
        expect(result!.reason).toBeDefined();
        expect(result!.reason).toContain('Duration mismatch');
        expect(result!.reason).toContain('10h 0m');
        expect(result!.reason).toContain('10h 50m');
      });

      it('duration beyond the 90s band (high title score, no relaxation) → reason includes "Duration mismatch" with both values', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 36000,
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 696 })
          .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('medium');
        expect(result!.reason).toBeDefined();
        expect(result!.reason).toContain('Duration mismatch');
        expect(result!.reason).toContain('10h 0m');
        expect(result!.reason).toContain('11h 36m');
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
        expect(result!.confidence).toBe('medium');
        expect(result!.reason).toBe('Multiple results — no duration data to disambiguate');
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
        expect(result!.confidence).toBe('medium');
        expect(result!.reason).toBe('Multiple results — no duration data to disambiguate');
        expect(result!.reason).not.toContain('0.0');
      });

      it('multiple results, top result lacks duration but scanned duration exists → reason is "Best match missing duration — cannot verify"', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 36000,
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1' })
          .mockResolvedValueOnce({ asin: 'A2', duration: 800 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('medium');
        expect(result!.reason).toBe('Best match missing duration — cannot verify');
      });

      it('duration beyond 90s (weak title score) → medium confidence with duration-mismatch reason', async () => {
        const weakCandidate: MatchCandidate = {
          path: '/audiobooks/Doctor Sleep',
          title: 'Doctor Sleep',
          author: 'Stephen King',
        };
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 60000,
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'Doctor Sleep: A Novel', authors: [{ name: 'Stephen King' }], providerId: 'p1' }),
          makeBookMetadata({ title: 'Doctor Sleep (Unabridged)', authors: [{ name: 'Stephen King' }], providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 1051 })
          .mockResolvedValueOnce({ asin: 'A2', duration: 1200 });

        const id = service.createJob([weakCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('medium');
        expect(result!.reason).toContain('Duration mismatch');
      });

      it('duration beyond 90s (high title score, no relaxation) → medium confidence with duration-mismatch reason', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 60000,
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 1151 })
          .mockResolvedValueOnce({ asin: 'A2', duration: 1300 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('medium');
        expect(result!.reason).toContain('Duration mismatch');
      });
    });

    describe('reason NOT populated for high/none confidence', () => {
      it('single result with high confidence → reason is undefined', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const meta = makeBookMetadata({ providerId: 'asin-123' });
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([meta]);
        (metadataService.getBook as ReturnType<typeof vi.fn>).mockResolvedValue({ asin: 'B123', duration: 600 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('high');
        expect(result!.reason).toBeUndefined();
      });

      it('no search results (none confidence) → reason is undefined', async () => {
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('none');
        expect(result!.reason).toBeUndefined();
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
        expect(result!.confidence).toBe('none');
        expect(result!.reason).toBeUndefined();
      });

      it('error during matching (none confidence with error field) → reason is undefined', async () => {
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API failure'));

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('none');
        expect(result!.error).toBe('API failure');
        expect(result!.reason).toBeUndefined();
      });

      it('duration at exactly the 90s band edge (inclusive <=) → high confidence, no reason', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 36090,
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Unabridged)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
          .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('high');
        expect(result!.reason).toBeUndefined();
      });

      it('duration within the 90s band with high title score → high confidence, no reason', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 36050,
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 600 })
          .mockResolvedValueOnce({ asin: 'A2', duration: 900 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('high');
        expect(result!.reason).toBeUndefined();
      });
    });

    describe('duration conversion in reason string', () => {
      it('converts minutes to h:mm correctly in reason string (e.g., 2229 min → 37h 9m)', async () => {
        (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
          totalDuration: 2229 * 60,
          files: [],
        });
        const results = [
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          makeBookMetadata({ title: 'The Way of Kings (Extended)', providerId: 'p2' }),
        ];
        (metadataService.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(results);
        (metadataService.getBook as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ asin: 'A1', duration: 2730 })
          .mockResolvedValueOnce({ asin: 'A2', duration: 3000 });

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('medium');
        expect(result!.reason).toContain('37h 9m');
        expect(result!.reason).toContain('45h 30m');
      });
    });
  });

  describe('matchSingleBook swap retry (issue #426)', () => {
    it('returns match when first search succeeds — no swap', async () => {
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
      ]);
      vi.mocked(metadataService.getBook).mockResolvedValue(
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1', asin: 'B1' }),
      );

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
      expect(result!.confidence).not.toBe('none');
    });

    it('retries with swapped author/title on zero results', async () => {
      vi.mocked(metadataService.searchBooks)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        ]);
      vi.mocked(metadataService.getBook).mockResolvedValue(
        makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1', asin: 'B1' }),
      );

      const candidate: MatchCandidate = {
        path: '/audiobooks/test',
        title: 'The Correspondent',
        author: 'Virginia Evans',
      };

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      expect(metadataService.searchBooks).toHaveBeenCalledTimes(2);
      expect(metadataService.searchBooks).toHaveBeenNthCalledWith(
        2,
        'Virginia Evans The Correspondent',
        { title: 'Virginia Evans', author: 'The Correspondent' },
      );
    });

    it('does not swap when author is absent', async () => {
      vi.mocked(metadataService.searchBooks).mockResolvedValue([]);

      const candidate: MatchCandidate = {
        path: '/audiobooks/test',
        title: 'Solo Title',
      };

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('none');
    });

    it('returns none confidence when both searches return empty', async () => {
      vi.mocked(metadataService.searchBooks)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      expect(metadataService.searchBooks).toHaveBeenCalledTimes(2);
      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('none');
    });

    it('swap retry error does not crash job', async () => {
      vi.mocked(metadataService.searchBooks)
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('API error on retry'));

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const job = service.getJob(id)!;
      expect(job.status).toBe('completed');
    });
  });

  describe('swap retry with swapped context (issue #447)', () => {
    const misparsedCandidate: MatchCandidate = {
      path: '/audiobooks/To Kill a Mockingbird - Harper Lee',
      title: 'Harper Lee',
      author: 'To Kill a Mockingbird',
    };

    it('accepts match when swap retry fires and result title matches book.author (misparsed folder)', async () => {
      vi.mocked(metadataService.searchBooks)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeBookMetadata({ title: 'To Kill a Mockingbird', authors: [{ name: 'Harper Lee' }], providerId: 'p1' }),
        ]);
      vi.mocked(metadataService.getBook).mockResolvedValue(
        makeBookMetadata({ title: 'To Kill a Mockingbird', authors: [{ name: 'Harper Lee' }], providerId: 'p1', asin: 'B1' }),
      );

      const id = service.createJob([misparsedCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).not.toBe('none');
      expect(result!.bestMatch?.title).toBe('To Kill a Mockingbird');
    });

    it('ranks correct candidate #1 when swap retry returns multiple results for misparsed folder', async () => {
      const correctBook = makeBookMetadata({ title: 'To Kill a Mockingbird', authors: [{ name: 'Harper Lee' }], providerId: 'p1' });
      const wrongBook = makeBookMetadata({ title: 'Go Set a Watchman', authors: [{ name: 'Harper Lee' }], providerId: 'p2' });

      vi.mocked(metadataService.searchBooks)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([correctBook, wrongBook]);
      vi.mocked(metadataService.getBook)
        .mockResolvedValueOnce(makeBookMetadata({ ...correctBook, asin: 'B1' }))
        .mockResolvedValueOnce(makeBookMetadata({ ...wrongBook, asin: 'B2' }));

      const id = service.createJob([misparsedCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.bestMatch?.title).toBe('To Kill a Mockingbird');
      expect(result!.confidence).not.toBe('none');
    });

    it('returns high confidence for single-result swap retry with misparsed folder', async () => {
      const correspondentCandidate: MatchCandidate = {
        path: '/audiobooks/The Correspondent - Virginia Evans',
        title: 'Virginia Evans',
        author: 'The Correspondent',
      };

      vi.mocked(metadataService.searchBooks)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeBookMetadata({ title: 'The Correspondent', authors: [{ name: 'Virginia Evans' }], providerId: 'p1' }),
        ]);
      vi.mocked(metadataService.getBook).mockResolvedValue(
        makeBookMetadata({ title: 'The Correspondent', authors: [{ name: 'Virginia Evans' }], providerId: 'p1', asin: 'B1' }),
      );

      const id = service.createJob([correspondentCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('high');
      expect(result!.bestMatch?.title).toBe('The Correspondent');
    });

    it('returns medium confidence for multi-result swap retry with misparsed folder (no duration)', async () => {
      const hyperionCandidate: MatchCandidate = {
        path: '/audiobooks/Hyperion - Dan Simmons',
        title: 'Dan Simmons',
        author: 'Hyperion',
      };

      vi.mocked(metadataService.searchBooks)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeBookMetadata({ title: 'Hyperion', authors: [{ name: 'Dan Simmons' }], providerId: 'p1' }),
          makeBookMetadata({ title: 'The Fall of Hyperion', authors: [{ name: 'Dan Simmons' }], providerId: 'p2' }),
        ]);
      vi.mocked(metadataService.getBook)
        .mockResolvedValueOnce(makeBookMetadata({ title: 'Hyperion', authors: [{ name: 'Dan Simmons' }], providerId: 'p1' }))
        .mockResolvedValueOnce(makeBookMetadata({ title: 'The Fall of Hyperion', authors: [{ name: 'Dan Simmons' }], providerId: 'p2' }));

      const id = service.createJob([hyperionCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('medium');
      expect(result!.bestMatch?.title).toBe('Hyperion');
    });

    it('uses original context for ranking and similarity when no swap retry occurs', async () => {
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], providerId: 'p1' }),
      ]);
      vi.mocked(metadataService.getBook).mockResolvedValue(
        makeBookMetadata({ title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], providerId: 'p1', asin: 'B1' }),
      );

      const id = service.createJob([sampleCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
      expect(result!.confidence).toBe('high');
      expect(result!.bestMatch?.title).toBe('The Way of Kings');
    });

    it('uses original context when author is absent (no swap possible)', async () => {
      const noAuthorCandidate: MatchCandidate = {
        path: '/audiobooks/Mystery Book',
        title: 'Mystery Book',
      };

      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Mystery Book', providerId: 'p1' }),
      ]);
      vi.mocked(metadataService.getBook).mockResolvedValue(
        makeBookMetadata({ title: 'Mystery Book', providerId: 'p1', asin: 'B1' }),
      );

      const id = service.createJob([noAuthorCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
      expect(result!.confidence).toBe('high');
    });

    it('accepts match when swapped-context title matches exactly', async () => {
      const candidate: MatchCandidate = {
        path: '/audiobooks/test',
        title: 'Some Author',
        author: 'Boundary Title',
      };

      vi.mocked(metadataService.searchBooks)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeBookMetadata({ title: 'Boundary Title', providerId: 'p1' }),
        ]);
      vi.mocked(metadataService.getBook).mockResolvedValue(
        makeBookMetadata({ title: 'Boundary Title', providerId: 'p1', asin: 'B1' }),
      );

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).not.toBe('none');
    });

    it('rejects match when swapped-context similarity is below floor', async () => {
      const candidate: MatchCandidate = {
        path: '/audiobooks/test',
        title: 'Alpha Beta',
        author: 'Gamma Delta',
      };

      vi.mocked(metadataService.searchBooks)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeBookMetadata({ title: 'Completely Unrelated Book', providerId: 'p1' }),
        ]);
      vi.mocked(metadataService.getBook).mockResolvedValue(
        makeBookMetadata({ title: 'Completely Unrelated Book', providerId: 'p1' }),
      );

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('none');
    });

    it('falls back to original context when swap fires but book.author is undefined', async () => {
      const noAuthorCandidate: MatchCandidate = {
        path: '/audiobooks/Solo Title',
        title: 'Solo Title',
      };

      vi.mocked(metadataService.searchBooks).mockResolvedValue([]);

      const id = service.createJob([noAuthorCandidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
      expect(result!.confidence).toBe('none');
    });

    it('returns none confidence when diceCoefficient returns 0 for both title and author comparisons', async () => {
      const candidate: MatchCandidate = {
        path: '/audiobooks/test',
        title: 'AAAA',
        author: 'BBBB',
      };

      vi.mocked(metadataService.searchBooks)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeBookMetadata({ title: 'ZZZZ YYYY', authors: [{ name: 'XXXX WWWW' }], providerId: 'p1' }),
        ]);
      vi.mocked(metadataService.getBook).mockResolvedValue(
        makeBookMetadata({ title: 'ZZZZ YYYY', authors: [{ name: 'XXXX WWWW' }], providerId: 'p1' }),
      );

      const id = service.createJob([candidate]);
      await waitForJob(service, id);

      const result = service.getJob(id)!.results[0];
      expect(result!.confidence).toBe('none');
    });
  });

  describe('tag-first matching (#984)', () => {
    function makeTaggedScan(tagTitle: string, tagAuthor: string, totalDuration = 36000) {
      return {
        codec: 'AAC',
        bitrate: 128000,
        sampleRate: 44100,
        channels: 2,
        bitrateMode: 'cbr' as const,
        fileFormat: 'm4b',
        totalDuration,
        totalSize: 100_000_000,
        fileCount: 1,
        hasCoverArt: false,
        tagTitle,
        tagAuthor,
      };
    }

    const taggedCandidate: MatchCandidate = {
      path: '/audiobooks/Eric Discworld, Book 11.m4b',
      title: 'Eric Discworld',
      author: 'Eric Discworld',
    };

    describe('Pass 1 fires when tagTitle and tagAuthor are populated', () => {
      it('first searchBooks call carries the tag-derived title/author (cleanTagTitle applied)', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Eric: Discworld, Book 9', 'Terry Pratchett'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'Eric: Discworld, Book 9', authors: [{ name: 'Terry Pratchett' }], providerId: 'p1' }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({ title: 'Eric: Discworld, Book 9', authors: [{ name: 'Terry Pratchett' }], providerId: 'p1', asin: 'B1' }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
        expect(metadataService.searchBooks).toHaveBeenNthCalledWith(
          1,
          'Eric: Discworld Terry Pratchett',
          { title: 'Eric: Discworld', author: 'Terry Pratchett' },
        );
        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('high');
        expect(result!.bestMatch?.title).toBe('Eric: Discworld, Book 9');
      });

      it('strips trailing "(audio)" suffix from tagAuthor before Audible search (#1030)', async () => {
        // Audible rejected this literal UAT tag author; normalize both query forms.
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Dune', 'Frank Herbert (audio)'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'Dune', authors: [{ name: 'Frank Herbert' }], providerId: 'p1' }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({ title: 'Dune', authors: [{ name: 'Frank Herbert' }], providerId: 'p1', asin: 'B1' }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        expect(metadataService.searchBooks).toHaveBeenNthCalledWith(
          1,
          'Dune Frank Herbert',
          { title: 'Dune', author: 'Frank Herbert' },
        );
      });

      // Direct ranking tests cannot catch attemptQuery dropping the series position.
      it('threads tagSeriesPosition through attemptQuery so the tag-pass tiebreaker picks the right entry', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue({
          ...makeTaggedScan('Fablehaven', 'Brandon Mull'),
          tagSeriesPosition: 1,
        });
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 2 }], asin: 'B2' }),
          makeBookMetadata({ title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], series: [{ name: 'Fablehaven', position: 1 }], asin: 'B1' }),
        ]);

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.bestMatch?.asin).toBe('B1');
        expect(pickPrimarySeries(result!.bestMatch!)?.position).toBe(1);
      });

      // Direct ranking tests cannot catch runTagSearch → tryAttempt dropping totalDuration (#1882).
      it('threads totalDuration through runTagSearch → tryAttempt so the edition tiebreaker picks the 9h58m sibling', async () => {
        // 35,936s verifies the 598min sibling, not the provider's first 568min result.
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Dogs of War', 'Adrian Tchaikovsky', 35_936),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], asin: 'B0FFH568', duration: 568 }),
          makeBookMetadata({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], asin: 'B0BT2T598', duration: 598 }),
        ]);

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.bestMatch?.asin).toBe('B0BT2T598');
        expect(result!.bestMatch?.duration).toBe(598);
        expect(result!.confidence).toBe('high');
      });

      it('does NOT fall through to Pass 2 when tag-derived match is accepted', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('The Final Empire', 'Brandon Sanderson'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'The Final Empire', authors: [{ name: 'Brandon Sanderson' }], providerId: 'p1' }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({ title: 'The Final Empire', authors: [{ name: 'Brandon Sanderson' }], providerId: 'p1', asin: 'B1' }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
      });
    });

    // Attempt caps must preserve the tag path's scannedSeconds and specific reason kind.
    describe('#1929 scannedSeconds + reasonKind threading (tag path)', () => {
      it('tag-derived duration-mismatch result exposes scannedSeconds + reasonKind:duration-mismatch', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Dogs of War', 'Adrian Tchaikovsky', 36000),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], providerId: 'p1' }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], providerId: 'p1', asin: 'B1', duration: 700 }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0]!;
        expect(result.confidence).toBe('medium');
        expect(result.reasonKind).toBe('duration-mismatch');
        expect(result.reason).toContain('Duration mismatch');
        expect(result.scannedSeconds).toBe(36000);
      });

      it('tag-derived duration-verified high exposes scannedSeconds and NO reasonKind', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Dogs of War', 'Adrian Tchaikovsky', 36000),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], providerId: 'p1' }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({ title: 'Dogs of War', authors: [{ name: 'Adrian Tchaikovsky' }], providerId: 'p1', asin: 'B1', duration: 600 }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0]!;
        expect(result.confidence).toBe('high');
        expect(result.scannedSeconds).toBe(36000);
        expect(result.reasonKind).toBeUndefined();
      });
    });

    describe('Pass 1 is skipped when scan lacks usable tags', () => {
      it('skips when scan returns null', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(null);
        vi.mocked(metadataService.searchBooks).mockResolvedValue([]);

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        expect(metadataService.searchBooks).toHaveBeenCalledWith(
          'The Way of Kings Brandon Sanderson',
          { title: 'The Way of Kings', author: 'Brandon Sanderson' },
        );
      });

      it('skips when tagTitle is empty', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeTaggedScan('', 'Brandon Sanderson'));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
        expect(metadataService.searchBooks).toHaveBeenNthCalledWith(
          1,
          'The Way of Kings Brandon Sanderson',
          { title: 'The Way of Kings', author: 'Brandon Sanderson' },
        );
      });

      it('skips when tagAuthor is empty', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeTaggedScan('The Way of Kings', ''));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
        expect(metadataService.searchBooks).toHaveBeenNthCalledWith(
          1,
          'The Way of Kings Brandon Sanderson',
          { title: 'The Way of Kings', author: 'Brandon Sanderson' },
        );
      });
    });

    describe('Pass 1 fall-through cases (AC6)', () => {
      it('zero results from tag pass — NO swap retry, falls through to Pass 2', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Tag Title', 'Tag Author'),
        );
        vi.mocked(metadataService.searchBooks)
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1', asin: 'B1' }),
        );

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        expect(metadataService.searchBooks).toHaveBeenCalledTimes(2);
        expect(metadataService.searchBooks).toHaveBeenNthCalledWith(
          1,
          'Tag Title Tag Author',
          { title: 'Tag Title', author: 'Tag Author' },
        );
        expect(metadataService.searchBooks).toHaveBeenNthCalledWith(
          2,
          'The Way of Kings Brandon Sanderson',
          { title: 'The Way of Kings', author: 'Brandon Sanderson' },
        );
        // A throttled provider returns []; only an unexpected throw should warn.
        expect(log.warn).not.toHaveBeenCalledWith(
          expect.anything(),
          'tag-search provider error — falling through to filename-derived path',
        );
      });

      it('top result fails title floor — falls through to Pass 2', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Tag Title', 'Brandon Sanderson'),
        );
        vi.mocked(metadataService.searchBooks)
          .mockResolvedValueOnce([
            makeBookMetadata({ title: 'Wildly Different Book', authors: [{ name: 'Brandon Sanderson' }], providerId: 'p1' }),
          ])
          .mockResolvedValueOnce([
            makeBookMetadata({ title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], providerId: 'p2' }),
          ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(metadataService.searchBooks).toHaveBeenCalledTimes(2);
        expect(result!.bestMatch?.title).toBe('The Way of Kings');
      });

      it('top result passes title floor but fails author predicate — falls through (AC5)', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('The Final Empire', 'Suzanne Collins'),
        );
        vi.mocked(metadataService.searchBooks)
          .mockResolvedValueOnce([
            makeBookMetadata({ title: 'The Final Empire', authors: [{ name: 'Brandon Sanderson' }], providerId: 'p1' }),
          ])
          .mockResolvedValueOnce([
            makeBookMetadata({ title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], providerId: 'p2' }),
          ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(metadataService.searchBooks).toHaveBeenCalledTimes(2);
        expect(result!.bestMatch?.title).toBe('The Way of Kings');
      });

      it('AC13 case 2: unexpected throw from tag-pass searchBooks emits warn log + falls through', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Tag Title', 'Tag Author'),
        );
        vi.mocked(metadataService.searchBooks)
          .mockRejectedValueOnce(new Error('service-internal failure'))
          .mockResolvedValueOnce([
            makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1' }),
          ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({ title: 'The Way of Kings', providerId: 'p1', asin: 'B1' }),
        );

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('high');
        expect(result!.bestMatch?.title).toBe('The Way of Kings');
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            tagTitle: 'Tag Title',
            tagAuthor: 'Tag Author',
          }),
          'tag-search provider error — falling through to filename-derived path',
        );
      });

      it('AC13 case 2 + Pass 2 also throws: outer catch returns none with Pass 2 error preserved', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Tag Title', 'Tag Author'),
        );
        vi.mocked(metadataService.searchBooks)
          .mockRejectedValueOnce(new Error('tag-pass failure'))
          .mockRejectedValueOnce(new Error('pass-2 failure'));

        const id = service.createJob([sampleCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('none');
        expect(result!.error).toBe('pass-2 failure');
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ tagTitle: 'Tag Title' }),
          'tag-search provider error — falling through to filename-derived path',
        );
      });
    });

    describe('symmetric cleanTagTitle scoring (AC7)', () => {
      it('input "Eric: Discworld, Book 9" matches Audible "Eric: Discworld, Book 9" exactly (dice = 1.0 after cleaning)', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Eric: Discworld, Book 9', 'Terry Pratchett'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'Eric: Discworld, Book 9', authors: [{ name: 'Terry Pratchett' }], providerId: 'p1' }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({ title: 'Eric: Discworld, Book 9', authors: [{ name: 'Terry Pratchett' }], providerId: 'p1', asin: 'B1' }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('high');
      });

      it('AC7.5 same-prefix volume disambiguation: "Sandman: Act II" picks Act II over Act I/III', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('The Sandman: Act II', 'Neil Gaiman'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'The Sandman: Act I', authors: [{ name: 'Neil Gaiman' }], providerId: 'p1' }),
          makeBookMetadata({ title: 'The Sandman: Act II', authors: [{ name: 'Neil Gaiman' }], providerId: 'p2' }),
          makeBookMetadata({ title: 'The Sandman: Act III', authors: [{ name: 'Neil Gaiman' }], providerId: 'p3' }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.bestMatch?.title).toBe('The Sandman: Act II');
      });
    });

    describe('#1007 production failure recovery (multi-form scoring against series[])', () => {
      it('Eric: tagTitle "Eric: Discworld" composes against series=[{name:"Discworld"}]', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Eric: Discworld, Book 9', 'Terry Pratchett'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({
            title: 'Eric',
            authors: [{ name: 'Terry Pratchett' }],
            series: [{ name: 'Discworld', position: 9 }],
            providerId: 'p1',
          }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({
            title: 'Eric',
            authors: [{ name: 'Terry Pratchett' }],
            series: [{ name: 'Discworld', position: 9 }],
            providerId: 'p1',
            asin: 'B1',
          }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('high');
        expect(result!.bestMatch?.title).toBe('Eric');
      });

      it('Dark Forest: post-#1004 English-only fixture composes title + ":" + series.name to dice ≈ 1.0', async () => {
        // Assumes #1004 has already removed the Spanish edition.
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('The Dark Forest: The Three-Body Problem', 'Cixin Liu'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({
            title: 'The Dark Forest',
            authors: [{ name: 'Cixin Liu' }],
            series: [{ name: 'The Three-Body Problem', position: 2 }],
            providerId: 'p1',
          }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({
            title: 'The Dark Forest',
            authors: [{ name: 'Cixin Liu' }],
            series: [{ name: 'The Three-Body Problem', position: 2 }],
            providerId: 'p1',
            asin: 'B2',
          }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('high');
        expect(result!.bestMatch?.title).toBe('The Dark Forest');
      });

      it('Armageddon: tagTitle "Armageddon: Expeditionary Force" composes against series', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Armageddon: Expeditionary Force', 'Craig Alanson'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({
            title: 'Armageddon',
            authors: [{ name: 'Craig Alanson' }],
            series: [{ name: 'Expeditionary Force', position: 8 }],
            providerId: 'p1',
          }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({
            title: 'Armageddon',
            authors: [{ name: 'Craig Alanson' }],
            series: [{ name: 'Expeditionary Force', position: 8 }],
            providerId: 'p1',
            asin: 'B3',
          }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('high');
        expect(result!.bestMatch?.title).toBe('Armageddon');
      });

      it('Imagine Me: dash-separator form composes via "title - series.name" candidate', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Imagine Me - Shatter Me Series, Book 6', 'Tahereh Mafi'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({
            title: 'Imagine Me',
            authors: [{ name: 'Tahereh Mafi' }],
            series: [{ name: 'Shatter Me', position: 6 }],
            providerId: 'p1',
          }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({
            title: 'Imagine Me',
            authors: [{ name: 'Tahereh Mafi' }],
            series: [{ name: 'Shatter Me', position: 6 }],
            providerId: 'p1',
            asin: 'B4',
          }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).not.toBe('none');
        expect(result!.bestMatch?.title).toBe('Imagine Me');
      });

      it('Zero Hour: cleanTagTitle strips "(Unabridged)" before series-marker, then multi-form composes', async () => {
        // Removing `(Unabridged)` first exposes the trailing `, Book 5` marker.
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Zero Hour: Expeditionary Force, Book 5 (Unabridged)', 'Craig Alanson'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({
            title: 'Zero Hour',
            authors: [{ name: 'Craig Alanson' }],
            series: [{ name: 'Expeditionary Force', position: 5 }],
            providerId: 'p1',
          }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({
            title: 'Zero Hour',
            authors: [{ name: 'Craig Alanson' }],
            series: [{ name: 'Expeditionary Force', position: 5 }],
            providerId: 'p1',
            asin: 'B5',
          }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('high');
        expect(result!.bestMatch?.title).toBe('Zero Hour');
      });

      it('World War 3.1: cleanTagTitle preserves dots — Audible title= param is dot-sensitive', async () => {
        // Audible rejects `World War 3 1`; periods are search-significant.
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('World War 3.1', 'John Birmingham'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({
            title: 'World War 3.1',
            authors: [{ name: 'John Birmingham' }],
            providerId: 'p1',
          }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({
            title: 'World War 3.1',
            authors: [{ name: 'John Birmingham' }],
            providerId: 'p1',
            asin: 'B6',
          }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('high');
        expect(result!.bestMatch?.title).toBe('World War 3.1');
        expect(metadataService.searchBooks).toHaveBeenCalledWith(
          'World War 3.1 John Birmingham',
          { title: 'World War 3.1', author: 'John Birmingham' },
        );
      });

      it('Final Empire: extended series-marker strips space-prefixed "trilogy book 1"; passes 0.5 floor', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('The Final Empire Mistborn trilogy book 1', 'Brandon Sanderson'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({
            title: 'The Final Empire',
            authors: [{ name: 'Brandon Sanderson' }],
            series: [{ name: 'Mistborn', position: 1 }],
            providerId: 'p1',
          }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({
            title: 'The Final Empire',
            authors: [{ name: 'Brandon Sanderson' }],
            series: [{ name: 'Mistborn', position: 1 }],
            providerId: 'p1',
            asin: 'B7',
          }),
        );

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).not.toBe('none');
        expect(result!.bestMatch?.title).toBe('The Final Empire');
      });

      it('AC13 predicate-gate regression: Eric-shape passes the 0.5 floor with multi-form, would fail with single-form', async () => {
        // Ranking alone is insufficient: the predicate must use the same composed score (1.0 versus ~0.4).
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('Eric: Discworld, Book 9', 'Terry Pratchett'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({
            title: 'Eric',
            authors: [{ name: 'Terry Pratchett' }],
            series: [{ name: 'Discworld', position: 9 }],
            providerId: 'p1',
          }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).not.toBe('none');
        expect(result!.bestMatch?.title).toBe('Eric');
        expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
      });

      it('Jaina double-colon: composes via "series.name: title" preserving nested-series form', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeTaggedScan('World of Warcraft: Jaina Proudmoore: Tides of War', 'Christie Golden'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({
            title: 'Jaina Proudmoore: Tides of War',
            authors: [{ name: 'Christie Golden' }],
            series: [{ name: 'World of Warcraft' }],
            providerId: 'p1',
          }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([taggedCandidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).not.toBe('none');
        expect(result!.bestMatch?.title).toBe('Jaina Proudmoore: Tides of War');
      });
    });

    describe('#1036 tag-search planner — ordered retry attempts', () => {
      function makeRichScan(
        tagTitle: string,
        tagAuthor: string,
        extras: { tagAlbum?: string; tagAsin?: string; totalDuration?: number } = {},
      ) {
        return {
          codec: 'AAC',
          bitrate: 128000,
          sampleRate: 44100,
          channels: 2,
          bitrateMode: 'cbr' as const,
          fileFormat: 'm4b',
          totalDuration: extras.totalDuration ?? 36000,
          totalSize: 100_000_000,
          fileCount: 1,
          hasCoverArt: false,
          tagTitle,
          tagAuthor,
          ...(extras.tagAlbum !== undefined && { tagAlbum: extras.tagAlbum }),
          ...(extras.tagAsin !== undefined && { tagAsin: extras.tagAsin }),
        };
      }

      const candidate: MatchCandidate = {
        path: '/audiobooks/Some Folder',
        title: 'Some Folder',
        author: 'Some Author',
      };

      it('AC20 — Dark Forest: exact attempt zero results, album attempt wins with medium cap', async () => {
        // With no `, Book N` marker, deriveTagQuery cannot preempt planner album recovery.
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeRichScan('The Dark Forest: The Three-Body Problem', 'Cixin Liu', {
            tagAlbum: 'The Dark Forest (Unabridged)',
          }),
        );
        vi.mocked(metadataService.searchBooks)
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            makeBookMetadata({
              title: 'The Dark Forest',
              authors: [{ name: 'Cixin Liu' }],
              providerId: 'p1',
              duration: 600,
            }),
          ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([candidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.bestMatch?.title).toBe('The Dark Forest');
        // 36,000s verifies 600min, bypassing the album attempt's medium cap.
        expect(result!.confidence).toBe('high');
        expect(result!.reason).toBeUndefined();
        expect(metadataService.searchBooks).toHaveBeenCalledTimes(2);
        expect(metadataService.searchBooks).toHaveBeenNthCalledWith(
          2,
          'The Dark Forest Cixin Liu',
          { title: 'The Dark Forest', author: 'Cixin Liu' },
        );
      });

      it('AC21 — Imagine Me (multi-file album): album candidate cleans `- Series, Book N`', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeRichScan('Imagine Me - Part 3', 'Tahereh Mafi', {
            tagAlbum: 'Imagine Me - Shatter Me Series, Book 6',
          }),
        );
        vi.mocked(metadataService.searchBooks)
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            makeBookMetadata({
              title: 'Imagine Me',
              authors: [{ name: 'Tahereh Mafi' }],
              providerId: 'p1',
              duration: 600,
            }),
          ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([candidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.bestMatch?.title).toBe('Imagine Me');
        expect(result!.confidence).toBe('high');
        expect(result!.reason).toBeUndefined();
        expect(metadataService.searchBooks).toHaveBeenNthCalledWith(
          2,
          'Imagine Me Tahereh Mafi',
          { title: 'Imagine Me', author: 'Tahereh Mafi' },
        );
      });

      it('AC22 — Reacher: exact attempt fails, strip-leading-series produces `Second Son`', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeRichScan('Reacher 00.15-Second Son', 'Lee Child'),
        );
        vi.mocked(metadataService.searchBooks)
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            makeBookMetadata({
              title: 'Second Son',
              authors: [{ name: 'Lee Child' }],
              providerId: 'p1',
              duration: 600,
            }),
          ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([candidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.bestMatch?.title).toBe('Second Son');
        expect(result!.confidence).toBe('high');
        expect(result!.reason).toBeUndefined();
        expect(metadataService.searchBooks).toHaveBeenNthCalledWith(
          2,
          'Second Son Lee Child',
          { title: 'Second Son', author: 'Lee Child' },
        );
      });

      it('AC23 — ASIN kill-shot returns immediately, no planner attempts fire', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeRichScan('Anything', 'Anyone', { tagAsin: 'B07KILLSHT' }),
        );
        vi.mocked(metadataService.getBook).mockResolvedValue(
          makeBookMetadata({ title: 'Real Book Title', providerId: 'p1', asin: 'B07KILLSHT' }),
        );

        const id = service.createJob([candidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.bestMatch?.title).toBe('Real Book Title');
        expect(result!.confidence).toBe('high');
        expect(metadataService.searchBooks).not.toHaveBeenCalled();
        expect(metadataService.getBook).toHaveBeenCalledWith('B07KILLSHT');
      });

      it('AC23 — ASIN miss falls through to planner attempts', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeRichScan('Some Book', 'Some Author', { tagAsin: 'B07MISSXXX' }),
        );
        vi.mocked(metadataService.getBook).mockResolvedValueOnce(null);
        vi.mocked(metadataService.searchBooks).mockResolvedValueOnce([
          makeBookMetadata({
            title: 'Some Book',
            authors: [{ name: 'Some Author' }],
            providerId: 'p1',
            duration: 600,
          }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([candidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.bestMatch?.title).toBe('Some Book');
        expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
      });

      it('AC18/AC19 — single-result shortcut still applies cap (medium for stripped attempt)', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeRichScan('Imagine Me - Part 5', 'Tahereh Mafi'),
        );
        vi.mocked(metadataService.searchBooks)
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            makeBookMetadata({
              title: 'Imagine Me',
              authors: [{ name: 'Tahereh Mafi' }],
              providerId: 'p1',
            }),
          ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([candidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('medium');
      });

      it('AC18 — multi-result duration-derived path also caps to medium for stripped attempt', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeRichScan('Imagine Me - Part 5', 'Tahereh Mafi', { totalDuration: 36000 }),
        );
        vi.mocked(metadataService.searchBooks)
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            makeBookMetadata({ title: 'Imagine Me', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p1', duration: 600 }),
            makeBookMetadata({ title: 'Imagine Me Too', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p2', duration: 800 }),
          ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([candidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        // Duration verification must bypass the stripped attempt's medium cap.
        expect(result!.confidence).toBe('high');
        expect(result!.reason).toBeUndefined();
      });

      describe('#1052 capped-attempt review reason', () => {
        const CAPPED_REASON = 'Low confidence match. Please verify.';

        it('AC1 — single-result with medium-cap attempt: confidence=medium AND reason set', async () => {
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Imagine Me - Part 5', 'Tahereh Mafi'),
          );
          vi.mocked(metadataService.searchBooks)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              makeBookMetadata({
                title: 'Imagine Me',
                authors: [{ name: 'Tahereh Mafi' }],
                providerId: 'p1',
              }),
            ]);
          vi.mocked(metadataService.getBook).mockResolvedValue(null);

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('medium');
          expect(result!.reason).toBe(CAPPED_REASON);
        });

        it('AC2 — single-result via ASIN kill-shot (high-cap): confidence=high AND no reason', async () => {
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Anything', 'Anyone', { tagAsin: 'B07KILLSHT' }),
          );
          vi.mocked(metadataService.getBook).mockResolvedValue(
            makeBookMetadata({ title: 'Real Book Title', providerId: 'p1', asin: 'B07KILLSHT' }),
          );

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('high');
          expect(result!.reason).toBeUndefined();
        });

        it('#1821 — single-result via ASIN kill-shot (high-cap) + duration MISMATCH → medium + duration-specific reason', async () => {
          // A sibling ASIN is not absolute truth; measured 556min versus 807min must still demote.
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Anything', 'Anyone', { tagAsin: 'B07KILLSHT', totalDuration: 556 * 60 }),
          );
          vi.mocked(metadataService.getBook).mockResolvedValue(
            makeBookMetadata({ title: 'Real Book Title', providerId: 'p1', asin: 'B07KILLSHT', duration: 807 }),
          );

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('medium');
          expect(result!.reason).toBe('Duration mismatch — scanned 9h 16m vs expected 13h 27m');
        });

        it('#1821 — single-result via ASIN kill-shot (high-cap) + NO scanned duration → high (absent data does not demote)', async () => {
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Anything', 'Anyone', { tagAsin: 'B07KILLSHT', totalDuration: 0 }),
          );
          vi.mocked(metadataService.getBook).mockResolvedValue(
            makeBookMetadata({ title: 'Real Book Title', providerId: 'p1', asin: 'B07KILLSHT', duration: 807 }),
          );

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('high');
          expect(result!.reason).toBeUndefined();
        });

        it('#1266 AC3 — multi-result, duration verifies top result: cap bypassed, high with no reason', async () => {
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Imagine Me - Part 5', 'Tahereh Mafi', { totalDuration: 36000 }),
          );
          vi.mocked(metadataService.searchBooks)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              makeBookMetadata({ title: 'Imagine Me', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p1', duration: 600 }),
              makeBookMetadata({ title: 'Imagine Me Too', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p2', duration: 800 }),
            ]);
          vi.mocked(metadataService.getBook).mockResolvedValue(null);

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('high');
          expect(result!.reason).toBeUndefined();
        });

        it('AC4 — multi-result with duration mismatch under capped attempt: duration-specific reason wins', async () => {
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Imagine Me - Part 5', 'Tahereh Mafi', { totalDuration: 600 * 60 }),
          );
          vi.mocked(metadataService.searchBooks)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              makeBookMetadata({ title: 'Imagine Me', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p1', duration: 730 }),
              makeBookMetadata({ title: 'Imagine Me Too', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p2', duration: 900 }),
            ]);
          vi.mocked(metadataService.getBook).mockResolvedValue(null);

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('medium');
          expect(result!.reason).toContain('Duration mismatch');
          expect(result!.reason).not.toBe(CAPPED_REASON);
        });

        it('AC4 — multi-result with no duration data under capped attempt: duration-derived reason wins', async () => {
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Imagine Me - Part 5', 'Tahereh Mafi', { totalDuration: 0 }),
          );
          vi.mocked(metadataService.searchBooks)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              makeBookMetadata({ title: 'Imagine Me', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p1' }),
              makeBookMetadata({ title: 'Imagine Me Too', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p2' }),
            ]);
          vi.mocked(metadataService.getBook).mockResolvedValue(null);

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('medium');
          expect(result!.reason).toContain('no duration data');
          expect(result!.reason).not.toBe(CAPPED_REASON);
        });
      });

      describe('#1266 duration-verified strip-cap bypass', () => {
        const CAPPED_REASON = 'Low confidence match. Please verify.';

        it('single-result + strip cap + duration-verified → high, no reason', async () => {
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Imagine Me - Part 5', 'Tahereh Mafi', { totalDuration: 36000 }),
          );
          vi.mocked(metadataService.searchBooks)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              makeBookMetadata({ title: 'Imagine Me', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p1', duration: 600 }),
            ]);
          vi.mocked(metadataService.getBook).mockResolvedValue(null);

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('high');
          expect(result!.reason).toBeUndefined();
        });

        it('single-result + strip cap + duration within the 90s band → high (cap bypassed by verification)', async () => {
          // 36,050s versus 600min: Δ50s inside the score-independent band.
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Imagine Me - Part 5', 'Tahereh Mafi', { totalDuration: 36050 }),
          );
          vi.mocked(metadataService.searchBooks)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              makeBookMetadata({ title: 'Imagine Me', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p1', duration: 600 }),
            ]);
          vi.mocked(metadataService.getBook).mockResolvedValue(null);

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('high');
          expect(result!.reason).toBeUndefined();
        });

        it('#2168 single-result + strip cap + TRIMMED-only agreement → high (cap bypassed by the trimmed reference)', async () => {
          // Cap-bypass recomputation must receive the same full and trimmed references as promotion.
          // Full Δ1200s is out of band; trimmed Δ10s is in band.
          vi.mocked(metadataService.getChapterRuntimeSeconds)
            .mockResolvedValue({ fullSeconds: 36000, trimmedSeconds: 34810 });
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Imagine Me - Part 5', 'Tahereh Mafi', { totalDuration: 34800 }),
          );
          vi.mocked(metadataService.searchBooks)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              makeBookMetadata({ title: 'Imagine Me', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p1', duration: 600, asin: 'B0IMAGINEME' }),
            ]);
          vi.mocked(metadataService.getBook).mockResolvedValue(null);

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('high');
          expect(result!.reason).toBeUndefined();
          expect(result!.reasonKind).toBeUndefined();
        });

        it('single-result + strip cap + NO scanned duration → medium + capped reason', async () => {
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Imagine Me - Part 5', 'Tahereh Mafi', { totalDuration: 0 }),
          );
          vi.mocked(metadataService.searchBooks)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              makeBookMetadata({ title: 'Imagine Me', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p1', duration: 600 }),
            ]);
          vi.mocked(metadataService.getBook).mockResolvedValue(null);

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('medium');
          expect(result!.reason).toBe(CAPPED_REASON);
        });

        it('single-result + strip cap + duration MISMATCH → medium + duration-specific reason', async () => {
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Imagine Me - Part 5', 'Tahereh Mafi', { totalDuration: 600 * 60 }),
          );
          vi.mocked(metadataService.searchBooks)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              makeBookMetadata({ title: 'Imagine Me', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p1', duration: 900 }),
            ]);
          vi.mocked(metadataService.getBook).mockResolvedValue(null);

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('medium');
          expect(result!.reason).toBe('Duration mismatch — scanned 10h 0m vs expected 15h 0m');
        });

        it('multi-result + strip cap + duration MISMATCH → medium + duration-mismatch reason', async () => {
          vi.mocked(scanAudioDirectory).mockResolvedValue(
            makeRichScan('Imagine Me - Part 5', 'Tahereh Mafi', { totalDuration: 600 * 60 }),
          );
          vi.mocked(metadataService.searchBooks)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              makeBookMetadata({ title: 'Imagine Me', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p1', duration: 900 }),
              makeBookMetadata({ title: 'Imagine Me Too', authors: [{ name: 'Tahereh Mafi' }], providerId: 'p2', duration: 1000 }),
            ]);
          vi.mocked(metadataService.getBook).mockResolvedValue(null);

          const id = service.createJob([candidate]);
          await waitForJob(service, id);

          const result = service.getJob(id)!.results[0];
          expect(result!.confidence).toBe('medium');
          expect(result!.reason).toContain('Duration mismatch');
          expect(result!.reason).not.toBe(CAPPED_REASON);
        });
      });

      it('AC17 — capConfidence semantics: caps high to medium, leaves medium/none/high alone', () => {
        expect(capConfidence('high', 'medium')).toBe('medium');
        expect(capConfidence('medium', 'medium')).toBe('medium');
        expect(capConfidence('none', 'medium')).toBe('none');
        expect(capConfidence('high', 'high')).toBe('high');
      });

      it('AC26 — provider rate-limit on first attempt: subsequent attempts also return [] via service gate', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeRichScan('Imagine Me - Part 3', 'Tahereh Mafi', {
            tagAlbum: 'Imagine Me - Shatter Me Series, Book 6',
          }),
        );
        // Once rate-limited, the service gate returns [] for every attempt without throwing.
        vi.mocked(metadataService.searchBooks).mockResolvedValue([]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([candidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.confidence).toBe('none');
        // No warning: the service-level swallow returns [] rather than throwing.
        expect(log.warn).not.toHaveBeenCalledWith(
          expect.anything(),
          'tag-search provider error — falling through to filename-derived path',
        );
      });

      it('AC15 — predicate-fail on first attempt continues to next attempt instead of falling through', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeRichScan('The Dark Forest: The Three-Body Problem, Book 2', 'Cixin Liu', {
            tagAlbum: 'The Dark Forest (Unabridged)',
          }),
        );
        vi.mocked(metadataService.searchBooks)
          .mockResolvedValueOnce([
            makeBookMetadata({
              title: 'The Dark Forest: The Three-Body Problem, Book 2',
              authors: [{ name: 'Wrong Author Entirely' }],
              providerId: 'p1',
            }),
          ])
          .mockResolvedValueOnce([
            makeBookMetadata({
              title: 'The Dark Forest',
              authors: [{ name: 'Cixin Liu' }],
              providerId: 'p2',
            }),
          ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([candidate]);
        await waitForJob(service, id);

        const result = service.getJob(id)!.results[0];
        expect(result!.bestMatch?.title).toBe('The Dark Forest');
      });

      it('logs debug per attempt with title/author/source/candidateCount (AC30)', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeRichScan('Test Book', 'Test Author'),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValueOnce([
          makeBookMetadata({ title: 'Test Book', authors: [{ name: 'Test Author' }], providerId: 'p1' }),
        ]);
        vi.mocked(metadataService.getBook).mockResolvedValue(null);

        const id = service.createJob([candidate]);
        await waitForJob(service, id);

        expect(log.debug).toHaveBeenCalledWith(
          expect.objectContaining({
            tagTitle: 'Test Book',
            tagAuthor: 'Test Author',
            source: 'exact',
            candidateCount: 1,
          }),
          'Tag-search attempt fired',
        );
      });
    });
  });

  describe('#1650 narrator wrong-edition cap', () => {
    // 443min is the measured Brave New World file runtime.
    function makeNarratorScan(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        codec: 'AAC',
        bitrate: 128000,
        sampleRate: 44100,
        channels: 2,
        bitrateMode: 'cbr' as const,
        fileFormat: 'm4b',
        totalSize: 100_000_000,
        fileCount: 1,
        hasCoverArt: false,
        totalDuration: 443 * 60,
        ...overrides,
      };
    }

    const candidate: MatchCandidate = {
      path: '/audiobooks/Brave New World',
      title: 'Brave New World',
      author: 'Aldous Huxley',
    };

    async function runSingle(): Promise<MatchResult> {
      const id = service.createJob([candidate]);
      await waitForJob(service, id);
      return service.getJob(id)!.results[0]!;
    }

    it('caps a duration-verified tag-pass high → medium on narrator mismatch (headline, multi-alternative)', async () => {
      // Runtime verifies the 480min result (Δ50s); Adriel Brandt versus Michael York identifies the wrong edition.
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagTitle: 'Brave New World', tagAuthor: 'Aldous Huxley', tagNarrator: 'Adriel Brandt', totalDuration: 28850 }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], duration: 480, asin: 'B002V1BVK4' }),
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Some Reader'], duration: 500, asin: 'B0OTHEREDN' }),
      ]);

      const result = await runSingle();
      expect(result.bestMatch?.title).toBe('Brave New World');
      expect(result.confidence).toBe('medium');
      expect(result.reason).toContain('Adriel Brandt');
      expect(result.reason).toContain('Michael York');
      expect(result.reason).toContain('Narrator mismatch');
    });

    it('does NOT cap when the file narrator is a spelling variant at or above 0.8 (Juliet/Juliette Stevenson)', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagTitle: 'Sense and Sensibility', tagAuthor: 'Jane Austen', tagNarrator: 'Juliet Stevenson' }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Sense and Sensibility', authors: [{ name: 'Jane Austen' }], narrators: ['Juliette Stevenson'], asin: 'B0SENSE001' }),
      ]);

      const result = await runSingle();
      expect(result.confidence).toBe('high');
      expect(result.reason).toBeUndefined();
    });

    it('does NOT cap on an exact narrator match (and does not promote)', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagTitle: 'Brave New World', tagAuthor: 'Aldous Huxley', tagNarrator: 'Michael York' }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], asin: 'B002V1BVK4' }),
      ]);

      const result = await runSingle();
      expect(result.confidence).toBe('high');
      expect(result.reason).toBeUndefined();
    });

    // Six normalized-noise cases plus two no-signal placeholders from the UAT false positives.
    describe('#1655 UAT false-positive fixture resolves high (no cap)', () => {
      const fixture = [
        { title: 'Zero Hour', author: 'Joshua Dalzelle', tag: 'R. C. Bray', edition: ['R.C. Bray'] },
        { title: "Death's End", author: 'Cixin Liu', tag: 'Read by: P. J. Ochlan', edition: ['P. J. Ochlan'] },
        { title: 'To Kill a Mockingbird', author: 'Harper Lee', tag: 'Read By Sissy Spacek', edition: ['Sissy Spacek'] },
        { title: "Assassin's Apprentice", author: 'Robin Hobb', tag: 'Narrated by Paul Boehmer', edition: ['Paul Boehmer'] },
        { title: 'Storm Front', author: 'Jim Butcher', tag: 'James Marsters (Spike from Buffy The Vampire Slayer)', edition: ['James Marsters'] },
        { title: 'Shelter Mountain', author: 'Robyn Carr', tag: 'Therese Plummer', edition: ['Thérèse Plummer'] },
        { title: 'Hyperion', author: 'Dan Simmons', tag: 'Multiple Readers', edition: ['Marc Vietor', 'Allyson Johnson', 'Kevin Pariseau', 'Jay Snyder', 'Victor Bevine'] },
        { title: '1776', author: 'David McCullough', tag: 'Author', edition: ['David McCullough'] },
      ];

      it.each(fixture)('$title — tag "$tag" stays high (no cap)', async ({ title, author, tag, edition }) => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeNarratorScan({ tagTitle: title, tagAuthor: author, tagNarrator: tag }),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title, authors: [{ name: author }], narrators: edition, asin: 'B0FIXTURE1' }),
        ]);

        const id = service.createJob([{ path: `/audiobooks/${title}`, title, author }]);
        await waitForJob(service, id);
        const result = service.getJob(id)!.results[0]!;
        expect(result.confidence).toBe('high');
        expect(result.reason).toBeUndefined();
      });

      it('control: a genuinely different real narrator still caps high → medium', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeNarratorScan({ tagTitle: 'Zero Hour', tagAuthor: 'Joshua Dalzelle', tagNarrator: 'Scott Brick' }),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'Zero Hour', authors: [{ name: 'Joshua Dalzelle' }], narrators: ['R.C. Bray'], asin: 'B0FIXTURE2' }),
        ]);

        const id = service.createJob([{ path: '/audiobooks/Zero Hour', title: 'Zero Hour', author: 'Joshua Dalzelle' }]);
        await waitForJob(service, id);
        const result = service.getJob(id)!.results[0]!;
        expect(result.confidence).toBe('medium');
        expect(result.reason).toContain('Narrator mismatch');
        expect(result.reason).toContain('Scott Brick');
      });
    });

    it('multi-narrator edition: no cap when any file narrator overlaps the cast', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagTitle: 'Slaughterhouse-Five', tagAuthor: 'Kurt Vonnegut', tagNarrator: 'Ethan Hawke' }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Slaughterhouse-Five', authors: [{ name: 'Kurt Vonnegut' }], narrators: ['James Franco', 'Ethan Hawke'], asin: 'B0SLAUGH01' }),
      ]);

      const result = await runSingle();
      expect(result.confidence).toBe('high');
      expect(result.reason).toBeUndefined();
    });

    it('multi-narrator edition: caps when no file narrator overlaps the cast', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagTitle: 'Slaughterhouse-Five', tagAuthor: 'Kurt Vonnegut', tagNarrator: 'Ethan Hawke' }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Slaughterhouse-Five', authors: [{ name: 'Kurt Vonnegut' }], narrators: ['James Franco', 'Tatiana Maslany'], asin: 'B0SLAUGH02' }),
      ]);

      const result = await runSingle();
      expect(result.confidence).toBe('medium');
      expect(result.reason).toContain('Narrator mismatch');
    });

    it('no file narrator → result untouched (no cap, no reason)', async () => {
      for (const tagNarrator of [undefined, '', '   ']) {
        vi.clearAllMocks();
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeNarratorScan({ tagTitle: 'Brave New World', tagAuthor: 'Aldous Huxley', ...(tagNarrator !== undefined && { tagNarrator }) }),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], asin: 'B002V1BVK4' }),
        ]);

        const result = await runSingle();
        expect(result.confidence).toBe('high');
        expect(result.reason).toBeUndefined();
      }
    });

    it('no edition narrators → result untouched (undefined and [] both)', async () => {
      for (const narrators of [undefined, [] as string[]]) {
        vi.clearAllMocks();
        vi.mocked(scanAudioDirectory).mockResolvedValue(
          makeNarratorScan({ tagTitle: 'Brave New World', tagAuthor: 'Aldous Huxley', tagNarrator: 'Adriel Brandt' }),
        );
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], ...(narrators !== undefined && { narrators }), asin: 'B002V1BVK4' }),
        ]);

        const result = await runSingle();
        expect(result.confidence).toBe('high');
        expect(result.reason).toBeUndefined();
      }
    });

    it('never promotes: a duration-capped medium with a MATCHING narrator stays medium with its original reason', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagTitle: 'Brave New World', tagAuthor: 'Aldous Huxley', tagNarrator: 'Michael York' }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], duration: 600, asin: 'B002V1BVK4' }),
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], duration: 620, asin: 'B0OTHEREDN' }),
      ]);

      const result = await runSingle();
      expect(result.confidence).toBe('medium');
      expect(result.reason).toContain('Duration mismatch');
    });

    it('Pass 2 (filename-derived): caps a single-result high → medium on narrator mismatch', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagNarrator: 'Adriel Brandt' }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], asin: 'B002V1BVK4' }),
      ]);

      const result = await runSingle();
      expect(result.confidence).toBe('medium');
      expect(result.reason).toContain('Narrator mismatch');
    });

    it('ASIN kill-shot branch: caps a high-confidence ASIN match → medium on narrator mismatch', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagTitle: 'Brave New World', tagAuthor: 'Aldous Huxley', tagNarrator: 'Adriel Brandt', tagAsin: 'B002V1BVK4' }),
      );
      vi.mocked(metadataService.getBook).mockResolvedValue(
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], asin: 'B002V1BVK4' }),
      );

      const result = await runSingle();
      expect(result.bestMatch?.title).toBe('Brave New World');
      expect(result.confidence).toBe('medium');
      expect(result.reason).toContain('Narrator mismatch');
      expect(metadataService.searchBooks).not.toHaveBeenCalled();
    });

    const CAP_LOG = 'Narrator wrong-edition cap fired';

    it('#1652: does NOT cap on punctuation-only narrators (lone hyphen vs period — no signal)', async () => {
      // Both punctuation-only names normalize empty and must be treated as no signal.
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagTitle: 'Brave New World', tagAuthor: 'Aldous Huxley', tagNarrator: '-' }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['.'], asin: 'B002V1BVK4' }),
      ]);

      const result = await runSingle();
      expect(result.confidence).toBe('high');
      expect(result.reason).toBeUndefined();
      expect(log.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining(CAP_LOG));
    });

    it('#1652 (item 3a): a duration-capped medium with a MISMATCHING narrator keeps its duration reason (no-op, no cap log)', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagTitle: 'Brave New World', tagAuthor: 'Aldous Huxley', tagNarrator: 'Adriel Brandt' }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], duration: 600, asin: 'B002V1BVK4' }),
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], duration: 620, asin: 'B0OTHEREDN' }),
      ]);

      const result = await runSingle();
      expect(result.confidence).toBe('medium');
      expect(result.reason).toContain('Duration mismatch');
      expect(result.reason).not.toContain('Narrator mismatch');
      expect(log.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining(CAP_LOG));
    });

    it('#1652 (item 5): logs the cap once with matchSource + durationVerified on a tag-pass demotion (F6: exact/ASIN duration-matched → durationVerified true)', async () => {
      // ASIN attempts can be durationVerified even though only medium attempts set capBypassedByDuration.
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagTitle: 'Brave New World', tagAuthor: 'Aldous Huxley', tagNarrator: 'Adriel Brandt', tagAsin: 'B002V1BVK4' }),
      );
      vi.mocked(metadataService.getBook).mockResolvedValue(
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], duration: 443, asin: 'B002V1BVK4' }),
      );

      const result = await runSingle();
      expect(result.confidence).toBe('medium');
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          matchSource: 'asin-tag',
          durationVerified: true,
          fileNarrator: 'Adriel Brandt',
          editionNarrators: ['Michael York'],
        }),
        expect.stringContaining(CAP_LOG),
      );
    });

    it('#1652 (item 5): the filename-single branch logs matchSource "filename-single" with durationVerified false', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagNarrator: 'Adriel Brandt' }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], asin: 'B002V1BVK4' }),
      ]);

      const result = await runSingle();
      expect(result.confidence).toBe('medium');
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ matchSource: 'filename-single', durationVerified: false }),
        expect.stringContaining(CAP_LOG),
      );
    });

    it('#1652 (item 5) / #1821 (AC9): the filename-single branch logs durationVerified TRUE when the scanned runtime corroborates the edition', async () => {
      // Guards against filename-single cap context reverting to a hard-coded false.
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagNarrator: 'Adriel Brandt' }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], duration: 443, asin: 'B002V1BVK4' }),
      ]);

      const result = await runSingle();
      expect(result.confidence).toBe('medium');
      expect(result.reason).toContain('Narrator mismatch');
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ matchSource: 'filename-single', durationVerified: true }),
        expect.stringContaining(CAP_LOG),
      );
    });

    it('#1652 (item 5): the filename duration-resolved multi-result branch logs matchSource "filename-duration-resolved" with durationVerified true', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagNarrator: 'Adriel Brandt' }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], duration: 443, asin: 'B002V1BVK4' }),
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Some Reader'], duration: 500, asin: 'B0OTHEREDN' }),
      ]);

      const result = await runSingle();
      expect(result.confidence).toBe('medium');
      expect(result.reason).toContain('Narrator mismatch');
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ matchSource: 'filename-duration-resolved', durationVerified: true }),
        expect.stringContaining(CAP_LOG),
      );
    });

    it('#1652 (item 5): a matching narrator does NOT fire the cap log', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValue(
        makeNarratorScan({ tagTitle: 'Brave New World', tagAuthor: 'Aldous Huxley', tagNarrator: 'Michael York' }),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        makeBookMetadata({ title: 'Brave New World', authors: [{ name: 'Aldous Huxley' }], narrators: ['Michael York'], asin: 'B002V1BVK4' }),
      ]);

      const result = await runSingle();
      expect(result.confidence).toBe('high');
      expect(log.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining(CAP_LOG));
    });
  });

  // Measured Fablehaven: file 33219.47s, chapters 33219.49s, scalar 32340s.
  // Chapter runtime is a lazy, suppress-only corroborating source.
  describe('#1942 chapter-runtime corroboration', () => {
    const FABLEHAVEN_ASIN = 'B00CXXEX8W';
    const SCANNED_SECONDS = 33219.47;
    const SCALAR_MINUTES = 539;
    const CHAPTER_SECONDS = 33219.49;
    // No trimmable tail: preserve the full/trimmed reference shape (#2168).
    const CHAPTER_REFS = { fullSeconds: CHAPTER_SECONDS, trimmedSeconds: CHAPTER_SECONDS };
    const NO_CHAPTER_REFS = {};
    const CAP_LOG = 'Narrator wrong-edition cap fired';
    const MISMATCH = 'Duration mismatch';

    const candidate: MatchCandidate = {
      path: '/audiobooks/Fablehaven',
      title: 'Fablehaven',
      author: 'Brandon Mull',
    };

    function makeScan(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        codec: 'AAC',
        bitrate: 128000,
        sampleRate: 44100,
        channels: 2,
        bitrateMode: 'cbr' as const,
        fileFormat: 'm4b',
        totalSize: 100_000_000,
        fileCount: 1,
        hasCoverArt: false,
        totalDuration: SCANNED_SECONDS,
        ...overrides,
      };
    }

    function tagScan(overrides: Partial<Record<string, unknown>> = {}) {
      return makeScan({ tagTitle: 'Fablehaven', tagAuthor: 'Brandon Mull', ...overrides });
    }

    function fablehaven(overrides: Partial<BookMetadata> = {}): BookMetadata {
      return makeBookMetadata({
        title: 'Fablehaven',
        authors: [{ name: 'Brandon Mull' }],
        narrators: ['E. B. Stevens'],
        duration: SCALAR_MINUTES,
        asin: FABLEHAVEN_ASIN,
        ...overrides,
      });
    }

    async function runSingle(): Promise<MatchResult> {
      const id = service.createJob([candidate]);
      await waitForJob(service, id);
      return service.getJob(id)!.results[0]!;
    }

    function chapterLookups(): unknown[][] {
      return vi.mocked(metadataService.getChapterRuntimeSeconds).mock.calls;
    }

    beforeEach(() => {
      vi.mocked(metadataService.getChapterRuntimeSeconds).mockResolvedValue(CHAPTER_REFS);
    });

    describe('AC6 — rescue, run independently through BOTH assembly paths (F21)', () => {
      it('FILENAME assembly (single result): high, no duration-mismatch reason, exactly one lookup', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(result.confidence).toBe('high');
        expect(result.reason).toBeUndefined();
        expect(result.reasonKind).toBeUndefined();
        expect(chapterLookups()).toEqual([[FABLEHAVEN_ASIN]]);
      });

      it('FILENAME assembly (multi result): high, no duration-mismatch reason, exactly one lookup', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          fablehaven(),
          fablehaven({ asin: 'B0OTHEREDN', duration: 700 }),
        ]);

        const result = await runSingle();

        expect(result.confidence).toBe('high');
        expect(result.reason).toBeUndefined();
        expect(result.reasonKind).toBeUndefined();
        expect(chapterLookups()).toEqual([[FABLEHAVEN_ASIN]]);
      });

      it('TAG assembly: high, no duration-mismatch reason, exactly one lookup', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(tagScan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(result.confidence).toBe('high');
        expect(result.reason).toBeUndefined();
        expect(result.reasonKind).toBeUndefined();
        expect(chapterLookups()).toEqual([[FABLEHAVEN_ASIN]]);
      });

      it('TAG assembly via the ASIN kill-shot: high, no duration-mismatch reason, exactly one lookup', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(tagScan({ tagAsin: FABLEHAVEN_ASIN }));
        vi.mocked(metadataService.getBook).mockResolvedValue(fablehaven());

        const result = await runSingle();

        expect(result.confidence).toBe('high');
        expect(result.reason).toBeUndefined();
        expect(result.reasonKind).toBeUndefined();
        // Kill-shot bypasses the planner, so pin this separate bridge call.
        expect(chapterLookups()).toEqual([[FABLEHAVEN_ASIN]]);
      });

      it('without the corroboration the SAME inputs flag — the rescue is genuinely doing the work', async () => {
        vi.mocked(metadataService.getChapterRuntimeSeconds).mockResolvedValue(NO_CHAPTER_REFS);
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(result.reason).toContain(MISMATCH);
        expect(result.reasonKind).toBe('duration-mismatch');
      });
    });

    describe('AC8 — cap routing: the promoted verdict reaches applyNarratorCap with durationVerified true', () => {
      // durationVerified is observable only when narrator mismatch emits the cap log.
      it('FILENAME single assembly', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ tagNarrator: 'Adriel Brandt' }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(result.reason).toContain('Narrator mismatch');
        expect(log.info).toHaveBeenCalledWith(
          expect.objectContaining({ matchSource: 'filename-single', durationVerified: true }),
          expect.stringContaining(CAP_LOG),
        );
      });

      it('FILENAME multi assembly', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ tagNarrator: 'Adriel Brandt' }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          fablehaven(),
          fablehaven({ asin: 'B0OTHEREDN', duration: 700, narrators: ['Some Reader'] }),
        ]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(log.info).toHaveBeenCalledWith(
          expect.objectContaining({ matchSource: 'filename-duration-resolved', durationVerified: true }),
          expect.stringContaining(CAP_LOG),
        );
      });

      it('TAG assembly', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(tagScan({ tagNarrator: 'Adriel Brandt' }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(log.info).toHaveBeenCalledWith(
          expect.objectContaining({ matchSource: 'exact', durationVerified: true }),
          expect.stringContaining(CAP_LOG),
        );
      });
    });

    describe('AC7 — suppress-only: a genuinely-off file still flags', () => {
      it('FILENAME assembly: a file 300s past BOTH references stays medium/duration-mismatch', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: SCANNED_SECONDS + 300 }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(result.reason).toContain(MISMATCH);
        expect(result.reasonKind).toBe('duration-mismatch');
      });

      it('TAG assembly: a TRUNCATED file (half the runtime) stays medium/duration-mismatch', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(tagScan({ totalDuration: SCANNED_SECONDS / 2 }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(result.reason).toContain(MISMATCH);
        expect(result.reasonKind).toBe('duration-mismatch');
      });

      it('never demotes: a scalar-VERIFIED match stays high even if the chapter runtime disagrees', async () => {
        vi.mocked(metadataService.getChapterRuntimeSeconds).mockResolvedValue({ fullSeconds: 1, trimmedSeconds: 1 });
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: SCALAR_MINUTES * 60 }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(result.confidence).toBe('high');
        expect(result.reason).toBeUndefined();
      });

      it('the mismatch reason still renders the SCALAR expectation when nothing rescues it', async () => {
        vi.mocked(metadataService.getChapterRuntimeSeconds).mockResolvedValue(NO_CHAPTER_REFS);
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(result.reason).toBe('Duration mismatch — scanned 9h 13m vs expected 8h 59m');
      });
    });

    describe('AC4 — laziness: only a qualifying mismatch fetches', () => {
      it('a scalar-VERIFIED match issues ZERO chapter lookups (filename + tag)', async () => {
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: SCALAR_MINUTES * 60 }));
        expect((await runSingle()).confidence).toBe('high');
        vi.mocked(scanAudioDirectory).mockResolvedValue(tagScan({ totalDuration: SCALAR_MINUTES * 60 }));
        expect((await runSingle()).confidence).toBe('high');

        expect(chapterLookups()).toEqual([]);
      });

      it('an ambiguity-class review (no-duration-data) issues ZERO chapter lookups', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: 0 }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          fablehaven(),
          fablehaven({ asin: 'B0OTHEREDN', duration: 700 }),
        ]);

        const result = await runSingle();

        expect(result.reasonKind).toBe('no-duration-data');
        expect(chapterLookups()).toEqual([]);
      });

      it('a missing-duration review issues ZERO chapter lookups', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([
          fablehaven({ duration: undefined }),
          fablehaven({ asin: 'B0OTHEREDN', duration: undefined, title: 'Fablehaven' }),
        ]);

        const result = await runSingle();

        expect(result.reasonKind).toBe('missing-duration');
        expect(chapterLookups()).toEqual([]);
      });

      it.each([
        ['FILENAME', makeScan],
        ['TAG', tagScan],
      ])('%s assembly: a duration mismatch whose top candidate has NO asin issues zero lookups and keeps the scalar verdict', async (_label, scan) => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(scan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven({ asin: undefined })]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(result.reasonKind).toBe('duration-mismatch');
        expect(chapterLookups()).toEqual([]);
      });

      it.each([
        ['FILENAME', makeScan],
        ['TAG', tagScan],
      ])('%s assembly: a BLANK asin is treated as absent — zero lookups', async (_label, scan) => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(scan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven({ asin: '   ' })]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(result.reasonKind).toBe('duration-mismatch');
        expect(chapterLookups()).toEqual([]);
      });
    });

    describe('boundary — the shared 240s band judges the chapter runtime too', () => {
      it.each([
        ['exactly 240s from the chapter runtime verifies (inclusive)', 240, 'high'],
        ['241s flags', 241, 'medium'],
      ])('%s', async (_label, delta, expected) => {
        vi.mocked(metadataService.getChapterRuntimeSeconds).mockResolvedValue({ fullSeconds: SCANNED_SECONDS + delta, trimmedSeconds: SCANNED_SECONDS + delta });
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        expect((await runSingle()).confidence).toBe(expected);
      });
    });

    describe('AC9 — graceful degradation', () => {
      it('a THROWING chapter lookup degrades to the scalar verdict — it never becomes confidence "none"', async () => {
        vi.mocked(metadataService.getChapterRuntimeSeconds).mockRejectedValue(new Error('Audnexus exploded'));
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(result.bestMatch?.asin).toBe(FABLEHAVEN_ASIN);
        expect(result.reasonKind).toBe('duration-mismatch');
        expect(result.error).toBeUndefined();
        expect(log.debug).toHaveBeenCalledWith(
          expect.objectContaining({ asin: FABLEHAVEN_ASIN }),
          expect.stringContaining('keeping the scalar duration verdict'),
        );
      });

      it('the same failure on the TAG path also degrades rather than losing the match', async () => {
        vi.mocked(metadataService.getChapterRuntimeSeconds).mockRejectedValue(new Error('Audnexus exploded'));
        vi.mocked(scanAudioDirectory).mockResolvedValue(tagScan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(result.bestMatch?.asin).toBe(FABLEHAVEN_ASIN);
        expect(result.error).toBeUndefined();
      });
    });

    describe('AC10 — no new MatchResult field', () => {
      it('a rescued row carries no chapter-runtime field for the client to consume', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(Object.keys(result).sort()).toEqual(
          ['alternatives', 'bestMatch', 'confidence', 'path', 'scannedSeconds'],
        );
      });
    });

    // Measured Addie LaRue: a retail rip omits a 21.1min End Credits tail;
    // the file is 1256s from full runtime and 10s from trimmed runtime.
    describe('#2168 trimmed chapter-runtime corroboration', () => {
      const ADDIE_ASIN = 'B0ADDIELARU';
      const ADDIE_SCALAR_MINUTES = 1440;
      const ADDIE_SCANNED = 85_144;
      const ADDIE_FULL_SECONDS = 86_400;
      const ADDIE_TRIMMED_SECONDS = 85_134;
      const ADDIE_REFS = { fullSeconds: ADDIE_FULL_SECONDS, trimmedSeconds: ADDIE_TRIMMED_SECONDS };

      function addie(overrides: Partial<BookMetadata> = {}): BookMetadata {
        return makeBookMetadata({
          title: 'Fablehaven',
          authors: [{ name: 'Brandon Mull' }],
          narrators: ['E. B. Stevens'],
          duration: ADDIE_SCALAR_MINUTES,
          asin: ADDIE_ASIN,
          ...overrides,
        });
      }

      beforeEach(() => {
        vi.mocked(metadataService.getChapterRuntimeSeconds).mockResolvedValue(ADDIE_REFS);
      });

      // Multi rows need the extra candidate; alternatives count proves the multi-result resolver ran.
      it.each([
        ['FILENAME single', () => makeScan({ totalDuration: ADDIE_SCANNED }), [] as BookMetadata[]],
        ['FILENAME multi', () => makeScan({ totalDuration: ADDIE_SCANNED }), [addie({ asin: 'B0OTHEREDN', duration: 700 })]],
        ['TAG single', () => tagScan({ totalDuration: ADDIE_SCANNED }), [] as BookMetadata[]],
        ['TAG multi', () => tagScan({ totalDuration: ADDIE_SCANNED }), [addie({ asin: 'B0OTHEREDN', duration: 700 })]],
      ])('%s assembly: the TRIMMED reference alone rescues the row — high with NO mismatch reason', async (_label, scan, extra) => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(scan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([addie(), ...extra]);

        const result = await runSingle();

        expect(result.confidence).toBe('high');
        expect(result.reason).toBeUndefined();
        expect(result.reasonKind).toBeUndefined();
        expect(result.bestMatch?.asin).toBe(ADDIE_ASIN);
        expect(result.alternatives).toHaveLength(extra.length);
        expect(chapterLookups()).toEqual([[ADDIE_ASIN]]);
      });

      it('the FULL reference alone would NOT have rescued it — the trim is doing the work', async () => {
        vi.mocked(metadataService.getChapterRuntimeSeconds).mockResolvedValue({ fullSeconds: ADDIE_FULL_SECONDS });
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: ADDIE_SCANNED }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([addie()]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(result.reasonKind).toBe('duration-mismatch');
      });

      it('AC23 — a trimmed-driven promotion reports durationVerified TRUE to the narrator cap', async () => {
        // Passing only the full reference would make this false and let the cap demote.
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: ADDIE_SCANNED, tagNarrator: 'Adriel Brandt' }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([addie()]);

        await runSingle();

        expect(log.info).toHaveBeenCalledWith(
          expect.objectContaining({ matchSource: 'filename-single', durationVerified: true }),
          expect.stringContaining(CAP_LOG),
        );
      });

      it('AC23 — the TAG path reports durationVerified TRUE on the same basis', async () => {
        vi.mocked(scanAudioDirectory).mockResolvedValue(tagScan({ totalDuration: ADDIE_SCANNED, tagNarrator: 'Adriel Brandt' }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([addie()]);

        await runSingle();

        expect(log.info).toHaveBeenCalledWith(
          expect.objectContaining({ matchSource: 'exact', durationVerified: true }),
          expect.stringContaining(CAP_LOG),
        );
      });

      it('pin 2 (The Rook) — a file that runs LONG still flags, trimmable tail or not', async () => {
        // Measured ~260s excess comes from 13 duplicated-narration overlaps; trimming widens the gap.
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: ADDIE_FULL_SECONDS + 260 }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([addie()]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(result.reasonKind).toBe('duration-mismatch');
      });

      it('pin 2 control — the same long file with NO trimmable tail also flags', async () => {
        vi.mocked(metadataService.getChapterRuntimeSeconds)
          .mockResolvedValue({ fullSeconds: ADDIE_FULL_SECONDS, trimmedSeconds: ADDIE_FULL_SECONDS });
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: ADDIE_FULL_SECONDS + 260 }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([addie()]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(result.reasonKind).toBe('duration-mismatch');
      });

      it('pin 3 (Legends & Lattes) — the walk stops on a named bonus story, so the row STILL flags', async () => {
        // The named bonus story halts trimming before End Credits; the file genuinely lacks 57.5min.
        const FULL = 22_800;
        vi.mocked(metadataService.getChapterRuntimeSeconds)
          .mockResolvedValue({ fullSeconds: FULL, trimmedSeconds: FULL });
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: FULL - 3_450 }));
        vi.mocked(metadataService.searchBooks).mockResolvedValue([addie({ duration: 380 })]);

        const result = await runSingle();

        expect(result.confidence).toBe('medium');
        expect(result.reasonKind).toBe('duration-mismatch');
        // The reason remains based on the 380min scalar.
        expect(result.reason).toBe('Duration mismatch — scanned 5h 22m vs expected 6h 20m');
      });

      it('a trimmed reference that is present but EQUAL to the full one behaves exactly as today (AC31)', async () => {
        vi.mocked(metadataService.getChapterRuntimeSeconds).mockResolvedValue(CHAPTER_REFS);
        vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan());
        vi.mocked(metadataService.searchBooks).mockResolvedValue([fablehaven()]);

        const result = await runSingle();

        expect(result.confidence).toBe('high');
        expect(result.reasonKind).toBeUndefined();
      });
    });
  });
});
