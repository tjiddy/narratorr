import type { BookStatus, EnrichmentStatus } from '../../../shared/schemas.js';
import type { BookMetadata, AuthorMetadata, MetadataSearchResults } from '../../../core/metadata/types.js';
import { fetchApi, fetchMultipart } from './client.js';

export type { BookMetadata, AuthorMetadata, MetadataSearchResults };

export interface Author {
  id: number;
  name: string;
  slug: string;
  asin?: string | null;
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
  status: BookStatus;
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
  authors?: { name: string; asin?: string | undefined }[] | undefined;
  narrators?: string[] | undefined;
  description?: string | undefined;
  coverUrl?: string | undefined;
  asin?: string | undefined;
  isbn?: string | undefined;
  seriesName?: string | undefined;
  seriesPosition?: number | undefined;
  seriesAsin?: string | undefined;
  seriesProvider?: string | undefined;
  duration?: number | undefined;
  publishedDate?: string | undefined;
  genres?: string[] | undefined;
  providerId?: string | undefined;
  monitorForUpgrades?: boolean | undefined;
  searchImmediately?: boolean | undefined;
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
  title?: string | undefined;
  authors?: { name: string; asin?: string | undefined }[] | undefined;
  narrators?: string[] | undefined;
  description?: string | undefined;
  coverUrl?: string | undefined;
  status?: BookStatus | undefined;
  seriesName?: string | null | undefined;
  seriesPosition?: number | null | undefined;
  monitorForUpgrades?: boolean | undefined;
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

export interface RefreshScanResult {
  bookId: number;
  codec: string;
  bitrate: number;
  fileCount: number;
  durationMinutes: number;
  narratorsUpdated: boolean;
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
  status?: BookStatus;
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
  refreshScanBook: (id: number) =>
    fetchApi<RefreshScanResult>(`/books/${id}/refresh-scan`, { method: 'POST' }),
  searchBook: (id: number) =>
    fetchApi<SingleBookSearchResult>(`/books/${id}/search`, { method: 'POST' }),
  mergeBookToM4b: (id: number) =>
    fetchApi<MergeAcknowledgement>(`/books/${id}/merge-to-m4b`, { method: 'POST' }),
  cancelMergeBook: (id: number) =>
    fetchApi<{ success: boolean }>(`/books/${id}/merge-to-m4b`, { method: 'DELETE' }),
  markBookAsWrongRelease: (id: number) =>
    fetchApi<{ success: boolean }>(`/books/${id}/wrong-release`, { method: 'POST' }),
  retryBookImport: (id: number) =>
    fetchApi<{ jobId: number }>(`/books/${id}/retry-import`, { method: 'POST' }),
  checkRetryImportAvailable: (id: number) =>
    fetchApi<{ available: boolean }>(`/books/${id}/retry-import`),
  uploadBookCover: (id: number, file: File): Promise<BookWithAuthor> => {
    const formData = new FormData();
    formData.append('file', file);
    return fetchMultipart<BookWithAuthor>(`/books/${id}/cover`, formData);
  },
  getBookSeries: (id: number) =>
    fetchApi<{ series: BookSeriesCardData | null }>(`/books/${id}/series`),
  refreshBookSeries: (id: number) =>
    fetchApi<RefreshBookSeriesResponse>(`/books/${id}/series/refresh`, { method: 'POST' }),
};

export interface BookSeriesMemberCard {
  id: number;
  providerBookId: string | null;
  title: string;
  positionRaw: string | null;
  position: number | null;
  isCurrent: boolean;
  libraryBookId: number | null;
  coverUrl: string | null;
}

export interface BookSeriesCardData {
  id: number;
  name: string;
  providerSeriesId: string | null;
  lastFetchedAt: string | null;
  lastFetchStatus: 'success' | 'failed' | 'rate_limited' | null;
  nextFetchAfter: string | null;
  members: BookSeriesMemberCard[];
}

export interface RefreshBookSeriesResponse {
  status: 'refreshed' | 'queued' | 'rate_limited' | 'failed';
  series: BookSeriesCardData | null;
  nextFetchAfter?: string;
  error?: string;
}
