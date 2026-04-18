import type { BookListParams } from './api/books.js';
import type { ActivityListParams } from './api/activity.js';
import type { EventHistoryParams } from './api/event-history.js';
import type { BlacklistListParams } from './api/blacklist.js';

export const queryKeys = {
  books: (params?: BookListParams) => params ? ['books', params] as const : ['books'] as const,
  bookStats: () => ['books', 'stats'] as const,
  bookIdentifiers: () => ['books', 'identifiers'] as const,
  book: (id: number) => ['books', id] as const,
  bookFiles: (id: number) => ['books', id, 'files'] as const,
  activity: (params?: ActivityListParams) => params ? ['activity', params] as const : ['activity'] as const,
  activityCounts: () => ['activity', 'counts'] as const,
  search: (q: string) => ['search', q] as const,
  metadata: {
    search: (q: string) => ['metadata', 'search', q] as const,
    author: (id: string) => ['metadata', 'author', id] as const,
    authorBooks: (id: string) => ['metadata', 'author', id, 'books'] as const,
    book: (id: string) => ['metadata', 'book', id] as const,
  },
  settings: () => ['settings'] as const,
  indexers: () => ['indexers'] as const,
  downloadClients: () => ['downloadClients'] as const,
  notifiers: () => ['notifiers'] as const,
  importLists: () => ['importLists'] as const,
  blacklist: (params?: BlacklistListParams) => params ? ['blacklist', params] as const : ['blacklist'] as const,
  remotePathMappings: (clientId?: number) =>
    clientId !== undefined
      ? (['remotePathMappings', clientId] as const)
      : (['remotePathMappings'] as const),
  auth: {
    status: () => ['auth', 'status'] as const,
    config: () => ['auth', 'config'] as const,
  },
  eventHistory: {
    root: () => ['eventHistory'] as const,
    all: (params?: EventHistoryParams) => ['eventHistory', params] as const,
    byBookId: (bookId: number) => ['eventHistory', 'book', bookId] as const,
  },
  filesystem: {
    browse: (path: string) => ['filesystem', 'browse', path] as const,
  },
  searchReleases: (bookId: number, query: string) => ['search-releases', bookId, query] as const,
  backups: () => ['backups'] as const,
  health: {
    status: () => ['health', 'status'] as const,
    summary: () => ['health', 'summary'] as const,
  },
  systemTasks: () => ['system', 'tasks'] as const,
  systemInfo: () => ['system', 'info'] as const,
  importJobs: (params?: { status?: string }) => params ? ['importJobs', params] as const : ['importJobs'] as const,
  systemStatus: () => ['systemStatus'] as const,
  discover: {
    suggestions: () => ['discover', 'suggestions'] as const,
    stats: () => ['discover', 'stats'] as const,
  },
} as const;
