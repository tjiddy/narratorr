import { fetchApi } from './client.js';
import type { BookMetadata } from './books.js';

export type ImportMode = 'copy' | 'move';

export interface DiscoveredBook {
  path: string;
  parsedTitle: string;
  parsedAuthor: string | null;
  parsedSeries: string | null;
  fileCount: number;
  totalSize: number;
  isDuplicate: boolean;
  existingBookId?: number;
}

export interface SingleBookResult {
  book: DiscoveredBook;
  metadata: BookMetadata | null;
}

export interface ImportConfirmItem {
  path: string;
  title: string;
  authorName?: string;
  seriesName?: string;
  coverUrl?: string;
  asin?: string;
  metadata?: BookMetadata;
  /** When true, bypasses the server-side title+author safety-net duplicate check */
  forceImport?: boolean;
}

export interface ImportSingleResult {
  imported: boolean;
  bookId?: number;
  enriched: boolean;
  error?: string;
}

export interface ScanResult {
  discoveries: DiscoveredBook[];
  totalFolders: number;
}

export interface ImportResult {
  accepted: number;
}

export interface RescanResult {
  scanned: number;
  missing: number;
  restored: number;
}

export type Confidence = 'high' | 'medium' | 'none';

export interface MatchCandidate {
  path: string;
  title: string;
  author?: string;
}

export interface MatchResult {
  path: string;
  confidence: Confidence;
  bestMatch: BookMetadata | null;
  alternatives: BookMetadata[];
  error?: string;
}

export interface MatchJobStatus {
  id: string;
  status: 'matching' | 'completed' | 'cancelled';
  total: number;
  matched: number;
  results: MatchResult[];
}

export const libraryScanApi = {
  rescanLibrary: () =>
    fetchApi<RescanResult>('/library/rescan', { method: 'POST' }),
  scanSingleBook: (path: string) =>
    fetchApi<SingleBookResult>('/library/import/scan-single', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  importSingleBook: (item: ImportConfirmItem & { mode?: ImportMode }) =>
    fetchApi<ImportSingleResult>('/library/import/single', {
      method: 'POST',
      body: JSON.stringify(item),
    }),
  scanDirectory: (path: string) =>
    fetchApi<ScanResult>('/library/import/scan', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  confirmImport: (books: ImportConfirmItem[], mode?: ImportMode) =>
    fetchApi<ImportResult>('/library/import/confirm', {
      method: 'POST',
      body: JSON.stringify({ books, mode }),
    }),
  startMatchJob: (books: MatchCandidate[]) =>
    fetchApi<{ jobId: string }>('/library/import/match', {
      method: 'POST',
      body: JSON.stringify({ books }),
    }),
  getMatchJob: (jobId: string) =>
    fetchApi<MatchJobStatus>(`/library/import/match/${jobId}`),
  cancelMatchJob: (jobId: string) =>
    fetchApi<{ cancelled: boolean }>(`/library/import/match/${jobId}`, {
      method: 'DELETE',
    }),
};
