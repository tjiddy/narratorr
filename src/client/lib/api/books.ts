import { fetchApi } from './client.js';

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
  enrichmentStatus?: string | null;
  // Audio technical info
  audioCodec?: string | null;
  audioBitrate?: number | null;
  audioSampleRate?: number | null;
  audioChannels?: number | null;
  audioBitrateMode?: string | null;
  audioFileFormat?: string | null;
  audioFileCount?: number | null;
  audioTotalSize?: number | null;
  audioDuration?: number | null;
  monitorForUpgrades: boolean;
  importListId?: number | null;
  importListName?: string | null;
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

export interface BookFile {
  name: string;
  size: number;
}

export interface UpdateBookPayload {
  title?: string;
  narrator?: string;
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

export type SingleBookSearchResult =
  | { result: 'grabbed'; title: string }
  | { result: 'no_results' }
  | { result: 'skipped'; reason: string };

export const booksApi = {
  getBooks: (status?: string) =>
    fetchApi<{ data: BookWithAuthor[]; total: number }>(status ? `/books?status=${encodeURIComponent(status)}` : '/books'),
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
};
