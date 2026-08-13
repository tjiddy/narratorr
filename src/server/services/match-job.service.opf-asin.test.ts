// #2292 — the OPF/tag ASIN identification rung. Boundary: stub MetadataService and the
// opf-reader module, never match-job internals, so the real rung/ladder/cap logic executes.
// The one real-filesystem proof that the sidecar is actually read lives in the sibling
// match-job.service.opf-asin.fs.test.ts, which deliberately does not mock the reader.

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('@core/utils/audio-processor.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, resolveFfmpegPath: () => Promise.resolve('/usr/bin/ffmpeg') };
});

vi.mock('@core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/opf-reader.js', () => ({
  readOpfMetadata: vi.fn().mockResolvedValue(null),
}));

// Preserve crypto.randomBytes: auth.service builds DUMMY_SALT during transitive import.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, randomUUID: vi.fn().mockReturnValue('opf-asin-job') };
});

import { createMockLogger, inject } from '../__tests__/helpers.js';
import { MatchJobService, type MatchCandidate, type MatchResult } from './match-job.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookService } from './book.service.js';
import type { BookMetadata } from '@core/metadata/index.js';
import type { AudioScanResult } from '@core/utils/audio-scanner.js';
import type { OpfMetadata } from '../utils/opf-reader.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { readOpfMetadata } from '../utils/opf-reader.js';
import { randomUUID } from 'node:crypto';

const GUNSLINGER_ASIN = 'B019NNU7XE';
const DRAWING_ASIN = 'B019NNTLBS';
/** The Secret Commonwealth ships this ISBN-10 in its OPF ASIN field. */
const ISBN_IN_ASIN_FIELD = '0593105192';

const gunslinger: MatchCandidate = {
  path: '/audiobooks/Stephen King/The Gunslinger',
  title: 'The Gunslinger',
  author: 'Stephen King',
};

function makeOpf(overrides: Partial<OpfMetadata> = {}): OpfMetadata {
  return {
    title: 'The Gunslinger',
    subtitle: null,
    authors: ['Stephen King'],
    narrators: [],
    description: null,
    publisher: null,
    publishedDate: null,
    asin: null,
    isbn: null,
    seriesName: null,
    seriesPosition: null,
    genres: [],
    ...overrides,
  };
}

function makeScan(overrides: Partial<AudioScanResult> = {}): AudioScanResult {
  return {
    hasCoverArt: false,
    codec: 'AAC',
    bitrate: 128000,
    sampleRate: 44100,
    channels: 2,
    bitrateMode: 'cbr',
    fileFormat: 'm4b',
    totalDuration: 0,
    totalSize: 100_000_000,
    fileCount: 1,
    ...overrides,
  };
}

function darkTowerI(overrides: Partial<BookMetadata> = {}): BookMetadata {
  return {
    title: 'Dark Tower I',
    authors: [{ name: 'Stephen King' }],
    asin: GUNSLINGER_ASIN,
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

async function waitForJob(service: MatchJobService, id: string, maxMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const status = service.getJob(id);
    if (!status || status.status !== 'matching') return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('MatchJobService — OPF/tag ASIN identification rung (#2292)', () => {
  let service: MatchJobService;
  let metadataService: MetadataService;
  let bookService: BookService;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    // *Once queues are used below, so reset rather than clear; then re-establish the module
    // defaults, since `readOpfMetadata` resolving undefined would break every rung call.
    vi.resetAllMocks();
    vi.mocked(scanAudioDirectory).mockResolvedValue(null);
    vi.mocked(readOpfMetadata).mockResolvedValue(null);
    (randomUUID as ReturnType<typeof vi.fn>).mockReturnValue('opf-asin-job');

    log = createMockLogger();
    metadataService = createMockMetadataService();
    bookService = inject<BookService>({
      findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false }),
    });
    service = new MatchJobService(
      metadataService,
      inject<FastifyBaseLogger>(log),
      inject<SettingsService>({ get: vi.fn().mockResolvedValue({ ffmpegPath: '' }) }),
      bookService,
    );
  });

  async function runJob(books: MatchCandidate[]): Promise<MatchResult[]> {
    const id = service.createJob(books);
    await waitForJob(service, id);
    return service.getJob(id)!.results;
  }

  async function runSingle(book: MatchCandidate = gunslinger): Promise<MatchResult> {
    const [result] = await runJob([book]);
    return result!;
  }

  const getBookArgs = (): unknown[][] => vi.mocked(metadataService.getBook).mock.calls;
  const debugCalls = (): [Record<string, unknown>, string][] =>
    (log.debug as Mock).mock.calls as [Record<string, unknown>, string][];
  const debugMessages = (): string[] => debugCalls().map(([, message]) => message);

  function debugRecord(message: string): Record<string, unknown> | undefined {
    return debugCalls().find(([, logged]) => logged === message)?.[0];
  }

  describe('the regression this issue exists for', () => {
    it('identifies a curated title from its OPF ASIN, without searching at all', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(darkTowerI());

      const result = await runSingle();

      expect(getBookArgs()).toEqual([[GUNSLINGER_ASIN]]);
      expect(metadataService.searchBooks).not.toHaveBeenCalled();
      expect(result.confidence).toBe('high');
      expect(result.bestMatch?.title).toBe('Dark Tower I');
      expect(result.alternatives).toEqual([]);
    });

    it('AC2 — the title-similarity floor is never consulted: a zero-overlap provider title still wins', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(
        darkTowerI({ title: 'Zzzz Qqqq Vvvv' }),
      );

      const result = await runSingle();

      expect(result.confidence).toBe('high');
      expect(result.bestMatch?.title).toBe('Zzzz Qqqq Vvvv');
    });
  });

  describe('AC4 — ASIN validation gates the provider call', () => {
    it('an ISBN in the OPF ASIN field never reaches getBook; the text path runs as it does today', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: ISBN_IN_ASIN_FIELD }));
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        darkTowerI({ title: 'The Gunslinger', asin: 'B0TEXTPATH' }),
      ]);

      const result = await runSingle();

      expect(getBookArgs()).toEqual([]);
      expect(metadataService.searchBooks).toHaveBeenCalledWith(
        'The Gunslinger Stephen King',
        { title: 'The Gunslinger', author: 'Stephen King' },
      );
      expect(result.bestMatch?.title).toBe('The Gunslinger');
      expect(result.confidence).toBe('high');
    });

    it('a rejected OPF value still lets a valid tag ASIN fire', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: ISBN_IN_ASIN_FIELD }));
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ tagAsin: DRAWING_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(darkTowerI({ title: 'Dark Tower II', asin: DRAWING_ASIN }));

      const result = await runSingle();

      expect(getBookArgs()).toEqual([[DRAWING_ASIN]]);
      expect(result.confidence).toBe('high');
      expect(result.bestMatch?.title).toBe('Dark Tower II');
    });
  });

  describe('AC5/AC6 — null and missing data cost exactly today\'s provider calls', () => {
    it('no metadata.opf at all: no identification lookup', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(null);

      await runSingle();

      expect(getBookArgs()).toEqual([]);
      expect(metadataService.searchBooks).toHaveBeenNthCalledWith(
        1,
        'The Gunslinger Stephen King',
        { title: 'The Gunslinger', author: 'Stephen King' },
      );
    });

    it('an OPF that parses but carries no identifier: no identification lookup', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf());

      await runSingle();

      expect(getBookArgs()).toEqual([]);
    });

    it('the Handmade case — an ISBN identifier only: no lookup, and the ISBN goes nowhere', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ isbn: '9780593105191' }));

      await runSingle();

      expect(getBookArgs()).toEqual([]);
      expect(vi.mocked(metadataService.searchBooks).mock.calls.flat(2)).not.toContain('9780593105191');
    });

    it('an over-bound OPF ASIN the reader already dropped: the rung sees null and issues no lookup', async () => {
      // readOpfMetadata drops identifiers over ID_MAX as `dropped-over-bound`, surfacing asin: null.
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: null }));

      await runSingle();

      expect(getBookArgs()).toEqual([]);
    });

    it('a single-file pointer path is a rung no-op', async () => {
      const pointer: MatchCandidate = { path: '/audiobooks/Doctor Sleep.m4b', title: 'Doctor Sleep', author: 'Stephen King' };

      await runSingle(pointer);

      expect(readOpfMetadata).toHaveBeenCalledWith(pointer.path, expect.anything());
      expect(getBookArgs()).toEqual([]);
    });
  });

  describe('AC5 — a miss or an error is never worse than today', () => {
    it('getBook resolving null falls through to the text search with today\'s query', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(null);
      vi.mocked(metadataService.searchBooks).mockResolvedValue([darkTowerI({ title: 'The Gunslinger' })]);

      const result = await runSingle();

      expect(metadataService.searchBooks).toHaveBeenCalledWith(
        'The Gunslinger Stephen King',
        { title: 'The Gunslinger', author: 'Stephen King' },
      );
      expect(result.bestMatch?.title).toBe('The Gunslinger');
    });

    it('getBook rejecting falls through, is logged, and the book still gets its text-search outcome', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockRejectedValue(new Error('provider exploded'));
      vi.mocked(metadataService.searchBooks).mockResolvedValue([darkTowerI({ title: 'The Gunslinger' })]);

      const result = await runSingle();

      expect(debugMessages()).toContain('ASIN identification rung errored — falling through');
      expect(result.confidence).toBe('high');
      expect(result.bestMatch?.title).toBe('The Gunslinger');
    });

    it('a readOpfMetadata rejection degrades that one book only — a sibling in the same job completes', async () => {
      const sibling: MatchCandidate = { path: '/audiobooks/Stephen King/Wolves of the Calla', title: 'Wolves of the Calla', author: 'Stephen King' };
      vi.mocked(readOpfMetadata).mockImplementation((folder: string) =>
        folder === gunslinger.path
          ? Promise.reject(new Error('reader contract violated'))
          : Promise.resolve(null),
      );
      vi.mocked(metadataService.searchBooks).mockResolvedValue([
        darkTowerI({ title: 'Wolves of the Calla' }),
      ]);

      const results = await runJob([gunslinger, sibling]);

      const failed = results.find(r => r.path === gunslinger.path)!;
      expect(failed.confidence).toBe('none');
      expect(failed.error).toBe('reader contract violated');
      const survivor = results.find(r => r.path === sibling.path)!;
      expect(survivor.confidence).toBe('high');
      expect(survivor.bestMatch?.title).toBe('Wolves of the Calla');
    });
  });

  describe('AC1/AC6/AC8 — rung precedence and the call ceiling', () => {
    it('OPF and tag differ and the OPF resolves: only the OPF value is probed', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ tagAsin: DRAWING_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(darkTowerI());

      const result = await runSingle();

      expect(getBookArgs()).toEqual([[GUNSLINGER_ASIN]]);
      expect(result.confidence).toBe('high');
    });

    it('OPF misses and the tag ASIN canonicalizes equal: the duplicate is never re-probed', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ tagAsin: GUNSLINGER_ASIN.toLowerCase() }));
      vi.mocked(metadataService.getBook).mockResolvedValue(null);
      vi.mocked(metadataService.searchBooks).mockResolvedValue([darkTowerI({ title: 'The Gunslinger' })]);

      await runSingle();

      expect(getBookArgs()).toEqual([[GUNSLINGER_ASIN]]);
      expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
    });

    it('OPF misses and the tag ASIN differs: both are probed, OPF first, then the text search runs', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ tagAsin: DRAWING_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(null);
      vi.mocked(metadataService.searchBooks).mockResolvedValue([darkTowerI({ title: 'The Gunslinger' })]);

      await runSingle();

      expect(getBookArgs()).toEqual([[GUNSLINGER_ASIN], [DRAWING_ASIN]]);
      expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
    });

    it('F4 — an OPF rejection probes a DISTINCT tag ASIN second', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ tagAsin: DRAWING_ASIN }));
      vi.mocked(metadataService.getBook)
        .mockRejectedValueOnce(new Error('provider exploded'))
        .mockResolvedValue(darkTowerI({ title: 'Dark Tower II', asin: DRAWING_ASIN }));

      const result = await runSingle();

      expect(getBookArgs()).toEqual([[GUNSLINGER_ASIN], [DRAWING_ASIN]]);
      expect(result.bestMatch?.title).toBe('Dark Tower II');
      expect(metadataService.searchBooks).not.toHaveBeenCalled();
    });

    it('F4 — an OPF rejection never re-probes an EQUAL-canonical tag ASIN', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ tagAsin: `  ${GUNSLINGER_ASIN.toLowerCase()}  ` }));
      vi.mocked(metadataService.getBook).mockRejectedValue(new Error('provider exploded'));
      vi.mocked(metadataService.searchBooks).mockResolvedValue([darkTowerI({ title: 'The Gunslinger' })]);

      await runSingle();

      expect(getBookArgs()).toEqual([[GUNSLINGER_ASIN]]);
      expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
    });

    it('a lone usable ASIN that misses costs exactly one lookup, then the text search runs', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(null);
      vi.mocked(metadataService.searchBooks).mockResolvedValue([darkTowerI({ title: 'The Gunslinger' })]);

      await runSingle();

      expect(getBookArgs()).toEqual([[GUNSLINGER_ASIN]]);
      expect(metadataService.searchBooks).toHaveBeenCalledTimes(1);
    });

    it('AC8 — a tag ASIN fires even with no usable tag title or author', async () => {
      // deriveTagQuery returns null here, which used to gate the kill-shot out entirely.
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ tagAsin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(darkTowerI());

      const result = await runSingle();

      expect(getBookArgs()).toEqual([[GUNSLINGER_ASIN]]);
      expect(result.confidence).toBe('high');
      expect(result.bestMatch?.title).toBe('Dark Tower I');
      expect(metadataService.searchBooks).not.toHaveBeenCalled();
    });
  });

  describe('AC3 — the shared post-match caps still apply', () => {
    it('a narrator mismatch demotes the rung hit and the cap log carries matchSource asin-opf', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: 443 * 60, tagNarrator: 'Adriel Brandt' }));
      vi.mocked(metadataService.getBook).mockResolvedValue(
        darkTowerI({ narrators: ['George Guidall'], duration: 443 }),
      );

      const result = await runSingle();

      expect(result.confidence).toBe('medium');
      expect(result.reason).toContain('Narrator mismatch');
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ matchSource: 'asin-opf', durationVerified: true }),
        expect.stringContaining('Narrator wrong-edition cap fired'),
      );
    });

    it('a duration mismatch takes exactly one chapter-runtime bridge call and survives as medium', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: 556 * 60 }));
      vi.mocked(metadataService.getBook).mockResolvedValue(darkTowerI({ duration: 807 }));

      const result = await runSingle();

      expect(vi.mocked(metadataService.getChapterRuntimeSeconds).mock.calls).toEqual([[GUNSLINGER_ASIN]]);
      expect(result.confidence).toBe('medium');
      expect(result.reasonKind).toBe('duration-mismatch');
    });

    it('a corroborated duration mismatch stays high with no reason', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: 556 * 60 }));
      vi.mocked(metadataService.getBook).mockResolvedValue(darkTowerI({ duration: 807 }));
      vi.mocked(metadataService.getChapterRuntimeSeconds).mockResolvedValue({ fullSeconds: 556 * 60 });

      const result = await runSingle();

      expect(result.confidence).toBe('high');
      expect(result).not.toHaveProperty('reason');
      expect(result).not.toHaveProperty('reasonKind');
    });

    it('applyLibraryDuplicate still annotates the rung hit', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(darkTowerI());
      vi.mocked(bookService.findDuplicate).mockResolvedValue({
        verdict: 'same-recording', book: { id: 421, title: 'Dark Tower I' }, hasIncumbent: true,
      } as unknown as Awaited<ReturnType<BookService['findDuplicate']>>);

      const result = await runSingle();

      expect(result.isDuplicate).toBe(true);
      expect(result.existingBookId).toBe(421);
      expect(result.duplicateReason).toBe('slug');
      expect(result.recordingVerdict).toBe('same-recording');
    });

    it('scannedSeconds rides along on a rung hit, and is absent when the scan produced nothing', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ totalDuration: 4200 }));
      vi.mocked(metadataService.getBook).mockResolvedValue(darkTowerI({ duration: 70 }));

      expect((await runSingle()).scannedSeconds).toBe(4200);

      vi.mocked(scanAudioDirectory).mockResolvedValue(null);
      expect(await runSingle()).not.toHaveProperty('scannedSeconds');
    });

    it('a null audio scan still produces a high rung hit rather than throwing', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(scanAudioDirectory).mockResolvedValue(null);
      vi.mocked(metadataService.getBook).mockResolvedValue(darkTowerI({ duration: 443 }));

      const result = await runSingle();

      expect(result.confidence).toBe('high');
      expect(result.error).toBeUndefined();
    });
  });

  describe('AC7 — books with no usable ASIN are untouched, and the rung adds no filtering', () => {
    it('the Dark Tower V–VIII shape (no OPF ASIN) still matches high through the text path', async () => {
      const later: MatchCandidate[] = ['Wolves of the Calla', 'Song of Susannah', 'The Dark Tower', 'The Wind Through the Keyhole']
        .map(title => ({ path: `/audiobooks/Stephen King/${title}`, title, author: 'Stephen King' }));
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf());
      vi.mocked(metadataService.searchBooks).mockImplementation((_q, opts) =>
        Promise.resolve([darkTowerI({ title: opts!.title!, asin: 'B0LATERDT1' })]),
      );

      const results = await runJob(later);

      expect(results).toHaveLength(4);
      for (const result of results) {
        expect(result.confidence).toBe('high');
      }
      expect(getBookArgs()).toEqual([]);
    });

    it('the rung post-filters nothing: an 18-minute direct-lookup result still resolves high', async () => {
      // Direct ASIN lookup is deliberately exempt from minDurationMinutes, rejectWords and
      // language filtering (metadata.service.test.ts:1059). The rung must not reintroduce them.
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(darkTowerI({ duration: 18, language: 'german' }));

      const result = await runSingle();

      expect(result.confidence).toBe('high');
      expect(result.bestMatch?.duration).toBe(18);
    });

    it('the mirror case: with no usable ASIN the text path\'s result is passed through unaltered', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(null);
      const searched = darkTowerI({ title: 'The Gunslinger', duration: 18, asin: 'B0TEXTPATH' });
      vi.mocked(metadataService.searchBooks).mockResolvedValue([searched]);

      const result = await runSingle();

      expect(result.bestMatch).toEqual(searched);
      expect(getBookArgs()).toEqual([]);
    });
  });

  describe('races and cancellation', () => {
    it('each book in a concurrent job probes its own ASIN exactly once', async () => {
      const asins = ['B019NNU7XE', 'B019NNTLBS', 'B019NNT1G8'];
      const books: MatchCandidate[] = asins.map((_asin, i) => ({ path: `/audiobooks/book-${i}`, title: `Book ${i}`, author: 'Stephen King' }));
      vi.mocked(readOpfMetadata).mockImplementation((folder: string) => {
        const index = Number(folder.slice(folder.lastIndexOf('-') + 1));
        return Promise.resolve(makeOpf({ asin: asins[index]! }));
      });
      vi.mocked(metadataService.getBook).mockImplementation((asin: string) =>
        Promise.resolve(darkTowerI({ asin, title: `Resolved ${asin}` })),
      );

      const results = await runJob(books);

      expect(results).toHaveLength(3);
      expect(getBookArgs().flat().sort()).toEqual([...asins].sort());
    });

    it('a job cancelled before a book starts issues no lookup for it', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(darkTowerI());

      const id = service.createJob([gunslinger]);
      service.cancelJob(id);
      await waitForJob(service, id);

      expect(getBookArgs()).toEqual([]);
    });
  });

  describe('AC10 — every rung outcome is traceable at debug, keyed on path', () => {
    it('logs found then resolved for a hit', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(darkTowerI());

      await runSingle();

      expect(debugRecord('ASIN identification candidate found')).toEqual(
        expect.objectContaining({ path: gunslinger.path, source: 'asin-opf', asin: GUNSLINGER_ASIN }),
      );
      expect(debugRecord('ASIN identification rung resolved')).toEqual(
        expect.objectContaining({ path: gunslinger.path, source: 'asin-opf', asin: GUNSLINGER_ASIN, title: 'Dark Tower I' }),
      );
      expect(log.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('ASIN identification'));
    });

    it('logs the rejection of a non-ASIN value', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: ISBN_IN_ASIN_FIELD }));

      await runSingle();

      expect(debugRecord('ASIN identification candidate rejected — not a full-string Audible ASIN')).toEqual(
        expect.objectContaining({ path: gunslinger.path, source: 'asin-opf', asin: ISBN_IN_ASIN_FIELD }),
      );
      expect(debugMessages()).not.toContain('ASIN identification candidate found');
    });

    it('logs a miss', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(null);

      await runSingle();

      expect(debugRecord('ASIN identification rung missed — falling through')).toEqual(
        expect.objectContaining({ path: gunslinger.path, source: 'asin-opf', asin: GUNSLINGER_ASIN }),
      );
    });

    it('logs a provider error at debug, not above it — the fall-through is a normal outcome', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockRejectedValue(new Error('provider exploded'));

      await runSingle();

      expect(debugRecord('ASIN identification rung errored — falling through')).toEqual(
        expect.objectContaining({ path: gunslinger.path, source: 'asin-opf', asin: GUNSLINGER_ASIN, error: expect.anything() }),
      );
      expect(log.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('ASIN identification'));
    });

    it('logs the duplicate skip when both sources carry the same ASIN', async () => {
      vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ asin: GUNSLINGER_ASIN }));
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan({ tagAsin: GUNSLINGER_ASIN }));
      vi.mocked(metadataService.getBook).mockResolvedValue(null);

      await runSingle();

      expect(debugRecord('ASIN identification candidate skipped — duplicate of an earlier source')).toEqual(
        expect.objectContaining({ path: gunslinger.path, source: 'asin-tag', asin: GUNSLINGER_ASIN }),
      );
    });
  });
});
