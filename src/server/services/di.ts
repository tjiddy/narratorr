// Dependency-injection container shape for the server.
//
// The `Services` aggregate type and its companion `SERVICE_KEYS` list live here,
// alongside the services they describe, rather than in routes/. Routes are a
// higher layer than services; defining the DI container in routes/ forced lower
// layers (jobs/) to import "upward" from routes/ just to name the container.
// Re-homing the type here keeps the dependency direction correct
// (routes → services, jobs → services) and lets the layering eslint guard cover
// both services/ and jobs/. routes/index.ts re-exports `Services` so existing
// route consumers (health-routes.ts, system.ts) keep importing it from there.
import type {
  SettingsService,
  AuthService,
  IndexerService,
  IndexerSearchService,
  DownloadClientService,
  BookService,
  BookImportService,
  BookListService,
  DownloadService,
  DownloadOrchestrator,
  MetadataService,
  ImportService,
  ImportOrchestrator,
  LibraryScanService,
  MatchJobService,
  NotifierService,
  BlacklistService,
  RemotePathMappingService,
  RenameService,
  EventHistoryService,
  TaggingService,
  QualityGateService,
  RetryBudget,
  EventBroadcasterService,
  BackupService,
  HealthCheckService,
  TaskRegistry,
  ImportListService,
  DiscoveryService,
  BookRejectionService,
  BookDeletionService,
  SeriesCardService,
  ReferenceReadService,
  RetrySearchDeps,
} from './index.js';
import type { MergeService } from './merge.service.js';
import type { QualityGateOrchestrator } from './quality-gate-orchestrator.js';
import type { BulkOperationService } from './bulk-operation.service.js';
import type { ImportQueueWorker } from './import-queue-worker.js';

export interface Services {
  settings: SettingsService;
  auth: AuthService;
  indexer: IndexerService;
  indexerSearch: IndexerSearchService;
  downloadClient: DownloadClientService;
  book: BookService;
  bookImport: BookImportService;
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
  bookDeletion: BookDeletionService;
  importQueueWorker: ImportQueueWorker;
  retrySearchDeps: RetrySearchDeps;
  seriesCard: SeriesCardService;
  referenceRead: ReferenceReadService;
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
  indexerSearch: true,
  downloadClient: true,
  book: true,
  bookImport: true,
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
  bookDeletion: true,
  importQueueWorker: true,
  retrySearchDeps: true,
  seriesCard: true,
  referenceRead: true,
} satisfies Record<keyof Services, true>) as (keyof Services)[];
