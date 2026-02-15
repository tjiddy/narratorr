import { fetchApi } from './client.js';

export interface DiscoveredBook {
  path: string;
  parsedTitle: string;
  parsedAuthor: string | null;
  parsedSeries: string | null;
  fileCount: number;
  totalSize: number;
}

export interface ScanResult {
  discoveries: DiscoveredBook[];
  totalFolders: number;
  skippedDuplicates: number;
}

export interface ImportConfirmItem {
  path: string;
  title: string;
  authorName?: string;
  seriesName?: string;
}

export interface ImportResult {
  imported: number;
  failed: number;
}

export const libraryScanApi = {
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
