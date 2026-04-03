import { type FastifyInstance } from 'fastify';
import { type Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import {
  SettingsService,
  AuthService,
  IndexerService,
  DownloadClientService,
  BookService,
  BookListService,
  DownloadService,
  MetadataService,
  NotifierService,
  BlacklistService,
  RemotePathMappingService,
  RenameService,
  EventHistoryService,
  TaggingService,
  QualityGateService,
  RetryBudget,
  DiscoveryService,
} from '../services';
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

import { booksRoutes, bookFilesRoute } from './books.js';
import { bookPreviewRoute } from './book-preview.js';
import { searchRoutes } from './search.js';
import { activityRoutes } from './activity.js';
import { indexersRoutes } from './indexers.js';
import { downloadClientsRoutes } from './download-clients.js';
import { settingsRoutes } from './settings.js';
import { systemRoutes } from './system.js';
import { metadataRoutes } from './metadata.js';
import { libraryScanRoutes } from './library-scan.js';
import { notifiersRoutes } from './notifiers.js';
import { blacklistRoutes } from './blacklist.js';
import { authRoutes } from './auth.js';
import { filesystemRoutes } from './filesystem.js';
import { remotePathMappingRoutes } from './remote-path-mappings.js';
import { eventHistoryRoutes } from './event-history.js';
import { prowlarrCompatRoutes } from './prowlarr-compat.js';
import { eventsRoutes } from './events.js';
import { searchStreamRoutes } from './search-stream.js';
import { SearchSessionManager } from '../services/search-session.js';
import { importListsRoutes } from './import-lists.js';
import { updateRoutes } from './update.js';
import { discoverRoutes } from './discover.js';
import { bulkOperationsRoutes } from './bulk-operations.js';
import { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { BookRejectionService } from '../services/book-rejection.service.js';
import { createRetrySearchDeps } from '../services/retry-search.js';

export interface Services {
  settings: SettingsService;
  auth: AuthService;
  indexer: IndexerService;
  downloadClient: DownloadClientService;
  book: BookService;
  bookList: BookListService;
  download: DownloadService;
  downloadOrchestrator: DownloadOrchestrator;
  metadata: MetadataService;
  import: ImportService;
  importOrchestrator: ImportOrchestrator;
  libraryScan: LibraryScanService;
  matchJob: MatchJobService;
  notifier: NotifierService;
  blacklist: BlacklistService;
  remotePathMapping: RemotePathMappingService;
  rename: RenameService;
  merge: MergeService;
  eventHistory: EventHistoryService;
  tagging: TaggingService;
  qualityGate: QualityGateService;
  qualityGateOrchestrator: QualityGateOrchestrator;
  retryBudget: RetryBudget;
  eventBroadcaster: EventBroadcasterService;
  backup: BackupService;
  healthCheck: HealthCheckService;
  taskRegistry: TaskRegistry;
  importList: ImportListService;
  discovery: DiscoveryService;
  bulkOperation: BulkOperationService;
  bookRejection: BookRejectionService;
}

/**
 * Runtime list of all service keys, kept in sync with the Services interface.
 * The `satisfies` clause ensures TS errors if a key is added to Services but
 * not listed here — `Record<keyof Services, true>` requires every key present.
 */
export const SERVICE_KEYS = Object.keys({
  settings: true,
  auth: true,
  indexer: true,
  downloadClient: true,
  book: true,
  bookList: true,
  download: true,
  downloadOrchestrator: true,
  metadata: true,
  import: true,
  importOrchestrator: true,
  libraryScan: true,
  matchJob: true,
  notifier: true,
  blacklist: true,
  remotePathMapping: true,
  rename: true,
  merge: true,
  eventHistory: true,
  tagging: true,
  qualityGate: true,
  qualityGateOrchestrator: true,
  retryBudget: true,
  eventBroadcaster: true,
  backup: true,
  healthCheck: true,
  taskRegistry: true,
  importList: true,
  discovery: true,
  bulkOperation: true,
  bookRejection: true,
} satisfies Record<keyof Services, true>) as (keyof Services)[];

export async function createServices(db: Db, log: FastifyBaseLogger): Promise<Services> {
  const settings = new SettingsService(db, log);
  const auth = new AuthService(db, log);
  const indexer = new IndexerService(db, log, settings);
  const downloadClient = new DownloadClientService(db, log);

  // Load metadata settings for Audible region
  const metadataSettings = await settings.get('metadata');
  const metadata = new MetadataService(log, {
    audibleRegion: metadataSettings?.audibleRegion,
  });

  const notifier = new NotifierService(db, log);
  const blacklistService = new BlacklistService(db, log, settings);

  // EventBroadcaster and EventHistoryService created early so they can be injected into lifecycle services
  const eventBroadcaster = new EventBroadcasterService(log);
  const book = new BookService(db, log, metadata);
  const bookList = new BookListService(db);
  const eventHistory = new EventHistoryService(db, log, blacklistService, book);

  const download = new DownloadService(db, downloadClient, log);
  const downloadOrchestrator = new DownloadOrchestrator(download, db, log, notifier, eventHistory, eventBroadcaster, blacklistService);
  const remotePathMapping = new RemotePathMappingService(db, log);
  const taggingService = new TaggingService(db, settings, log, book);
  const importService = new ImportService(db, downloadClient, settings, log, remotePathMapping, book);
  const importOrchestrator = new ImportOrchestrator(importService, settings, log, notifier, taggingService, eventHistory, eventBroadcaster);
  const libraryScan = new LibraryScanService(db, book, metadata, settings, log, eventHistory);
  const matchJob = new MatchJobService(metadata, log);

  const qualityGateService = new QualityGateService(db, log);
  const renameService = new RenameService(db, book, settings, log, eventHistory);
  const mergeService = new MergeService(db, book, settings, log, eventHistory, eventBroadcaster);
  const retryBudget = new RetryBudget();
  const backup = new BackupService(config.configPath, config.dbPath, settings, log);
  const importList = new ImportListService(db, log, metadata);
  const taskRegistry = new TaskRegistry();
  const discovery = new DiscoveryService(db, log, metadata, book, settings);
  const bulkOperation = new BulkOperationService(db, renameService, taggingService, settings, book, log);

  // Bootstrap processing defaults on first run (no-op if row exists)
  const { probeFfmpeg, detectFfmpegPath } = await import('../../core/utils/audio-processor.js');
  await settings.bootstrapProcessingDefaults(detectFfmpegPath);

  // Health check service with system deps
  const { resolveProxyIp } = await import('../../core/indexers/proxy.js');
  const healthCheck = new HealthCheckService(
    indexer, downloadClient, settings, notifier, db, log,
    { fsAccess: fsp.access, fsStatfs: fsp.statfs, probeFfmpeg, resolveProxyIp },
  );

  // Wire retry search dependencies into services that need them
  const retrySearchDeps = createRetrySearchDeps(
    { indexer, downloadOrchestrator, blacklist: blacklistService, book, settings, retryBudget },
    log,
  );
  download.setRetrySearchDeps(retrySearchDeps);
  eventHistory.setRetrySearchDeps(retrySearchDeps);

  const qualityGateOrchestrator = new QualityGateOrchestrator(qualityGateService, db, log, downloadClient, eventHistory, eventBroadcaster, blacklistService, remotePathMapping, retrySearchDeps, settings);
  const bookRejection = new BookRejectionService(db, log, book, blacklistService, settings, eventHistory, retrySearchDeps);

  return { settings, auth, indexer, downloadClient, book, bookList, download, downloadOrchestrator, metadata, import: importService, importOrchestrator, libraryScan, matchJob, notifier, blacklist: blacklistService, remotePathMapping, rename: renameService, merge: mergeService, eventHistory, tagging: taggingService, qualityGate: qualityGateService, qualityGateOrchestrator, retryBudget, eventBroadcaster, backup, healthCheck, taskRegistry, importList, discovery, bulkOperation, bookRejection };
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
    indexerService: s.indexer,
    bookRejectionService: s.bookRejection,
  }),
  (app, s) => bookFilesRoute(app, s.book),
  (app, s) => bookPreviewRoute(app, s.book),
  (app, s) => searchRoutes(app, s.indexer, s.downloadOrchestrator, s.blacklist, s.settings),
  (app, s) => activityRoutes(app, s.download, s.downloadOrchestrator, s.qualityGate, s.qualityGateOrchestrator, s.import, s.importOrchestrator),
  (app, s) => indexersRoutes(app, s.indexer),
  (app, s) => downloadClientsRoutes(app, s.downloadClient),
  (app, s) => settingsRoutes(app, s.settings, s.indexer, s.healthCheck),
  (app, s) => metadataRoutes(app, s.metadata),
  (app, s) => libraryScanRoutes(app, s.libraryScan, s.matchJob),
  (app, s, db) => systemRoutes(app, s, db),
  (app, s) => updateRoutes(app, s.settings),
  (app, s) => notifiersRoutes(app, s.notifier),
  (app, s) => blacklistRoutes(app, s.blacklist),
  (app, s) => authRoutes(app, s.auth),
  (app, s) => remotePathMappingRoutes(app, s.remotePathMapping),
  (app) => filesystemRoutes(app),
  (app, s) => eventHistoryRoutes(app, s.eventHistory),
  (app, s) => eventsRoutes(app, s.eventBroadcaster),
  (app, s) => searchStreamRoutes(app, s.indexer, s.blacklist, s.settings, new SearchSessionManager()),
  (app, s) => prowlarrCompatRoutes(app, s.indexer),
  (app, s) => importListsRoutes(app, s.importList),
  (app, s) => discoverRoutes(app, {
    discoveryService: s.discovery,
    settingsService: s.settings,
    taskRegistry: s.taskRegistry,
  }),
  (app, s) => bulkOperationsRoutes(app, s.bulkOperation),
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
