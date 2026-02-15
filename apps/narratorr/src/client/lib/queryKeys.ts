export const queryKeys = {
  books: () => ['books'] as const,
  book: (id: number) => ['books', id] as const,
  activity: () => ['activity'] as const,
  activityCounts: () => ['activity', 'counts'] as const,
  search: (q: string) => ['search', q] as const,
  metadata: {
    search: (q: string) => ['metadata', 'search', q] as const,
    author: (asin: string) => ['metadata', 'author', asin] as const,
    authorBooks: (asin: string) => ['metadata', 'author', asin, 'books'] as const,
    book: (asin: string) => ['metadata', 'book', asin] as const,
  },
  settings: () => ['settings'] as const,
  indexers: () => ['indexers'] as const,
  downloadClients: () => ['downloadClients'] as const,
  notifiers: () => ['notifiers'] as const,
} as const;
