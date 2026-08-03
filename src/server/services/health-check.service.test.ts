import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { HealthCheckService } from './health-check.service.js';
import { getUpdateStatus, checkForUpdate } from '../jobs/version-check.js';
import { HardcoverClient } from '@core/metadata/hardcover.js';
import { RateLimitError, TransientError, MetadataError } from '@core/metadata/errors.js';
import { inject, createMockLogger, createMockSettingsService } from '../__tests__/helpers.js';
import { DEFAULT_SETTINGS } from '@shared/schemas/settings/registry.js';
import type { FastifyBaseLogger } from 'fastify';
import type { IndexerService } from './indexer.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { NotifierService } from './notifier.service.js';
import type { Db } from '@db/index.js';

vi.mock('../jobs/version-check.js', () => ({
  getUpdateStatus: vi.fn(),
  checkForUpdate: vi.fn(),
}));

// ffmpeg is auto-detected now; checkFfmpeg calls resolveFfmpegPath(). Plain-arrow mock over a
// hoisted toggle (survives vi.clearAllMocks); default detected, flip false for the not-found path.
const { ffmpegState } = vi.hoisted(() => ({ ffmpegState: { resolves: true } }));
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/utils/audio-processor.js')>();
  return { ...actual, resolveFfmpegPath: () => Promise.resolve(ffmpegState.resolves ? '/usr/bin/ffmpeg' : null) };
});

function createService(overrides?: {
  indexer?: Partial<IndexerService>;
  downloadClient?: Partial<DownloadClientService>;
  settings?: Partial<SettingsService>;
  notifier?: Partial<NotifierService>;
  db?: unknown;
  fsAccess?: (path: string, mode?: number) => Promise<void>;
  fsStatfs?: (path: string) => Promise<{ bavail: number; bsize: number }>;
  probeFfmpeg?: (path: string) => Promise<string>;
  resolveProxyIp?: (proxyUrl: string) => Promise<string>;
}) {
  const log = createMockLogger();
  const indexer = {
    getAll: vi.fn().mockResolvedValue([]),
    test: vi.fn().mockResolvedValue({ success: true }),
    ...overrides?.indexer,
  };
  const downloadClient = {
    getAll: vi.fn().mockResolvedValue([]),
    test: vi.fn().mockResolvedValue({ success: true }),
    ...overrides?.downloadClient,
  };
  const settings = overrides?.settings ?? createMockSettingsService({
    processing: {},
  });
  const notifier = {
    notify: vi.fn().mockResolvedValue(undefined),
    ...overrides?.notifier,
  };
  const db = overrides?.db ?? {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  };

  const service = new HealthCheckService(
    inject<IndexerService>(indexer),
    inject<DownloadClientService>(downloadClient),
    inject<SettingsService>(settings),
    inject<NotifierService>(notifier),
    inject<Db>(db),
    inject<FastifyBaseLogger>(log),
    {
      fsAccess: overrides?.fsAccess ?? vi.fn().mockResolvedValue(undefined),
      fsStatfs: overrides?.fsStatfs ?? vi.fn().mockResolvedValue({ bavail: 100_000_000, bsize: 4096 }),
      probeFfmpeg: overrides?.probeFfmpeg ?? vi.fn().mockResolvedValue('6.1.1'),
      resolveProxyIp: overrides?.resolveProxyIp ?? vi.fn().mockResolvedValue('203.0.113.1'),
    },
  );

  return { service, indexer, downloadClient, settings, notifier, log, db };
}

/**
 * The `health` payload of every `on_health_issue` notify call, in dispatch order,
 * optionally narrowed to one `checkName`. Filtering by check rather than counting
 * all calls keeps an assertion honest when a pass legitimately changes more than
 * one check (#2090).
 */
function healthNotifications(
  notifier: { notify: unknown },
  checkName?: string,
): Array<{ checkName: string; previousState: string; currentState: string; message?: string }> {
  return (notifier.notify as ReturnType<typeof vi.fn>).mock.calls
    .filter((call: unknown[]) => call[0] === 'on_health_issue')
    .map((call: unknown[]) => (call[1] as {
      health: { checkName: string; previousState: string; currentState: string; message?: string };
    }).health)
    .filter((health) => checkName === undefined || health.checkName === checkName);
}

/** Drive `n` consecutive full health passes. */
async function runPasses(service: HealthCheckService, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await service.runAllChecks();
}

describe('HealthCheckService', () => {
  describe('checkIndexers', () => {
    it('calls test() on each enabled indexer and returns healthy on success', async () => {
      const { service, indexer } = createService({
        indexer: {
          getAll: vi.fn().mockResolvedValue([{ id: 1, name: 'NZB', enabled: true }]),
          test: vi.fn().mockResolvedValue({ success: true }),
        },
      });

      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'indexer:NZB');
      expect(check).toMatchObject({ state: 'healthy' });
      expect(indexer.test).toHaveBeenCalledWith(1);
    });

    it('returns error with message when indexer test fails', async () => {
      const { service } = createService({
        indexer: {
          getAll: vi.fn().mockResolvedValue([{ id: 1, name: 'NZB', enabled: true }]),
          test: vi.fn().mockResolvedValue({ success: false, message: 'Connection refused' }),
        },
      });

      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'indexer:NZB');
      expect(check).toMatchObject({ state: 'error', message: 'Connection refused' });
    });

    it('returns error when getAll throws (deleted indexer)', async () => {
      const { service } = createService({
        indexer: {
          getAll: vi.fn().mockResolvedValue([{ id: 1, name: 'NZB', enabled: true }]),
          test: vi.fn().mockRejectedValue(new Error('Not found')),
        },
      });

      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'indexer:NZB');
      expect(check).toMatchObject({ state: 'error' });
      expect(check!.message).toContain('Not found');
    });

    it('returns empty results when no indexers configured', async () => {
      const { service } = createService();
      const results = await service.runAllChecks();
      const indexerChecks = results.filter((r) => r.checkName.startsWith('indexer:'));
      expect(indexerChecks).toHaveLength(0);
    });

    it('populates target with indexer kind and id from the indexer row (success path)', async () => {
      const { service } = createService({
        indexer: {
          getAll: vi.fn().mockResolvedValue([{ id: 42, name: 'NZB', enabled: true }]),
          test: vi.fn().mockResolvedValue({ success: true }),
        },
      });

      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'indexer:NZB');
      expect(check?.target).toEqual({ kind: 'indexer', id: 42 });
    });

    it('populates target with indexer kind and id even when test throws', async () => {
      const { service } = createService({
        indexer: {
          getAll: vi.fn().mockResolvedValue([{ id: 17, name: 'NZB', enabled: true }]),
          test: vi.fn().mockRejectedValue(new Error('boom')),
        },
      });

      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'indexer:NZB');
      expect(check?.target).toEqual({ kind: 'indexer', id: 17 });
    });
  });

  describe('checkDownloadClients', () => {
    it('calls test() on each enabled download client and returns healthy on success', async () => {
      const { service, downloadClient } = createService({
        downloadClient: {
          getAll: vi.fn().mockResolvedValue([{ id: 1, name: 'qBit', enabled: true }]),
          test: vi.fn().mockResolvedValue({ success: true }),
        },
      });

      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'download-client:qBit');
      expect(check).toMatchObject({ state: 'healthy' });
      expect(downloadClient.test).toHaveBeenCalledWith(1);
    });

    it('returns error with message when download client test fails', async () => {
      const { service } = createService({
        downloadClient: {
          getAll: vi.fn().mockResolvedValue([{ id: 1, name: 'qBit', enabled: true }]),
          test: vi.fn().mockResolvedValue({ success: false, message: 'Auth failed' }),
        },
      });

      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'download-client:qBit');
      expect(check).toMatchObject({ state: 'error', message: 'Auth failed' });
    });

    it('returns error when test throws', async () => {
      const { service } = createService({
        downloadClient: {
          getAll: vi.fn().mockResolvedValue([{ id: 1, name: 'qBit', enabled: true }]),
          test: vi.fn().mockRejectedValue(new Error('Timeout')),
        },
      });

      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'download-client:qBit');
      expect(check).toMatchObject({ state: 'error' });
    });

    it('returns empty results when no download clients configured', async () => {
      const { service } = createService();
      const results = await service.runAllChecks();
      const clientChecks = results.filter((r) => r.checkName.startsWith('download-client:'));
      expect(clientChecks).toHaveLength(0);
    });

    it('populates target with download-client kind and id from the client row', async () => {
      const { service } = createService({
        downloadClient: {
          getAll: vi.fn().mockResolvedValue([{ id: 5, name: 'qBit', enabled: true }]),
          test: vi.fn().mockResolvedValue({ success: false, message: 'Auth failed' }),
        },
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'download-client:qBit');
      expect(check?.target).toEqual({ kind: 'download-client', id: 5 });
    });

    it('populates target with download-client kind and id even when test throws', async () => {
      const { service } = createService({
        downloadClient: {
          getAll: vi.fn().mockResolvedValue([{ id: 9, name: 'qBit', enabled: true }]),
          test: vi.fn().mockRejectedValue(new Error('Timeout')),
        },
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'download-client:qBit');
      expect(check?.target).toEqual({ kind: 'download-client', id: 9 });
    });
  });

  describe('checkLibraryRoot', () => {
    it('returns healthy when library root exists and is writable', async () => {
      const { service } = createService();
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'library-root');
      expect(check).toMatchObject({ state: 'healthy' });
    });

    it('returns error with path in message when library root missing', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const { service } = createService({ fsAccess: vi.fn().mockRejectedValue(err) });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'library-root');
      expect(check).toMatchObject({ state: 'error' });
      expect(check!.message).toContain('/audiobooks');
    });

    it('returns error with permission message when library root not writable', async () => {
      const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      const { service } = createService({ fsAccess: vi.fn().mockRejectedValue(err) });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'library-root');
      expect(check).toMatchObject({ state: 'error' });
      expect(check!.message).toMatch(/permission|writable|access/i);
    });

    it('returns not-writable message when fsAccess rejects a non-Error value', async () => {
      const { service } = createService({ fsAccess: vi.fn().mockRejectedValue('string-rejection') });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'library-root');
      expect(check).toMatchObject({ state: 'error', message: 'Library path not writable: /audiobooks' });
    });

    it('populates target route to /settings (General settings index) on healthy and error paths', async () => {
      const { service } = createService();
      const healthyResults = await service.runAllChecks();
      const healthyCheck = healthyResults.find((r) => r.checkName === 'library-root');
      expect(healthyCheck?.target).toEqual({ kind: 'route', path: '/settings' });

      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const { service: errorService } = createService({ fsAccess: vi.fn().mockRejectedValue(err) });
      const errorResults = await errorService.runAllChecks();
      const errorCheck = errorResults.find((r) => r.checkName === 'library-root');
      expect(errorCheck?.target).toEqual({ kind: 'route', path: '/settings' });
    });
  });

  describe('checkDiskSpace', () => {
    it('returns healthy when free space above threshold', async () => {
      // 10GB free, threshold 5GB
      const { service } = createService({
        fsStatfs: vi.fn().mockResolvedValue({ bavail: 10_000_000_000 / 4096, bsize: 4096 }),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'disk-space');
      expect(check).toMatchObject({ state: 'healthy' });
    });

    it('returns healthy when free space exactly at threshold (boundary: inclusive)', async () => {
      // Exactly 5GB
      const fiveGB = 5 * 1024 * 1024 * 1024;
      const { service } = createService({
        fsStatfs: vi.fn().mockResolvedValue({ bavail: fiveGB / 4096, bsize: 4096 }),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'disk-space');
      expect(check).toMatchObject({ state: 'healthy' });
    });

    it('returns warning with human-readable sizes when free space below threshold', async () => {
      // 2GB free, threshold 5GB
      const twoGB = 2 * 1024 * 1024 * 1024;
      const { service } = createService({
        fsStatfs: vi.fn().mockResolvedValue({ bavail: twoGB / 4096, bsize: 4096 }),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'disk-space');
      expect(check).toMatchObject({ state: 'warning' });
      expect(check!.message).toMatch(/2.*GB/i);
    });

    it('returns error when free space is zero', async () => {
      const { service } = createService({
        fsStatfs: vi.fn().mockResolvedValue({ bavail: 0, bsize: 4096 }),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'disk-space');
      expect(check).toMatchObject({ state: 'error' });
    });

    it('returns warning when library path is not configured', async () => {
      const nullLibSettings = createMockSettingsService({ library: { path: '' } });
      // Override library.get to return null to test unconfigured path
      (nullLibSettings.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'library') return Promise.resolve(null);
        return Promise.resolve(DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS]);
      });
      const { service } = createService({ settings: nullLibSettings });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'disk-space');
      expect(check).toMatchObject({ state: 'warning' });
      expect(check!.message).toContain('not configured');
    });

    it('returns error with message when statfs throws', async () => {
      const { service } = createService({
        fsStatfs: vi.fn().mockRejectedValue(new Error('Permission denied')),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'disk-space');
      expect(check).toMatchObject({ state: 'error' });
      expect(check!.message).toContain('Permission denied');
    });

    it('returns stringified value when statfs rejects a non-Error value', async () => {
      const { service } = createService({
        fsStatfs: vi.fn().mockRejectedValue('string-rejection'),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'disk-space');
      expect(check).toMatchObject({ state: 'error', message: 'Failed to check disk space: string-rejection' });
    });

    it('populates target route to /settings (General settings index) across all branches', async () => {
      const { service: healthy } = createService();
      const healthyCheck = (await healthy.runAllChecks()).find((r) => r.checkName === 'disk-space');
      expect(healthyCheck?.target).toEqual({ kind: 'route', path: '/settings' });

      const twoGB = 2 * 1024 * 1024 * 1024;
      const { service: warning } = createService({
        fsStatfs: vi.fn().mockResolvedValue({ bavail: twoGB / 4096, bsize: 4096 }),
      });
      const warningCheck = (await warning.runAllChecks()).find((r) => r.checkName === 'disk-space');
      expect(warningCheck?.target).toEqual({ kind: 'route', path: '/settings' });

      const { service: error } = createService({
        fsStatfs: vi.fn().mockResolvedValue({ bavail: 0, bsize: 4096 }),
      });
      const errorCheck = (await error.runAllChecks()).find((r) => r.checkName === 'disk-space');
      expect(errorCheck?.target).toEqual({ kind: 'route', path: '/settings' });
    });
  });

  describe('checkFfmpeg', () => {
    it('returns healthy when probeFfmpeg succeeds', async () => {
      const { service } = createService();
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'ffmpeg');
      expect(check).toMatchObject({ state: 'healthy' });
    });

    it('returns error with configured path in message when probeFfmpeg throws', async () => {
      const { service } = createService({
        probeFfmpeg: vi.fn().mockRejectedValue(new Error('spawn ENOENT')),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'ffmpeg');
      expect(check).toMatchObject({ state: 'error' });
      expect(check!.message).toContain('/usr/bin/ffmpeg');
    });

    it('stays silent when ffmpeg is absent and no automation needs it (ffmpeg is optional)', async () => {
      ffmpegState.resolves = false;
      // Default mock settings: autoMergeDownloads off, tagging.enabled off.
      const { service } = createService();
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'ffmpeg');
      expect(check).toBeUndefined();
      ffmpegState.resolves = true;
    });

    it('reports an error when ffmpeg is absent and auto-merge is enabled', async () => {
      ffmpegState.resolves = false;
      const { service } = createService({
        settings: createMockSettingsService({ processing: { autoMergeDownloads: true } }),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'ffmpeg');
      expect(check).toMatchObject({ state: 'error' });
      expect(check!.message).toContain('auto-merge');
      ffmpegState.resolves = true;
    });

    it('reports an error when ffmpeg is absent and tag embedding is enabled', async () => {
      ffmpegState.resolves = false;
      const { service } = createService({
        settings: createMockSettingsService({ tagging: { enabled: true } }),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'ffmpeg');
      expect(check).toMatchObject({ state: 'error' });
      ffmpegState.resolves = true;
    });

    it('populates target settings:post-processing on healthy and error paths', async () => {
      const { service: healthy } = createService();
      const healthyCheck = (await healthy.runAllChecks()).find((r) => r.checkName === 'ffmpeg');
      expect(healthyCheck?.target).toEqual({ kind: 'settings', path: 'audio-tools' });

      const { service: error } = createService({
        probeFfmpeg: vi.fn().mockRejectedValue(new Error('spawn ENOENT')),
      });
      const errorCheck = (await error.runAllChecks()).find((r) => r.checkName === 'ffmpeg');
      expect(errorCheck?.target).toEqual({ kind: 'settings', path: 'audio-tools' });
    });
  });

  describe('checkHardcover', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('skips check and returns no result when no API key is configured', async () => {
      const searchSeries = vi.spyOn(HardcoverClient.prototype, 'searchSeries');
      const { service } = createService({
        settings: createMockSettingsService({ metadata: { hardcoverApiKey: '' } }),
      });
      const results = await service.runAllChecks();
      expect(results.find((r) => r.checkName === 'hardcover')).toBeUndefined();
      expect(searchSeries).not.toHaveBeenCalled();
    });

    it('skips check (no probe) when API key is whitespace-only', async () => {
      const searchSeries = vi.spyOn(HardcoverClient.prototype, 'searchSeries');
      const { service } = createService({
        settings: createMockSettingsService({ metadata: { hardcoverApiKey: '   ' } }),
      });
      const results = await service.runAllChecks();
      expect(results.find((r) => r.checkName === 'hardcover')).toBeUndefined();
      expect(searchSeries).not.toHaveBeenCalled();
    });

    it('returns healthy when searchSeries resolves a non-empty array', async () => {
      vi.spyOn(HardcoverClient.prototype, 'searchSeries').mockResolvedValue([
        { id: 1 } as never,
      ]);
      const { service } = createService({
        settings: createMockSettingsService({ metadata: { hardcoverApiKey: 'valid-key' } }),
      });
      const results = await service.runAllChecks();
      expect(results.find((r) => r.checkName === 'hardcover')).toMatchObject({ state: 'healthy' });
    });

    it('probes Hardcover with the literal "test" query', async () => {
      const searchSeries = vi.spyOn(HardcoverClient.prototype, 'searchSeries').mockResolvedValue([]);
      const { service } = createService({
        settings: createMockSettingsService({ metadata: { hardcoverApiKey: 'valid-key' } }),
      });
      await service.runAllChecks();
      expect(searchSeries).toHaveBeenCalledWith('test');
    });

    it('returns healthy when searchSeries resolves an empty array (empty is success)', async () => {
      vi.spyOn(HardcoverClient.prototype, 'searchSeries').mockResolvedValue([]);
      const { service } = createService({
        settings: createMockSettingsService({ metadata: { hardcoverApiKey: 'valid-key' } }),
      });
      const results = await service.runAllChecks();
      expect(results.find((r) => r.checkName === 'hardcover')).toMatchObject({ state: 'healthy' });
    });

    it('returns error with the Bearer-prefix hint for an invalid-key MetadataError', async () => {
      vi.spyOn(HardcoverClient.prototype, 'searchSeries').mockRejectedValue(
        new MetadataError('hardcover', 'Hardcover search error: Could not verify JWT: signature mismatch'),
      );
      const { service } = createService({
        settings: createMockSettingsService({ metadata: { hardcoverApiKey: 'bad-key' } }),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'hardcover');
      expect(check).toMatchObject({ state: 'error' });
      expect(check!.message).toContain('Invalid Hardcover API key');
    });

    it('returns error with the unreachable hint for a TransientError', async () => {
      vi.spyOn(HardcoverClient.prototype, 'searchSeries').mockRejectedValue(
        new TransientError('hardcover', 'ECONNRESET'),
      );
      const { service } = createService({
        settings: createMockSettingsService({ metadata: { hardcoverApiKey: 'valid-key' } }),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'hardcover');
      expect(check).toMatchObject({ state: 'error' });
      expect(check!.message).toContain("Couldn't reach Hardcover");
    });

    it('returns error with the rate-limit hint for a RateLimitError', async () => {
      vi.spyOn(HardcoverClient.prototype, 'searchSeries').mockRejectedValue(
        new RateLimitError(5000, 'hardcover'),
      );
      const { service } = createService({
        settings: createMockSettingsService({ metadata: { hardcoverApiKey: 'valid-key' } }),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'hardcover');
      expect(check).toMatchObject({ state: 'error' });
      expect(check!.message).toContain('rate-limiting');
    });

    it('populates target settings:search on healthy and error paths', async () => {
      vi.spyOn(HardcoverClient.prototype, 'searchSeries').mockResolvedValue([]);
      const { service: healthy } = createService({
        settings: createMockSettingsService({ metadata: { hardcoverApiKey: 'valid-key' } }),
      });
      const healthyCheck = (await healthy.runAllChecks()).find((r) => r.checkName === 'hardcover');
      expect(healthyCheck?.target).toEqual({ kind: 'settings', path: 'search' });

      vi.restoreAllMocks();
      vi.spyOn(HardcoverClient.prototype, 'searchSeries').mockRejectedValue(
        new TransientError('hardcover', 'ECONNRESET'),
      );
      const { service: error } = createService({
        settings: createMockSettingsService({ metadata: { hardcoverApiKey: 'valid-key' } }),
      });
      const errorCheck = (await error.runAllChecks()).find((r) => r.checkName === 'hardcover');
      expect(errorCheck?.target).toEqual({ kind: 'settings', path: 'search' });
    });

    it('does not fire on_health_issue for hardcover when no key is configured', async () => {
      const { service, notifier } = createService({
        settings: createMockSettingsService({ metadata: { hardcoverApiKey: '' } }),
      });
      await service.runAllChecks();
      const hardcoverCalls = (notifier.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) =>
          c[0] === 'on_health_issue' &&
          (c[1] as { health?: { checkName?: string } })?.health?.checkName === 'hardcover',
      );
      expect(hardcoverCalls).toHaveLength(0);
    });
  });

  describe('checkStuckDownloads', () => {
    it('returns warning for download with progressUpdatedAt >1 hour ago', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { service } = createService({
        db: {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                { id: 1, title: 'Stuck Book', progressUpdatedAt: twoHoursAgo, progress: 0.5 },
              ]),
            }),
          }),
        },
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'stuck-downloads');
      expect(check).toMatchObject({ state: 'warning' });
      expect(check!.message).toContain('Stuck Book');
    });

    it('returns healthy when progressUpdatedAt is exactly 1 hour ago (boundary: exclusive)', async () => {
      // Add 1 second buffer to avoid flaky timing between Date.now() calls
      const exactlyOneHour = new Date(Date.now() - 60 * 60 * 1000 + 1000);
      const { service } = createService({
        db: {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                { id: 1, title: 'Active Book', progressUpdatedAt: exactlyOneHour, progress: 0.5 },
              ]),
            }),
          }),
        },
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'stuck-downloads');
      expect(check).toMatchObject({ state: 'healthy' });
    });

    it('returns healthy when no downloads are active', async () => {
      const { service } = createService();
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'stuck-downloads');
      expect(check).toMatchObject({ state: 'healthy' });
    });

    it('falls back to addedAt when progressUpdatedAt is null (legacy rows)', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { service } = createService({
        db: {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                { id: 1, title: 'Legacy Book', progressUpdatedAt: null, addedAt: twoHoursAgo, progress: 0.3 },
              ]),
            }),
          }),
        },
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'stuck-downloads');
      expect(check).toMatchObject({ state: 'warning' });
      expect(check!.message).toContain('Legacy Book');
    });

    it('returns error with message when download query fails', async () => {
      const { service } = createService({
        db: {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockRejectedValue(new Error('DB connection lost')),
            }),
          }),
        },
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'stuck-downloads');
      expect(check).toMatchObject({ state: 'error' });
      expect(check!.message).toContain('DB connection lost');
    });

    it('returns stringified value when download query rejects a non-Error value', async () => {
      const { service } = createService({
        db: {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockRejectedValue('string-rejection'),
            }),
          }),
        },
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'stuck-downloads');
      expect(check).toMatchObject({ state: 'error', message: 'Failed to check downloads: string-rejection' });
    });

    it('populates target route:/activity on healthy, warning, and error paths', async () => {
      const { service: healthy } = createService();
      const healthyCheck = (await healthy.runAllChecks()).find((r) => r.checkName === 'stuck-downloads');
      expect(healthyCheck?.target).toEqual({ kind: 'route', path: '/activity' });

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { service: warning } = createService({
        db: {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                { id: 1, title: 'Stuck', progressUpdatedAt: twoHoursAgo, progress: 0.5 },
              ]),
            }),
          }),
        },
      });
      const warningCheck = (await warning.runAllChecks()).find((r) => r.checkName === 'stuck-downloads');
      expect(warningCheck?.target).toEqual({ kind: 'route', path: '/activity' });

      const { service: error } = createService({
        db: {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockRejectedValue(new Error('DB gone')),
            }),
          }),
        },
      });
      const errorCheck = (await error.runAllChecks()).find((r) => r.checkName === 'stuck-downloads');
      expect(errorCheck?.target).toEqual({ kind: 'route', path: '/activity' });
    });
  });

  describe('runAllChecks', () => {
    it('runs all checks independently — one check throwing does not prevent remaining checks', async () => {
      const { service } = createService({
        indexer: {
          getAll: vi.fn().mockRejectedValue(new Error('DB gone')),
        },
      });
      const results = await service.runAllChecks();
      // Should still have library-root, disk-space, ffmpeg, stuck-downloads results
      expect(results.length).toBeGreaterThanOrEqual(3);
    });

    // #2090 note: every test below drives a LOCAL check (`library-root` via a
    // rejecting `fsAccess`, `disk-space` via `fsStatfs`) rather than an indexer.
    // Local checks confirm on their first pass, so these keep observing pass-1
    // dispatch. Driven by an indexer they would either go red (the window
    // suppresses pass 1) or — worse — stay green while no notification is ever
    // dispatched, making the fire-and-forget assertions vacuous. Each one that
    // depends on a notification actually happening asserts that explicitly.
    const libraryRootMissing = () => vi.fn().mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    it('fires on_health_issue notification once per changed check', async () => {
      const { service, notifier } = createService({ fsAccess: libraryRootMissing() });

      // First run establishes state
      await service.runAllChecks();
      // The initial run from unknown → error should fire a notification
      expect(healthNotifications(notifier, 'library-root')).toMatchObject([
        { previousState: 'healthy', currentState: 'error' },
      ]);
    });

    it('fires N notifications when N checks change in one run', async () => {
      const twoGB = 2 * 1024 * 1024 * 1024;
      const { service, notifier } = createService({
        fsAccess: libraryRootMissing(),
        fsStatfs: vi.fn().mockResolvedValue({ bavail: twoGB / 4096, bsize: 4096 }),
      });

      await service.runAllChecks();

      expect(healthNotifications(notifier).map((h) => h.checkName).sort()).toEqual(
        ['disk-space', 'library-root'],
      );
    });

    it('does not fire notification when check state is unchanged', async () => {
      const { service, notifier } = createService({ fsAccess: libraryRootMissing() });

      await service.runAllChecks();
      // The first pass must actually have dispatched, or the second pass's silence
      // proves nothing.
      expect(healthNotifications(notifier, 'library-root')).toHaveLength(1);
      (notifier.notify as ReturnType<typeof vi.fn>).mockClear();

      // Second run — same state, should not fire
      await service.runAllChecks();
      expect(healthNotifications(notifier)).toHaveLength(0);
    });

    it('notification fire-and-forget — notifier rejection does not throw or break health check', async () => {
      const { service, notifier } = createService({
        fsAccess: libraryRootMissing(),
        notifier: {
          notify: vi.fn().mockRejectedValue(new Error('notification failed')),
        },
      });

      // Should not throw
      const results = await service.runAllChecks();
      // The rejecting notifier was actually invoked — otherwise "did not throw" is
      // trivially true and this exercises no rejection containment at all.
      expect(healthNotifications(notifier, 'library-root')).toHaveLength(1);
      expect(results.length).toBeGreaterThan(0);
    });

    it('calls fireAndForget with notification promise, logger, and context string on state transition', async () => {
      const notifyPromise = Promise.resolve();
      const { service, notifier } = createService({
        fsAccess: libraryRootMissing(),
        notifier: {
          notify: vi.fn().mockReturnValue(notifyPromise),
        },
      });

      await service.runAllChecks();

      expect(notifier.notify).toHaveBeenCalledWith('on_health_issue', expect.objectContaining({
        health: expect.objectContaining({
          checkName: 'library-root',
          currentState: 'error',
        }),
      }));
    });

    it('runAllChecks resolves before a pending notification settles (deterministic deferred promise)', async () => {
      // Create a deferred promise that stays pending
      let resolveNotify!: () => void;
      const pendingPromise = new Promise<void>((resolve) => { resolveNotify = resolve; });
      let notifySettled = false;
      pendingPromise.then(() => { notifySettled = true; });

      const { service, notifier } = createService({
        fsAccess: libraryRootMissing(),
        notifier: {
          notify: vi.fn().mockReturnValue(pendingPromise),
        },
      });

      // runAllChecks should resolve even though the notification promise is still pending
      const results = await service.runAllChecks();
      expect(results.length).toBeGreaterThan(0);
      // The deferred promise was actually requested — `notifySettled === false` is
      // trivially true for a notification that was never dispatched.
      expect(healthNotifications(notifier, 'library-root')).toHaveLength(1);
      expect(notifySettled).toBe(false); // notification is still pending

      // Clean up: settle the deferred promise
      resolveNotify();
      await pendingPromise;
    });

    it('notification rejection is logged at warn level via fireAndForget, not silently swallowed', async () => {
      const error = new Error('notification failed');
      const { service, log, notifier } = createService({
        fsAccess: libraryRootMissing(),
        notifier: {
          notify: vi.fn().mockRejectedValue(error),
        },
      });

      await service.runAllChecks();
      expect(healthNotifications(notifier, 'library-root')).toHaveLength(1);
      // Allow microtasks to flush so fireAndForget's .catch() handler runs
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: error.message, type: 'Error' }) }),
        expect.stringContaining('health'),
      );
    });

    it('logs canonical serialized error when a sub-check throws outside its inner try', async () => {
      // indexerService.getAll() throws — this is called before checkIndexers'
      // inner try/catch, so the rejection propagates up to runAllChecks' catch.
      const { service, log } = createService({
        indexer: {
          getAll: vi.fn().mockRejectedValue(new Error('indexer backend down')),
          test: vi.fn(),
        },
      });

      await service.runAllChecks();

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'indexer backend down', type: 'Error' }) }),
        'Health check failed',
      );
    });
  });

  describe('getAggregateState', () => {
    it('returns healthy when all checks are healthy', async () => {
      const { service } = createService();
      await service.runAllChecks();
      expect(service.getAggregateState()).toBe('healthy');
    });

    it('returns warning when at least one check is warning and none are error', async () => {
      // Trigger a warning by setting low disk space (2GB, threshold 5GB)
      const twoGB = 2 * 1024 * 1024 * 1024;
      const { service } = createService({
        fsStatfs: vi.fn().mockResolvedValue({ bavail: twoGB / 4096, bsize: 4096 }),
      });
      await service.runAllChecks();
      expect(service.getAggregateState()).toBe('warning');
    });

    it('returns error when at least one check is error, even with warnings present', async () => {
      // Trigger both: error from ffmpeg + warning from low disk space
      const twoGB = 2 * 1024 * 1024 * 1024;
      const { service } = createService({
        fsStatfs: vi.fn().mockResolvedValue({ bavail: twoGB / 4096, bsize: 4096 }),
        probeFfmpeg: vi.fn().mockRejectedValue(new Error('not found')),
      });
      await service.runAllChecks();
      expect(service.getAggregateState()).toBe('error');
    });
  });

  describe('concurrency', () => {
    // A call that lands while a pass is running coalesces into the mutex: it does
    // NOT spawn a parallel pass. Post-#1411 (F1) it resolves with the guaranteed
    // trailing rerun's result — a pass that begins after it registered — instead
    // of returning the pre-existing cachedResults immediately. Returning stale
    // cache here was the bug that let a manual Run Now overlapping a scheduled
    // pass miss its freshly-fetched version row.
    it('a coalesced call waits for and resolves with the trailing rerun, not the pre-existing cache (#1411 F1)', async () => {
      let resolveFirstPass!: () => void;
      const getAll = vi.fn()
        .mockReturnValueOnce(new Promise<unknown[]>((r) => { resolveFirstPass = () => r([]); }))
        .mockResolvedValue([]);
      const { service } = createService({ indexer: { getAll, test: vi.fn() } });

      const first = service.runAllChecks();
      let secondResolved = false;
      const second = service.runAllChecks().then((r) => { secondResolved = true; return r; });

      // While pass #1 is gated, the coalesced call must NOT have resolved — it
      // parks for the trailing rerun rather than handing back stale cache.
      await new Promise((r) => setTimeout(r, 0));
      expect(secondResolved).toBe(false);

      resolveFirstPass!();
      const [, secondResults] = await Promise.all([first, second]);

      // It resolved with a real pass result, and exactly two passes ran (the
      // initial pass + one trailing rerun) — coalesced, not an unbounded loop.
      expect(secondResults).toEqual(expect.any(Array));
      expect(getAll).toHaveBeenCalledTimes(2);
    });
  });

  describe('probeFfmpeg delegation', () => {
    it('delegates to injected dep with exact path and returns version', async () => {
      const mockProbe = vi.fn().mockResolvedValue('6.1.1');
      const { service } = createService({ probeFfmpeg: mockProbe });

      const result = await service.probeFfmpeg('/usr/local/bin/ffmpeg');
      expect(result).toBe('6.1.1');
      expect(mockProbe).toHaveBeenCalledWith('/usr/local/bin/ffmpeg');
    });

    it('propagates errors from injected dep', async () => {
      const mockProbe = vi.fn().mockRejectedValue(new Error('spawn ENOENT'));
      const { service } = createService({ probeFfmpeg: mockProbe });

      await expect(service.probeFfmpeg('/bad/path')).rejects.toThrow('spawn ENOENT');
    });
  });

  describe('probeProxy delegation', () => {
    it('delegates to injected dep with exact proxy URL and returns IP', async () => {
      const mockResolve = vi.fn().mockResolvedValue('203.0.113.42');
      const { service } = createService({ resolveProxyIp: mockResolve });

      const result = await service.probeProxy('http://proxy.example.com:8080');
      expect(result).toBe('203.0.113.42');
      expect(mockResolve).toHaveBeenCalledWith('http://proxy.example.com:8080');
    });

    it('propagates errors from injected dep', async () => {
      const mockResolve = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const { service } = createService({ resolveProxyIp: mockResolve });

      await expect(service.probeProxy('http://bad-proxy:1234')).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('#372 — health check maps Mouse warning to warning state', () => {
    it('MAM test success with warning → health state is "warning" with warning message', async () => {
      const mamIndexer = { id: 1, name: 'MAM', type: 'myanonamouse', enabled: true };
      const { service } = createService({
        indexer: {
          getAll: vi.fn().mockResolvedValue([mamIndexer]),
          test: vi.fn().mockResolvedValue({ success: true, warning: 'Account is ratio-locked (Mouse class) — cannot download' }),
        },
      });
      const results = await service.runAllChecks();
      const indexerResult = results.find(r => r.checkName === 'indexer:MAM');
      expect(indexerResult).toBeDefined();
      expect(indexerResult!.state).toBe('warning');
      expect(indexerResult!.message).toBe('Account is ratio-locked (Mouse class) — cannot download');
    });

    it('MAM test success without warning → health state is "healthy"', async () => {
      const mamIndexer = { id: 1, name: 'MAM', type: 'myanonamouse', enabled: true };
      const { service } = createService({
        indexer: {
          getAll: vi.fn().mockResolvedValue([mamIndexer]),
          test: vi.fn().mockResolvedValue({ success: true }),
        },
      });
      const results = await service.runAllChecks();
      const indexerResult = results.find(r => r.checkName === 'indexer:MAM');
      expect(indexerResult).toBeDefined();
      expect(indexerResult!.state).toBe('healthy');
      expect(indexerResult!.message).toBeUndefined();
    });

    it('MAM test failure → health state is "error" (unchanged behavior)', async () => {
      const mamIndexer = { id: 1, name: 'MAM', type: 'myanonamouse', enabled: true };
      const { service } = createService({
        indexer: {
          getAll: vi.fn().mockResolvedValue([mamIndexer]),
          test: vi.fn().mockResolvedValue({ success: false, message: 'Auth failed' }),
        },
      });
      const results = await service.runAllChecks();
      const indexerResult = results.find(r => r.checkName === 'indexer:MAM');
      expect(indexerResult).toBeDefined();
      expect(indexerResult!.state).toBe('error');
      expect(indexerResult!.message).toBe('Auth failed');
    });
  });

  describe('#1230 — checkVersionUpdate', () => {
    afterEach(() => {
      vi.mocked(getUpdateStatus).mockReset();
    });

    it('emits a warning row with a release-notes link when an update is available', async () => {
      vi.mocked(getUpdateStatus).mockReturnValue({
        latestVersion: '1.2.3',
        releaseUrl: 'https://github.com/tjiddy/narratorr/releases/v1.2.3',
        channel: 'stable',
      });
      const { service } = createService();

      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'version-update');
      expect(check).toEqual({
        checkName: 'version-update',
        state: 'warning',
        message: 'Update available: v1.2.3',
        link: { url: 'https://github.com/tjiddy/narratorr/releases/v1.2.3', label: 'Release notes' },
      });
    });

    it('renders develop-channel copy and a compare link for a develop update (F2)', async () => {
      vi.mocked(getUpdateStatus).mockReturnValue({
        latestVersion: 'def5678', // bare develop HEAD sha — must NOT leak into the message
        releaseUrl: 'https://github.com/tjiddy/narratorr/compare/abc1234...develop',
        channel: 'develop',
      });
      const { service } = createService();

      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'version-update');
      expect(check).toEqual({
        checkName: 'version-update',
        state: 'warning',
        message: 'A newer develop build is available',
        link: { url: 'https://github.com/tjiddy/narratorr/compare/abc1234...develop', label: 'Compare changes' },
      });
      // No v-prefixed sha leaked into the message, and the diff isn't labelled "Release notes".
      expect(check!.message).not.toContain('vdef5678');
      expect(check!.link!.label).not.toBe('Release notes');
    });

    it('does not set a target (stays out of the clickable-button path)', async () => {
      vi.mocked(getUpdateStatus).mockReturnValue({
        latestVersion: '1.2.3',
        releaseUrl: 'https://example.com/r',
        channel: 'stable',
      });
      const { service } = createService();

      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'version-update');
      expect(check?.target).toBeUndefined();
    });

    it('omits the row entirely when no update is available', async () => {
      vi.mocked(getUpdateStatus).mockReturnValue(undefined);
      const { service } = createService();

      const results = await service.runAllChecks();
      expect(results.find((r) => r.checkName === 'version-update')).toBeUndefined();
    });

    it('aggregate rollup reports warning when version-update is the only non-healthy check', async () => {
      vi.mocked(getUpdateStatus).mockReturnValue({
        latestVersion: '1.2.3',
        releaseUrl: 'https://example.com/r',
        channel: 'stable',
      });
      const { service } = createService();

      await service.runAllChecks();
      expect(service.getAggregateState()).toBe('warning');
    });
  });

  describe('#1262 — nudge refresh + in-flight coalescing', () => {
    afterEach(() => {
      vi.mocked(getUpdateStatus).mockReset();
    });

    it('re-running runAllChecks lands the version-update warning into cached results', async () => {
      vi.mocked(getUpdateStatus).mockReturnValue(undefined);
      const { service } = createService();

      await service.runAllChecks();
      expect(service.getCachedResults().find((r) => r.checkName === 'version-update')).toBeUndefined();

      // Simulate a version-check populating cachedUpdate, then a nudge → recompute.
      vi.mocked(getUpdateStatus).mockReturnValue({
        latestVersion: '1.2.3',
        releaseUrl: 'https://example.com/r',
        channel: 'stable',
      });
      await service.runAllChecks();

      // The cached-read source (what the endpoints serve) now includes the row —
      // proving a real recompute ran, not bare invalidation that leaves it empty.
      const cached = service.getCachedResults();
      expect(cached.find((r) => r.checkName === 'version-update')).toMatchObject({
        checkName: 'version-update',
        state: 'warning',
      });
    });

    it('clearing the update and re-running drops the version-update warning', async () => {
      vi.mocked(getUpdateStatus).mockReturnValue({
        latestVersion: '1.2.3',
        releaseUrl: 'https://example.com/r',
        channel: 'stable',
      });
      const { service } = createService();

      await service.runAllChecks();
      expect(service.getCachedResults().find((r) => r.checkName === 'version-update')).toBeDefined();

      vi.mocked(getUpdateStatus).mockReturnValue(undefined);
      await service.runAllChecks();

      expect(service.getCachedResults().find((r) => r.checkName === 'version-update')).toBeUndefined();
    });

    it('a recompute requested mid-pass coalesces into exactly one trailing rerun that observes the new status', async () => {
      // Gate the first pass on a slow indexer so we can fire a nudge while it runs.
      let releaseFirstPass: () => void;
      const getAll = vi.fn()
        .mockReturnValueOnce(new Promise<unknown[]>((r) => { releaseFirstPass = () => r([]); }))
        .mockResolvedValue([]);
      const { service } = createService({ indexer: { getAll, test: vi.fn() } });

      // First pass observes NO update.
      vi.mocked(getUpdateStatus).mockReturnValue(undefined);
      const first = service.runAllChecks();

      // While the first pass is mid-flight, the version-check completes with a
      // newer build and nudges a recompute. The nudge must not be dropped.
      vi.mocked(getUpdateStatus).mockReturnValue({
        latestVersion: '2.0.0',
        releaseUrl: 'https://example.com/r2',
        channel: 'stable',
      });
      const nudge = service.runAllChecks(); // returns stale cached immediately

      // Let the first (and then the coalesced trailing) pass complete.
      releaseFirstPass!();
      await Promise.all([first, nudge]);

      // The trailing rerun observed the NEW status → it is surfaced, not lost.
      const cached = service.getCachedResults();
      expect(cached.find((r) => r.checkName === 'version-update')).toMatchObject({
        checkName: 'version-update',
        state: 'warning',
        message: 'Update available: v2.0.0',
      });

      // Exactly one trailing rerun: the first pass + one rerun = 2 full passes,
      // so getAll (called once per pass) was invoked exactly twice — no loop.
      expect(getAll).toHaveBeenCalledTimes(2);
    });

    it('non-overlapping sequential runs do not trigger a spurious trailing rerun', async () => {
      vi.mocked(getUpdateStatus).mockReturnValue(undefined);
      const getAll = vi.fn().mockResolvedValue([]);
      const { service } = createService({ indexer: { getAll, test: vi.fn() } });

      await service.runAllChecks();
      await service.runAllChecks();

      // Two awaited, non-overlapping passes → exactly two getAll calls. A spurious
      // trailing rerun would push this to 3.
      expect(getAll).toHaveBeenCalledTimes(2);
    });
  });

  // #1411 — manual "Run Now" fires a live version check before reading the
  // report, so the version-update row reflects a fresh check instead of the
  // up-to-24h-stale daily cache. Scheduled runs keep calling runAllChecks().
  describe('#1411 — runManualChecks (manual Run Now fires a live version check)', () => {
    beforeEach(() => {
      vi.mocked(checkForUpdate).mockReset();
      vi.mocked(getUpdateStatus).mockReset();
      // checkForUpdate resolves void in production; default to a settled promise
      // so the awaited `.catch` chain in runManualChecks has a thenable to bind.
      vi.mocked(checkForUpdate).mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.mocked(checkForUpdate).mockReset();
      vi.mocked(getUpdateStatus).mockReset();
    });

    it('awaits checkForUpdate BEFORE reading the report, so the run reflects the fresh cache (AC #1)', async () => {
      const { service, log } = createService();
      // The update only becomes visible AFTER checkForUpdate resolves. If
      // runAllChecks read getUpdateStatus before/concurrently, the row would be
      // absent — its presence proves serial ordering.
      let fetched = false;
      vi.mocked(checkForUpdate).mockImplementation(async () => {
        await Promise.resolve();
        fetched = true;
      });
      vi.mocked(getUpdateStatus).mockImplementation(() =>
        fetched
          ? { latestVersion: '2.0.0', releaseUrl: 'https://example.com/r', channel: 'stable' }
          : undefined,
      );

      const results = await service.runManualChecks(log as unknown as FastifyBaseLogger);

      expect(checkForUpdate).toHaveBeenCalledOnce();
      expect(results.find((r) => r.checkName === 'version-update')).toMatchObject({
        checkName: 'version-update',
        state: 'warning',
        message: 'Update available: v2.0.0',
      });
    });

    it('a delayed checkForUpdate still gates runAllChecks — the pass does not start early (AC #1 negative-timing)', async () => {
      const { service, log } = createService();
      let fetched = false;
      vi.mocked(checkForUpdate).mockImplementation(
        () => new Promise<void>((resolve) => { setTimeout(() => { fetched = true; resolve(); }, 25); }),
      );
      vi.mocked(getUpdateStatus).mockImplementation(() =>
        fetched
          ? { latestVersion: '3.1.0', releaseUrl: 'https://example.com/r3', channel: 'stable' }
          : undefined,
      );

      const results = await service.runManualChecks(log as unknown as FastifyBaseLogger);

      // Even with a 25ms-delayed fetch, the row is present → runAllChecks waited
      // for the fetch to land rather than reading the pre-fetch (undefined) cache.
      expect(results.find((r) => r.checkName === 'version-update')).toMatchObject({
        message: 'Update available: v3.1.0',
      });
    });

    it('passes the registered onUpdateChanged callback (same as boot/2 AM) into checkForUpdate (AC #5)', async () => {
      const { service, log } = createService();
      const onUpdateChanged = vi.fn();
      service.setVersionUpdateCallback(onUpdateChanged);
      vi.mocked(getUpdateStatus).mockReturnValue(undefined);

      await service.runManualChecks(log as unknown as FastifyBaseLogger);

      expect(checkForUpdate).toHaveBeenCalledWith(log, onUpdateChanged);
    });

    it('passes undefined when no callback is registered, without throwing (boot-less / route-test context)', async () => {
      const { service, log } = createService();
      vi.mocked(getUpdateStatus).mockReturnValue(undefined);

      await expect(service.runManualChecks(log as unknown as FastifyBaseLogger)).resolves.toBeDefined();
      expect(checkForUpdate).toHaveBeenCalledWith(log, undefined);
    });

    it('a failing version fetch does not fail the run — falls through to the cached value (AC #2)', async () => {
      const { service, log } = createService();
      // Defensive: the production checkForUpdate swallows its own errors and never
      // rejects, but runManualChecks guards it so a rejection can't fail the run.
      vi.mocked(checkForUpdate).mockRejectedValue(new Error('GitHub unreachable'));
      // The prior cached value remains intact and is what the report reflects.
      vi.mocked(getUpdateStatus).mockReturnValue({
        latestVersion: '1.2.3',
        releaseUrl: 'https://example.com/cached',
        channel: 'stable',
      });

      const results = await service.runManualChecks(log as unknown as FastifyBaseLogger);

      // Run still completed with the cached row; the failure was logged, not thrown.
      expect(results.find((r) => r.checkName === 'version-update')).toMatchObject({
        message: 'Update available: v1.2.3',
      });
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'GitHub unreachable' }) }),
        'Manual health run: live version check failed',
      );
    });

    it('dev/unbuilt build: checkForUpdate is a silent no-op and the run completes cleanly with no version-update row (AC #5)', async () => {
      const { service, log } = createService();
      // Mirrors checkForUpdate's `version === 'dev'` early return: touches nothing.
      vi.mocked(checkForUpdate).mockResolvedValue(undefined);
      vi.mocked(getUpdateStatus).mockReturnValue(undefined);

      const results = await service.runManualChecks(log as unknown as FastifyBaseLogger);

      expect(results.find((r) => r.checkName === 'version-update')).toBeUndefined();
      expect(checkForUpdate).toHaveBeenCalledOnce();
    });

    it('does NOT fire a version check on the scheduled path — runAllChecks() stays cache-only (AC #3)', async () => {
      const { service } = createService();
      vi.mocked(getUpdateStatus).mockReturnValue(undefined);

      await service.runAllChecks();

      // The scheduled health-check cron calls runAllChecks() directly; it must
      // never reach checkForUpdate — that lives only in the manual entry point.
      expect(checkForUpdate).not.toHaveBeenCalled();
    });

    it('returns a post-fetch report even when the manual run overlaps an active health pass (AC #1, F1)', async () => {
      // Gate the first (scheduled) pass on a slow indexer so the manual run lands
      // while runAllChecks is already `running` and would otherwise coalesce into
      // the in-progress branch and return the pre-fetch cachedResults.
      let releaseScheduledPass!: () => void;
      const getAll = vi.fn()
        .mockReturnValueOnce(new Promise<unknown[]>((r) => { releaseScheduledPass = () => r([]); }))
        .mockResolvedValue([]);
      const { service, log } = createService({ indexer: { getAll, test: vi.fn() } });

      // Update only becomes visible AFTER the manual run's checkForUpdate resolves.
      let fetched = false;
      vi.mocked(checkForUpdate).mockImplementation(async () => { fetched = true; });
      vi.mocked(getUpdateStatus).mockImplementation(() =>
        fetched
          ? { latestVersion: '2.0.0', releaseUrl: 'https://example.com/r2', channel: 'stable' }
          : undefined,
      );

      // Scheduled pass #1 is now parked on the gated getAll (running === true).
      const scheduled = service.runAllChecks();

      // Manual run: awaits the live fetch (stamps 2.0.0), then coalesces into the
      // active pass. It must resolve with the trailing rerun's post-fetch report.
      const manual = service.runManualChecks(log as unknown as FastifyBaseLogger);

      // Let the manual fetch resolve and its coalesced runAllChecks register
      // before the scheduled pass drains.
      await new Promise((r) => setTimeout(r, 0));
      releaseScheduledPass();

      const [, manualResults] = await Promise.all([scheduled, manual]);

      // The report the manual caller receives reflects the post-fetch cache — the
      // pre-fetch (undefined) cachedResults would have omitted this row entirely.
      expect(manualResults.find((r) => r.checkName === 'version-update')).toMatchObject({
        checkName: 'version-update',
        state: 'warning',
        message: 'Update available: v2.0.0',
      });
      // Exactly one trailing rerun: pass #1 + one rerun = 2 full passes (getAll
      // called once per pass) — the overlap coalesced, it did not spawn a loop.
      expect(getAll).toHaveBeenCalledTimes(2);
    });
  });

  // #2090 — notification dispatch waits for a network-backed check's new state to
  // hold three consecutive passes. Detection, the health card and every API
  // response stay instant; only the notifier is debounced. Local checks keep
  // firing on pass 1.
  //
  // Most assertions below are "zero notifications were sent", which is exactly the
  // shape that passes against broken production code, so each names the mutation
  // that must turn it red (see the `vacuous-assertion-observation-points` learning).
  describe('#2090 — notification confirmation window', () => {
    const FAILED = { success: false, message: 'down' };
    const OK = { success: true };
    const oneIndexer = [{ id: 1, name: 'NZB', enabled: true }];

    beforeEach(() => {
      // version-update is a local check: a cached update leaked from an earlier
      // block would add an unrelated pass-1 notification to these totals.
      vi.mocked(getUpdateStatus).mockReturnValue(undefined);
      vi.mocked(checkForUpdate).mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.mocked(getUpdateStatus).mockReset();
      vi.mocked(checkForUpdate).mockReset();
    });

    describe('window suppression (AC 3, 8, 9)', () => {
      it('sends nothing when a network-backed check fails a single pass', async () => {
        const { service, notifier } = createService({
          indexer: { getAll: vi.fn().mockResolvedValue(oneIndexer), test: vi.fn().mockResolvedValue(FAILED) },
        });

        await service.runAllChecks();

        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(0);
      });

      it('sends nothing at all for a blip that self-heals inside the window — no orphaned resolve', async () => {
        // The issue's live specimen: a ~7s upstream failure straddling two ticks.
        const { service, notifier } = createService({
          indexer: {
            getAll: vi.fn().mockResolvedValue(oneIndexer),
            test: vi.fn().mockResolvedValueOnce(FAILED).mockResolvedValueOnce(FAILED).mockResolvedValue(OK),
          },
        });

        await service.runAllChecks();
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(0);
        await service.runAllChecks();
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(0);
        await service.runAllChecks();

        // Neither the failure nor the recovery is announced: the failure was never
        // confirmed, so there is no announced episode for a resolve to close.
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(0);
      });

      it('fires exactly one error notification, on the third failing pass and not the fourth', async () => {
        const { service, notifier } = createService({
          indexer: { getAll: vi.fn().mockResolvedValue(oneIndexer), test: vi.fn().mockResolvedValue(FAILED) },
        });

        await runPasses(service, 2);
        // Observation point 1: still silent after two confirming passes.
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(0);

        await service.runAllChecks();
        // Observation point 2: the third pass is the one that dispatches.
        expect(healthNotifications(notifier, 'indexer:NZB')).toEqual([
          { checkName: 'indexer:NZB', previousState: 'healthy', currentState: 'error', message: 'down' },
        ]);
      });

      it('does not re-fire while the confirmed error is sustained', async () => {
        const { service, notifier } = createService({
          indexer: { getAll: vi.fn().mockResolvedValue(oneIndexer), test: vi.fn().mockResolvedValue(FAILED) },
        });

        await runPasses(service, 5);

        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(1);
      });
    });

    describe('symmetric resolve (AC 10)', () => {
      it('announces the resolve on the third healthy pass, not the first', async () => {
        const { service, notifier } = createService({
          indexer: {
            getAll: vi.fn().mockResolvedValue(oneIndexer),
            test: vi.fn()
              .mockResolvedValueOnce(FAILED).mockResolvedValueOnce(FAILED).mockResolvedValueOnce(FAILED)
              .mockResolvedValue(OK),
          },
        });

        await runPasses(service, 5); // error x3 (notified) + healthy x2
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(1);

        await service.runAllChecks(); // third healthy pass
        const calls = healthNotifications(notifier, 'indexer:NZB');
        expect(calls).toHaveLength(2);
        expect(calls[1]).toMatchObject({ previousState: 'error', currentState: 'healthy' });
      });

      it('sends nothing further when a dependency flaps after an announced episode', async () => {
        const { service, notifier } = createService({
          indexer: {
            getAll: vi.fn().mockResolvedValue(oneIndexer),
            test: vi.fn()
              .mockResolvedValueOnce(FAILED).mockResolvedValueOnce(FAILED).mockResolvedValueOnce(FAILED)
              .mockResolvedValueOnce(OK).mockResolvedValueOnce(FAILED)
              .mockResolvedValueOnce(OK).mockResolvedValueOnce(FAILED),
          },
        });

        await runPasses(service, 7);

        // At most one pair per sustained episode — never one per flap.
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(1);
      });
    });

    describe('tri-state confirmation (AC 4)', () => {
      it('restarts the run when the observed state changes value, not just healthy/unhealthy', async () => {
        const { service, notifier } = createService({
          indexer: {
            getAll: vi.fn().mockResolvedValue(oneIndexer),
            test: vi.fn()
              .mockResolvedValueOnce(FAILED).mockResolvedValueOnce(FAILED)
              .mockResolvedValue({ success: true, warning: 'degraded' }),
          },
        });

        await runPasses(service, 4); // error, error, warning, warning
        // A healthy/unhealthy boolean would have confirmed `error` on pass 3.
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(0);

        await service.runAllChecks(); // third consecutive warning
        expect(healthNotifications(notifier, 'indexer:NZB')).toEqual([
          { checkName: 'indexer:NZB', previousState: 'healthy', currentState: 'warning', message: 'degraded' },
        ]);
      });
    });

    describe('per-check classification (AC 2, 11)', () => {
      it('debounces hardcover', async () => {
        vi.spyOn(HardcoverClient.prototype, 'searchSeries').mockRejectedValue(new Error('hardcover down'));
        const { service, notifier } = createService({
          settings: createMockSettingsService({ metadata: { hardcoverApiKey: 'valid-key' } }),
        });

        await service.runAllChecks();
        expect(healthNotifications(notifier, 'hardcover')).toHaveLength(0);

        await runPasses(service, 2);
        expect(healthNotifications(notifier, 'hardcover')).toHaveLength(1);
      });

      it('debounces download clients', async () => {
        const { service, notifier } = createService({
          downloadClient: {
            getAll: vi.fn().mockResolvedValue([{ id: 1, name: 'qbit', enabled: true }]),
            test: vi.fn().mockResolvedValue(FAILED),
          },
        });

        await service.runAllChecks();
        expect(healthNotifications(notifier, 'download-client:qbit')).toHaveLength(0);

        await runPasses(service, 2);
        expect(healthNotifications(notifier, 'download-client:qbit')).toHaveLength(1);
      });

      it('notifies library-root on the first pass (local, immediate)', async () => {
        const { service, notifier } = createService({
          fsAccess: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' })),
        });

        await service.runAllChecks();

        expect(healthNotifications(notifier, 'library-root')).toHaveLength(1);
      });

      it('notifies disk-space on the first pass (local, immediate)', async () => {
        const twoGB = 2 * 1024 * 1024 * 1024;
        const { service, notifier } = createService({
          fsStatfs: vi.fn().mockResolvedValue({ bavail: twoGB / 4096, bsize: 4096 }),
        });

        await service.runAllChecks();

        expect(healthNotifications(notifier, 'disk-space')).toMatchObject([{ currentState: 'warning' }]);
      });

      it('dispatches only the local check when a local and a network check fail in the same pass', async () => {
        const { service, notifier } = createService({
          indexer: { getAll: vi.fn().mockResolvedValue(oneIndexer), test: vi.fn().mockResolvedValue(FAILED) },
          fsAccess: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' })),
        });

        await service.runAllChecks();

        expect(healthNotifications(notifier).map((h) => h.checkName)).toEqual(['library-root']);
      });
    });

    // AC 2.1-2.5 — `checkName` classifies, the tracking key identifies. Connector
    // names are neither unique nor immutable, so every scenario below is one the
    // pre-#2090 `checkName`-keyed map gets wrong.
    describe('tracking identity (AC 2.1-2.5)', () => {
      const twoSameNamedIndexers = [
        { id: 1, name: 'NZB', enabled: true },
        { id: 2, name: 'NZB', enabled: true },
      ];

      it('tracks two same-named indexers as two independent entities', async () => {
        const { service, notifier } = createService({
          indexer: { getAll: vi.fn().mockResolvedValue(twoSameNamedIndexers), test: vi.fn().mockResolvedValue(FAILED) },
        });

        await runPasses(service, 2);
        // Mutation: key by `checkName` and both results land on one entry, which
        // reaches 3 during pass 2 and notifies a whole pass early.
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(0);

        await service.runAllChecks();
        // One confirmation apiece — a single pass contributes at most one
        // observation to any one tracking key (AC 2.2).
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(2);
      });

      it('does not let two same-named indexers in divergent states reset each other', async () => {
        const { service, notifier } = createService({
          indexer: {
            getAll: vi.fn().mockResolvedValue(twoSameNamedIndexers),
            test: vi.fn().mockImplementation((id: number) => Promise.resolve(id === 1 ? FAILED : OK)),
          },
        });

        await runPasses(service, 3);

        // Mutation: key by `checkName` and the error/healthy pair restarts the run
        // every pass — zero notifications ever fire.
        expect(healthNotifications(notifier, 'indexer:NZB')).toEqual([
          { checkName: 'indexer:NZB', previousState: 'healthy', currentState: 'error', message: 'down' },
        ]);
      });

      it('tracks two same-named download clients as two independent entities', async () => {
        const { service, notifier } = createService({
          downloadClient: {
            getAll: vi.fn().mockResolvedValue([
              { id: 1, name: 'qbit', enabled: true },
              { id: 2, name: 'qbit', enabled: true },
            ]),
            test: vi.fn().mockResolvedValue(FAILED),
          },
        });

        await runPasses(service, 2);
        // Mutation: drop the `download-client` arm from the tracking key and this
        // falls back to `checkName`, confirming a pass early — the indexer tests
        // above cannot observe that arm.
        expect(healthNotifications(notifier, 'download-client:qbit')).toHaveLength(0);

        await service.runAllChecks();
        expect(healthNotifications(notifier, 'download-client:qbit')).toHaveLength(2);
      });

      it('preserves a pending run across a rename and reports the confirming pass name', async () => {
        const { service, notifier } = createService({
          indexer: {
            getAll: vi.fn()
              .mockResolvedValueOnce([{ id: 1, name: 'A', enabled: true }])
              .mockResolvedValueOnce([{ id: 1, name: 'A', enabled: true }])
              .mockResolvedValue([{ id: 1, name: 'B', enabled: true }]),
            test: vi.fn().mockResolvedValue(FAILED),
          },
        });

        await runPasses(service, 2);
        expect(healthNotifications(notifier)).toHaveLength(0);

        await service.runAllChecks();
        // Mutation: key by `checkName` and the rename restarts the run — nothing
        // fires on pass 3.
        expect(healthNotifications(notifier)).toEqual([
          { checkName: 'indexer:B', previousState: 'healthy', currentState: 'error', message: 'down' },
        ]);
      });

      it('does not emit a second error after a rename mid-episode', async () => {
        const { service, notifier } = createService({
          indexer: {
            getAll: vi.fn()
              .mockResolvedValueOnce([{ id: 1, name: 'A', enabled: true }])
              .mockResolvedValueOnce([{ id: 1, name: 'A', enabled: true }])
              .mockResolvedValueOnce([{ id: 1, name: 'A', enabled: true }])
              .mockResolvedValue([{ id: 1, name: 'B', enabled: true }]),
            test: vi.fn().mockResolvedValue(FAILED),
          },
        });

        await runPasses(service, 6);

        expect(healthNotifications(notifier)).toEqual([
          { checkName: 'indexer:A', previousState: 'healthy', currentState: 'error', message: 'down' },
        ]);
      });

      it('does not let a recreated connector inherit a deleted one\'s notified episode', async () => {
        const deleted = [{ id: 1, name: 'A', enabled: true }];
        const { service, notifier } = createService({
          indexer: {
            getAll: vi.fn()
              .mockResolvedValueOnce(deleted).mockResolvedValueOnce(deleted).mockResolvedValueOnce(deleted)
              .mockResolvedValue([{ id: 2, name: 'A', enabled: true }]),
            test: vi.fn().mockImplementation((id: number) => Promise.resolve(id === 1 ? FAILED : OK)),
          },
        });

        await runPasses(service, 3);
        expect(healthNotifications(notifier)).toHaveLength(1);

        await runPasses(service, 3);
        // AC 2.4: AUTOINCREMENT never reissues an id, so id 2 starts from a fresh
        // default-healthy entry. Mutation: key by `checkName` and the reused name
        // inherits id 1's notified `error`, emitting a spurious resolve on pass 6.
        expect(healthNotifications(notifier)).toHaveLength(1);
      });

      it('keeps library-root and disk-space independent despite their shared route target', async () => {
        // Both carry `{ kind: 'route', path: '/settings' }` — the client's cardKey
        // arm. Driving them to the SAME state in the same pass is what makes the
        // bad key observable: with distinct states a merged entry still produces
        // two transitions (healthy->error, error->warning) and looks correct.
        const { service, notifier } = createService({
          fsAccess: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' })),
          fsStatfs: vi.fn().mockResolvedValue({ bavail: 0, bsize: 4096 }), // freeBytes === 0 -> error
        });

        await service.runAllChecks();

        expect(healthNotifications(notifier, 'library-root')).toMatchObject([{ currentState: 'error' }]);
        expect(healthNotifications(notifier, 'disk-space')).toMatchObject([{ currentState: 'error' }]);
      });
    });

    describe('absent checks freeze the run (AC 16)', () => {
      it('preserves rather than resets a pending run while the check is absent', async () => {
        const settingsState = { hardcoverApiKey: 'valid-key' };
        const backing = createMockSettingsService({ metadata: { hardcoverApiKey: 'valid-key' } });
        const settings = inject<SettingsService>({
          ...backing,
          get: vi.fn().mockImplementation(async (category: string) => {
            const value = await backing.get(category as 'metadata');
            return category === 'metadata'
              ? { ...(value as object), hardcoverApiKey: settingsState.hardcoverApiKey }
              : value;
          }),
        });
        vi.spyOn(HardcoverClient.prototype, 'searchSeries').mockRejectedValue(new Error('hardcover down'));
        const { service, notifier } = createService({ settings });

        await runPasses(service, 2); // two failing observations

        settingsState.hardcoverApiKey = ''; // key removed -> checkHardcover returns []
        await runPasses(service, 2);
        expect(healthNotifications(notifier, 'hardcover')).toHaveLength(0);

        settingsState.hardcoverApiKey = 'valid-key';
        await service.runAllChecks();
        // The third *appearing* error observation confirms. Asserting only "zero
        // during the absent passes" is satisfied by an incorrect reset-on-absence
        // too; this is the assertion that separates freeze from reset. Mutation:
        // delete the pending entry on absence and the notification slips to pass 7.
        expect(healthNotifications(notifier, 'hardcover')).toHaveLength(1);
      });
    });

    describe('payload provenance (AC 7)', () => {
      it('carries the confirming pass\'s message, not an earlier observation\'s', async () => {
        const { service, notifier } = createService({
          indexer: {
            getAll: vi.fn().mockResolvedValue(oneIndexer),
            test: vi.fn()
              .mockResolvedValueOnce({ success: false, message: 'down 1' })
              .mockResolvedValueOnce({ success: false, message: 'down 2' })
              .mockResolvedValue({ success: false, message: 'down 3' }),
          },
        });

        await runPasses(service, 3);

        // Mutation: retain and emit the first observation's message and this reads
        // 'down 1' — a stale diagnostic that satisfies every state assertion above.
        expect(healthNotifications(notifier, 'indexer:NZB')).toEqual([
          { checkName: 'indexer:NZB', previousState: 'healthy', currentState: 'error', message: 'down 3' },
        ]);
      });
    });

    describe('_reset() clears both maps (AC 17)', () => {
      it('starts a fresh run and a fresh notified state after a reset', async () => {
        const { service, notifier } = createService({
          indexer: { getAll: vi.fn().mockResolvedValue(oneIndexer), test: vi.fn().mockResolvedValue(FAILED) },
        });

        await runPasses(service, 3);
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(1);

        service._reset();
        (notifier.notify as ReturnType<typeof vi.fn>).mockClear();

        await runPasses(service, 2);
        // A stale pending map would notify here on the first post-reset pass.
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(0);

        await service.runAllChecks();
        // A stale notified map would suppress this entirely (still `error`) — and
        // `previousState: 'healthy'` is what proves it was cleared, not merely
        // flipped. Both maps are observed through public behavior only.
        expect(healthNotifications(notifier, 'indexer:NZB')).toEqual([
          { checkName: 'indexer:NZB', previousState: 'healthy', currentState: 'error', message: 'down' },
        ]);
      });
    });

    // AC 15 — the unit of accounting is one `runChecksOnce` execution, not a
    // wall-clock interval and not only the scheduled cron. Every pass is a real
    // live probe, so three failing passes is three real observations of failure.
    describe('pass accounting (AC 15)', () => {
      it('counts manual "Run Now" passes, so three back-to-back runs confirm', async () => {
        const { service, notifier, log } = createService({
          indexer: { getAll: vi.fn().mockResolvedValue(oneIndexer), test: vi.fn().mockResolvedValue(FAILED) },
        });

        // No timers advance between these three calls: the counter is driven by
        // passes, not elapsed time.
        await service.runManualChecks(log as unknown as FastifyBaseLogger);
        await service.runManualChecks(log as unknown as FastifyBaseLogger);
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(0);

        await service.runManualChecks(log as unknown as FastifyBaseLogger);
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(1);
      });

      it('counts the coalesced trailing rerun as a pass', async () => {
        let releaseFirstPass!: () => void;
        const getAll = vi.fn()
          .mockReturnValueOnce(new Promise<unknown[]>((r) => { releaseFirstPass = () => r(oneIndexer); }))
          .mockResolvedValue(oneIndexer);
        const { service, notifier } = createService({
          indexer: { getAll, test: vi.fn().mockResolvedValue(FAILED) },
        });

        const first = service.runAllChecks();
        const nudge = service.runAllChecks(); // coalesces -> guarantees a trailing rerun
        releaseFirstPass();
        await Promise.all([first, nudge]);

        expect(getAll).toHaveBeenCalledTimes(2); // two real passes ran
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(0);

        await service.runAllChecks();
        // If the trailing rerun had not counted, this third call would be
        // observation 2 and nothing would fire.
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(1);
      });
    });

    describe('untouched surfaces (AC 13, 14)', () => {
      it('reports the raw current state immediately even while dispatch is debounced', async () => {
        const { service, notifier } = createService({
          indexer: { getAll: vi.fn().mockResolvedValue(oneIndexer), test: vi.fn().mockResolvedValue(FAILED) },
        });

        const results = await service.runAllChecks();

        expect(results.find((r) => r.checkName === 'indexer:NZB')).toMatchObject({ state: 'error' });
        expect(service.getCachedResults().find((r) => r.checkName === 'indexer:NZB')).toMatchObject({ state: 'error' });
        expect(service.getAggregateState()).toBe('error');
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(0);
      });

      it('returns the live report from runManualChecks on the first failing pass', async () => {
        const { service, notifier, log } = createService({
          indexer: { getAll: vi.fn().mockResolvedValue(oneIndexer), test: vi.fn().mockResolvedValue(FAILED) },
        });

        const results = await service.runManualChecks(log as unknown as FastifyBaseLogger);

        expect(results.find((r) => r.checkName === 'indexer:NZB')).toMatchObject({ state: 'error', message: 'down' });
        expect(healthNotifications(notifier, 'indexer:NZB')).toHaveLength(0);
      });
    });
  });
});
