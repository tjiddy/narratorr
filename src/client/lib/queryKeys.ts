import type { BookListParams, LibraryBookListParams, RetagOverrides } from './api/books.js';
import type { ActivityListParams } from './api/activity.js';
import type { EventHistoryParams } from './api/event-history.js';
import type { BlacklistListParams } from './api/blacklist.js';

export const queryKeys = {
  books: (params?: BookListParams) => params ? ['books', params] as const : ['books'] as const,
  // Child of the `books` prefix so existing invalidateQueries({ queryKey: ['books'] })
  // calls invalidate library-books too (TanStack prefix matching).
  libraryBooks: (params?: LibraryBookListParams) => params ? ['books', 'library', params] as const : ['books', 'library'] as const,
  bookStats: () => ['books', 'stats'] as const,
  bookIdentifiers: () => ['books', 'identifiers'] as const,
  book: (id: number) => ['books', id] as const,
  bookFiles: (id: number) => ['books', id, 'files'] as const,
  // Singular `book` namespace (distinct from the plural `books` list namespace above).
  bookSeries: (id: number) => ['book', id, 'series'] as const,
  // Prefix-extension of bookSeries(id) so invalidating the base key cascades to the
  // in-flight series search (TanStack prefix matching).
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
  // Shared by the Audio Tools status row, the ffmpeg-gated Post Processing toggles,
  // and BookDetails merge/retag gating — one cache entry so they never disagree.
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
  // Durable import report (#1894). `list` backs the Activity import-history pages
  // (patched by id when a self-polled detail advances — F86/F89); `latest` backs
  // the last-import panel; `attention` backs the banner; `detail` backs both
  // expansion surfaces. All share the `['importSubmissions']` root prefix so the
  // cache patch can scan every cached page.
  importSubmissions: {
    root: () => ['importSubmissions'] as const,
    list: (params: { source?: string; limit?: number; offset?: number }) => ['importSubmissions', 'list', params] as const,
    latest: (source?: string) => ['importSubmissions', 'latest', source ?? 'all'] as const,
    attention: (source?: string) => ['importSubmissions', 'attention', source ?? 'all'] as const,
    detail: (id: number) => ['importSubmissions', 'detail', id] as const,
  },
} as const;
