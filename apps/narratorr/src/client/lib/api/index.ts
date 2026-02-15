export { ApiError } from './client.js';

export type { Author, BookWithAuthor, CreateBookPayload, BookMetadata, AuthorMetadata, MetadataSearchResults } from './books.js';
export type { SearchResult } from './search.js';
export type { Download } from './activity.js';
export type { Indexer } from './indexers.js';
export type { DownloadClient } from './download-clients.js';
export type { Notifier } from './notifiers.js';
export type { Settings, TestResult } from './settings.js';
export type { DiscoveredBook, ScanResult, ImportConfirmItem, ImportResult } from './library-scan.js';

export { formatBytes, formatProgress } from './utils.js';

import { booksApi } from './books.js';
import { searchApi } from './search.js';
import { activityApi } from './activity.js';
import { indexersApi } from './indexers.js';
import { downloadClientsApi } from './download-clients.js';
import { notifiersApi } from './notifiers.js';
import { settingsApi } from './settings.js';
import { libraryScanApi } from './library-scan.js';
import { systemApi } from './system.js';

export const api = {
  ...booksApi,
  ...searchApi,
  ...activityApi,
  ...indexersApi,
  ...downloadClientsApi,
  ...notifiersApi,
  ...settingsApi,
  ...libraryScanApi,
  ...systemApi,
};
