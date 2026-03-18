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
  ProwlarrSyncService,
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
import { ImportListService } from '../services/import-list.service.js';
import { LibraryScanService } from '../services/library-scan.service.js';
import { MatchJobService } from '../services/match-job.service.js';
import { BackupService } from '../services/backup.service.js';
import { HealthCheckService } from '../services/health-check.service.js';
import { TaskRegistry } from '../services/task-registry.js';
import { config } from '../config.js';
import fsp from 'fs/promises';

import { booksRoutes, bookFilesRoute } from './books.js';
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
import { prowlarrRoutes } from './prowlarr.js';
import { authRoutes } from './auth.js';
import { filesystemRoutes } from './filesystem.js';
import { remotePathMappingRoutes } from './remote-path-mappings.js';
import { eventHistoryRoutes } from './event-history.js';
import { prowlarrCompatRoutes } from './prowlarr-compat.js';
import { eventsRoutes } from './events.js';
import { recyclingBinRoutes } from './recycling-bin.js';
import { importListsRoutes } from './import-lists.js';
import { updateRoutes } from './update.js';
import { discoverRoutes } from './discover.js';
import { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { RecyclingBinService } from '../services/recycling-bin.service.js';
import { createRetrySearchDeps } from '../services/retry-search.js';

export interface Services {
  settings: SettingsService;
  auth: AuthService;
  indexer: IndexerService;
  downloadClient: DownloadClientService;
  book: BookService;
  bookList: BookListService;
  download: DownloadService;
  metadata: MetadataService;
  import: ImportService;
  importOrchestrator: ImportOrchestrator;
  libraryScan: LibraryScanService;
  matchJob: MatchJobService;
  notifier: NotifierService;
  blacklist: BlacklistService;
  prowlarrSync: ProwlarrSyncService;
  remotePathMapping: RemotePathMappingService;
  rename: RenameService;
  eventHistory: EventHistoryService;
  tagging: TaggingService;
  qualityGate: QualityGateService;
  retryBudget: RetryBudget;
  eventBroadcaster: EventBroadcasterService;
  backup: BackupService;
  healthCheck: HealthCheckService;
  taskRegistry: TaskRegistry;
  recyclingBin: RecyclingBinService;
  importList: ImportListService;
  discovery: DiscoveryService;
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
  metadata: true,
  import: true,
  importOrchestrator: true,
  libraryScan: true,
  matchJob: true,
  notifier: true,
  blacklist: true,
  prowlarrSync: true,
  remotePathMapping: true,
  rename: true,
  eventHistory: true,
  tagging: true,
  qualityGate: true,
  retryBudget: true,
  eventBroadcaster: true,
  backup: true,
  healthCheck: true,
  taskRegistry: true,
  recyclingBin: true,
  importList: true,
  discovery: true,
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

  const download = new DownloadService(db, downloadClient, log, notifier, eventHistory, eventBroadcaster);
  const remotePathMapping = new RemotePathMappingService(db, log);
  const taggingService = new TaggingService(db, settings, log);
  const importService = new ImportService(db, downloadClient, settings, log, remotePathMapping);
  const importOrchestrator = new ImportOrchestrator(importService, settings, log, notifier, taggingService, eventHistory, eventBroadcaster);
  const libraryScan = new LibraryScanService(db, book, metadata, settings, log);
  const matchJob = new MatchJobService(metadata, log);
  const prowlarrSync = new ProwlarrSyncService(db, log);

  const qualityGateService = new QualityGateService(db, downloadClient, eventHistory, blacklistService, log, remotePathMapping);
  const renameService = new RenameService(db, book, settings, log, eventHistory);
  const retryBudget = new RetryBudget();
  const backup = new BackupService(config.configPath, config.dbPath, settings, log);
  const recyclingBin = new RecyclingBinService(db, log, config.configPath, settings);
  const importList = new ImportListService(db, log, metadata);
  const taskRegistry = new TaskRegistry();
  const discovery = new DiscoveryService(db, log, metadata, book, settings);

  // Health check service with system deps
  const { probeFfmpeg } = await import('../../core/utils/audio-processor.js');
  const healthCheck = new HealthCheckService(
    indexer, downloadClient, settings, notifier, db, log,
    { fsAccess: fsp.access, fsStatfs: fsp.statfs, probeFfmpeg },
  );

  // Wire broadcaster into quality gate service
  qualityGateService.setBroadcaster(eventBroadcaster);

  // Wire retry search dependencies into services that need them
  const retrySearchDeps = createRetrySearchDeps(
    { indexer, download, blacklist: blacklistService, book, settings, retryBudget },
    log,
  );
  download.setRetrySearchDeps(retrySearchDeps);
  eventHistory.setRetrySearchDeps(retrySearchDeps);

  return { settings, auth, indexer, downloadClient, book, bookList, download, metadata, import: importService, importOrchestrator, libraryScan, matchJob, notifier, blacklist: blacklistService, prowlarrSync, remotePathMapping, rename: renameService, eventHistory, tagging: taggingService, qualityGate: qualityGateService, retryBudget, eventBroadcaster, backup, healthCheck, taskRegistry, recyclingBin, importList, discovery };
}

export async function registerRoutes(
  app: FastifyInstance,
  services: Services,
  db: Db,
): Promise<void> {
  await booksRoutes(app, {
    bookService: services.book,
    bookListService: services.bookList,
    downloadService: services.download,
    settingsService: services.settings,
    renameService: services.rename,
    taggingService: services.tagging,
    eventHistory: services.eventHistory,
    indexerService: services.indexer,
    recyclingBinService: services.recyclingBin,
  });
  await bookFilesRoute(app, services.book);
  await searchRoutes(app, services.indexer, services.download, services.blacklist, services.settings);
  await activityRoutes(app, services.download, services.qualityGate, services.import, services.importOrchestrator);
  await indexersRoutes(app, services.indexer);
  await downloadClientsRoutes(app, services.downloadClient);
  await settingsRoutes(app, services.settings, services.indexer);
  await metadataRoutes(app, services.metadata);
  await libraryScanRoutes(app, services.libraryScan, services.matchJob);
  await systemRoutes(app, services, db);
  await updateRoutes(app, services.settings);
  await notifiersRoutes(app, services.notifier);
  await blacklistRoutes(app, services.blacklist);
  await prowlarrRoutes(app, services.prowlarrSync);
  await authRoutes(app, services.auth);
  await remotePathMappingRoutes(app, services.remotePathMapping);
  await filesystemRoutes(app);
  await eventHistoryRoutes(app, services.eventHistory);
  await eventsRoutes(app, services.eventBroadcaster);
  await recyclingBinRoutes(app, services.recyclingBin);
  await prowlarrCompatRoutes(app, services.indexer);
  await importListsRoutes(app, services.importList);
  await discoverRoutes(app, {
    discoveryService: services.discovery,
    settingsService: services.settings,
    taskRegistry: services.taskRegistry,
  });
}
