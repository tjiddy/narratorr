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
  blacklist: () => ['blacklist'] as const,
  prowlarr: {
    config: () => ['prowlarr', 'config'] as const,
    preview: () => ['prowlarr', 'preview'] as const,
  },
  auth: {
    status: () => ['auth', 'status'] as const,
    config: () => ['auth', 'config'] as const,
  },
} as const;
