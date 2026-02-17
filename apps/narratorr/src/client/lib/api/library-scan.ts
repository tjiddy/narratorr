import { fetchApi } from './client.js';
import type { BookMetadata } from './books.js';

export interface DiscoveredBook {
  path: string;
  parsedTitle: string;
  parsedAuthor: string | null;
  parsedSeries: string | null;
  fileCount: number;
  totalSize: number;
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
  skippedDuplicates: number;
}

export interface ImportResult {
  imported: number;
  failed: number;
  enriched?: number;
  enrichmentFailed?: number;
}

export const libraryScanApi = {
  scanSingleBook: (path: string) =>
    fetchApi<SingleBookResult>('/library/import/scan-single', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  importSingleBook: (item: ImportConfirmItem) =>
    fetchApi<ImportSingleResult>('/library/import/single', {
      method: 'POST',
      body: JSON.stringify(item),
    }),
  scanDirectory: (path: string) =>
    fetchApi<ScanResult>('/library/import/scan', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  confirmImport: (books: ImportConfirmItem[]) =>
    fetchApi<ImportResult>('/library/import/confirm', {
      method: 'POST',
      body: JSON.stringify({ books }),
    }),
};
