// Keep the DI aggregate here so jobs and routes both depend downward; routes re-exports it.
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
  CompanionEbookReconciler,
} from './index.js';
import type { MergeService } from './merge.service.js';
import type { QualityGateOrchestrator } from './quality-gate-orchestrator.js';
import type { BulkOperationService } from './bulk-operation.service.js';
import type { ImportQueueWorker } from './import-queue-worker.js';
import type { ImportStagingService } from './import-staging.service.js';
import type { ImportSubmissionReportService } from './import-submission-report.service.js';
import type { ImportSubmissionRunner } from './import-submission-runner.js';

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
  connector: ConnectorService;
  blacklist: BlacklistService;
  importListExclusion: ImportListExclusionService;
  remotePathMapping: RemotePathMappingService;
  rename: RenameService;
  merge: MergeService;
  eventHistory: EventHistoryService;
  tagging: TaggingService;
  qualityGate: QualityGateService;
  qualityGateOrchestrator: QualityGateOrchestrator;
  retryBudget: RetryBudget;
  searchLadderCooldown: SearchLadderCooldown;
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
  importStaging: ImportStagingService;
  importSubmissionReport: ImportSubmissionReportService;
  importSubmissionRunner: ImportSubmissionRunner;
  retrySearchDeps: RetrySearchDeps;
  seriesCard: SeriesCardService;
  referenceRead: ReferenceReadService;
  companionEbook: CompanionEbookReconciler;
}

/** Exhaustive runtime keys; satisfies makes omissions a type error. */
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
  connector: true,
  blacklist: true,
  importListExclusion: true,
  remotePathMapping: true,
  rename: true,
  merge: true,
  eventHistory: true,
  tagging: true,
  qualityGate: true,
  qualityGateOrchestrator: true,
  retryBudget: true,
  searchLadderCooldown: true,
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
  importStaging: true,
  importSubmissionReport: true,
  importSubmissionRunner: true,
  retrySearchDeps: true,
  seriesCard: true,
  referenceRead: true,
  companionEbook: true,
} satisfies Record<keyof Services, true>) as (keyof Services)[];
