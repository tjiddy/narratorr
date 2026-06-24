import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';

vi.mock('./enrichment-utils.js', () => ({
  enrichBookFromAudio: vi.fn(),
}));

vi.mock('../../core/utils/ffprobe-path.js', () => ({
  resolveFfprobePathFromSettings: vi.fn(),
}));

import { enrichBookFromAudio } from './enrichment-utils.js';
import { resolveFfprobePathFromSettings } from '../../core/utils/ffprobe-path.js';
import { orchestrateBookEnrichment, applyAudnexusEnrichment } from './enrichment-orchestration.helpers.js';
import { mockDbChain } from '../__tests__/helpers.js';
import { RateLimitError } from '../../core/index.js';

/** A db whose `update().set().where()` chain resolves; returns the captured chain for assertions. */
function dbWithUpdateChain() {
  const updateChain = mockDbChain();
  const db = { update: vi.fn().mockReturnValue(updateChain) } as unknown as Db;
  return { db, updateChain };
}

const mockEnrichBookFromAudio = vi.mocked(enrichBookFromAudio);
const mockResolveFfprobePath = vi.mocked(resolveFfprobePathFromSettings);

function createMockDeps() {
  return {
    db: {} as Db,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger,
    settingsService: { get: vi.fn().mockResolvedValue({ ffmpegPath: '/usr/bin/ffmpeg' }) } as unknown as SettingsService,
    bookService: { update: vi.fn(), findAsinCollision: vi.fn().mockResolvedValue(null) } as unknown as BookService,
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

    it('resolves ffprobe path from processing settings before calling enrichBookFromAudio', async () => {
      (deps.settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({ ffmpegPath: '/custom/ffmpeg' });
      mockResolveFfprobePath.mockReturnValue('/custom/ffprobe');

      await orchestrateBookEnrichment(42, '/path', { narrators: null, duration: null, coverUrl: null, existingGenres: null }, deps, { primaryAsin: null });

      expect(deps.settingsService.get).toHaveBeenCalledWith('processing');
      expect(mockResolveFfprobePath).toHaveBeenCalledWith('/custom/ffmpeg');
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
    const updateChain = mockDbChain();
    const db = { update: vi.fn().mockReturnValue(updateChain) } as unknown as Db;
    (deps.metadataService.enrichBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ subtitle: 'Filled Subtitle', publisher: 'Filled Publisher' });

    await applyAudnexusEnrichment(42, { primaryAsin: 'B001', existingSubtitle: null, existingPublisher: null }, { ...deps, db });

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ subtitle: 'Filled Subtitle', publisher: 'Filled Publisher' }),
    );
  });

  it('does NOT overwrite an existing subtitle/publisher (#1614)', async () => {
    const updateChain = mockDbChain();
    const db = { update: vi.fn().mockReturnValue(updateChain) } as unknown as Db;
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

  it('meta.series[0].position: 0 wins over item.seriesPosition (provider-truth, regression guard for falsy)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T', seriesPosition: 99 },
      { title: 'T', authors: [{ name: 'A' }], series: [{ name: 'S', position: 0 }] },
      'importing',
    );
    expect(payload.seriesPosition).toBe(0);
  });

  it('meta.series[0].position wins over item.seriesPosition (#1071 provider-truth precedence)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T', seriesPosition: 99 },
      { title: 'T', authors: [{ name: 'A' }], series: [{ name: 'Wax and Wayne', position: 1 }] },
      'importing',
    );
    expect(payload.seriesPosition).toBe(1);
    expect(payload.seriesName).toBe('Wax and Wayne');
  });

  it('item.seriesPosition: 1.5 falls through when meta has no series', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T', seriesPosition: 1.5 },
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

  it('extracts meta.series[0].asin onto seriesAsin (#1074)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T' },
      { title: 'T', authors: [{ name: 'A' }], series: [{ name: 'S', position: 1, asin: 'B09168SRZK' }] },
      'importing',
    );
    expect(payload.seriesAsin).toBe('B09168SRZK');
  });

  it('seriesAsin is undefined when meta is null (#1074)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T' },
      null,
      'importing',
    );
    expect(payload.seriesAsin).toBeUndefined();
  });

  it('seriesAsin is undefined when meta.series is empty (#1074)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T' },
      { title: 'T', authors: [{ name: 'A' }], series: [] },
      'importing',
    );
    expect(payload.seriesAsin).toBeUndefined();
  });

  it('seriesAsin is undefined when meta.series[0].asin is missing (#1074)', async () => {
    const { buildBookCreatePayload } = await import('./enrichment-orchestration.helpers.js');
    const payload = buildBookCreatePayload(
      { path: '/x', title: 'T' },
      { title: 'T', authors: [{ name: 'A' }], series: [{ name: 'S', position: 1 }] },
      'importing',
    );
    expect(payload.seriesAsin).toBeUndefined();
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
    expect(payload.seriesAsin).toBe('B009NF6YPM');
  });
});
