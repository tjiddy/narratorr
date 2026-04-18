import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeRegistry } from './index.js';
import type { FastifyInstance } from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { Services } from './index.js';

// ---------------------------------------------------------------------------
// Module mocks for createServices tests
// ---------------------------------------------------------------------------

// All service constructors mocked as bare vi.fn() (returns empty object when called with new).
// DownloadService and EventHistoryService need setRetrySearchDeps; use regular-function constructors.
vi.mock('../services', () => ({
  SettingsService: vi.fn(),  // configured per test
  AuthService: vi.fn(),
  IndexerService: vi.fn(),
  DownloadClientService: vi.fn(),
  BookService: vi.fn(),
  BookListService: vi.fn(),

  DownloadService: vi.fn().mockImplementation(function(this: Record<string, unknown>) { this.setRetrySearchDeps = vi.fn(); }),
  MetadataService: vi.fn(),
  NotifierService: vi.fn(),
  BlacklistService: vi.fn(),
  RemotePathMappingService: vi.fn(),
  RenameService: vi.fn(),

  EventHistoryService: vi.fn().mockImplementation(function(this: Record<string, unknown>) { this.setRetrySearchDeps = vi.fn(); }),
  TaggingService: vi.fn(),
  QualityGateService: vi.fn(),
  RetryBudget: vi.fn(),
  DiscoveryService: vi.fn(),
}));
vi.mock('../services/import.service.js', () => ({ ImportService: vi.fn() }));
vi.mock('../services/import-orchestrator.js', () => ({
  ImportOrchestrator: vi.fn().mockImplementation(function(this: Record<string, unknown>) { this.setBlacklistDeps = vi.fn(); this.setQueueDeps = vi.fn(); }),
}));
vi.mock('../services/download-orchestrator.js', () => ({ DownloadOrchestrator: vi.fn() }));
vi.mock('../services/quality-gate-orchestrator.js', () => ({ QualityGateOrchestrator: vi.fn() }));
vi.mock('../services/import-list.service.js', () => ({ ImportListService: vi.fn() }));
vi.mock('../services/library-scan.service.js', () => ({
  LibraryScanService: vi.fn().mockImplementation(function(this: Record<string, unknown>) {
    this.setNudgeWorker = vi.fn();
    this.importDeps = {};
  }),
}));
vi.mock('../services/match-job.service.js', () => ({ MatchJobService: vi.fn() }));
vi.mock('../services/backup.service.js', () => ({ BackupService: vi.fn() }));
vi.mock('../services/health-check.service.js', () => ({ HealthCheckService: vi.fn() }));
vi.mock('../services/task-registry.js', () => ({ TaskRegistry: vi.fn() }));
vi.mock('../services/event-broadcaster.service.js', () => ({ EventBroadcasterService: vi.fn() }));
vi.mock('../services/retry-search.js', () => ({ createRetrySearchDeps: vi.fn().mockReturnValue({}) }));
vi.mock('../services/import-queue-worker.js', () => ({ ImportQueueWorker: vi.fn() }));
vi.mock('../services/import-adapters/registry.js', () => ({
  registerImportAdapter: vi.fn(),
  getImportAdapter: vi.fn(),
  clearImportAdapters: vi.fn(),
}));
vi.mock('../services/import-adapters/manual.js', () => ({ ManualImportAdapter: vi.fn() }));
vi.mock('./retry-import.js', () => ({ retryImportRoute: vi.fn() }));
vi.mock('../config.js', () => ({ config: { configPath: '/tmp/config', dbPath: '/tmp/db.sqlite' } }));
vi.mock('../../core/utils/audio-processor.js', () => ({ detectFfmpegPath: vi.fn(), probeFfmpeg: vi.fn() }));
vi.mock('../../core/indexers/proxy.js', () => ({ resolveProxyIp: vi.fn() }));

describe('routeRegistry', () => {
  it('contains all 26 route factories', () => {
    // books, bookFiles, bookPreview, search, activity, importJobs, indexers, downloadClients,
    // settings, metadata, libraryScan, system, update, notifiers, blacklist,
    // auth, remotePathMapping, filesystem, eventHistory, events, searchStream,
    // prowlarrCompat, importLists, discover, bulkOperations, retryImport
    expect(routeRegistry).toHaveLength(26);
  });

  it('every entry is a function', () => {
    for (const factory of routeRegistry) {
      expect(typeof factory).toBe('function');
    }
  });
});

describe('registerRoutes', () => {
  it('calls every factory in sequence with app, services, and db', async () => {
    const callOrder: number[] = [];
    const spies = Array.from({ length: routeRegistry.length }, (_, i) =>
      vi.fn().mockImplementation(() => { callOrder.push(i); return Promise.resolve(); }),
    );

    // Snapshot and replace
    const originals = [...routeRegistry];
    for (let i = 0; i < routeRegistry.length; i++) {
      (routeRegistry as unknown[])[i] = spies[i];
    }

    const { registerRoutes } = await import('./index.js');
    const app = { fake: 'app' } as unknown as FastifyInstance;
    const services = { fake: 'services' } as unknown as Services;
    const db = { fake: 'db' } as unknown as Db;

    try {
      await registerRoutes(app, services, db);

      // Every factory called exactly once with correct args
      for (const spy of spies) {
        expect(spy).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledWith(app, services, db);
      }

      // Sequential execution order preserved
      expect(callOrder).toEqual(Array.from({ length: routeRegistry.length }, (_, i) => i));
    } finally {
      for (let i = 0; i < originals.length; i++) {
        (routeRegistry as unknown[])[i] = originals[i];
      }
    }
  });

  it('propagates errors from factories without swallowing', async () => {
    const originals = [...routeRegistry];
    (routeRegistry as unknown[])[0] = vi.fn().mockRejectedValue(new Error('Route boom'));

    const { registerRoutes } = await import('./index.js');

    try {
      await expect(
        registerRoutes({} as FastifyInstance, {} as Services, {} as Db),
      ).rejects.toThrow('Route boom');
    } finally {
      for (let i = 0; i < originals.length; i++) {
        (routeRegistry as unknown[])[i] = originals[i];
      }
    }
  });
});

describe('createServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wires blacklistService into DownloadOrchestrator constructor', async () => {
    const { SettingsService, BlacklistService } = await import('../services/index.js');
    const { DownloadOrchestrator } = await import('../services/download-orchestrator.js');

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    // DownloadOrchestrator constructor should receive the BlacklistService instance as 7th arg
    const orchestratorCalls = vi.mocked(DownloadOrchestrator).mock.calls;
    expect(orchestratorCalls).toHaveLength(1);
    const blacklistArg = orchestratorCalls[0][6];
    expect(blacklistArg).toBeInstanceOf(BlacklistService);
  });

  // ===== #386 — migrateLanguageSettings called on startup =====
  it('invokes migrateLanguageSettings on startup', async () => {
    const { SettingsService } = await import('../services/index.js');

    const mockMigrate = vi.fn().mockResolvedValue(undefined);

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = mockMigrate;
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    expect(mockMigrate).toHaveBeenCalledOnce();
  });

  it('invokes bootstrapProcessingDefaults with detectFfmpegPath on startup', async () => {
    const { SettingsService } = await import('../services/index.js');
    const { detectFfmpegPath } = await import('../../core/utils/audio-processor.js');

    // Capture the bootstrap mock so we can assert on it
    const mockBootstrap = vi.fn().mockResolvedValue(undefined);
  
    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = mockBootstrap;
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    expect(mockBootstrap).toHaveBeenCalledOnce();
    expect(mockBootstrap).toHaveBeenCalledWith(detectFfmpegPath);
  });

  // #504 — setBlacklistDeps wiring
  it('wires importOrchestrator.setBlacklistDeps with blacklistService and retrySearchDeps', async () => {
    const { SettingsService, BlacklistService } = await import('../services/index.js');
    const { ImportOrchestrator } = await import('../services/import-orchestrator.js');
    const { createRetrySearchDeps } = await import('../services/retry-search.js');

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    const orchestratorInstances = vi.mocked(ImportOrchestrator).mock.instances;
    expect(orchestratorInstances).toHaveLength(1);
    const instance = orchestratorInstances[0] as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(instance.setBlacklistDeps).toHaveBeenCalledOnce();
    // Verify the actual arguments: BlacklistService instance + retrySearchDeps return value
    const [blacklistArg, retryDepsArg] = instance.setBlacklistDeps.mock.calls[0];
    expect(blacklistArg).toBeInstanceOf(BlacklistService);
    const retrySearchDepsResult = vi.mocked(createRetrySearchDeps).mock.results[0].value;
    expect(retryDepsArg).toBe(retrySearchDepsResult);
  });

  // #618 — EventBroadcasterService wired into LibraryScanService
  it('passes EventBroadcasterService into LibraryScanService constructor', async () => {
    const { SettingsService } = await import('../services/index.js');
    const { LibraryScanService } = await import('../services/library-scan.service.js');
    const { EventBroadcasterService } = await import('../services/event-broadcaster.service.js');

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    // LibraryScanService constructor should receive EventBroadcasterService as 7th arg
    const libraryScanCalls = vi.mocked(LibraryScanService).mock.calls;
    expect(libraryScanCalls).toHaveLength(1);
    const broadcasterArg = libraryScanCalls[0][6];
    expect(broadcasterArg).toBeInstanceOf(EventBroadcasterService);
  });
});
