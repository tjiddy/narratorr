import type { BookListParams, LibraryBookListParams, RetagOverrides } from './api/books.js';
import type { ActivityListParams } from './api/activity.js';
import type { EventHistoryParams } from './api/event-history.js';
import type { BlacklistListParams } from './api/blacklist.js';

export const queryKeys = {
  books: (params?: BookListParams) => params ? ['books', params] as const : ['books'] as const,
  // Child of `books` so prefix invalidation refreshes library results.
  libraryBooks: (params?: LibraryBookListParams) => params ? ['books', 'library', params] as const : ['books', 'library'] as const,
  bookStats: () => ['books', 'stats'] as const,
  bookIdentifiers: () => ['books', 'identifiers'] as const,
  book: (id: number) => ['books', id] as const,
  bookFiles: (id: number) => ['books', id, 'files'] as const,
  // Child of `book(id)` so shared book invalidation also refreshes the ebook panel.
  companionEbook: (id: number) => ['books', id, 'companion-epub'] as const,
  // Child of `companionEbook(id)` so book and ebook invalidations cascade here.
  // `filename` indexes expected state only; trust the filename returned in the response.
  companionEbookMetadata: (id: number, filename: string) =>
    ['books', id, 'companion-epub', 'metadata', filename] as const,
  // The singular namespace is intentionally separate from plural list keys.
  bookSeries: (id: number) => ['book', id, 'series'] as const,
  // Extends `bookSeries(id)` so base-key invalidation refreshes active searches.
  bookSeriesSearch: (id: number, query: string) => ['book', id, 'series', 'search', query] as const,
  bookRenamePreview: (id: number) => ['books', id, 'rename-preview'] as const,
  bulkRenamePreview: () => ['books', 'bulk', 'rename-preview'] as const,
  bookRetagPreview: (id: number, overrides?: RetagOverrides) =>
    overrides && (overrides.mode !== undefined || overrides.embedCover !== undefined)
      ? ['books', id, 'retag-preview', overrides] as const
      : ['books', id, 'retag-preview'] as const,
  activity: (params?: ActivityListParams) => params ? ['activity', params] as const : ['activity'] as const,
  activityCounts: () => ['activity', 'counts'] as const,
  metadata: {
    search: (q: string) => ['metadata', 'search', q] as const,
    author: (id: string) => ['metadata', 'author', id] as const,
    authorBooks: (id: string) => ['metadata', 'author', id, 'books'] as const,
    book: (id: string) => ['metadata', 'book', id] as const,
  },
  settings: () => ['settings'] as const,
  // All ffmpeg-gated surfaces share one cache entry.
  ffmpegStatus: () => ['ffmpeg-status'] as const,
  indexers: () => ['indexers'] as const,
  downloadClients: () => ['downloadClients'] as const,
  notifiers: () => ['notifiers'] as const,
  connectors: () => ['connectors'] as const,
  importLists: () => ['importLists'] as const,
  blacklist: (params?: BlacklistListParams) => params ? ['blacklist', params] as const : ['blacklist'] as const,
  remotePathMappings: (clientId?: number) =>
    clientId !== undefined
      ? (['remotePathMappings', clientId] as const)
      : (['remotePathMappings'] as const),
  auth: {
    status: () => ['auth', 'status'] as const,
    adminStatus: () => ['auth', 'admin-status'] as const,
    config: () => ['auth', 'config'] as const,
    streamToken: () => ['auth', 'stream-token'] as const,
  },
  eventHistory: {
    root: () => ['eventHistory'] as const,
    all: (params?: EventHistoryParams) => ['eventHistory', params] as const,
    byBookId: (bookId: number) => ['eventHistory', 'book', bookId] as const,
  },
  filesystem: {
    browse: (path: string) => ['filesystem', 'browse', path] as const,
  },
  backups: () => ['backups'] as const,
  health: {
    status: () => ['health', 'status'] as const,
    summary: () => ['health', 'summary'] as const,
  },
  systemTasks: () => ['system', 'tasks'] as const,
  systemInfo: () => ['system', 'info'] as const,
  thirdPartyNotices: () => ['system', 'notices'] as const,
  importJobs: (params?: { status?: string }) => params ? ['importJobs', params] as const : ['importJobs'] as const,
  systemStatus: () => ['systemStatus'] as const,
  discover: {
    suggestions: () => ['discover', 'suggestions'] as const,
    stats: () => ['discover', 'stats'] as const,
  },
  // All report feeds share a root so cache patches can scan every cached list page.
  importSubmissions: {
    root: () => ['importSubmissions'] as const,
    list: (params: { source?: string; limit?: number; offset?: number }) => ['importSubmissions', 'list', params] as const,
    latest: (source?: string) => ['importSubmissions', 'latest', source ?? 'all'] as const,
    attention: (source?: string) => ['importSubmissions', 'attention', source ?? 'all'] as const,
    detail: (id: number) => ['importSubmissions', 'detail', id] as const,
  },
} as const;
