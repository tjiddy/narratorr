export { ApiError } from './client.js';

export type { Author, BookWithAuthor, BookIdentifier, CreateBookPayload, UpdateBookPayload, RenameResult, RenamePreviewResult, RetagResult, RetagExcludableField, RetagPlan, RetagPlanFile, RetagPlanFileDiff, RetagMode, RetagOverrides, SingleBookSearchResult, BookMetadata, AuthorMetadata, MetadataSearchResults, BookFile, BookListParams, LibraryBookListParams, BookStats, BookSeriesCardData, BookSeriesMemberCard, RefreshBookSeriesResponse, HardcoverSeriesCandidate, FixMatchPayload, LibraryBookListItem, LibraryBookListResponse } from './books.js';
export { RenameConflictError, RetagFfmpegNotConfiguredError } from './books.js';
export type { SearchResult, SearchResponse } from './search.js';
export type { Download, ActivityCounts, QualityGateData, ActivityListParams } from './activity.js';
export type { Indexer } from './indexers.js';
export type { DownloadClient } from './download-clients.js';
export type { Notifier } from './notifiers.js';
export type { BlacklistEntry } from './blacklist.js';
export type { Settings, TestResult, FfmpegProbeResult, ProxyTestResult, HardcoverTestResult } from './settings.js';
export type { AuthStatus, AuthConfig } from './auth.js';
export type { DiscoveredBook, ScanResult, ImportConfirmItem, ImportResult, ImportMode, Confidence, MatchCandidate, MatchResult, MatchJobStatus, RescanResult } from './library-scan.js';
export type { BrowseResult } from './filesystem.js';
export type { RemotePathMapping } from './remote-path-mappings.js';
export type { BookEvent, EventHistoryParams } from './event-history.js';
export type { BackupMetadata, RestoreValidation, BackupJobResult } from './backups.js';
export type { HealthState, HealthCheckResult, HealthCheckTarget, HealthSummary, TaskMetadata, SystemInfo, SystemStatus } from './system.js';
export type { ImportList, ImportListItem, ImportListPreview } from './import-lists.js';
export type { SuggestionRow, MarkAddedResult, RefreshResult } from './discover.js';
export type { BulkOpType, BulkJobStatus, RenameCount, BulkRenamePreview, BulkRenamePreviewItem } from './bulk-operations.js';
export type { ImportJobWithBook, ImportJobBook, ImportJobsParams } from './import-jobs.js';

export { formatBytes } from '@core/utils/parse.js';
export { formatBytesPerSec } from './formatBytesPerSec.js';
export { formatProgress } from './utils.js';

import { booksApi } from './books.js';
import { searchApi } from './search.js';
import { activityApi } from './activity.js';
import { indexersApi } from './indexers.js';
import { downloadClientsApi } from './download-clients.js';
import { notifiersApi } from './notifiers.js';
import { blacklistApi } from './blacklist.js';
import { settingsApi } from './settings.js';
import { libraryScanApi } from './library-scan.js';
import { systemApi } from './system.js';
import { authApi } from './auth.js';
import { filesystemApi } from './filesystem.js';
import { remotePathMappingsApi } from './remote-path-mappings.js';
import { eventHistoryApi } from './event-history.js';
import { backupsApi } from './backups.js';
import { importListsApi } from './import-lists.js';
import { discoverApi } from './discover.js';
import { bulkOperationsApi } from './bulk-operations.js';
import { importJobsApi } from './import-jobs.js';

/**
 * Single source of truth for the API barrel. Both the runtime `api` object and
 * the collision test (`api-collision.test.ts`) derive from this one collection,
 * so a module added here is automatically merged into `api` AND covered by the
 * collision guard — there is no second list to keep in sync. Each entry carries
 * its module name so the collision test can report which modules define a
 * duplicate key (see CLAUDE.md: domain-prefixed API method names).
 */
export const apiModules = [
  { name: 'booksApi', api: booksApi },
  { name: 'searchApi', api: searchApi },
  { name: 'activityApi', api: activityApi },
  { name: 'indexersApi', api: indexersApi },
  { name: 'downloadClientsApi', api: downloadClientsApi },
  { name: 'notifiersApi', api: notifiersApi },
  { name: 'blacklistApi', api: blacklistApi },
  { name: 'settingsApi', api: settingsApi },
  { name: 'libraryScanApi', api: libraryScanApi },
  { name: 'systemApi', api: systemApi },
  { name: 'authApi', api: authApi },
  { name: 'filesystemApi', api: filesystemApi },
  { name: 'remotePathMappingsApi', api: remotePathMappingsApi },
  { name: 'eventHistoryApi', api: eventHistoryApi },
  { name: 'backupsApi', api: backupsApi },
  { name: 'importListsApi', api: importListsApi },
  { name: 'discoverApi', api: discoverApi },
  { name: 'bulkOperationsApi', api: bulkOperationsApi },
  { name: 'importJobsApi', api: importJobsApi },
];

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (
  arg: infer I,
) => void
  ? I
  : never;

/** Merged shape of every module's exported methods — the intersection of all `apiModules[*].api` types. */
export type Api = UnionToIntersection<(typeof apiModules)[number]['api']>;

export const api = Object.assign({}, ...apiModules.map((m) => m.api)) as Api;
