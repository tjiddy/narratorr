import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { routeRegistry } from './index.js';
import type { FastifyInstance } from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { Services } from './index.js';

// Constructors are bare mocks; services with required cyclic wiring expose wire spies.
vi.mock('../services', () => ({
  SettingsService: vi.fn(),
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
  ConnectorService: vi.fn(),
  BlacklistService: vi.fn(),
  ImportListExclusionService: vi.fn(),
  RemotePathMappingService: vi.fn(),
  RenameService: vi.fn(),

  EventHistoryService: vi.fn().mockImplementation(function(this: Record<string, unknown>) { this.wire = vi.fn(); }),
  TaggingService: vi.fn(),
  QualityGateService: vi.fn(),
  RetryBudget: vi.fn(),
  SearchLadderCooldown: vi.fn(),
  DiscoveryService: vi.fn(),
  SeriesCardService: vi.fn(),
  ReferenceReadService: vi.fn(),
  CompanionEbookReconciler: vi.fn(),
}));
vi.mock('../services/import.service.js', () => ({ ImportService: vi.fn() }));
vi.mock('../services/merge.service.js', () => ({ MergeService: vi.fn() }));
vi.mock('../services/import-orchestrator.js', () => ({
  ImportOrchestrator: vi.fn().mockImplementation(function(this: Record<string, unknown>) { this.wire = vi.fn(); }),
}));
vi.mock('../services/download-orchestrator.js', () => ({ DownloadOrchestrator: vi.fn() }));
vi.mock('../services/quality-gate-orchestrator.js', () => ({
  QualityGateOrchestrator: vi.fn().mockImplementation(function(this: Record<string, unknown>) { this.wire = vi.fn(); }),
}));
vi.mock('../services/import-list.service.js', () => ({ ImportListService: vi.fn() }));
vi.mock('../services/import-list-add-ledger-backfill.js', () => ({
  backfillImportListAddLedger: vi.fn().mockResolvedValue(undefined),
}));
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
vi.mock('../services/bulk-operation.service.js', () => ({ BulkOperationService: vi.fn() }));
vi.mock('../services/book-rejection.service.js', () => ({ BookRejectionService: vi.fn() }));
vi.mock('../services/import-adapters/registry.js', () => ({
  registerImportAdapter: vi.fn(),
  getImportAdapter: vi.fn(),
  clearImportAdapters: vi.fn(),
}));
vi.mock('../services/import-adapters/manual.js', () => ({ ManualImportAdapter: vi.fn() }));
vi.mock('../services/import-adapters/auto.js', () => ({ AutoImportAdapter: vi.fn() }));
vi.mock('./retry-import.js', () => ({ retryImportRoute: vi.fn() }));
// Route mocks expose each registry closure's dependency bag; generic registry tests only prove order (#1961).
vi.mock('./v1/capabilities.js', () => ({ v1CapabilitiesRoutes: vi.fn() }));
vi.mock('./companion-ebook.js', () => ({ companionEbookRoutes: vi.fn() }));
vi.mock('./v1/companion-ebook.js', () => ({ v1CompanionEbookRoutes: vi.fn() }));
vi.mock('./v1/metadata.js', () => ({ v1MetadataRoutes: vi.fn() }));
vi.mock('./settings.js', () => ({ settingsRoutes: vi.fn() }));
vi.mock('./library-scan.js', () => ({ libraryScanRoutes: vi.fn() }));
vi.mock('./books.js', () => ({ booksRoutes: vi.fn() }));
vi.mock('../config.js', () => ({ config: { configPath: '/tmp/config', dbPath: '/tmp/db.sqlite' } }));
vi.mock('@core/utils/audio-processor.js', () => ({ detectFfmpegPath: vi.fn(), probeFfmpeg: vi.fn() }));
vi.mock('@core/indexers/proxy.js', () => ({ resolveProxyIp: vi.fn() }));

describe('routeRegistry', () => {
  it('contains all 41 route factories', () => {
    expect(routeRegistry).toHaveLength(41);
  });

  it('every entry is a function', () => {
    for (const factory of routeRegistry) {
      expect(typeof factory).toBe('function');
    }
  });

  // Memoized identities expose closure-built deps; unmocked factories may throw after target mocks record their calls.
  async function driveCompositionRoot(): Promise<{ app: FastifyInstance; services: Services; db: Db }> {
    const stubs = new Map<string, object>();
    const services = new Proxy({}, {
      get(_t, prop: string) {
        if (!stubs.has(prop)) stubs.set(prop, { __service: prop });
        return stubs.get(prop);
      },
    }) as unknown as Services;
    const app = {} as FastifyInstance;
    const db = {} as Db;

    for (const factory of routeRegistry) {
      try {
        await factory(app, services, db);
      } catch {
        // Unmocked factories require a real Fastify instance.
      }
    }
    return { app, services, db };
  }

  function svc(services: Services, name: string): object {
    return (services as unknown as Record<string, object>)[name]!;
  }

  // Keep deps extensible, but pin db exactly because observation reads depend on it (#1974).
  it('composes companionEbookRoutes exactly once, with { bookService, settingsService, reconciler } and the db', async () => {
    const { companionEbookRoutes } = await import('./companion-ebook.js');
    (companionEbookRoutes as unknown as Mock).mockClear();

    const { app, services, db } = await driveCompositionRoot();

    expect(companionEbookRoutes as unknown as Mock).toHaveBeenCalledTimes(1);
    expect(companionEbookRoutes as unknown as Mock).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        bookService: svc(services, 'book'),
        settingsService: svc(services, 'settings'),
        reconciler: svc(services, 'companionEbook'),
      }),
      db,
    );
  });

  // Exact deps reject misrouting or leaked maxConcurrentStreams; db is pinned for observation reads (#1975).
  it('composes v1CompanionEbookRoutes exactly once, with { bookService, settingsService, reconciler } and the db', async () => {
    const { v1CompanionEbookRoutes } = await import('./v1/companion-ebook.js');
    (v1CompanionEbookRoutes as unknown as Mock).mockClear();

    const { app, services, db } = await driveCompositionRoot();

    expect(v1CompanionEbookRoutes as unknown as Mock).toHaveBeenCalledTimes(1);
    expect(v1CompanionEbookRoutes as unknown as Mock).toHaveBeenCalledWith(app, {
      bookService: svc(services, 'book'),
      settingsService: svc(services, 'settings'),
      reconciler: svc(services, 'companionEbook'),
    }, db);
  });

  it('composes settingsRoutes with the live reconciler as its 5th argument', async () => {
    const { settingsRoutes } = await import('./settings.js');
    (settingsRoutes as unknown as Mock).mockClear();

    const { app, services } = await driveCompositionRoot();

    expect(settingsRoutes as unknown as Mock).toHaveBeenCalledTimes(1);
    // Pin the positional tail because dropping or reordering the reconciler still compiles.
    expect(settingsRoutes as unknown as Mock).toHaveBeenCalledWith(
      app, svc(services, 'settings'), svc(services, 'indexer'), svc(services, 'healthCheck'), svc(services, 'companionEbook'),
    );
  });

  it('composes libraryScanRoutes with the live reconciler as its 6th argument', async () => {
    const { libraryScanRoutes } = await import('./library-scan.js');
    (libraryScanRoutes as unknown as Mock).mockClear();

    const { app, services } = await driveCompositionRoot();

    expect(libraryScanRoutes as unknown as Mock).toHaveBeenCalledTimes(1);
    expect(libraryScanRoutes as unknown as Mock).toHaveBeenCalledWith(
      app, svc(services, 'libraryScan'), svc(services, 'matchJob'), svc(services, 'book'),
      svc(services, 'metadata'), svc(services, 'companionEbook'),
    );
  });

  it('composes booksRoutes with the live reconciler on its deps object', async () => {
    const { booksRoutes } = await import('./books.js');
    (booksRoutes as unknown as Mock).mockClear();

    const { app, services } = await driveCompositionRoot();

    expect(booksRoutes as unknown as Mock).toHaveBeenCalledTimes(1);
    // Identity matters: routes must use the reconciler the container owns and shutdown drains.
    expect(booksRoutes as unknown as Mock).toHaveBeenCalledWith(
      app, expect.objectContaining({ companionEbook: svc(services, 'companionEbook') }),
    );
  });

  it('composes v1CapabilitiesRoutes exactly once, with { settingsService: services.settings }', async () => {
    const { v1CapabilitiesRoutes } = await import('./v1/capabilities.js');
    (v1CapabilitiesRoutes as unknown as Mock).mockClear();

    const { app, services } = await driveCompositionRoot();

    expect(v1CapabilitiesRoutes as unknown as Mock).toHaveBeenCalledTimes(1);
    expect(v1CapabilitiesRoutes as unknown as Mock).toHaveBeenCalledWith(app, {
      settingsService: svc(services, 'settings'),
    });
  });

  it('composes v1MetadataRoutes exactly once, with { metadataService, bookService, settingsService } from services', async () => {
    const { v1MetadataRoutes } = await import('./v1/metadata.js');
    (v1MetadataRoutes as unknown as Mock).mockClear();

    const { app, services } = await driveCompositionRoot();

    expect(v1MetadataRoutes as unknown as Mock).toHaveBeenCalledTimes(1);
    expect(v1MetadataRoutes as unknown as Mock).toHaveBeenCalledWith(app, {
      metadataService: svc(services, 'metadata'),
      bookService: svc(services, 'book'),
      settingsService: svc(services, 'settings'),
    });
  });
});

describe('registerRoutes', () => {
  it('calls every factory in sequence with app, services, and db', async () => {
    const callOrder: number[] = [];
    const spies = Array.from({ length: routeRegistry.length }, (_, i) =>
      vi.fn().mockImplementation(() => { callOrder.push(i); return Promise.resolve(); }),
    );

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

      for (const spy of spies) {
        expect(spy).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledWith(app, services, db);
      }

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
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    const orchestratorCalls = vi.mocked(DownloadOrchestrator).mock.calls;
    expect(orchestratorCalls).toHaveLength(1);
    const blacklistArg = orchestratorCalls[0]![6];
    expect(blacklistArg).toBeInstanceOf(BlacklistService);
  });

  it('invokes migrateLanguageSettings on startup', async () => {
    const { SettingsService } = await import('../services/index.js');

    const mockMigrate = vi.fn().mockResolvedValue(undefined);

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = mockMigrate;
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
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

  it('invokes migrateRejectWordsDefault on startup', async () => {
    const { SettingsService } = await import('../services/index.js');

    const mockMigrate = vi.fn().mockResolvedValue(undefined);

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = mockMigrate;
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
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
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
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

  it('invokes migrateMaxConcurrentProcessingDefaults on startup, after rejectWords migrations', async () => {
    const { SettingsService } = await import('../services/index.js');

    const callOrder: string[] = [];
    const v2Migrate = vi.fn().mockImplementation(() => { callOrder.push('v2'); return Promise.resolve(); });
    const maxConcurrentMigrate = vi.fn().mockImplementation(() => { callOrder.push('maxConcurrent'); return Promise.resolve(); });

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = v2Migrate;
      this.migrateMaxConcurrentProcessingDefaults = maxConcurrentMigrate;
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    expect(maxConcurrentMigrate).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(['v2', 'maxConcurrent']);
  });

  // #2595 AC9: BackupService reads the app migration count through the connection it is handed, so
  // handing it anything other than the composition root's long-lived Db silently reintroduces the
  // second live connection to the database file. Both halves matter and neither is type-checkable:
  // a different same-typed Db compiles, and so does a reordering of the two adjacent string args.
  it('passes the composition root Db itself to BackupService, after configPath/dbPath/settings/log', async () => {
    const { SettingsService } = await import('../services/index.js');
    const { BackupService } = await import('../services/backup.service.js');

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    const services = await createServices(db, log);

    const calls = vi.mocked(BackupService).mock.calls;
    expect(calls).toHaveLength(1);
    // Values pin the positional order (config is mocked at the top of this file); identity pins the
    // connection, which is the half a same-typed replacement would otherwise pass.
    expect(calls[0]).toEqual(['/tmp/config', '/tmp/db.sqlite', services.settings, log, db]);
    expect(calls[0]![4]).toBe(db);
  });


  // AC24 of #2530: the backfill must land before `startJobs` arms the import-list cron, and
  // `createServices` is the only place that ordering can be asserted structurally — `index.ts`
  // awaits it (`src/server/index.ts:131`) before `startRuntime` (`:169`).
  it('awaits the add-ledger backfill during construction, after the settings migrations', async () => {
    const { SettingsService, ImportListExclusionService } = await import('../services/index.js');
    const { backfillImportListAddLedger } = await import('../services/import-list-add-ledger-backfill.js');

    const callOrder: string[] = [];
    const maxConcurrentMigrate = vi.fn().mockImplementation(() => { callOrder.push('maxConcurrent'); return Promise.resolve(); });
    vi.mocked(backfillImportListAddLedger).mockImplementation(() => { callOrder.push('backfill'); return Promise.resolve(); });

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateMaxConcurrentProcessingDefaults = maxConcurrentMigrate;
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    const services = await createServices(db, log);

    expect(callOrder).toEqual(['maxConcurrent', 'backfill']);
    expect(backfillImportListAddLedger).toHaveBeenCalledOnce();
    expect(backfillImportListAddLedger).toHaveBeenCalledWith(db, services.importListExclusion, log);
    expect(vi.mocked(ImportListExclusionService).mock.instances).toHaveLength(1);
  });

  // Required cyclic dependencies use wire(deps) after construction (#739).
  it('calls wire() once on each required-wiring service with the correct cyclic deps', async () => {
    const { SettingsService, BlacklistService, DownloadService, EventHistoryService } = await import('../services/index.js');
    const { ImportOrchestrator } = await import('../services/import-orchestrator.js');
    const { QualityGateOrchestrator } = await import('../services/quality-gate-orchestrator.js');
    const { createRetrySearchDeps } = await import('../services/retry-search.js');

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
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

    // LibraryScanService lost its wire seam with direct-confirm removal (#1902); QGO remains wired.
    const qgoInstance = vi.mocked(QualityGateOrchestrator).mock.instances[0] as unknown as { wire: ReturnType<typeof vi.fn> };
    expect(qgoInstance.wire).toHaveBeenCalledOnce();
    expect(typeof qgoInstance.wire.mock.calls[0]![0].nudgeImportWorker).toBe('function');
  });

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
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    const libraryScanCalls = vi.mocked(LibraryScanService).mock.calls;
    expect(libraryScanCalls).toHaveLength(1);
    const broadcasterArg = libraryScanCalls[0]![7];
    expect(broadcasterArg).toBeInstanceOf(EventBroadcasterService);
  });

  // The fourth worker argument enables stranded-marker recovery from the configured library root (#1338).
  it('injects a library-root resolver into ImportQueueWorker that reads settings.get("library").path', async () => {
    const { SettingsService } = await import('../services/index.js');
    const { ImportQueueWorker } = await import('../services/import-queue-worker.js');

    const settingsGet = vi.fn().mockResolvedValue({ audibleRegion: 'us', path: '/library/root' });

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = settingsGet;
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    const workerCalls = vi.mocked(ImportQueueWorker).mock.calls;
    expect(workerCalls).toHaveLength(1);
    const getLibraryRoot = workerCalls[0]![3];
    expect(typeof getLibraryRoot).toBe('function');

    settingsGet.mockClear();
    const resolved = await (getLibraryRoot as () => Promise<string | null | undefined>)();
    expect(resolved).toBe('/library/root');
    expect(settingsGet).toHaveBeenCalledWith('library');
  });

  // The fifth worker argument records durable import_failed history for forced-import refusals (#1736).
  it('injects the EventHistoryService instance into ImportQueueWorker as its 5th constructor arg', async () => {
    const { SettingsService, EventHistoryService } = await import('../services/index.js');
    const { ImportQueueWorker } = await import('../services/import-queue-worker.js');

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us', path: '/library/root' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    const workerCalls = vi.mocked(ImportQueueWorker).mock.calls;
    expect(workerCalls).toHaveLength(1);
    const eventHistoryArg = workerCalls[0]![4];
    const eventHistoryInstances = vi.mocked(EventHistoryService).mock.instances;
    expect(eventHistoryInstances).toHaveLength(1);
    expect(eventHistoryArg).toBe(eventHistoryInstances[0]);
  });

  // Auto-merge is optional at this boundary, so only composition coverage catches a dropped MergeService (#1836).
  it('injects the composed MergeService instance into ImportOrchestrator as its 10th constructor arg', async () => {
    const { SettingsService } = await import('../services/index.js');
    const { MergeService } = await import('../services/merge.service.js');
    const { ImportOrchestrator } = await import('../services/import-orchestrator.js');

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    const orchestratorCalls = vi.mocked(ImportOrchestrator).mock.calls;
    expect(orchestratorCalls).toHaveLength(1);
    const mergeServiceArg = orchestratorCalls[0]![9];
    const mergeInstances = vi.mocked(MergeService).mock.instances;
    expect(mergeInstances).toHaveLength(1);
    expect(mergeServiceArg).toBe(mergeInstances[0]);
  });

  // The optional trailing TaggingService keeps post-merge re-tagging live; omission still compiles (#2078).
  it('injects the composed TaggingService instance into MergeService as its 8th constructor arg (#2078)', async () => {
    const { SettingsService, TaggingService } = await import('../services/index.js');
    const { MergeService } = await import('../services/merge.service.js');

    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    await createServices(db, log);

    const mergeCalls = vi.mocked(MergeService).mock.calls;
    expect(mergeCalls).toHaveLength(1);
    const taggingArg = mergeCalls[0]![7];
    const taggingInstances = vi.mocked(TaggingService).mock.instances;
    expect(taggingInstances).toHaveLength(1);
    expect(taggingArg).toBe(taggingInstances[0]);
  });

  // Pin both callbacks to their composed instances; no-op or reversed callbacks still compile (F29).
  it('wires the finalize nudge to the composed runner and the accepted-item nudge to the composed worker (F29)', async () => {
    const { SettingsService } = await import('../services/index.js');
    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    const services = await createServices(db, log);

    // The constructor mock has no methods, so add nudge to the captured worker instance.
    const workerNudge = vi.fn();
    (services.importQueueWorker as unknown as { nudge: () => void }).nudge = workerNudge;
    const runnerNudge = vi.spyOn(services.importSubmissionRunner, 'nudge').mockImplementation(() => {});

    (services.importStaging as unknown as { nudgeRunner: () => void }).nudgeRunner();
    (services.importSubmissionRunner as unknown as { nudgeImportWorker: () => void }).nudgeImportWorker();

    expect(runnerNudge).toHaveBeenCalledTimes(1);
    expect(workerNudge).toHaveBeenCalledTimes(1);
  });

  // The reconciler must share db/settings/log with the container, and shutdown must drain that returned instance (#1959).
  it('constructs CompanionEbookReconciler once with the composed db/settings/log and returns that instance', async () => {
    const { SettingsService, CompanionEbookReconciler } = await import('../services/index.js');
    vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
      this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us', path: '/library/root' });
      this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
    } as never);

    const { createServices } = await import('./index.js');
    const db = {} as unknown as Db;
    const log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
    } as unknown as FastifyBaseLogger;

    const services = await createServices(db, log);

    const reconcilerCalls = vi.mocked(CompanionEbookReconciler).mock.calls;
    expect(reconcilerCalls).toHaveLength(1);
    const settingsInstances = vi.mocked(SettingsService).mock.instances;
    expect(settingsInstances).toHaveLength(1);
    expect(reconcilerCalls[0]).toEqual([db, settingsInstances[0], log]);

    const reconcilerInstances = vi.mocked(CompanionEbookReconciler).mock.instances;
    expect(reconcilerInstances).toHaveLength(1);
    expect(services.companionEbook).toBe(reconcilerInstances[0]);
  });

  // These trailing optional dependencies can vanish without type errors, so each seam pins the composed reconciler (#1960).
  describe('#1960 — the live reconciler reaches every optional-dependency seam', () => {
    async function composeServices() {
      const { SettingsService } = await import('../services/index.js');
      vi.mocked(SettingsService).mockImplementation(function(this: Record<string, unknown>) {
        this.get = vi.fn().mockResolvedValue({ audibleRegion: 'us', path: '/library/root' });
        this.bootstrapProcessingDefaults = vi.fn().mockResolvedValue(undefined);
        this.migrateLanguageSettings = vi.fn().mockResolvedValue(undefined);
        this.migrateRejectWordsDefault = vi.fn().mockResolvedValue(undefined);
        this.migrateRejectWordsAbridgedDefault = vi.fn().mockResolvedValue(undefined);
        this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
      } as never);

      const { createServices } = await import('./index.js');
      const db = {} as unknown as Db;
      const log = {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        child: vi.fn().mockReturnThis(), trace: vi.fn(), fatal: vi.fn(),
      } as unknown as FastifyBaseLogger;
      const services = await createServices(db, log);
      return { services };
    }

    it('F6: ImportQueueWorker receives the composed reconciler as its 6th constructor arg', async () => {
      const { ImportQueueWorker } = await import('../services/import-queue-worker.js');

      const { services } = await composeServices();

      const calls = vi.mocked(ImportQueueWorker).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]![5]).toBe(services.companionEbook);
    });

    it('F7: BulkOperationService receives the composed reconciler as its 8th constructor arg', async () => {
      const { BulkOperationService } = await import('../services/bulk-operation.service.js');

      const { services } = await composeServices();

      const calls = vi.mocked(BulkOperationService).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]![7]).toBe(services.companionEbook);
    });

    it('F8: BookRejectionService receives the composed reconciler as its 8th constructor arg', async () => {
      const { BookRejectionService } = await import('../services/book-rejection.service.js');

      const { services } = await composeServices();

      const calls = vi.mocked(BookRejectionService).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]![7]).toBe(services.companionEbook);
    });
  });
});
