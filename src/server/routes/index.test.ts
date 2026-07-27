import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
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
  ConnectorService: vi.fn(),
  BlacklistService: vi.fn(),
  RemotePathMappingService: vi.fn(),
  RenameService: vi.fn(),

  EventHistoryService: vi.fn().mockImplementation(function(this: Record<string, unknown>) { this.wire = vi.fn(); }),
  TaggingService: vi.fn(),
  QualityGateService: vi.fn(),
  RetryBudget: vi.fn(),
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
// #1960 (F7/F8) — constructor-mocked so the composition root can assert that each service
// actually receives the live `CompanionEbookReconciler`. Both dependencies are OPTIONAL by
// design (AC8's shape), so dropping the argument compiles and leaves every service-level suite
// green while production silently stops reconciling; only a composition assertion catches that.
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
// #1961 F8/F2 — mocked so the composition-root tests can assert what each registry
// closure actually hands its route factory. The generic `registerRoutes` test below
// replaces every entry with an anonymous spy, so it proves invocation ORDER only;
// it cannot see a closure's deps object. Both v1 factories whose dependency bag
// this issue changed are pinned: `v1CapabilitiesRoutes` (new) and
// `v1MetadataRoutes` (gained `settingsService`).
vi.mock('./v1/capabilities.js', () => ({ v1CapabilitiesRoutes: vi.fn() }));
// #1974 — same technique for the new companion-ebook module: the length bump proves an entry
// exists, not what its closure hands the factory (including the `db` third argument, which
// carries the observation read).
vi.mock('./companion-ebook.js', () => ({ companionEbookRoutes: vi.fn() }));
// #1975 F7 — the public v1 stream. Same reason: the length bump cannot see that production
// wiring passes the right two services, the right `db`, and NO `maxConcurrentStreams`.
vi.mock('./v1/companion-ebook.js', () => ({ v1CompanionEbookRoutes: vi.fn() }));
vi.mock('./v1/metadata.js', () => ({ v1MetadataRoutes: vi.fn() }));
vi.mock('../config.js', () => ({ config: { configPath: '/tmp/config', dbPath: '/tmp/db.sqlite' } }));
vi.mock('../../core/utils/audio-processor.js', () => ({ detectFfmpegPath: vi.fn(), probeFfmpeg: vi.fn() }));
vi.mock('../../core/indexers/proxy.js', () => ({ resolveProxyIp: vi.fn() }));

describe('routeRegistry', () => {
  it('contains all 39 route factories', () => {
    // books, bookFiles, bookPreview, companionEbook, search, activity, importJobs, indexers, downloadClients,
    // settings, metadata, libraryScan, importSubmissions, system, notifiers, connectors, blacklist,
    // auth, remotePathMapping, filesystem, eventHistory, events, searchStream,
    // prowlarrCompat, importLists, discover, bulkOperations, retryImport, importPreview,
    // v1Books, v1Authors, v1Narrators, v1Series, v1Downloads, v1Actions, v1Metadata, v1System,
    // v1Capabilities, v1CompanionEbook
    expect(routeRegistry).toHaveLength(39);
  });

  it('every entry is a function', () => {
    for (const factory of routeRegistry) {
      expect(typeof factory).toBe('function');
    }
  });

  // #1961 F8/F2 — the length bump detects a MISSING entry; it does not establish
  // WHAT a closure passes. Invoke every entry against a memoizing service proxy
  // (other factories reach for a real Fastify instance and throw — that is fine
  // and expected) so each mocked route factory records the exact deps object its
  // production closure built.
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
        // Every other factory reaches for a real Fastify instance and throws.
      }
    }
    return { app, services, db };
  }

  /** Read a service stub off the proxy by identity, for deps-object comparison. */
  function svc(services: Services, name: string): object {
    return (services as unknown as Record<string, object>)[name]!;
  }

  // #1974 AC30 — the deps object is asserted with object-CONTAINING matching, not exact
  // equality, on purpose: #1976 adds its own service dependency to this same closure when it
  // lands the selection PUT, and that must extend this assertion rather than fail it. The
  // `db` third argument IS pinned exactly — the observation read depends on it.
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
        // #1976 AC35 / F20 — `objectContaining` PASSES on an omitted key, so without this
        // line production could stop passing the reconciler and every suite would stay green.
        // The route-module suite supplies its own fake, so it proves handler behaviour and
        // structurally cannot prove that production wires the real instance.
        reconciler: svc(services, 'companionEbook'),
      }),
      db,
    );
  });

  // #1975 AC3 / F7 — EXACT deps object, not `objectContaining`. A misrouted service fails
  // here, and so does a stray `maxConcurrentStreams` in production wiring: that property is a
  // test-only seam, and leaking it into the composition root would silently move the
  // concurrency bound off `MAX_CONCURRENT_COMPANION_STREAMS`. The `db` third argument is
  // pinned exactly — the observation read depends on it.
  it('composes v1CompanionEbookRoutes exactly once, with { bookService, settingsService, reconciler } and the db', async () => {
    const { v1CompanionEbookRoutes } = await import('./v1/companion-ebook.js');
    (v1CompanionEbookRoutes as unknown as Mock).mockClear();

    const { app, services, db } = await driveCompositionRoot();

    expect(v1CompanionEbookRoutes as unknown as Mock).toHaveBeenCalledTimes(1);
    expect(v1CompanionEbookRoutes as unknown as Mock).toHaveBeenCalledWith(app, {
      bookService: svc(services, 'book'),
      settingsService: svc(services, 'settings'),
      // #1960 AC30 — required, unlike the still-absent `maxConcurrentStreams` seam.
      reconciler: svc(services, 'companionEbook'),
    }, db);
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

  // #1961 F2 — this issue added `settingsService: s.settings` to the metadata
  // closure. `metadata.test.ts` injects its own correct settings mock, so it
  // cannot see a production wiring regression; without this assertion the
  // metadata search could reach the service with no companion setting (or the
  // wrong one) while every route-level test stayed green.
  it('composes v1MetadataRoutes exactly once, with { metadataService, bookService, settingsService } from services', async () => {
    const { v1MetadataRoutes } = await import('./v1/metadata.js');
    (v1MetadataRoutes as unknown as Mock).mockClear();

    const { app, services } = await driveCompositionRoot();

    expect(v1MetadataRoutes as unknown as Mock).toHaveBeenCalledTimes(1);
    // Exact deps object — an added, dropped, or misrouted service fails here.
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
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
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

  // ===== #1367 — migrateMaxConcurrentProcessingDefaults called on startup AFTER rejectWords migrations =====
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


  // #739 (originally #504) — required-wiring contract via wire(deps) instead of setter injection
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

    // LibraryScanService no longer has a wire() seam — its direct-confirm path was removed
    // (#1902), so the composition root no longer calls libraryScan.wire(...). The adjacent
    // QualityGateOrchestrator wiring below is unaffected and still asserted.
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
      this.migrateMaxConcurrentProcessingDefaults = vi.fn().mockResolvedValue(undefined);
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

  // #1338 — ImportQueueWorker receives a library-root resolver so the boot-time stranded-marker
  // sweep is actually enabled in the running app. Without this 4th constructor argument the sweep
  // is a no-op in production even though the direct worker tests still pass.
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

    // ImportQueueWorker constructor should receive the resolver as its 4th arg
    // (signature: db, log, broadcaster, getLibraryRoot)
    const workerCalls = vi.mocked(ImportQueueWorker).mock.calls;
    expect(workerCalls).toHaveLength(1);
    const getLibraryRoot = workerCalls[0]![3];
    expect(typeof getLibraryRoot).toBe('function');

    // The injected resolver must read the configured library path, not a constant.
    settingsGet.mockClear();
    const resolved = await (getLibraryRoot as () => Promise<string | null | undefined>)();
    expect(resolved).toBe('/library/root');
    expect(settingsGet).toHaveBeenCalledWith('library');
  });

  // #1736 (F2) — ImportQueueWorker receives the EventHistoryService as its 5th constructor argument
  // so the forced-import-refused terminal disposition can record its durable `import_failed` event in
  // production. Without this wiring the worker still finalizes the job + emits SSE but silently skips
  // the durable history row, and the direct worker tests (which inject eventHistory) would not catch it.
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

    // The worker's 5th arg must be the SAME EventHistoryService instance composed by createServices,
    // not a fresh/other object — a removed or swapped arg would drop the durable refusal event.
    const workerCalls = vi.mocked(ImportQueueWorker).mock.calls;
    expect(workerCalls).toHaveLength(1);
    const eventHistoryArg = workerCalls[0]![4];
    const eventHistoryInstances = vi.mocked(EventHistoryService).mock.instances;
    expect(eventHistoryInstances).toHaveLength(1);
    expect(eventHistoryArg).toBe(eventHistoryInstances[0]);
  });

  // #1836 (F1) — ImportOrchestrator receives the composed MergeService as its 10th constructor
  // argument so opt-in auto-merge is live in production. The service-level orchestrator tests
  // inject a mock mergeService, so removing this constructor arg would leave them green while
  // auto-merge silently becomes a no-op in the running app. This test guards the wiring: the
  // orchestrator's 10th arg must be the SAME MergeService instance createServices constructed.
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

    // ImportOrchestrator ctor signature: importService, settings, log, notifier, taggingService,
    // eventHistory, eventBroadcaster, connector, book, mergeService — mergeService is index 9.
    const orchestratorCalls = vi.mocked(ImportOrchestrator).mock.calls;
    expect(orchestratorCalls).toHaveLength(1);
    const mergeServiceArg = orchestratorCalls[0]![9];
    const mergeInstances = vi.mocked(MergeService).mock.instances;
    expect(mergeInstances).toHaveLength(1);
    expect(mergeServiceArg).toBe(mergeInstances[0]);
  });

  // F29: the composition root must wire the winning-finalize nudge to the SAME
  // ImportSubmissionRunner instance it returns, and the accepted-item nudge to the
  // SAME ImportQueueWorker instance — passing no-op/reversed callbacks would compile
  // and leave service-local tests green while delaying finalized/accepted processing.
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

    // ImportQueueWorker is a constructor mock (no methods) — give the SAME instance the
    // composition root captured a `nudge` spy so the runner's callback can invoke it.
    const workerNudge = vi.fn();
    (services.importQueueWorker as unknown as { nudge: () => void }).nudge = workerNudge;
    // ImportSubmissionRunner is a REAL instance — spy its nudge to observe the staging callback.
    const runnerNudge = vi.spyOn(services.importSubmissionRunner, 'nudge').mockImplementation(() => {});

    // Invoke the two callbacks the composition root injected into the real services.
    (services.importStaging as unknown as { nudgeRunner: () => void }).nudgeRunner();
    (services.importSubmissionRunner as unknown as { nudgeImportWorker: () => void }).nudgeImportWorker();

    // staging's nudgeRunner → the composed runner instance; runner's nudge → the composed worker.
    expect(runnerNudge).toHaveBeenCalledTimes(1);
    expect(workerNudge).toHaveBeenCalledTimes(1);
  });

  // #1959 (F4) — CompanionEbookReconciler is constructed once with the SAME db, the SAME
  // composed SettingsService, and the SAME logger createServices was handed, and the instance
  // it returns as `services.companionEbook` is that construction. Every one of those terms is
  // load-bearing at runtime and invisible to the service-level suite, which injects its own
  // doubles: a wrong `db` writes observations to another connection (and escapes the shared
  // write lane keyed on it), a wrong settings instance reads a different feature flag and
  // library root, and a wrong returned instance means `shutdown.ts` drains a reconciler that
  // owns none of the in-flight work.
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

    // ctor signature: (db, settings, log)
    const reconcilerCalls = vi.mocked(CompanionEbookReconciler).mock.calls;
    expect(reconcilerCalls).toHaveLength(1);
    const settingsInstances = vi.mocked(SettingsService).mock.instances;
    expect(settingsInstances).toHaveLength(1);
    expect(reconcilerCalls[0]).toEqual([db, settingsInstances[0], log]);

    // …and the container hands out that exact construction, not a second one.
    const reconcilerInstances = vi.mocked(CompanionEbookReconciler).mock.instances;
    expect(reconcilerInstances).toHaveLength(1);
    expect(services.companionEbook).toBe(reconcilerInstances[0]);
  });

  // ==========================================================================
  // #1960 F6/F7/F8 — the three OPTIONAL reconciler injections
  // ==========================================================================
  //
  // Each of these three services takes the reconciler as a trailing OPTIONAL constructor
  // argument (AC8's shape, so existing unit constructions keep compiling). That optionality is
  // exactly what makes the wiring fragile: delete the argument at the composition root and the
  // code still typechecks, every service-level suite still passes — they inject their own spies
  // — and production silently stops reconciling. The composition root is the only place that
  // can see it, so each seam gets a same-instance assertion here.
  describe('#1960 — the live reconciler reaches every optional-dependency seam', () => {
    /** Drive `createServices` with the standard SettingsService double this file uses. */
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
      // Same INSTANCE, not merely defined: a wrong reconciler reconciles nothing this process
      // owns, and `shutdown.ts` would drain a different one.
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
