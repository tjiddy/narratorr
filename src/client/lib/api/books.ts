import type { EnrichmentStatus } from '../../../shared/schemas.js';
import { fetchApi } from './client.js';

export interface Author {
  id: number;
  name: string;
  slug: string;
  asin?: string | null;
  imageUrl?: string | null;
  bio?: string | null;
}

export interface Narrator {
  id: number;
  name: string;
  slug: string;
}

export interface BookWithAuthor {
  id: number;
  title: string;
  authors: Author[];
  narrators: Narrator[];
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
  enrichmentStatus?: EnrichmentStatus | null;
  // Audio technical info
  audioCodec?: string | null;
  audioBitrate?: number | null;
  audioSampleRate?: number | null;
  audioChannels?: number | null;
  audioBitrateMode?: string | null;
  audioFileFormat?: string | null;
  audioFileCount?: number | null;
  topLevelAudioFileCount?: number | null;
  audioTotalSize?: number | null;
  audioDuration?: number | null;
  lastGrabGuid?: string | null;
  lastGrabInfoHash?: string | null;
  monitorForUpgrades: boolean;
  importListId?: number | null;
  importListName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBookPayload {
  title: string;
  authors?: { name: string; asin?: string }[];
  narrators?: string[];
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
  monitorForUpgrades?: boolean;
  searchImmediately?: boolean;
}

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

export interface BookIdentifier {
  asin: string | null;
  title: string;
  authorName: string | null;
  authorSlug: string | null;
}

export interface BookFile {
  name: string;
  size: number;
}

export interface UpdateBookPayload {
  title?: string;
  authors?: { name: string; asin?: string }[];
  narrators?: string[];
  description?: string;
  coverUrl?: string;
  status?: string;
  seriesName?: string | null;
  seriesPosition?: number | null;
  monitorForUpgrades?: boolean;
}

export interface RenameResult {
  oldPath: string;
  newPath: string;
  message: string;
  filesRenamed: number;
}

export interface RetagResult {
  bookId: number;
  tagged: number;
  skipped: number;
  failed: number;
  warnings: string[];
}

export interface MergeResult {
  bookId: number;
  outputFile: string;
  filesReplaced: number;
  message: string;
  enrichmentWarning?: string;
}

export interface MergeAcknowledgement {
  status: 'started' | 'queued';
  bookId: number;
  position?: number;
}

export type SingleBookSearchResult =
  | { result: 'grabbed'; title: string }
  | { result: 'no_results' }
  | { result: 'skipped'; reason: string };

export interface BookListParams {
  status?: string;
  search?: string;
  sortField?: string;
  sortDirection?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface BookStats {
  counts: {
    wanted: number;
    downloading: number;
    imported: number;
    failed: number;
    missing: number;
  };
  authors: string[];
  series: string[];
  narrators: string[];
}

export const booksApi = {
  getBooks: (params?: BookListParams) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set('status', params.status);
    if (params?.search) searchParams.set('search', params.search);
    if (params?.sortField) searchParams.set('sortField', params.sortField);
    if (params?.sortDirection) searchParams.set('sortDirection', params.sortDirection);
    if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
    if (params?.offset !== undefined) searchParams.set('offset', String(params.offset));
    const qs = searchParams.toString();
    return fetchApi<{ data: BookWithAuthor[]; total: number }>(`/books${qs ? `?${qs}` : ''}`);
  },
  getBookStats: () =>
    fetchApi<BookStats>('/books/stats'),
  getBookIdentifiers: () =>
    fetchApi<BookIdentifier[]>('/books/identifiers'),
  getBookById: (id: number) =>
    fetchApi<BookWithAuthor>(`/books/${id}`),
  addBook: (data: CreateBookPayload) =>
    fetchApi<BookWithAuthor>('/books', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteBook: (id: number, options?: { deleteFiles?: boolean }) =>
    fetchApi<{ success: boolean }>(`/books/${id}${options?.deleteFiles ? '?deleteFiles=true' : ''}`, { method: 'DELETE' }),
  deleteMissingBooks: () =>
    fetchApi<{ deleted: number }>('/books/missing', { method: 'DELETE' }),
  getBookFiles: (id: number) =>
    fetchApi<BookFile[]>(`/books/${id}/files`),

  searchMetadata: (query: string) =>
    fetchApi<MetadataSearchResults>(`/metadata/search?q=${encodeURIComponent(query)}`),
  getAuthor: (id: string) =>
    fetchApi<AuthorMetadata>(`/metadata/authors/${encodeURIComponent(id)}`),
  getAuthorBooks: (id: string) =>
    fetchApi<BookMetadata[]>(`/metadata/authors/${encodeURIComponent(id)}/books`),
  getBook: (id: string) =>
    fetchApi<BookMetadata>(`/metadata/books/${encodeURIComponent(id)}`),
  updateBook: (id: number, data: UpdateBookPayload) =>
    fetchApi<BookWithAuthor>(`/books/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  renameBook: (id: number) =>
    fetchApi<RenameResult>(`/books/${id}/rename`, { method: 'POST' }),
  retagBook: (id: number) =>
    fetchApi<RetagResult>(`/books/${id}/retag`, { method: 'POST' }),
  searchBook: (id: number) =>
    fetchApi<SingleBookSearchResult>(`/books/${id}/search`, { method: 'POST' }),
  mergeBookToM4b: (id: number) =>
    fetchApi<MergeAcknowledgement>(`/books/${id}/merge-to-m4b`, { method: 'POST' }),
  markBookAsWrongRelease: (id: number) =>
    fetchApi<{ success: boolean }>(`/books/${id}/wrong-release`, { method: 'POST' }),
};
