import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';

// Extend, don't replace: the module also exports the live narrator re-read this suite exercises for
// real, and a factory that drops it fails at call time rather than at load.
vi.mock('./enrichment-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./enrichment-utils.js')>()),
  enrichBookFromAudioWithinAdmissionLock: vi.fn(),
}));

vi.mock('@core/utils/ffprobe-path.js', () => ({
  resolveFfprobePathFromSettings: vi.fn(),
}));
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/utils/audio-processor.js')>();
  return { ...actual, resolveFfmpegPath: () => Promise.resolve('/usr/bin/ffmpeg') };
});

import { enrichBookFromAudioWithinAdmissionLock } from './enrichment-utils.js';
import { resolveFfprobePathFromSettings } from '@core/utils/ffprobe-path.js';
import { orchestrateBookEnrichment, applyAudnexusEnrichment } from './enrichment-orchestration.helpers.js';
import { mockDbChain } from '../__tests__/helpers.js';
import { RateLimitError, TransientError } from '@core/index.js';

interface MockHandle {
  update: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
}

// Filter by projection rather than brittle select-call order.
function narratorReads(handle: MockHandle): unknown[] {
  return handle.select.mock.calls.filter(
    ([projection]) => projection && typeof projection === 'object' && 'narratorId' in (projection as object),
  );
}

/** Root and transaction handles are distinct so routing regressions are observable. Narrator
 * reads are selected by projection; both update spies share the assertion chain. The projected
 * row carries every column the fill guards read, so a suppression assertion observes the LIVE
 * value rather than passing because the column was absent from the double. */
function dbWithUpdateChain(
  row?: {
    asin?: string | null;
    userClearedFields?: string | null;
    duration?: number | null;
    subtitle?: string | null;
    publisher?: string | null;
    genres?: string[] | null;
  },
  narratorRows: { narratorId: number }[] = [],
) {
  const updateChain = mockDbChain();
  const selectRow = {
    asin: row?.asin ?? null,
    userClearedFields: row?.userClearedFields ?? null,
    duration: row?.duration ?? null,
    subtitle: row?.subtitle ?? null,
    publisher: row?.publisher ?? null,
    genres: row?.genres ?? null,
  };
  const makeHandle = (): MockHandle => ({
    update: vi.fn().mockReturnValue(updateChain),
    select: vi.fn().mockImplementation((projection?: Record<string, unknown>) =>
      projection && 'narratorId' in projection ? mockDbChain(narratorRows) : mockDbChain([selectRow]),
    ),
  });

  const tx = makeHandle();
  const db = makeHandle() as MockHandle & { transaction: ReturnType<typeof vi.fn> };
  db.transaction = vi.fn().mockImplementation((cb: (tx: Db) => Promise<unknown>) => cb(tx as unknown as Db));
  return { db: db as unknown as Db, root: db as MockHandle, tx, updateChain };
}

const mockEnrichBookFromAudio = vi.mocked(enrichBookFromAudioWithinAdmissionLock);
const mockResolveFfprobePath = vi.mocked(resolveFfprobePathFromSettings);

function createMockDeps() {
  return {
    db: dbWithUpdateChain().db,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger,
    settingsService: { get: vi.fn().mockResolvedValue({ }) } as unknown as SettingsService,
    bookService: { update: vi.fn(), findAsinCollision: vi.fn().mockResolvedValue(null), trackUnmatchedGenres: vi.fn().mockResolvedValue(undefined) } as unknown as BookService,
    metadataService: { enrichBook: vi.fn(), resolveBook: vi.fn() } as unknown as MetadataService,
  };
}

describe('orchestrateBookEnrichment', () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    mockResolveFfprobePath.mockReturnValue('/usr/bin/ffprobe');
    mockEnrichBookFromAudio.mockResolvedValue({ enriched: true });
  });

  describe('audio enrichment', () => {
    it('calls enrichBookFromAudioWithinAdmissionLock with correct book ID, path, and existing metadata', async () => {
      await orchestrateBookEnrichment(
        42,
        '/audiobooks/MyBook',
        { narrators: [{ name: 'Jim Dale' }], duration: 3600, coverUrl: 'http://cover.jpg' },
        deps,
        { primaryAsin: 'B001', alternateAsins: [], existingNarrator: 'Jim Dale' },
      );

      expect(mockEnrichBookFromAudio).toHaveBeenCalledWith(
        42,
        '/audiobooks/MyBook',
        { narrators: [{ name: 'Jim Dale' }], duration: 3600, coverUrl: 'http://cover.jpg' },
        deps.db,
        deps.log,
        deps.bookService,
        '/usr/bin/ffprobe',
        // #2435: the attach options are forwarded verbatim; a non-attach caller passes none.
        undefined,
      );
    });

    it('resolves ffprobe path from the auto-detected ffmpeg before calling enrichBookFromAudioWithinAdmissionLock', async () => {
      mockResolveFfprobePath.mockReturnValue('/custom/ffprobe');

      await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null }, deps, { primaryAsin: null });

      expect(mockResolveFfprobePath).toHaveBeenCalledWith('/usr/bin/ffmpeg');
      expect(mockEnrichBookFromAudio).toHaveBeenCalledWith(
        42, '/path', expect.anything(), deps.db, deps.log, deps.bookService, '/custom/ffprobe', undefined,
      );
    });

    it('forwards the attach option through to the audio enrichment (#2435)', async () => {
      await orchestrateBookEnrichment(
        42, '/path', { narrators: null, duration: null, coverUrl: null },
        deps, { primaryAsin: null }, { attach: true },
      );

      expect(mockEnrichBookFromAudio).toHaveBeenCalledWith(
        42, '/path', expect.anything(), deps.db, deps.log, deps.bookService, expect.anything(), { attach: true },
      );
    });

    it('returns audioEnriched: true when enrichBookFromAudioWithinAdmissionLock reports enrichment', async () => {
      mockEnrichBookFromAudio.mockResolvedValue({ enriched: true });

      const result = await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null }, deps, { primaryAsin: null });

      expect(result).toEqual({ audioEnriched: true });
    });

    it('returns audioEnriched: false when enrichBookFromAudioWithinAdmissionLock reports no enrichment', async () => {
      mockEnrichBookFromAudio.mockResolvedValue({ enriched: false });

      const result = await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null }, deps, { primaryAsin: null });

      expect(result).toEqual({ audioEnriched: false });
    });
  });

  describe('audnexus enrichment', () => {
    it('calls metadataService.enrichBook with provided ASIN', async () => {
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValue({ duration: 7200 });

      await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null }, deps, {
        primaryAsin: 'B001',
        alternateAsins: [],
        existingNarrator: null,
      });

      expect(deps.metadataService.enrichBook).toHaveBeenCalledWith('B001');
    });

    it('runs audnexus enrichment after audio enrichment (sequential order)', async () => {
      const callOrder: string[] = [];
      mockEnrichBookFromAudio.mockImplementation(async () => {
        callOrder.push('audio');
        return { enriched: true };
      });
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('audnexus');
        return { duration: 7200 };
      });

      await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null }, deps, { primaryAsin: 'B001' });

      expect(callOrder).toEqual(['audio', 'audnexus']);
    });
  });

  describe('contract boundaries', () => {
    it('propagates audio enrichment errors to caller without catching', async () => {
      mockEnrichBookFromAudio.mockRejectedValue(new Error('Audio scan failed'));

      await expect(
        orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null }, deps, { primaryAsin: null }),
      ).rejects.toThrow('Audio scan failed');
    });

    it('does not emit events — eventHistory is not part of EnrichmentDeps', async () => {
      await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null }, deps, { primaryAsin: null });

      expect('eventHistory' in deps).toBe(false);
      expect(Object.keys(deps).sort()).toEqual(['bookService', 'db', 'log', 'metadataService', 'settingsService']);
    });
  });
});

describe('applyAudnexusEnrichment', () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
  });

  it('skips enrichment when no ASINs are provided', async () => {
    await applyAudnexusEnrichment(42, { primaryAsin: null, alternateAsins: [] }, deps);

    expect(deps.metadataService.enrichBook).not.toHaveBeenCalled();
  });

  it('tries alternate ASINs when primary returns no data', async () => {
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ duration: 7200 });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', alternateAsins: ['B002'] }, deps);

    expect(deps.metadataService.enrichBook).toHaveBeenCalledTimes(2);
    expect(deps.metadataService.enrichBook).toHaveBeenCalledWith('B001');
    expect(deps.metadataService.enrichBook).toHaveBeenCalledWith('B002');
  });

  it('catches and logs individual ASIN failures without propagating', async () => {
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, deps);

    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 42, asin: 'B001' }),
      'Audnexus enrichment failed',
    );
  });

  it('fills blank subtitle/publisher from the enrichment data (#1614)', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ subtitle: 'Filled Subtitle', publisher: 'Filled Publisher' });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, { ...deps, db });

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ subtitle: 'Filled Subtitle', publisher: 'Filled Publisher' }),
    );
  });

  it('does NOT overwrite an existing subtitle/publisher (#1614)', async () => {
    const { db, updateChain } = dbWithUpdateChain({ subtitle: 'Kept Subtitle', publisher: 'Kept Publisher' });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ subtitle: 'Provider Subtitle', publisher: 'Provider Publisher' });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, { ...deps, db });

    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('subtitle');
    expect(setArg).not.toHaveProperty('publisher');
  });

  it('an empty-string live subtitle is falsy, so the provider value fills', async () => {
    const { db, updateChain } = dbWithUpdateChain({ subtitle: '' });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ subtitle: 'Provider Subtitle' });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, { ...deps, db });

    expect((updateChain.set.mock.calls[0]![0] as Record<string, unknown>).subtitle).toBe('Provider Subtitle');
  });

  // `books.duration` is MINUTES, so these literals are 0 and 1 minutes, not seconds.
  it('a live duration of 0 is falsy, so the provider duration fills', async () => {
    const { db, updateChain } = dbWithUpdateChain({ duration: 0 });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ duration: 600 });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, { ...deps, db });

    expect((updateChain.set.mock.calls[0]![0] as Record<string, unknown>).duration).toBe(600);
  });

  it('a live duration of 1 suppresses the provider duration', async () => {
    const { db, updateChain } = dbWithUpdateChain({ duration: 1 });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ duration: 600 });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, { ...deps, db });

    expect(updateChain.set.mock.calls[0]![0] as Record<string, unknown>).not.toHaveProperty('duration');
  });

  it('an empty live genres array still fills, a populated one suppresses the write and its telemetry', async () => {
    const empty = dbWithUpdateChain({ genres: [] });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ genres: ['Fantasy'] });
    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, { ...deps, db: empty.db });
    expect(deps.bookService.update).toHaveBeenCalledWith(42, { genres: ['Fantasy'] }, { tx: expect.anything() });
    expect(deps.bookService.trackUnmatchedGenres).toHaveBeenCalledWith(['Fantasy']);

    vi.clearAllMocks();

    const populated = dbWithUpdateChain({ genres: ['Kept'] });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ genres: ['Fantasy'] });
    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, { ...deps, db: populated.db });
    expect(deps.bookService.update).not.toHaveBeenCalled();
    expect(deps.bookService.trackUnmatchedGenres).not.toHaveBeenCalled();
  });

  it('all four live columns empty and no tombstones — every field fills and the genres are tracked', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      duration: 600, subtitle: 'Sub', publisher: 'Pub', genres: ['Fantasy'], narrators: ['Michael Kramer'],
    });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, { ...deps, db });

    expect(updateChain.set.mock.calls[0]![0]).toMatchObject({
      duration: 600, subtitle: 'Sub', publisher: 'Pub', enrichmentStatus: 'enriched',
    });
    expect(deps.bookService.update).toHaveBeenCalledWith(42, { genres: ['Fantasy'] }, { tx: expect.anything() });
    expect(deps.bookService.trackUnmatchedGenres).toHaveBeenCalledWith(['Fantasy']);
  });

  it('a field missing from the provider payload stays off the set while its siblings fill', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ duration: 600, publisher: 'Pub' });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, { ...deps, db });

    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('subtitle');
    expect(setArg).toMatchObject({ duration: 600, publisher: 'Pub' });
  });

  // The pre-fetch read cannot be the gate: an operator can populate the column while provider I/O runs.
  it('reads the value the TRANSACTION projects, not the one the root handle saw', async () => {
    const updateChain = mockDbChain();
    const tx = {
      update: vi.fn().mockReturnValue(updateChain),
      select: vi.fn().mockReturnValue(mockDbChain([{ asin: null, userClearedFields: null, duration: null, subtitle: 'Landed Mid-Flight', publisher: null, genres: null }])),
    };
    const root = {
      update: vi.fn().mockReturnValue(updateChain),
      select: vi.fn().mockReturnValue(mockDbChain([{ asin: null, userClearedFields: null, duration: null, subtitle: null, publisher: null, genres: null }])),
    } as unknown as Db & { transaction: unknown };
    root.transaction = vi.fn().mockImplementation((cb: (h: Db) => Promise<unknown>) => cb(tx as unknown as Db));
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ subtitle: 'Provider Subtitle' });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, { ...deps, db: root as Db });

    expect(updateChain.set.mock.calls[0]![0] as Record<string, unknown>).not.toHaveProperty('subtitle');
  });

  const mockEnrichBook = (d: typeof deps) => d.metadataService.enrichBook as ReturnType<typeof vi.fn>;
  const mockResolveBook = (d: typeof deps) => d.metadataService.resolveBook as ReturnType<typeof vi.fn>;
  const mockFindCollision = (d: typeof deps) => d.bookService.findAsinCollision as ReturnType<typeof vi.fn>;

  it('fast path: primary ASIN resolves — no search, no collision check, ASIN not rewritten', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValueOnce({ duration: 7200 });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', title: 'My Book', author: 'An Author' }, { ...deps, db });

    expect(mockResolveBook(deps)).not.toHaveBeenCalled();
    expect(mockFindCollision(deps)).not.toHaveBeenCalled();
    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ enrichmentStatus: 'enriched' });
    expect(setArg).not.toHaveProperty('asin');
  });

  it('alternate ASIN resolves — collision-checked, ASIN written back, search NOT called', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValueOnce(null).mockResolvedValueOnce({ duration: 7200 });
    mockFindCollision(deps).mockResolvedValueOnce(null);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', alternateAsins: ['B002'], title: 'My Book' }, { ...deps, db });

    expect(mockFindCollision(deps)).toHaveBeenCalledWith(42, 'B002');
    expect(mockResolveBook(deps)).not.toHaveBeenCalled();
    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ asin: 'B002', enrichmentStatus: 'enriched' });
  });

  it('(F2) alternate ASIN collides — ASIN write skipped, fields kept + enriched, warn logged, NOT failed', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValueOnce(null).mockResolvedValueOnce({ duration: 7200 });
    mockFindCollision(deps).mockResolvedValueOnce({ conflictBookId: 9, conflictTitle: 'Other' });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', alternateAsins: ['B002'], title: 'My Book' }, { ...deps, db });

    expect(mockFindCollision(deps)).toHaveBeenCalledWith(42, 'B002');
    expect(mockResolveBook(deps)).not.toHaveBeenCalled();
    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ duration: 7200, enrichmentStatus: 'enriched' });
    expect(setArg).not.toHaveProperty('asin');
    expect(setArg.enrichmentStatus).not.toBe('failed');
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 42, conflictBookId: 9 }),
      expect.stringContaining('collides'),
    );
  });

  it('all ASINs miss → search fallback hits with a new ASIN, written back', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockResolvedValueOnce({ asin: 'B999', duration: 3600 });
    mockFindCollision(deps).mockResolvedValueOnce(null);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', title: 'My Book', author: 'An Author' }, { ...deps, db });

    expect(mockResolveBook(deps)).toHaveBeenCalledWith({ title: 'My Book', author: 'An Author' });
    expect(mockFindCollision(deps)).toHaveBeenCalledWith(42, 'B999');
    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ asin: 'B999', duration: 3600, enrichmentStatus: 'enriched' });
  });

  it('(#1733) resolved ASIN is canonicalized (uppercased) before collision check + writeback', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockResolvedValueOnce({ asin: 'b0newedition', duration: 3600 });
    mockFindCollision(deps).mockResolvedValueOnce(null);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', title: 'My Book', author: 'An Author' }, { ...deps, db });

    expect(mockFindCollision(deps)).toHaveBeenCalledWith(42, 'B0NEWEDITION');
    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ asin: 'B0NEWEDITION', enrichmentStatus: 'enriched' });
  });

  it('(#1733) resolved ASIN equal to primary only by case → treated as unchanged, not rewritten', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockResolvedValueOnce({ asin: 'b001', duration: 3600 });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', title: 'My Book', author: 'An Author' }, { ...deps, db });

    expect(mockFindCollision(deps)).not.toHaveBeenCalled();
    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('asin');
  });

  it('(F1) search fallback hits with NO asin — fields written, no asin write, no collision check', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockResolvedValueOnce({ duration: 3600, subtitle: 'Sub' });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', title: 'My Book' }, { ...deps, db });

    expect(mockFindCollision(deps)).not.toHaveBeenCalled();
    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ duration: 3600, subtitle: 'Sub', enrichmentStatus: 'enriched' });
    expect(setArg).not.toHaveProperty('asin');
  });

  it('(F2) resolved ASIN collides — fields kept + enriched, ASIN write skipped, warn logged, NOT failed', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockResolvedValueOnce({ asin: 'B999', duration: 3600 });
    mockFindCollision(deps).mockResolvedValueOnce({ conflictBookId: 7, conflictTitle: 'Other' });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', title: 'My Book' }, { ...deps, db });

    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ duration: 3600, enrichmentStatus: 'enriched' });
    expect(setArg).not.toHaveProperty('asin');
    expect(setArg.enrichmentStatus).not.toBe('failed');
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 42, conflictBookId: 7 }),
      expect.stringContaining('collides'),
    );
  });

  it('all ASINs miss AND search misses — no writes, status not enriched', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockResolvedValueOnce(null);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', title: 'My Book' }, { ...deps, db });

    expect(updateChain.set).not.toHaveBeenCalled();
    // #2202: a held ambiguous window is a plain null here, so no ASIN writeback and no apply pass.
    expect(deps.bookService.update).not.toHaveBeenCalled();
    expect(mockFindCollision(deps)).not.toHaveBeenCalled();
  });

  it('no ASINs and no title — early return, neither enrichBook nor resolveBook called', async () => {
    await applyAudnexusEnrichment(42, { primaryAsin: null, alternateAsins: [] }, deps);

    expect(mockEnrichBook(deps)).not.toHaveBeenCalled();
    expect(mockResolveBook(deps)).not.toHaveBeenCalled();
  });

  it('no ASINs but title present — ASIN loop skipped, search fallback runs directly', async () => {
    const { db } = dbWithUpdateChain();
    mockResolveBook(deps).mockResolvedValueOnce({ asin: 'B999', duration: 3600 });
    mockFindCollision(deps).mockResolvedValueOnce(null);

    await applyAudnexusEnrichment(42, { primaryAsin: null, title: 'My Book', author: 'An Author' }, { ...deps, db });

    expect(mockEnrichBook(deps)).not.toHaveBeenCalled();
    expect(mockResolveBook(deps)).toHaveBeenCalledWith({ title: 'My Book', author: 'An Author' });
  });

  it('RateLimitError on the ASIN path propagates (book left retryable, not enriched)', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockRejectedValueOnce(new RateLimitError(5000, 'Audnexus'));

    await expect(
      applyAudnexusEnrichment(42, { primaryAsin: 'B001', title: 'My Book' }, { ...deps, db }),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(mockResolveBook(deps)).not.toHaveBeenCalled();
    expect(updateChain.set).not.toHaveBeenCalled();
  });

  it('RateLimitError on the search fallback propagates (not swallowed)', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockRejectedValueOnce(new RateLimitError(5000, 'Audnexus'));

    await expect(
      applyAudnexusEnrichment(42, { primaryAsin: 'B001', title: 'My Book' }, { ...deps, db }),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(updateChain.set).not.toHaveBeenCalled();
  });

  it('#1628: TransientError on the search fallback is a non-fatal miss (no throw, no writes)', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockRejectedValueOnce(new TransientError('Audible.com', 'HTTP 503'));

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', title: 'My Book' }, { ...deps, db });

    expect(updateChain.set).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 42, title: 'My Book' }),
      expect.stringContaining('transient'),
    );
  });

  it('#1628: a generic Error on the search fallback is also a non-fatal miss (no throw, no writes)', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockRejectedValueOnce(new Error('Network error'));

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', title: 'My Book' }, { ...deps, db });

    expect(updateChain.set).not.toHaveBeenCalled();
  });

  // A durable failure is not a provider miss: only `metadataService.enrichBook` may recover per candidate.
  it('#2075: a durable write failure propagates — no alternate candidate, no fallback, not warned as a provider miss', async () => {
    const { db } = dbWithUpdateChain();
    const writeError = new Error('db write boom');
    (db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction.mockRejectedValueOnce(writeError);
    mockEnrichBook(deps).mockResolvedValueOnce({ duration: 7200 });

    await expect(
      applyAudnexusEnrichment(42, { primaryAsin: 'B001', alternateAsins: ['B002'], title: 'My Book' }, { ...deps, db }),
    ).rejects.toBe(writeError);

    expect(mockEnrichBook(deps)).toHaveBeenCalledTimes(1);
    expect(mockEnrichBook(deps)).not.toHaveBeenCalledWith('B002');
    expect(mockResolveBook(deps)).not.toHaveBeenCalled();
    expect(deps.log.warn).not.toHaveBeenCalledWith(expect.anything(), 'Audnexus enrichment failed');
  });

  it('#2075: a collision-query failure propagates too — the boundary moved for all of applyEnrichmentData', async () => {
    const { db } = dbWithUpdateChain();
    const collisionError = new Error('collision query boom');
    // B003 makes "no later candidate" observable after B002's collision-query failure.
    mockEnrichBook(deps).mockResolvedValueOnce(null).mockResolvedValueOnce({ duration: 7200 });
    mockFindCollision(deps).mockRejectedValueOnce(collisionError);

    await expect(
      applyAudnexusEnrichment(42, { primaryAsin: 'B001', alternateAsins: ['B002', 'B003'], title: 'My Book' }, { ...deps, db }),
    ).rejects.toBe(collisionError);

    expect(mockEnrichBook(deps)).toHaveBeenCalledTimes(2);
    expect(mockEnrichBook(deps)).not.toHaveBeenCalledWith('B003');
    expect(mockResolveBook(deps)).not.toHaveBeenCalled();
    expect(deps.log.warn).not.toHaveBeenCalledWith(expect.anything(), 'Audnexus enrichment failed');
    expect((db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction).not.toHaveBeenCalled();
  });

  it('#2075 control: a provider ERROR still warns AND still continues to the next candidate and the fallback', async () => {
    const { db } = dbWithUpdateChain();
    mockEnrichBook(deps).mockRejectedValueOnce(new Error('API error')).mockResolvedValueOnce(null);
    mockResolveBook(deps).mockResolvedValueOnce(null);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', alternateAsins: ['B002'], title: 'My Book', author: 'An Author' }, { ...deps, db });

    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 42, asin: 'B001' }),
      'Audnexus enrichment failed',
    );
    expect(mockEnrichBook(deps)).toHaveBeenCalledTimes(2);
    expect(mockEnrichBook(deps)).toHaveBeenCalledWith('B002');
    expect(mockResolveBook(deps)).toHaveBeenCalledWith({ title: 'My Book', author: 'An Author' });
  });

  it('conditional fill guards hold even when the search fallback returns values', async () => {
    const { db, updateChain } = dbWithUpdateChain({
      duration: 1000, subtitle: 'Kept Sub', publisher: 'Kept Pub', genres: ['Kept Genre'],
    });
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockResolvedValueOnce({ duration: 3600, subtitle: 'New Sub', publisher: 'New Pub', narrators: ['New Narrator'], genres: ['New Genre'] });

    await applyAudnexusEnrichment(42, {
      primaryAsin: 'B001', title: 'My Book', existingNarrator: 'Kept Narrator',
    }, { ...deps, db });

    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('duration');
    expect(setArg).not.toHaveProperty('subtitle');
    expect(setArg).not.toHaveProperty('publisher');
    expect(deps.bookService.update).not.toHaveBeenCalled();
  });

  // #2440: the staged item's provider duration is not `books.duration`, so a config built from it
  // used to refuse the Audnexus duration for a row whose own column was empty.
  it('#2440: a staged provider duration no longer suppresses the fill on an empty duration column', async () => {
    const { buildBackgroundAudnexusConfig, extractImportMetadata } = await import('./enrichment-orchestration.helpers.js');
    const { db, updateChain } = dbWithUpdateChain({ duration: null });
    const item = { path: '/x', title: 'Tress of the Emerald Sea', asin: 'B001' };
    const config = buildBackgroundAudnexusConfig(item, extractImportMetadata({ ...item, metadata: { title: item.title, authors: [], duration: 1000 } }));
    mockEnrichBook(deps).mockResolvedValueOnce({ duration: 600 });

    await applyAudnexusEnrichment(42, config, { ...deps, db });

    expect((updateChain.set.mock.calls[0]![0] as Record<string, unknown>).duration).toBe(600);
  });
});

describe('buildBackgroundAudnexusConfig (#1625 — search-fallback title/author threading)', () => {
  it('threads title/author from the import payload onto the config', async () => {
    const { buildBackgroundAudnexusConfig, extractImportMetadata } = await import('./enrichment-orchestration.helpers.js');
    const item = { path: '/x', title: 'Mistborn', authorName: 'Brandon Sanderson', asin: 'B001' };
    const extracted = extractImportMetadata(item);

    const config = buildBackgroundAudnexusConfig(item, extracted);

    expect(config.title).toBe('Mistborn');
    expect(config.author).toBe('Brandon Sanderson');
  });

  it('#2440: emits none of the four snapshot fields, and still carries the five it gates on', async () => {
    const { buildBackgroundAudnexusConfig, extractImportMetadata } = await import('./enrichment-orchestration.helpers.js');
    const item = { path: '/x', title: 'Mistborn', authorName: 'Brandon Sanderson', asin: 'B001' };
    const extracted = extractImportMetadata({
      ...item,
      narrators: ['Michael Kramer'],
      metadata: { title: 'Mistborn', authors: [], alternateAsins: ['B002'], duration: 1000 },
    });

    const config = buildBackgroundAudnexusConfig(item, extracted) as Record<string, unknown>;

    expect(config).not.toHaveProperty('existingDuration');
    expect(config).not.toHaveProperty('existingGenres');
    expect(config).not.toHaveProperty('existingSubtitle');
    expect(config).not.toHaveProperty('existingPublisher');
    expect(config).toMatchObject({
      primaryAsin: 'B001', alternateAsins: ['B002'], title: 'Mistborn',
      author: 'Brandon Sanderson', existingNarrator: 'Michael Kramer',
    });
  });

  it('leaves author null when the payload omits authorName (title still threaded)', async () => {
    const { buildBackgroundAudnexusConfig, extractImportMetadata } = await import('./enrichment-orchestration.helpers.js');
    const item = { path: '/x', title: 'Mistborn' };
    const extracted = extractImportMetadata(item);

    const config = buildBackgroundAudnexusConfig(item, extracted);

    expect(config.title).toBe('Mistborn');
    expect(config.author).toBeNull();
  });
});

describe('extractImportMetadata (#1028)', () => {
  it('item.narrators wins over meta.narrators for both narratorName and bookInput.narrators', async () => {
    const { extractImportMetadata } = await import('./enrichment-orchestration.helpers.js');
    const result = extractImportMetadata({
      path: '/audiobooks/Book',
      title: 'Book',
      narrators: ['Jim Dale', 'Stephen Fry'],
      metadata: { title: 'Book', authors: [{ name: 'Author' }], narrators: ['Other Narrator'] },
    });
    expect(result.narratorName).toBe('Jim Dale');
    expect(result.bookInput.narrators).toEqual([{ name: 'Jim Dale' }, { name: 'Stephen Fry' }]);
  });

  it('falls back to meta.narrators when item.narrators is absent', async () => {
    const { extractImportMetadata } = await import('./enrichment-orchestration.helpers.js');
    const result = extractImportMetadata({
      path: '/audiobooks/Book',
      title: 'Book',
      metadata: { title: 'Book', authors: [{ name: 'Author' }], narrators: ['Stephen Fry'] },
    });
    expect(result.narratorName).toBe('Stephen Fry');
    expect(result.bookInput.narrators).toEqual([{ name: 'Stephen Fry' }]);
  });

  it('returns manual narrator when no metadata is present', async () => {
    const { extractImportMetadata } = await import('./enrichment-orchestration.helpers.js');
    const result = extractImportMetadata({
      path: '/audiobooks/Book',
      title: 'Book',
      narrators: ['Jim Dale'],
    });
    expect(result.narratorName).toBe('Jim Dale');
    expect(result.bookInput.narrators).toEqual([{ name: 'Jim Dale' }]);
  });

  it('returns null narratorName and null narrators when neither is present', async () => {
    const { extractImportMetadata } = await import('./enrichment-orchestration.helpers.js');
    const result = extractImportMetadata({
      path: '/audiobooks/Book',
      title: 'Book',
    });
    expect(result.narratorName).toBeNull();
    expect(result.bookInput.narrators).toBeNull();
  });
});

describe('buildBookCreatePayload (#1028)', () => {
  it('item.narrators overrides meta.narrators', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T', narrators: ['Jim Dale'] },
      { title: 'T', authors: [{ name: 'A' }], narrators: ['Stephen Fry'] },
      'importing',
    );
    expect(payload.narrators).toEqual(['Jim Dale']);
  });

  it('falls back to meta.narrators when item.narrators is empty array', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T', narrators: [] },
      { title: 'T', authors: [{ name: 'A' }], narrators: ['Stephen Fry'] },
      'importing',
    );
    expect(payload.narrators).toEqual(['Stephen Fry']);
  });

  it('falls back to meta.narrators when item.narrators is undefined', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T' },
      { title: 'T', authors: [{ name: 'A' }], narrators: ['Stephen Fry'] },
      'importing',
    );
    expect(payload.narrators).toEqual(['Stephen Fry']);
  });

  it('snapshots subtitle and publisher from the provider meta (#1614)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T' },
      { title: 'T', authors: [{ name: 'A' }], subtitle: 'A Subtitle', publisher: 'Macmillan Audio' },
      'importing',
    );
    expect(payload.subtitle).toBe('A Subtitle');
    expect(payload.publisher).toBe('Macmillan Audio');
  });

  it('leaves subtitle/publisher undefined when meta is null', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload({ path: '/x', title: 'T' }, null, 'importing');
    expect(payload.subtitle).toBeUndefined();
    expect(payload.publisher).toBeUndefined();
  });

  it('item supplies series + position → payload uses the ITEM values, not metadata (#1927 AC1)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T', seriesName: 'The Dresden Files', seriesPosition: 10 },
      { title: 'T', authors: [{ name: 'A' }], series: [{ name: 'Wax and Wayne', position: 1 }] },
      'importing',
    );
    expect(payload.seriesName).toBe('The Dresden Files');
    expect(payload.seriesPosition).toBe(10);
  });

  it('item supplies series but NO position → item series with NO position, metadata position NOT grafted (#1927 AC3 pair-lock)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T', seriesName: 'Custom Saga' },
      { title: 'T', authors: [{ name: 'A' }], series: [{ name: 'Provider Saga', position: 15 }] },
      'importing',
    );
    expect(payload.seriesName).toBe('Custom Saga');
    expect(payload.seriesPosition).toBeUndefined();
  });

  it('item supplies series + position 0 → item position 0 survives (#1927 AC3 falsy guard)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T', seriesName: 'Prequels', seriesPosition: 0 },
      { title: 'T', authors: [{ name: 'A' }], series: [{ name: 'Provider Saga', position: 15 }] },
      'importing',
    );
    expect(payload.seriesName).toBe('Prequels');
    expect(payload.seriesPosition).toBe(0);
  });

  it('item OMITS series → defers to metadata primary, position 0 preserved (#1927 AC3/AC4 defer path)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T' },
      { title: 'T', authors: [{ name: 'A' }], series: [{ name: 'S', position: 0 }] },
      'importing',
    );
    expect(payload.seriesName).toBe('S');
    expect(payload.seriesPosition).toBe(0);
  });

  it('item seriesName "   " (whitespace) → treated as absent, defers to metadata (#1927 AC5)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T', seriesName: '   ', seriesPosition: 99 },
      { title: 'T', authors: [{ name: 'A' }], series: [{ name: 'Wax and Wayne', position: 1 }] },
      'importing',
    );
    expect(payload.seriesName).toBe('Wax and Wayne');
    expect(payload.seriesPosition).toBe(1);
  });

  it('item padded non-empty series " Saga " → item wins, name preserved VERBATIM (trim classifies only, #1927 AC5/F12)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T', seriesName: ' Saga ', seriesPosition: 3 },
      { title: 'T', authors: [{ name: 'A' }], series: [{ name: 'Provider Saga', position: 15 }] },
      'importing',
    );
    expect(payload.seriesName).toBe(' Saga ');
    expect(payload.seriesPosition).toBe(3);
  });

  it('item.seriesPosition: 1.5 with a series falls through when meta has no series (#1927 item-first)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T', seriesName: 'Some Series', seriesPosition: 1.5 },
      { title: 'T', authors: [{ name: 'A' }] },
      'importing',
    );
    expect(payload.seriesPosition).toBe(1.5);
  });

  it('leaves both undefined when item-empty and meta-empty', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T' },
      null,
      'importing',
    );
    expect(payload.narrators).toBeUndefined();
    expect(payload.seriesPosition).toBeUndefined();
  });

  it('prefers seriesPrimary over series[0] when both are present (#1097)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T' },
      {
        title: 'T',
        authors: [{ name: 'A' }],
        seriesPrimary: { name: 'The Stormlight Archive', position: 2, asin: 'B009NF6YPM' },
        series: [
          { name: 'The Cosmere', position: 5, asin: 'B07CWP1KCD' },
          { name: 'The Stormlight Archive', position: 2, asin: 'B009NF6YPM' },
        ],
      },
      'importing',
    );
    expect(payload.seriesName).toBe('The Stormlight Archive');
    expect(payload.seriesPosition).toBe(2);
  });

  it('populates productionType from meta.formatType (#1710)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T' },
      { title: 'T', authors: [{ name: 'A' }], formatType: 'Unabridged' },
      'importing',
    );
    expect(payload.productionType).toBe('unabridged');
  });

  it('defaults productionType to unknown when meta.formatType is absent (#1710)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T' },
      { title: 'T', authors: [{ name: 'A' }] },
      'importing',
    );
    expect(payload.productionType).toBe('unknown');
  });

  it('defaults productionType to unknown when meta is null (#1710)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload({ path: '/x', title: 'T' }, null, 'importing');
    expect(payload.productionType).toBe('unknown');
  });
});

// This fill-empty path guards subtitle, publisher, and genres; scalar and array writes share one transaction.
describe('applyAudnexusEnrichment — user-cleared fields (#2069)', () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
  });

  const providerData = { subtitle: 'Provider Subtitle', publisher: 'Provider Publisher', genres: ['Fantasy'], narrators: ['Michael Kramer'] };

  it('mixed state: a subtitle tombstone is omitted from the scalar set while publisher still fills', async () => {
    const { db, updateChain } = dbWithUpdateChain({ userClearedFields: '["subtitle"]' });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, { ...deps, db });

    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('subtitle');
    expect(setArg.publisher).toBe('Provider Publisher');
    expect(setArg.enrichmentStatus).toBe('enriched');
  });

  it('a publisher tombstone is omitted while subtitle still fills', async () => {
    const { db, updateChain } = dbWithUpdateChain({ userClearedFields: '["publisher"]' });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001' }, { ...deps, db });

    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('publisher');
    expect(setArg.subtitle).toBe('Provider Subtitle');
  });

  it('a genres tombstone skips the genres fill while the narrator fill in the same helper still runs', async () => {
    const { db } = dbWithUpdateChain({ userClearedFields: '["genres"]' });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db });

    const calls = (deps.bookService.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((c) => Object.keys(c[1] as object)[0])).toEqual(['narrators']);
  });

  it('AC10 scope: a seriesName-only tombstone leaves this path byte-identical to today', async () => {
    const { db, updateChain } = dbWithUpdateChain({ userClearedFields: '["seriesName"]' });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db });

    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.subtitle).toBe('Provider Subtitle');
    expect(setArg.publisher).toBe('Provider Publisher');
    expect(setArg).not.toHaveProperty('seriesName');
    const calls = (deps.bookService.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((c) => Object.keys(c[1] as object)[0])).toEqual(['narrators', 'genres']);
  });

  it('both writes share one transaction, and the array writes run on its handle', async () => {
    const { db } = dbWithUpdateChain();
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db });

    expect((db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction).toHaveBeenCalledTimes(1);
    for (const call of (deps.bookService.update as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[2]).toEqual({ tx: expect.anything() });
    }
  });

  // These doubles prove handle routing, not rollback; the migrated-DB integration suite proves atomicity.

  describe('F21 / F5 — the genre telemetry is a DEFERRED post-commit effect', () => {
    it('runs the telemetry with the written payload, AFTER the write transaction resolves', async () => {
      const order: string[] = [];
      const { db } = dbWithUpdateChain();
      const txMock = (db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction;
      txMock.mockImplementation(async (cb: (tx: Db) => Promise<unknown>) => {
        const result = await cb(db);
        order.push('tx-committed');
        return result;
      });
      (deps.bookService.trackUnmatchedGenres as ReturnType<typeof vi.fn>)
        .mockImplementation(async () => { order.push('telemetry'); });
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db });

      expect(deps.bookService.trackUnmatchedGenres).toHaveBeenCalledWith(['Fantasy']);
      expect(order).toEqual(['tx-committed', 'telemetry']);
    });

    it('records nothing when the genre fill was suppressed by a tombstone', async () => {
      const { db } = dbWithUpdateChain({ userClearedFields: '["genres"]' });
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db });

      expect(deps.bookService.trackUnmatchedGenres).not.toHaveBeenCalled();
    });

    it('records nothing when the write is stale-dropped on the identity re-read', async () => {
      const updateChain = mockDbChain();
      const db = {
        update: vi.fn().mockReturnValue(updateChain),
        select: vi.fn()
          .mockReturnValueOnce(mockDbChain([{ asin: 'B001' }]))
          .mockReturnValue(mockDbChain([{ asin: 'B999_REIDENTIFIED', userClearedFields: null }])),
      } as unknown as Db & { transaction: unknown };
      db.transaction = vi.fn().mockImplementation((cb: (tx: Db) => Promise<unknown>) => cb(db as Db));
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db: db as Db });

      expect(deps.bookService.trackUnmatchedGenres).not.toHaveBeenCalled();
    });

    it('does NOT record for a narrators-only write (narrators carry no telemetry)', async () => {
      const { db } = dbWithUpdateChain();
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ narrators: ['Michael Kramer'] });

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db });

      expect(deps.bookService.update).toHaveBeenCalledWith(42, { narrators: ['Michael Kramer'] }, { tx: expect.anything() });
      expect(deps.bookService.trackUnmatchedGenres).not.toHaveBeenCalled();
    });

    // Re-read narrators in the transaction; embedded-tag fill may have changed the pre-fetch snapshot.
    it('AC9: skips the narrator write when the row already carries narrators the snapshot missed', async () => {
      const { db } = dbWithUpdateChain(undefined, [{ narratorId: 7 }]);
      // Use a different narrator so "skipped" cannot pass vacuously.
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ narrators: ['Audnexus Narrator'] });

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db });

      expect(deps.bookService.update).not.toHaveBeenCalledWith(42, { narrators: ['Audnexus Narrator'] }, expect.anything());
    });

    it('AC9: still fills narrators when the row genuinely has none', async () => {
      const { db } = dbWithUpdateChain(undefined, []);
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ narrators: ['Audnexus Narrator'] });

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db });

      expect(deps.bookService.update).toHaveBeenCalledWith(42, { narrators: ['Audnexus Narrator'] }, { tx: expect.anything() });
    });

    it('AC9: the re-read runs on the TRANSACTION handle, never the root connection', async () => {
      const { db, root, tx } = dbWithUpdateChain(undefined, []);
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ narrators: ['Audnexus Narrator'] });

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db });

      // Root reads miss uncommitted libSQL state; distinct spies make this routing observable.
      expect(narratorReads(tx)).toHaveLength(1);
      expect(narratorReads(root)).toHaveLength(0);

      const updateCall = (deps.bookService.update as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect((updateCall[2] as { tx: unknown }).tx).toBe(tx);
    });

    it('a telemetry failure is non-fatal — the success log still fires', async () => {
      const { db } = dbWithUpdateChain();
      (deps.bookService.trackUnmatchedGenres as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('telemetry boom'));
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db });

      expect(deps.log.info).toHaveBeenCalledWith(expect.anything(), 'Audnexus enrichment applied');
    });
  });

  it('F15: a Fix Match committed during the provider fetch aborts the write, tombstones held constant', async () => {
    // Keep tombstones equal while ASIN changes between pre-fetch and transaction reads.
    const updateChain = mockDbChain();
    const db = {
      update: vi.fn().mockReturnValue(updateChain),
      select: vi.fn()
        .mockReturnValueOnce(mockDbChain([{ asin: 'B001' }]))
        .mockReturnValue(mockDbChain([{ asin: 'B999_REIDENTIFIED', userClearedFields: null }])),
    } as unknown as Db & { transaction: unknown };
    db.transaction = vi.fn().mockImplementation((cb: (tx: Db) => Promise<unknown>) => cb(db as Db));
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db: db as Db });

    expect(updateChain.set).not.toHaveBeenCalled();
    expect(deps.bookService.update).not.toHaveBeenCalled();
    expect(deps.log.info).not.toHaveBeenCalledWith(expect.anything(), 'Audnexus enrichment applied');
  });

  it('#2075 AC9: a stale drop still ENDS the call — no search fallback even with a title configured', async () => {
    // Include a title so any fallback after the stale drop is observable.
    const updateChain = mockDbChain();
    const db = {
      update: vi.fn().mockReturnValue(updateChain),
      select: vi.fn()
        .mockReturnValueOnce(mockDbChain([{ asin: 'B001' }]))
        .mockReturnValue(mockDbChain([{ asin: 'B999_REIDENTIFIED', userClearedFields: null }])),
    } as unknown as Db & { transaction: unknown };
    db.transaction = vi.fn().mockImplementation((cb: (tx: Db) => Promise<unknown>) => cb(db as Db));
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(
      42,
      { primaryAsin: 'B001', title: 'My Book', author: 'An Author', existingNarrator: null },
      { ...deps, db: db as Db },
    );

    expect(updateChain.set).not.toHaveBeenCalled();
    expect(deps.metadataService.resolveBook).not.toHaveBeenCalled();
    expect(deps.log.info).not.toHaveBeenCalledWith(expect.anything(), 'Audnexus enrichment applied');
  });

  it('negative control: with the identity unchanged the write lands and logs success', async () => {
    const { db, updateChain } = dbWithUpdateChain({ asin: 'B001' });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null }, { ...deps, db });

    expect(updateChain.set).toHaveBeenCalled();
    expect(deps.log.info).toHaveBeenCalledWith(expect.anything(), 'Audnexus enrichment applied');
  });
});
