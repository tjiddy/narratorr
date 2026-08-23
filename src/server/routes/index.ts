import { type FastifyInstance } from 'fastify';
import { type Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import {
  SettingsService,
  AuthService,
  IndexerService,
  IndexerSearchService,
  DownloadClientService,
  BookService,
  BookImportService,
  BookListService,
  DownloadService,
  MetadataService,
  NotifierService,
  ConnectorService,
  BlacklistService,
  ImportListExclusionService,
  RemotePathMappingService,
  RenameService,
  EventHistoryService,
  TaggingService,
  QualityGateService,
  RetryBudget,
  SearchLadderCooldown,
  DiscoveryService,
  SeriesCardService,
  ReferenceReadService,
  CompanionEbookReconciler,
} from '../services';
import { backfillImportListAddLedger } from '../services/import-list-add-ledger-backfill.js';
import { ImportService } from '../services/import.service.js';
import { ImportOrchestrator } from '../services/import-orchestrator.js';
import { DownloadOrchestrator } from '../services/download-orchestrator.js';
import { QualityGateOrchestrator } from '../services/quality-gate-orchestrator.js';
import { ImportListService } from '../services/import-list.service.js';
import { LibraryScanService } from '../services/library-scan.service.js';
import { MergeService } from '../services/merge.service.js';
import { MatchJobService } from '../services/match-job.service.js';
import { BulkOperationService } from '../services/bulk-operation.service.js';
import { BackupService } from '../services/backup.service.js';
import { HealthCheckService } from '../services/health-check.service.js';
import { TaskRegistry } from '../services/task-registry.js';
import { config } from '../config.js';
import fsp from 'fs/promises';

import { booksRoutes } from './books.js';
import { bookFilesRoute } from './book-files.js';
import { bookPreviewRoute } from './book-preview.js';
import { companionEbookRoutes } from './companion-ebook.js';
import { searchRoutes } from './search.js';
import { activityRoutes } from './activity.js';
import { importJobsRoutes } from './import-jobs.js';
import { indexersRoutes } from './indexers.js';
import { downloadClientsRoutes } from './download-clients.js';
import { settingsRoutes } from './settings.js';
import { systemRoutes } from './system.js';
import { metadataRoutes } from './metadata.js';
import { libraryScanRoutes } from './library-scan.js';
import { notifiersRoutes } from './notifiers.js';
import { connectorsRoutes } from './connectors.js';
import { blacklistRoutes } from './blacklist.js';
import { importListExclusionsRoutes } from './import-list-exclusions.js';
import { authRoutes } from './auth.js';
import { filesystemRoutes } from './filesystem.js';
import { remotePathMappingRoutes } from './remote-path-mappings.js';
import { eventHistoryRoutes } from './event-history.js';
import { prowlarrCompatRoutes } from './prowlarr-compat.js';
import { eventsRoutes } from './events.js';
import { searchStreamRoutes } from './search-stream.js';
import { SearchSessionManager } from '../services/search-session.js';
import { importListsRoutes } from './import-lists.js';
import { discoverRoutes } from './discover.js';
import { bulkOperationsRoutes } from './bulk-operations.js';
import { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { BookRejectionService } from '../services/book-rejection.service.js';
import { BookDeletionService } from '../services/book-deletion.service.js';
import { createRetrySearchDeps } from '../services/retry-search.js';
import { ImportQueueWorker } from '../services/import-queue-worker.js';
import { ImportStagingService } from '../services/import-staging.service.js';
import { ImportSubmissionReportService } from '../services/import-submission-report.service.js';
import { ImportSubmissionRunner } from '../services/import-submission-runner.js';
import { importSubmissionsRoutes } from './import-submissions.js';
import { registerImportAdapter } from '../services/import-adapters/registry.js';
import { ManualImportAdapter } from '../services/import-adapters/manual.js';
import { AutoImportAdapter } from '../services/import-adapters/auto.js';
import { retryImportRoute } from './retry-import.js';
import { bookImportFilesRoute } from './book-import-files.js';
import { importPreviewRoute } from './import-preview.js';
import { v1BooksRoutes } from './v1/books.js';
import { v1AuthorsRoutes } from './v1/authors.js';
import { v1NarratorsRoutes } from './v1/narrators.js';
import { v1SeriesRoutes } from './v1/series.js';
import { v1DownloadsRoutes } from './v1/downloads.js';
import { v1ActionsRoutes } from './v1/actions.js';
import { v1MetadataRoutes } from './v1/metadata.js';
import { v1SystemRoutes } from './v1/system.js';
import { v1CapabilitiesRoutes } from './v1/capabilities.js';
import { v1CompanionEbookRoutes } from './v1/companion-ebook.js';

// DI types live below routes; re-export them here for existing route consumers.
import type { Services } from '../services/di.js';
export { type Services, SERVICE_KEYS } from '../services/di.js';

export async function createServices(db: Db, log: FastifyBaseLogger): Promise<Services> {
  const settings = new SettingsService(db, log);
  const auth = new AuthService(db, log);
  const indexer = new IndexerService(db, log, settings);
  const indexerSearch = new IndexerSearchService(db, log, indexer, settings);
  const downloadClient = new DownloadClientService(db, log);

  const metadataSettings = await settings.get('metadata');
  const metadata = new MetadataService(log, {
    audibleRegion: metadataSettings?.audibleRegion,
  }, settings);

  const notifier = new NotifierService(db, log);
  const connector = new ConnectorService(db, log);
  const blacklistService = new BlacklistService(db, log, settings);
  const importListExclusion = new ImportListExclusionService(db, log);

  const eventBroadcaster = new EventBroadcasterService(log);
  const book = new BookService(db, log, metadata);
  const bookImport = new BookImportService(db, log);
  const bookList = new BookListService(db);
  const referenceRead = new ReferenceReadService(db);
  // One reconciler is triggered from every seam that creates, moves, rescans, or reads a book.
  const companionEbook = new CompanionEbookReconciler(db, settings, log);
  const eventHistory = new EventHistoryService(db, log, blacklistService, book);

  const download = new DownloadService(db, downloadClient, log);
  const downloadOrchestrator = new DownloadOrchestrator(download, db, log, notifier, eventHistory, eventBroadcaster, blacklistService);
  const remotePathMapping = new RemotePathMappingService(db, log);
  const taggingService = new TaggingService(db, settings, log, book);
  const importService = new ImportService(db, downloadClient, settings, log, remotePathMapping, book);
  // Construct merge first so automatic and manual merges share its bounded queue.
  // Tag committed output from canonical DB state, not the source parts' tags.
  const mergeService = new MergeService(db, book, settings, log, eventHistory, eventBroadcaster, connector, taggingService);
  const importOrchestrator = new ImportOrchestrator(importService, settings, log, notifier, taggingService, eventHistory, eventBroadcaster, connector, book, mergeService);
  const seriesCard = new SeriesCardService(db, log, settings);
  const libraryScan = new LibraryScanService(db, book, bookImport, metadata, settings, log, eventHistory, eventBroadcaster, connector);
  const matchJob = new MatchJobService(metadata, log, settings, book);

  const qualityGateService = new QualityGateService(db, log);
  const renameService = new RenameService(db, book, settings, log, eventHistory, connector);
  const retryBudget = new RetryBudget();
  const searchLadderCooldown = new SearchLadderCooldown();
  const backup = new BackupService(config.configPath, config.dbPath, settings, log, db);
  const importList = new ImportListService(db, log, book, metadata, {
    indexerSearchService: indexerSearch,
    indexerService: indexer,
    downloadOrchestrator,
    settingsService: settings,
    blacklistService,
    eventHistory,
    eventBroadcaster,
  }, importListExclusion);
  const taskRegistry = new TaskRegistry();
  const discovery = new DiscoveryService(db, log, metadata, settings);
  const bulkOperation = new BulkOperationService(db, renameService, taggingService, settings, book, log, connector, companionEbook);

  await settings.migrateLanguageSettings();

  await settings.migrateRejectWordsDefault();

  await settings.migrateRejectWordsAbridgedDefault();

  // Run before any processing read; >8 otherwise triggers whole-category parse fallback.
  await settings.migrateMaxConcurrentProcessingDefaults();

  // Awaited here, with the settings migrations, rather than in `runStartupRecovery`: that is
  // fire-and-forget AFTER `startJobs` arms the cron, so a backfill there races the first sync.
  await backfillImportListAddLedger(db, importListExclusion, log);

  const { resolveProxyIp } = await import('@core/indexers/proxy.js');
  const { probeFfmpeg } = await import('@core/utils/audio-processor.js');
  const { probeMutagen } = await import('@core/utils/mutagen-resolver.js');
  const healthCheck = new HealthCheckService(
    indexer, downloadClient, settings, notifier, db, log,
    { fsAccess: fsp.access, fsStatfs: fsp.statfs, probeFfmpeg, probeMutagen, resolveProxyIp },
  );

  const retrySearchDeps = createRetrySearchDeps(
    { indexerSearch, indexer, downloadOrchestrator, blacklist: blacklistService, book, settings, retryBudget, eventHistory },
    log,
  );

  const importQueueWorker = new ImportQueueWorker(db, log, eventBroadcaster, async () => (await settings.get('library')).path, eventHistory, companionEbook);
  const nudgeImportWorker = (): void => importQueueWorker.nudge();
  const importSubmissionRunner = new ImportSubmissionRunner({ db, log, bookService: book, bookImportService: bookImport, eventHistory, notifier, nudgeImportWorker });
  const importStaging = new ImportStagingService(db, log, () => importSubmissionRunner.nudge());
  const importSubmissionReport = new ImportSubmissionReportService(db);
  const qualityGateOrchestrator = new QualityGateOrchestrator(qualityGateService, db, log, downloadClient, {
    eventHistory,
    broadcaster: eventBroadcaster,
    blacklistService,
    remotePathMappingService: remotePathMapping,
    retrySearchDeps,
    settingsService: settings,
  });
  const bookRejection = new BookRejectionService(db, log, book, blacklistService, settings, eventHistory, retrySearchDeps, companionEbook);
  const bookDeletion = new BookDeletionService(db, book, download, downloadOrchestrator, settings, log, eventHistory, importListExclusion);

  // Wire after every instance exists; WireOnce rejects use-before-wire and duplicate wiring.
  download.wire({ retrySearchDeps, indexerService: indexer });
  eventHistory.wire({ retrySearchDeps });
  importOrchestrator.wire({ bookImportService: bookImport, blacklistService, retrySearchDeps, nudgeImportWorker });
  qualityGateOrchestrator.wire({ nudgeImportWorker, bookImportService: bookImport });

  // Register adapters only after their services are fully wired.
  registerImportAdapter(new ManualImportAdapter(libraryScan.importDeps));
  registerImportAdapter(new AutoImportAdapter(importOrchestrator));

  return { settings, auth, indexer, indexerSearch, downloadClient, book, bookImport, bookList, download, downloadOrchestrator, metadata, import: importService, importOrchestrator, libraryScan, matchJob, notifier, connector, blacklist: blacklistService, importListExclusion, remotePathMapping, rename: renameService, merge: mergeService, eventHistory, tagging: taggingService, qualityGate: qualityGateService, qualityGateOrchestrator, retryBudget, searchLadderCooldown, eventBroadcaster, backup, healthCheck, taskRegistry, importList, discovery, bulkOperation, bookRejection, bookDeletion, importQueueWorker, importStaging, importSubmissionReport, importSubmissionRunner, retrySearchDeps, seriesCard, referenceRead, companionEbook };
}

type RouteFactory = (app: FastifyInstance, services: Services, db: Db) => Promise<void>;

/** Route registry — adding a new route requires one entry here. */
const routeRegistry: RouteFactory[] = [
  (app, s) => booksRoutes(app, {
    bookService: s.book,
    bookListService: s.bookList,
    downloadService: s.download,
    downloadOrchestrator: s.downloadOrchestrator,
    settingsService: s.settings,
    renameService: s.rename,
    mergeService: s.merge,
    taggingService: s.tagging,
    eventHistory: s.eventHistory,
    bookDeletionService: s.bookDeletion,
    indexerSearchService: s.indexerSearch,
    indexerService: s.indexer,
    bookRejectionService: s.bookRejection,
    blacklistService: s.blacklist,
    eventBroadcaster: s.eventBroadcaster,
    seriesCardService: s.seriesCard,
    metadataService: s.metadata,
    companionEbook: s.companionEbook,
    connectorService: s.connector,
    importListExclusionService: s.importListExclusion,
  }),
  (app, s) => bookFilesRoute(app, s.book, s.settings, s.connector),
  (app, s) => bookPreviewRoute(app, s.book),
  (app, s, db) => companionEbookRoutes(app, {
    bookService: s.book,
    settingsService: s.settings,
    reconciler: s.companionEbook,
  }, db),
  (app, s) => searchRoutes(app, s.downloadOrchestrator),
  (app, s) => activityRoutes(app, s.download, s.downloadOrchestrator, s.qualityGate, s.qualityGateOrchestrator, s.bookImport, () => s.importQueueWorker.nudge()),
  (app, s) => importJobsRoutes(app, s.bookImport),
  (app, s) => indexersRoutes(app, s.indexer),
  (app, s) => downloadClientsRoutes(app, s.downloadClient),
  (app, s) => settingsRoutes(app, s.settings, s.indexer, s.healthCheck, s.companionEbook),
  (app, s) => metadataRoutes(app, s.metadata),
  (app, s) => libraryScanRoutes(app, s.libraryScan, s.matchJob, s.book, s.metadata, s.companionEbook),
  (app, s) => importSubmissionsRoutes(app, s.importStaging, s.importSubmissionReport),
  (app, s, db) => systemRoutes(app, s, db),
  (app, s) => notifiersRoutes(app, s.notifier),
  (app, s) => connectorsRoutes(app, s.connector),
  (app, s) => blacklistRoutes(app, s.blacklist),
  (app, s) => importListExclusionsRoutes(app, s.importListExclusion),
  (app, s) => authRoutes(app, s.auth),
  (app, s) => remotePathMappingRoutes(app, s.remotePathMapping),
  (app) => filesystemRoutes(app),
  (app, s) => eventHistoryRoutes(app, s.eventHistory),
  (app, s) => eventsRoutes(app, s.eventBroadcaster, s.merge),
  (app, s) => searchStreamRoutes(app, s.indexerSearch, s.blacklist, s.settings, s.indexer, new SearchSessionManager()),
  (app, s) => prowlarrCompatRoutes(app, s.indexer),
  (app, s) => importListsRoutes(app, s.importList, s.taskRegistry),
  (app, s) => discoverRoutes(app, {
    discoveryService: s.discovery,
    settingsService: s.settings,
    taskRegistry: s.taskRegistry,
  }),
  (app, s) => bulkOperationsRoutes(app, s.bulkOperation),
  (app, s) => retryImportRoute(app, s.bookImport, () => s.importQueueWorker.nudge()),
  (app, s, db) => bookImportFilesRoute(app, {
    db,
    bookService: s.book,
    bookImportService: s.bookImport,
    settingsService: s.settings,
    nudgeImportWorker: () => s.importQueueWorker.nudge(),
  }),
  (app) => importPreviewRoute(app),
  (app, s, db) => v1BooksRoutes(app, {
    bookService: s.book,
    bookListService: s.bookList,
    metadataService: s.metadata,
    downloadOrchestrator: s.downloadOrchestrator,
    indexerSearchService: s.indexerSearch,
    indexerService: s.indexer,
    blacklistService: s.blacklist,
    settingsService: s.settings,
    eventHistory: s.eventHistory,
    eventBroadcaster: s.eventBroadcaster,
  }, db),
  (app, s, db) => v1AuthorsRoutes(app, { referenceReadService: s.referenceRead }, db),
  (app, s, db) => v1NarratorsRoutes(app, { referenceReadService: s.referenceRead }, db),
  (app, s, db) => v1SeriesRoutes(app, { referenceReadService: s.referenceRead }, db),
  (app, s, db) => v1DownloadsRoutes(app, { downloadService: s.download }, db),
  (app, s, db) => v1ActionsRoutes(app, {
    bookService: s.book,
    indexerSearchService: s.indexerSearch,
    downloadOrchestrator: s.downloadOrchestrator,
    downloadService: s.download,
    blacklistService: s.blacklist,
    settingsService: s.settings,
    indexerService: s.indexer,
  }, db),
  (app, s) => v1MetadataRoutes(app, {
    metadataService: s.metadata,
    bookService: s.book,
    settingsService: s.settings,
  }),
  (app) => v1SystemRoutes(app),
  (app, s) => v1CapabilitiesRoutes(app, { settingsService: s.settings }),
  // Production uses the fixed stream cap; maxConcurrentStreams remains a test-only seam.
  // Require the reconciler so read-path failures cannot silently lose self-heal.
  (app, s, db) => v1CompanionEbookRoutes(app, {
    bookService: s.book,
    settingsService: s.settings,
    reconciler: s.companionEbook,
  }, db),
];

export { routeRegistry };

export async function registerRoutes(
  app: FastifyInstance,
  services: Services,
  db: Db,
): Promise<void> {
  for (const factory of routeRegistry) {
    await factory(app, services, db);
  }
}
