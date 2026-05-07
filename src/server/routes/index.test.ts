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
// Required-wiring services expose a wire() spy so the composition root tests can assert
// the new wire(deps) contract instead of the legacy setter-injection shape.
vi.mock('../services', () => ({
  SettingsService: vi.fn(),  // configured per test
  AuthService: vi.fn(),
  IndexerService: vi.fn(),
  IndexerSearchService: vi.fn(),
  DownloadClientService: vi.fn(),
  BookService: vi.fn(),
  BookImportService: vi.fn(),
  BookListService: vi.fn(),

  DownloadService: vi.fn().mockImplementation(function(this: Record<string, unknown>) { this.wire = vi.fn(); }),
  MetadataService: vi.fn(),
  NotifierService: vi.fn(),
  BlacklistService: vi.fn(),
  RemotePathMappingService: vi.fn(),
  RenameService: vi.fn(),

  EventHistoryService: vi.fn().mockImplementation(function(this: Record<string, unknown>) { this.wire = vi.fn(); }),
  TaggingService: vi.fn(),
  QualityGateService: vi.fn(),
  RetryBudget: vi.fn(),
  DiscoveryService: vi.fn(),
}));
vi.mock('../services/import.service.js', () => ({ ImportService: vi.fn() }));
vi.mock('../services/import-orchestrator.js', () => ({
  ImportOrchestrator: vi.fn().mockImplementation(function(this: Record<string, unknown>) { this.wire = vi.fn(); }),
}));
vi.mock('../services/download-orchestrator.js', () => ({ DownloadOrchestrator: vi.fn() }));
vi.mock('../services/quality-gate-orchestrator.js', () => ({
  QualityGateOrchestrator: vi.fn().mockImplementation(function(this: Record<string, unknown>) { this.wire = vi.fn(); }),
}));
vi.mock('../services/import-list.service.js', () => ({ ImportListService: vi.fn() }));
vi.mock('../services/library-scan.service.js', () => ({
  LibraryScanService: vi.fn().mockImplementation(function(this: Record<string, unknown>) {
    this.wire = vi.fn();
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
vi.mock('../services/import-adapters/auto.js', () => ({ AutoImportAdapter: vi.fn() }));
vi.mock('./retry-import.js', () => ({ retryImportRoute: vi.fn() }));
vi.mock('../config.js', () => ({ config: { configPath: '/tmp/config', dbPath: '/tmp/db.sqlite' } }));
vi.mock('../../core/utils/audio-processor.js', () => ({ detectFfmpegPath: vi.fn(), probeFfmpeg: vi.fn() }));
vi.mock('../../core/indexers/proxy.js', () => ({ resolveProxyIp: vi.fn() }));

describe('routeRegistry', () => {
  it('contains all 27 route factories', () => {
    // books, bookFiles, bookPreview, search, activity, importJobs, indexers, downloadClients,
    // settings, metadata, libraryScan, system, update, notifiers, blacklist,
    // auth, remotePathMapping, filesystem, eventHistory, events, searchStream,
    // prowlarrCompat, importLists, discover, bulkOperations, retryImport, importPreview
    expect(routeRegistry).toHaveLength(27);
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
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
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
    const blacklistArg = orchestratorCalls[0]![6];
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
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
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

  // ===== #986 — migrateRejectWordsDefault called on startup =====
  it('invokes migrateRejectWordsDefault on startup', async () => {
    const { SettingsService } = await import('../services/index.js');

    const mockMigrate = vi.fn().mockResolvedValue(undefined);

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = mockMigrate;
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
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

  // ===== #993 — migrateRejectWordsAbridgedDefault called on startup AFTER v1 =====
  it('invokes migrateRejectWordsAbridgedDefault on startup, after v1', async () => {
    const { SettingsService } = await import('../services/index.js');

    const callOrder: string[] = [];
    const v1Migrate = vi.fn().mockImplementation(() => { callOrder.push('v1'); return Promise.resolve(); });
    const v2Migrate = vi.fn().mockImplementation(() => { callOrder.push('v2'); return Promise.resolve(); });

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = v1Migrate;
      this.migrateRejectWordsAbridgedDefault = v2Migrate;
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    expect(v1Migrate).toHaveBeenCalledOnce();
    expect(v2Migrate).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(['v1', 'v2']);
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
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
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

  // #739 (originally #504) — required-wiring contract via wire(deps) instead of setter injection
  it('calls wire() once on each required-wiring service with the correct cyclic deps', async () => {
    const { SettingsService, BlacklistService, DownloadService, EventHistoryService } = await import('../services/index.js');
    const { ImportOrchestrator } = await import('../services/import-orchestrator.js');
    const { LibraryScanService } = await import('../services/library-scan.service.js');
    const { QualityGateOrchestrator } = await import('../services/quality-gate-orchestrator.js');
    const { createRetrySearchDeps } = await import('../services/retry-search.js');

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    const retrySearchDepsResult = vi.mocked(createRetrySearchDeps).mock.results[0]!.value;

    const { IndexerService } = await import('../services/index.js');
    const downloadInstance = vi.mocked(DownloadService).mock.instances[0] as unknown as { wire: ReturnType<typeof vi.fn> };
    expect(downloadInstance.wire).toHaveBeenCalledOnce();
    const downloadWireArg = downloadInstance.wire.mock.calls[0]![0];
    expect(downloadWireArg.retrySearchDeps).toBe(retrySearchDepsResult);
    expect(downloadWireArg.indexerService).toBeInstanceOf(IndexerService);

    const eventHistoryInstance = vi.mocked(EventHistoryService).mock.instances[0] as unknown as { wire: ReturnType<typeof vi.fn> };
    expect(eventHistoryInstance.wire).toHaveBeenCalledOnce();
    expect(eventHistoryInstance.wire).toHaveBeenCalledWith({ retrySearchDeps: retrySearchDepsResult });

    const importOrchestratorInstance = vi.mocked(ImportOrchestrator).mock.instances[0] as unknown as { wire: ReturnType<typeof vi.fn> };
    expect(importOrchestratorInstance.wire).toHaveBeenCalledOnce();
    const importWireArg = importOrchestratorInstance.wire.mock.calls[0]![0];
    expect(importWireArg.bookImportService).toBeDefined();
    expect(importWireArg.blacklistService).toBeInstanceOf(BlacklistService);
    expect(importWireArg.retrySearchDeps).toBe(retrySearchDepsResult);
    expect(typeof importWireArg.nudgeImportWorker).toBe('function');

    const libraryScanInstance = vi.mocked(LibraryScanService).mock.instances[0] as unknown as { wire: ReturnType<typeof vi.fn> };
    expect(libraryScanInstance.wire).toHaveBeenCalledOnce();
    expect(typeof libraryScanInstance.wire.mock.calls[0]![0].nudgeImportWorker).toBe('function');

    const qgoInstance = vi.mocked(QualityGateOrchestrator).mock.instances[0] as unknown as { wire: ReturnType<typeof vi.fn> };
    expect(qgoInstance.wire).toHaveBeenCalledOnce();
    expect(typeof qgoInstance.wire.mock.calls[0]![0].nudgeImportWorker).toBe('function');
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
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    // LibraryScanService constructor should receive EventBroadcasterService as 8th arg
    // (signature: db, bookService, bookImportService, metadata, settings, log, eventHistory, broadcaster)
    const libraryScanCalls = vi.mocked(LibraryScanService).mock.calls;
    expect(libraryScanCalls).toHaveLength(1);
    const broadcasterArg = libraryScanCalls[0]![7];
    expect(broadcasterArg).toBeInstanceOf(EventBroadcasterService);
  });
});
