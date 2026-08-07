import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';

vi.mock('./enrichment-utils.js', () => ({
  enrichBookFromAudio: vi.fn(),
}));

vi.mock('@core/utils/ffprobe-path.js', () => ({
  resolveFfprobePathFromSettings: vi.fn(),
}));
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/utils/audio-processor.js')>();
  return { ...actual, resolveFfmpegPath: () => Promise.resolve('/usr/bin/ffmpeg') };
});

import { enrichBookFromAudio } from './enrichment-utils.js';
import { resolveFfprobePathFromSettings } from '@core/utils/ffprobe-path.js';
import { orchestrateBookEnrichment, applyAudnexusEnrichment } from './enrichment-orchestration.helpers.js';
import { mockDbChain } from '../__tests__/helpers.js';
import { RateLimitError, TransientError } from '@core/index.js';

/** One mock handle — the root connection and the transaction handle are built from this. */
interface MockHandle {
  update: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
}

/** The `select` calls on `handle` that asked for the `book_narrators` projection. */
function narratorReads(handle: MockHandle): unknown[] {
  return handle.select.mock.calls.filter(
    ([projection]) => projection && typeof projection === 'object' && 'narratorId' in (projection as object),
  );
}

/**
 * A db whose `update().set().where()` chain resolves; returns the captured chain
 * for assertions.
 *
 * Also carries the two seams #2069 AC11 added to this path: a `select` (the
 * pre-fetch ASIN capture AND the in-transaction re-read of
 * `{ asin, user_cleared_fields }`) and a `transaction` that runs its callback.
 *
 * #2158 AC9 added a THIRD read — the in-transaction `book_narrators` re-read that
 * stops the Audnexus write from clobbering narrators the embedded-tag fill supplied
 * moments earlier. It is discriminated by PROJECTION rather than by call order
 * (`shared-test-double-defaults-ripple` §2): a call-index counter desynchronises the
 * moment a test issues a different number of reads. `narratorRows` defaults to EMPTY,
 * i.e. "the row has no narrators yet", which is what every pre-#2158 test in this
 * suite implicitly assumed.
 *
 * **The root and the transaction are DISTINCT objects (#2160 F1).** They used to be
 * the same object, which made handle routing unobservable: a read that regressed from
 * the callback's `tx` to `deps.db` landed on the very same `select` spy and every
 * assertion stayed green. `db.transaction` now hands the callback its own `tx`, so
 * WHICH handle a read or write used is a directly assertable fact — see
 * {@link narratorReads} and the AC9 handle test. The two `update` spies deliberately
 * share ONE `updateChain` so the existing scalar-write assertions read the same
 * object regardless of which handle issued the write; the handle question is answered
 * by the spies, not by the chain.
 */
function dbWithUpdateChain(
  row?: { asin?: string | null; userClearedFields?: string | null },
  narratorRows: { narratorId: number }[] = [],
) {
  const updateChain = mockDbChain();
  const selectRow = { asin: row?.asin ?? null, userClearedFields: row?.userClearedFields ?? null };
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

const mockEnrichBookFromAudio = vi.mocked(enrichBookFromAudio);
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
    it('calls enrichBookFromAudio with correct book ID, path, and existing metadata', async () => {
      await orchestrateBookEnrichment(
        42,
        '/audiobooks/MyBook',
        { narrators: [{ name: 'Jim Dale' }], duration: 3600, coverUrl: 'http://cover.jpg', existingGenres: ['Fantasy'] },
        deps,
        { primaryAsin: 'B001', alternateAsins: [], existingNarrator: 'Jim Dale', existingDuration: 3600, existingGenres: ['Fantasy'] },
      );

      expect(mockEnrichBookFromAudio).toHaveBeenCalledWith(
        42,
        '/audiobooks/MyBook',
        { narrators: [{ name: 'Jim Dale' }], duration: 3600, coverUrl: 'http://cover.jpg' },
        deps.db,
        deps.log,
        deps.bookService,
        '/usr/bin/ffprobe',
      );
    });

    it('resolves ffprobe path from the auto-detected ffmpeg before calling enrichBookFromAudio', async () => {
      mockResolveFfprobePath.mockReturnValue('/custom/ffprobe');

      await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null, existingGenres: null }, deps, { primaryAsin: null });

      expect(mockResolveFfprobePath).toHaveBeenCalledWith('/usr/bin/ffmpeg');
      expect(mockEnrichBookFromAudio).toHaveBeenCalledWith(
        42, '/path', expect.anything(), deps.db, deps.log, deps.bookService, '/custom/ffprobe',
      );
    });

    it('returns audioEnriched: true when enrichBookFromAudio reports enrichment', async () => {
      mockEnrichBookFromAudio.mockResolvedValue({ enriched: true });

      const result = await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null, existingGenres: null }, deps, { primaryAsin: null });

      expect(result).toEqual({ audioEnriched: true });
    });

    it('returns audioEnriched: false when enrichBookFromAudio reports no enrichment', async () => {
      mockEnrichBookFromAudio.mockResolvedValue({ enriched: false });

      const result = await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null, existingGenres: null }, deps, { primaryAsin: null });

      expect(result).toEqual({ audioEnriched: false });
    });
  });

  describe('audnexus enrichment', () => {
    it('calls metadataService.enrichBook with provided ASIN', async () => {
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValue({ duration: 7200 });

      await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null, existingGenres: null }, deps, {
        primaryAsin: 'B001',
        alternateAsins: [],
        existingNarrator: null,
        existingDuration: null,
        existingGenres: null,
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

      await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null, existingGenres: null }, deps, { primaryAsin: 'B001' });

      expect(callOrder).toEqual(['audio', 'audnexus']);
    });
  });

  describe('contract boundaries', () => {
    it('propagates audio enrichment errors to caller without catching', async () => {
      mockEnrichBookFromAudio.mockRejectedValue(new Error('Audio scan failed'));

      await expect(
        orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null, existingGenres: null }, deps, { primaryAsin: null }),
      ).rejects.toThrow('Audio scan failed');
    });

    it('does not emit events — eventHistory is not part of EnrichmentDeps', async () => {
      // orchestrateBookEnrichment has no access to eventHistory — callers own events.
      await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null, existingGenres: null }, deps, { primaryAsin: null });

      // The deps passed in (which the test built from createMockDeps) must not carry an eventHistory,
      // and orchestrateBookEnrichment must not have synthesized a call against one.
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

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingSubtitle: null, existingPublisher: null }, { ...deps, db });

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ subtitle: 'Filled Subtitle', publisher: 'Filled Publisher' }),
    );
  });

  it('does NOT overwrite an existing subtitle/publisher (#1614)', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ subtitle: 'Provider Subtitle', publisher: 'Provider Publisher' });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingSubtitle: 'Kept Subtitle', existingPublisher: 'Kept Publisher' }, { ...deps, db });

    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('subtitle');
    expect(setArg).not.toHaveProperty('publisher');
  });

  // ─── #1625: title/author search fallback ──────────────────────────────

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

    // The collision check sees the canonical (uppercase) form, and the persisted
    // ASIN is canonical — never the lowercase provider value.
    expect(mockFindCollision(deps)).toHaveBeenCalledWith(42, 'B0NEWEDITION');
    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ asin: 'B0NEWEDITION', enrichmentStatus: 'enriched' });
  });

  it('(#1733) resolved ASIN equal to primary only by case → treated as unchanged, not rewritten', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockResolvedValueOnce({ asin: 'b001', duration: 3600 });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', title: 'My Book', author: 'An Author' }, { ...deps, db });

    // A case-only "difference" from the primary is not a real ASIN change.
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

  // #1628 — a transient (non-rate-limit) error on the supplementary post-import
  // search fallback is a NON-FATAL miss: the import completes, nothing is written,
  // the book stays pending for the scheduled job to retry. (Contrast the
  // RateLimitError case above, which still propagates and fails the import.)
  it('#1628: TransientError on the search fallback is a non-fatal miss (no throw, no writes)', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockRejectedValueOnce(new TransientError('Audible.com', 'HTTP 503'));

    // Resolves without throwing — the manual import must not be failed by a
    // transient during supplementary enrichment.
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

  // ─── #2075: a DURABLE failure is not a provider miss ──────────────────
  //
  // The per-candidate catch exists to recover from `metadataService.enrichBook`.
  // It used to wrap `applyEnrichmentData` too, so a rolled-back write was logged as
  // 'Audnexus enrichment failed', the loop moved to the next ASIN, and the search
  // fallback then attempted a SECOND write with a different payload — against a row
  // whose commit state is ambiguous. Every assertion below is a negative, so each of
  // these rows was verified red against the pre-#2075 shape (`applyEnrichmentData`
  // back inside the `try`).
  it('#2075: a durable write failure propagates — no alternate candidate, no fallback, not warned as a provider miss', async () => {
    const { db } = dbWithUpdateChain();
    // Named so the assertion pins error IDENTITY: a future implementation that caught
    // this and rethrew a look-alike with the same message would fail here.
    const writeError = new Error('db write boom');
    (db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction.mockRejectedValueOnce(writeError);
    mockEnrichBook(deps).mockResolvedValueOnce({ duration: 7200 });

    await expect(
      applyAudnexusEnrichment(42, { primaryAsin: 'B001', alternateAsins: ['B002'], title: 'My Book' }, { ...deps, db }),
    ).rejects.toBe(writeError);

    expect(mockEnrichBook(deps)).toHaveBeenCalledTimes(1);
    expect(mockEnrichBook(deps)).not.toHaveBeenCalledWith('B002');
    expect(mockResolveBook(deps)).not.toHaveBeenCalled();
    // Matched on the MESSAGE argument specifically — a blanket "warn not called" would
    // be both weaker and wrong, since the ASIN-collision path legitimately warns.
    expect(deps.log.warn).not.toHaveBeenCalledWith(expect.anything(), 'Audnexus enrichment failed');
  });

  it('#2075: a collision-query failure propagates too — the boundary moved for all of applyEnrichmentData', async () => {
    const { db } = dbWithUpdateChain();
    const collisionError = new Error('collision query boom');
    // `resolveAsinWriteback` short-circuits when the resolved ASIN equals the primary,
    // so the collision query is only REACHED once an alternate resolves. B003 exists so
    // "no candidate followed the failure" is an observable fact rather than a vacuous one.
    mockEnrichBook(deps).mockResolvedValueOnce(null).mockResolvedValueOnce({ duration: 7200 });
    mockFindCollision(deps).mockRejectedValueOnce(collisionError);

    await expect(
      applyAudnexusEnrichment(42, { primaryAsin: 'B001', alternateAsins: ['B002', 'B003'], title: 'My Book' }, { ...deps, db }),
    ).rejects.toBe(collisionError);

    expect(mockEnrichBook(deps)).toHaveBeenCalledTimes(2);
    expect(mockEnrichBook(deps)).not.toHaveBeenCalledWith('B003');
    expect(mockResolveBook(deps)).not.toHaveBeenCalled();
    expect(deps.log.warn).not.toHaveBeenCalledWith(expect.anything(), 'Audnexus enrichment failed');
    // This failure lands BEFORE the transaction opens — the other half of "the whole of
    // applyEnrichmentData propagates", not just its `db.transaction` call.
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
    // The continuation, not just the log line — narrowing the catch must not narrow this.
    expect(mockEnrichBook(deps)).toHaveBeenCalledTimes(2);
    expect(mockEnrichBook(deps)).toHaveBeenCalledWith('B002');
    expect(mockResolveBook(deps)).toHaveBeenCalledWith({ title: 'My Book', author: 'An Author' });
  });

  it('conditional fill guards hold even when the search fallback returns values', async () => {
    const { db, updateChain } = dbWithUpdateChain();
    mockEnrichBook(deps).mockResolvedValue(null);
    mockResolveBook(deps).mockResolvedValueOnce({ duration: 3600, subtitle: 'New Sub', publisher: 'New Pub', narrators: ['New Narrator'], genres: ['New Genre'] });

    await applyAudnexusEnrichment(42, {
      primaryAsin: 'B001', title: 'My Book',
      existingDuration: 1000, existingSubtitle: 'Kept Sub', existingPublisher: 'Kept Pub', existingNarrator: 'Kept Narrator', existingGenres: ['Kept Genre'],
    }, { ...deps, db });

    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('duration');
    expect(setArg).not.toHaveProperty('subtitle');
    expect(setArg).not.toHaveProperty('publisher');
    expect(deps.bookService.update).not.toHaveBeenCalled();
  });
});

describe('buildBackgroundAudnexusConfig (#1625 — search-fallback title/author threading)', () => {
  // AC2: title/author must be threaded from the import payload into the config so the
  // production manual-import path can call resolveBook after the ASIN loop misses.
  it('threads title/author from the import payload onto the config', async () => {
    const { buildBackgroundAudnexusConfig, extractImportMetadata } = await import('./enrichment-orchestration.helpers.js');
    const item = { path: '/x', title: 'Mistborn', authorName: 'Brandon Sanderson', asin: 'B001' };
    const extracted = extractImportMetadata(item);

    const config = buildBackgroundAudnexusConfig(item, extracted, null);

    expect(config.title).toBe('Mistborn');
    expect(config.author).toBe('Brandon Sanderson');
  });

  it('leaves author null when the payload omits authorName (title still threaded)', async () => {
    const { buildBackgroundAudnexusConfig, extractImportMetadata } = await import('./enrichment-orchestration.helpers.js');
    const item = { path: '/x', title: 'Mistborn' };
    const extracted = extractImportMetadata(item);

    const config = buildBackgroundAudnexusConfig(item, extracted, null);

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

  // #1927 — item-first, two-state, pair-locked series resolution (was #1071 metadata-first).
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

  // #1097 — canonical primary-series preference over series[0]
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

  // #1710 — production_type populated from meta.formatType on this path only
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

// ─── #2069 AC10/AC11: the post-import fill surface honors tombstones ───
//
// This is the SECOND fill-empty writer. It writes no series field, so only
// `subtitle`, `publisher` and `genres` are guardable here — that asymmetry with the
// scheduled job (AC9) is deliberate. Its scalar write and its array writes now also
// share ONE transaction, and re-read the row identity inside it.
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

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingSubtitle: null, existingPublisher: null }, { ...deps, db });

    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('subtitle');
    expect(setArg.publisher).toBe('Provider Publisher');
    expect(setArg.enrichmentStatus).toBe('enriched');
  });

  it('a publisher tombstone is omitted while subtitle still fills', async () => {
    const { db, updateChain } = dbWithUpdateChain({ userClearedFields: '["publisher"]' });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingSubtitle: null, existingPublisher: null }, { ...deps, db });

    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('publisher');
    expect(setArg.subtitle).toBe('Provider Subtitle');
  });

  it('a genres tombstone skips the genres fill while the narrator fill in the same helper still runs', async () => {
    const { db } = dbWithUpdateChain({ userClearedFields: '["genres"]' });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null, existingGenres: null }, { ...deps, db });

    const calls = (deps.bookService.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((c) => Object.keys(c[1] as object)[0])).toEqual(['narrators']);
  });

  it('AC10 scope: a seriesName-only tombstone leaves this path byte-identical to today', async () => {
    const { db, updateChain } = dbWithUpdateChain({ userClearedFields: '["seriesName"]' });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingSubtitle: null, existingPublisher: null, existingGenres: null, existingNarrator: null }, { ...deps, db });

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

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null, existingGenres: null }, { ...deps, db });

    expect((db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction).toHaveBeenCalledTimes(1);
    for (const call of (deps.bookService.update as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[2]).toEqual({ tx: expect.anything() });
    }
  });

  // The F14 rollback proof deliberately does NOT live here. #2160 F1 split the root
  // and the transaction into distinct spies, so this suite can now tell WHICH handle
  // a statement used — but it still cannot prove ROLLBACK, because these doubles never
  // roll anything back: every write "succeeds" against an in-memory chain regardless of
  // whether the surrounding transaction later throws. Atomicity therefore stays with a
  // real migrated DB, with the split-transaction counterfactual executed alongside it:
  // see `src/db/user-cleared-fields-schema.integration.test.ts`,
  // 'AC11 / F14 — post-import atomicity, against a real DB'.

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

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null, existingGenres: null }, { ...deps, db });

      expect(deps.bookService.trackUnmatchedGenres).toHaveBeenCalledWith(['Fantasy']);
      // Running this before the commit would strand it on a rollback — the tx arm of
      // `update` emits no post-commit effects precisely so the owner can sequence it.
      expect(order).toEqual(['tx-committed', 'telemetry']);
    });

    it('records nothing when the genre fill was suppressed by a tombstone', async () => {
      const { db } = dbWithUpdateChain({ userClearedFields: '["genres"]' });
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null, existingGenres: null }, { ...deps, db });

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

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null, existingGenres: null }, { ...deps, db: db as Db });

      expect(deps.bookService.trackUnmatchedGenres).not.toHaveBeenCalled();
    });

    it('does NOT record for a narrators-only write (narrators carry no telemetry)', async () => {
      const { db } = dbWithUpdateChain();
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ narrators: ['Michael Kramer'] });

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null, existingGenres: null }, { ...deps, db });

      expect(deps.bookService.update).toHaveBeenCalledWith(42, { narrators: ['Michael Kramer'] }, { tx: expect.anything() });
      expect(deps.bookService.trackUnmatchedGenres).not.toHaveBeenCalled();
    });

    // ─── #2158 AC9: the narrator write re-reads the row inside its own transaction ───
    //
    // `existingNarrator` is a snapshot of the PRE-import item, taken before the provider fetch. When
    // the provider had no narrators, the embedded-tag fill can supply them between that snapshot and
    // this write — and the caller's pre-fetch cannot see it. The re-read is the fix; these two rows
    // are its positive and negative control.
    it('AC9: skips the narrator write when the row already carries narrators the snapshot missed', async () => {
      const { db } = dbWithUpdateChain(undefined, [{ narratorId: 7 }]);
      // A DIFFERENT narrator, otherwise the assertion cannot distinguish "skipped" from "wrote the
      // same value" — the vacuous-observation trap this suite has hit before.
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ narrators: ['Audnexus Narrator'] });

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null, existingGenres: null }, { ...deps, db });

      expect(deps.bookService.update).not.toHaveBeenCalledWith(42, { narrators: ['Audnexus Narrator'] }, expect.anything());
    });

    it('AC9: still fills narrators when the row genuinely has none', async () => {
      const { db } = dbWithUpdateChain(undefined, []);
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ narrators: ['Audnexus Narrator'] });

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null, existingGenres: null }, { ...deps, db });

      expect(deps.bookService.update).toHaveBeenCalledWith(42, { narrators: ['Audnexus Narrator'] }, { tx: expect.anything() });
    });

    it('AC9: the re-read runs on the TRANSACTION handle, never the root connection', async () => {
      const { db, root, tx } = dbWithUpdateChain(undefined, []);
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ narrators: ['Audnexus Narrator'] });

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null, existingGenres: null }, { ...deps, db });

      // The root and the transaction are distinct spies, so "which handle" is a fact rather than an
      // inference. Routing the re-read to `deps.db` would move the projection to `root` — verified
      // red by mutating `applyEnrichmentArrayFields(..., tx)` to `(..., deps.db)`. It matters twice
      // over: on libSQL a second connection cannot see the open transaction's uncommitted rows, and
      // `bookService.update` opening its own transaction throws NestedTransactionError.
      expect(narratorReads(tx)).toHaveLength(1);
      expect(narratorReads(root)).toHaveLength(0);

      // …and the write rides that SAME handle object — `toBe`, not a structural match, so a
      // different-but-similar handle cannot satisfy it.
      const updateCall = (deps.bookService.update as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect((updateCall[2] as { tx: unknown }).tx).toBe(tx);
    });

    it('a telemetry failure is non-fatal — the success log still fires', async () => {
      const { db } = dbWithUpdateChain();
      (deps.bookService.trackUnmatchedGenres as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('telemetry boom'));
      (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

      await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null, existingGenres: null }, { ...deps, db });

      expect(deps.log.info).toHaveBeenCalledWith(expect.anything(), 'Audnexus enrichment applied');
    });
  });

  it('F15: a Fix Match committed during the provider fetch aborts the write, tombstones held constant', async () => {
    // The pre-fetch capture reads 'B001'; the in-transaction re-read sees the
    // re-identified row. The tombstone column is NULL on both sides, so a
    // tombstone-only guard could not catch this.
    const updateChain = mockDbChain();
    const db = {
      update: vi.fn().mockReturnValue(updateChain),
      select: vi.fn()
        .mockReturnValueOnce(mockDbChain([{ asin: 'B001' }]))                                  // pre-fetch capture
        .mockReturnValue(mockDbChain([{ asin: 'B999_REIDENTIFIED', userClearedFields: null }])), // in-tx re-read
    } as unknown as Db & { transaction: unknown };
    db.transaction = vi.fn().mockImplementation((cb: (tx: Db) => Promise<unknown>) => cb(db as Db));
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null, existingGenres: null }, { ...deps, db: db as Db });

    expect(updateChain.set).not.toHaveBeenCalled();
    expect(deps.bookService.update).not.toHaveBeenCalled();
    expect(deps.log.info).not.toHaveBeenCalledWith(expect.anything(), 'Audnexus enrichment applied');
  });

  it('#2075 AC9: a stale drop still ENDS the call — no search fallback even with a title configured', async () => {
    // The F15 row above has no `title`, so it cannot answer the fallback question. A
    // stale drop resolves normally rather than throwing, so the `return` after the write
    // is what stops it — that return has to stay unconditional now that the call sits
    // outside the recovery `try`.
    const updateChain = mockDbChain();
    const db = {
      update: vi.fn().mockReturnValue(updateChain),
      select: vi.fn()
        .mockReturnValueOnce(mockDbChain([{ asin: 'B001' }]))                                  // pre-fetch capture
        .mockReturnValue(mockDbChain([{ asin: 'B999_REIDENTIFIED', userClearedFields: null }])), // in-tx re-read
    } as unknown as Db & { transaction: unknown };
    db.transaction = vi.fn().mockImplementation((cb: (tx: Db) => Promise<unknown>) => cb(db as Db));
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(
      42,
      { primaryAsin: 'B001', title: 'My Book', author: 'An Author', existingNarrator: null, existingGenres: null },
      { ...deps, db: db as Db },
    );

    expect(updateChain.set).not.toHaveBeenCalled();
    expect(deps.metadataService.resolveBook).not.toHaveBeenCalled();
    expect(deps.log.info).not.toHaveBeenCalledWith(expect.anything(), 'Audnexus enrichment applied');
  });

  it('negative control: with the identity unchanged the write lands and logs success', async () => {
    const { db, updateChain } = dbWithUpdateChain({ asin: 'B001' });
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerData);

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingNarrator: null, existingGenres: null }, { ...deps, db });

    expect(updateChain.set).toHaveBeenCalled();
    expect(deps.log.info).toHaveBeenCalledWith(expect.anything(), 'Audnexus enrichment applied');
  });
});
