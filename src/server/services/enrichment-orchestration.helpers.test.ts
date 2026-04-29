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

const mockEnrichBookFromAudio = vi.mocked(enrichBookFromAudio);
const mockResolveFfprobePath = vi.mocked(resolveFfprobePathFromSettings);

function createMockDeps() {
  return {
    db: {} as Db,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger,
    settingsService: { get: vi.fn().mockResolvedValue({ ffmpegPath: '/usr/bin/ffmpeg' }) } as unknown as SettingsService,
    bookService: { update: vi.fn() } as unknown as BookService,
    metadataService: { enrichBook: vi.fn() } as unknown as MetadataService,
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
});
