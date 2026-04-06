import { describe, it, expect, vi } from 'vitest';
import { HealthCheckService } from './health-check.service.js';
import { inject, createMockLogger, createMockSettingsService } from '../__tests__/helpers.js';
import { DEFAULT_SETTINGS } from '../../shared/schemas/settings/registry.js';
import type { FastifyBaseLogger } from 'fastify';
import type { IndexerService } from './indexer.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { NotifierService } from './notifier.service.js';
import type { Db } from '../../db/index.js';

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
    processing: { ffmpegPath: '/usr/bin/ffmpeg', enabled: true },
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

    it('returns "Unknown error" fallback message when statfs rejects a non-Error value', async () => {
      const { service } = createService({
        fsStatfs: vi.fn().mockRejectedValue('string-rejection'),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'disk-space');
      expect(check).toMatchObject({ state: 'error', message: 'Failed to check disk space: Unknown error' });
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

    it('skips check and returns no result when ffmpeg path is empty/unset', async () => {
      const { service } = createService({
        settings: createMockSettingsService({ processing: { ffmpegPath: '' } }),
      });
      const results = await service.runAllChecks();
      const check = results.find((r) => r.checkName === 'ffmpeg');
      expect(check).toBeUndefined();
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

    it('returns "Unknown error" fallback message when download query rejects a non-Error value', async () => {
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
      expect(check).toMatchObject({ state: 'error', message: 'Failed to check downloads: Unknown error' });
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

    it('fires on_health_issue notification once per changed check', async () => {
      const { service, notifier } = createService({
        indexer: {
          getAll: vi.fn().mockResolvedValue([{ id: 1, name: 'NZB', enabled: true }]),
          test: vi.fn().mockResolvedValue({ success: false, message: 'down' }),
        },
      });

      // First run establishes state
      await service.runAllChecks();
      // The initial run from unknown → error should fire a notification
      expect(notifier.notify).toHaveBeenCalledWith('on_health_issue', expect.objectContaining({
        health: expect.objectContaining({
          checkName: 'indexer:NZB',
          currentState: 'error',
        }),
      }));
    });

    it('fires N notifications when N checks change in one run', async () => {
      const { service, notifier } = createService({
        indexer: {
          getAll: vi.fn().mockResolvedValue([
            { id: 1, name: 'NZB1', enabled: true },
            { id: 2, name: 'NZB2', enabled: true },
          ]),
          test: vi.fn().mockResolvedValue({ success: false, message: 'down' }),
        },
      });

      await service.runAllChecks();
      const healthCalls = (notifier.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'on_health_issue'
      );
      expect(healthCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not fire notification when check state is unchanged', async () => {
      const { service, notifier } = createService({
        indexer: {
          getAll: vi.fn().mockResolvedValue([{ id: 1, name: 'NZB', enabled: true }]),
          test: vi.fn().mockResolvedValue({ success: false, message: 'still down' }),
        },
      });

      await service.runAllChecks();
      (notifier.notify as ReturnType<typeof vi.fn>).mockClear();

      // Second run — same state, should not fire
      await service.runAllChecks();
      const healthCalls = (notifier.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'on_health_issue'
      );
      expect(healthCalls).toHaveLength(0);
    });

    it('notification fire-and-forget — notifier rejection does not throw or break health check', async () => {
      const { service } = createService({
        indexer: {
          getAll: vi.fn().mockResolvedValue([{ id: 1, name: 'NZB', enabled: true }]),
          test: vi.fn().mockResolvedValue({ success: false, message: 'down' }),
        },
        notifier: {
          notify: vi.fn().mockRejectedValue(new Error('notification failed')),
        },
      });

      // Should not throw
      const results = await service.runAllChecks();
      expect(results.length).toBeGreaterThan(0);
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
    it('returns cached results when check is already in progress (mutex)', async () => {
      let resolveCheck: () => void;
      const slowIndexer = {
        getAll: vi.fn().mockReturnValue(new Promise<unknown[]>((r) => { resolveCheck = () => r([]); })),
        test: vi.fn(),
      };
      const { service } = createService({ indexer: slowIndexer });

      const first = service.runAllChecks();
      const second = await service.runAllChecks(); // Should return cached immediately

      expect(second).toEqual([]); // Empty cached results (no previous run)

      resolveCheck!();
      await first;
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
});
