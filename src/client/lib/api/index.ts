export { ApiError } from './client.js';

export type { Author, BookWithAuthor, CreateBookPayload, UpdateBookPayload, RenameResult, RetagResult, SingleBookSearchResult, BookMetadata, AuthorMetadata, MetadataSearchResults, BookFile } from './books.js';
export type { SearchResult, SearchResponse } from './search.js';
export type { Download, ActivityCounts, QualityGateData } from './activity.js';
export type { Indexer } from './indexers.js';
export type { DownloadClient } from './download-clients.js';
export type { Notifier } from './notifiers.js';
export type { BlacklistEntry } from './blacklist.js';
export type { Settings, TestResult, FfmpegProbeResult, ProxyTestResult } from './settings.js';
export type { AuthStatus, AuthConfig } from './auth.js';
export type { DiscoveredBook, ScanResult, SingleBookResult, ImportConfirmItem, ImportSingleResult, ImportResult, ImportMode, Confidence, MatchCandidate, MatchResult, MatchJobStatus, RescanResult } from './library-scan.js';
export type { ProwlarrConfig, SyncPreviewItem, SyncResult } from './prowlarr.js';
export type { BrowseResult } from './filesystem.js';
export type { RemotePathMapping } from './remote-path-mappings.js';
export type { BookEvent } from './event-history.js';
export type { BackupMetadata, RestoreValidation, BackupJobResult } from './backups.js';
export type { HealthState, HealthCheckResult, HealthSummary, TaskMetadata, SystemInfo } from './system.js';

export { formatBytes, formatProgress } from './utils.js';

import { booksApi } from './books.js';
import { searchApi } from './search.js';
import { activityApi } from './activity.js';
import { indexersApi } from './indexers.js';
import { downloadClientsApi } from './download-clients.js';
import { notifiersApi } from './notifiers.js';
import { blacklistApi } from './blacklist.js';
import { settingsApi } from './settings.js';
import { libraryScanApi } from './library-scan.js';
import { prowlarrApi } from './prowlarr.js';
import { systemApi } from './system.js';
import { authApi } from './auth.js';
import { filesystemApi } from './filesystem.js';
import { remotePathMappingsApi } from './remote-path-mappings.js';
import { eventHistoryApi } from './event-history.js';
import { backupsApi } from './backups.js';

export const api = {
  ...booksApi,
  ...searchApi,
  ...activityApi,
  ...indexersApi,
  ...downloadClientsApi,
  ...notifiersApi,
  ...blacklistApi,
  ...settingsApi,
  ...libraryScanApi,
  ...prowlarrApi,
  ...systemApi,
  ...authApi,
  ...filesystemApi,
  ...remotePathMappingsApi,
  ...eventHistoryApi,
  ...backupsApi,
};
