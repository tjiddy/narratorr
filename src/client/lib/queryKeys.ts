export const queryKeys = {
  books: () => ['books'] as const,
  book: (id: number) => ['books', id] as const,
  bookFiles: (id: number) => ['books', id, 'files'] as const,
  activity: () => ['activity'] as const,
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
  blacklist: () => ['blacklist'] as const,
  prowlarr: {
    config: () => ['prowlarr', 'config'] as const,
    preview: () => ['prowlarr', 'preview'] as const,
  },
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
    all: (params?: { eventType?: string; search?: string }) => ['eventHistory', params] as const,
    byBookId: (bookId: number) => ['eventHistory', 'book', bookId] as const,
  },
  filesystem: {
    browse: (path: string) => ['filesystem', 'browse', path] as const,
  },
  searchReleases: (bookId: number, query: string) => ['search-releases', bookId, query] as const,
  recyclingBin: () => ['recyclingBin'] as const,
  backups: () => ['backups'] as const,
  health: {
    status: () => ['health', 'status'] as const,
    summary: () => ['health', 'summary'] as const,
  },
  systemTasks: () => ['system', 'tasks'] as const,
  systemInfo: () => ['system', 'info'] as const,
  systemStatus: () => ['systemStatus'] as const,
} as const;
