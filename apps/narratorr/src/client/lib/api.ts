const API_BASE = '/api';

class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    const message = (body as { error?: string })?.error
      || (body as { message?: string })?.message
      || `HTTP ${status}`;
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string>),
  };

  // Only set Content-Type for requests with a body
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new ApiError(response.status, error);
  }

  return response.json();
}

export { ApiError };

// Types
export interface SearchResult {
  title: string;
  author?: string;
  narrator?: string;
  protocol: 'torrent' | 'usenet';
  downloadUrl?: string;
  infoHash?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  grabs?: number;
  indexer: string;
  detailsUrl?: string;
  coverUrl?: string;
}

export interface Download {
  id: number;
  bookId?: number;
  indexerId?: number;
  downloadClientId?: number;
  title: string;
  protocol: 'torrent' | 'usenet';
  infoHash?: string;
  downloadUrl?: string;
  size?: number;
  seeders?: number;
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'importing' | 'imported' | 'failed';
  progress: number;
  externalId?: string;
  errorMessage?: string;
  addedAt: string;
  completedAt?: string;
}

export interface Indexer {
  id: number;
  name: string;
  type: 'abb' | 'torznab' | 'newznab';
  enabled: boolean;
  priority: number;
  settings: Record<string, unknown>;
  createdAt: string;
}

export interface DownloadClient {
  id: number;
  name: string;
  type: 'qbittorrent' | 'transmission' | 'sabnzbd' | 'nzbget';
  enabled: boolean;
  priority: number;
  settings: Record<string, unknown>;
  createdAt: string;
}

export interface Settings {
  library: {
    path: string;
    folderFormat: string;
  };
  search: {
    intervalMinutes: number;
    enabled: boolean;
  };
  import: {
    deleteAfterImport: boolean;
    minSeedTime: number;
  };
  general: {
    logLevel: 'error' | 'warn' | 'info' | 'debug';
  };
}

export interface TestResult {
  success: boolean;
  message?: string;
}

// Library types
export interface Author {
  id: number;
  name: string;
  slug: string;
  asin?: string | null;
  imageUrl?: string | null;
  bio?: string | null;
}

export interface BookWithAuthor {
  id: number;
  title: string;
  authorId?: number | null;
  narrator?: string | null;
  description?: string | null;
  coverUrl?: string | null;
  asin?: string | null;
  isbn?: string | null;
  seriesName?: string | null;
  seriesPosition?: number | null;
  duration?: number | null;
  publishedDate?: string | null;
  genres?: string[] | null;
  status: string;
  path?: string | null;
  size?: number | null;
  createdAt: string;
  updatedAt: string;
  author?: Author;
}

export interface CreateBookPayload {
  title: string;
  authorName?: string;
  authorAsin?: string;
  narrator?: string;
  description?: string;
  coverUrl?: string;
  asin?: string;
  isbn?: string;
  seriesName?: string;
  seriesPosition?: number;
  duration?: number;
  publishedDate?: string;
  genres?: string[];
  providerId?: string;
}

// Metadata types
export interface BookMetadata {
  asin?: string;
  title: string;
  subtitle?: string;
  authors: { name: string; asin?: string }[];
  narrators?: string[];
  series?: { name: string; position?: number; asin?: string }[];
  description?: string;
  publisher?: string;
  coverUrl?: string;
  duration?: number;
  genres?: string[];
  providerId?: string;
  relevance?: number;
}

export interface AuthorMetadata {
  asin?: string;
  name: string;
  description?: string;
  imageUrl?: string;
  genres?: string[];
  relevance?: number;
}

export interface MetadataSearchResults {
  books: BookMetadata[];
  authors: AuthorMetadata[];
  series: unknown[];
}

// API methods
export const api = {
  // Library
  getBooks: (status?: string) =>
    fetchApi<BookWithAuthor[]>(status ? `/books?status=${encodeURIComponent(status)}` : '/books'),
  getBookById: (id: number) =>
    fetchApi<BookWithAuthor>(`/books/${id}`),
  addBook: (data: CreateBookPayload) =>
    fetchApi<BookWithAuthor>('/books', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteBook: (id: number) =>
    fetchApi<{ success: boolean }>(`/books/${id}`, { method: 'DELETE' }),

  // Metadata
  searchMetadata: (query: string) =>
    fetchApi<MetadataSearchResults>(`/metadata/search?q=${encodeURIComponent(query)}`),
  getAuthor: (asin: string) =>
    fetchApi<AuthorMetadata>(`/metadata/authors/${encodeURIComponent(asin)}`),
  getAuthorBooks: (asin: string) =>
    fetchApi<BookMetadata[]>(`/metadata/authors/${encodeURIComponent(asin)}/books`),
  getBook: (asin: string) =>
    fetchApi<BookMetadata>(`/metadata/books/${encodeURIComponent(asin)}`),

  // Search
  search: (query: string) =>
    fetchApi<SearchResult[]>(`/search?q=${encodeURIComponent(query)}`),

  grab: (params: {
    downloadUrl: string;
    title: string;
    protocol?: 'torrent' | 'usenet';
    bookId?: number;
    indexerId?: number;
    size?: number;
    seeders?: number;
  }) =>
    fetchApi<Download>('/search/grab', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // Activity
  getActivity: () => fetchApi<Download[]>('/activity'),
  getActiveDownloads: () => fetchApi<Download[]>('/activity/active'),
  cancelDownload: (id: number) =>
    fetchApi<{ success: boolean }>(`/activity/${id}`, { method: 'DELETE' }),
  retryDownload: (id: number) =>
    fetchApi<Download>(`/activity/${id}/retry`, { method: 'POST' }),

  // Indexers
  getIndexers: () => fetchApi<Indexer[]>('/indexers'),
  createIndexer: (data: Omit<Indexer, 'id' | 'createdAt'>) =>
    fetchApi<Indexer>('/indexers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateIndexer: (id: number, data: Partial<Indexer>) =>
    fetchApi<Indexer>(`/indexers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteIndexer: (id: number) =>
    fetchApi<{ success: boolean }>(`/indexers/${id}`, { method: 'DELETE' }),
  testIndexer: (id: number) =>
    fetchApi<TestResult>(`/indexers/${id}/test`, { method: 'POST' }),

  // Download Clients
  getClients: () => fetchApi<DownloadClient[]>('/download-clients'),
  createClient: (data: Omit<DownloadClient, 'id' | 'createdAt'>) =>
    fetchApi<DownloadClient>('/download-clients', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateClient: (id: number, data: Partial<DownloadClient>) =>
    fetchApi<DownloadClient>(`/download-clients/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteClient: (id: number) =>
    fetchApi<{ success: boolean }>(`/download-clients/${id}`, { method: 'DELETE' }),
  testClient: (id: number) =>
    fetchApi<TestResult>(`/download-clients/${id}/test`, { method: 'POST' }),

  // Settings
  getSettings: () => fetchApi<Settings>('/settings'),
  updateSettings: (data: Partial<Settings>) =>
    fetchApi<Settings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // System
  getStatus: () => fetchApi<{ version: string; status: string }>('/system/status'),
};

// Utility functions
export function formatBytes(bytes?: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatProgress(progress: number): string {
  return `${Math.round(progress * 100)}%`;
}
