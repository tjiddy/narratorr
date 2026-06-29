import { fetchApi } from './client.js';

export type BulkOpType = 'rename' | 'retag' | 'convert' | 'write_metadata_sidecars';

export interface BulkJobStatus {
  jobId: string;
  type: BulkOpType;
  status: 'running' | 'completed';
  completed: number;
  total: number;
  failures: number;
}

export interface BulkRenamePreviewItem {
  bookId: number;
  title: string;
  from: string;
  to: string;
}

export interface BulkRenamePreview {
  libraryRoot: string;
  folderFormat: string;
  fileFormat: string;
  items: BulkRenamePreviewItem[];
  mismatchedTotal: number;
  folderMatching: number;
  importedTotal: number;
  jobTotal: number;
}

export const bulkOperationsApi = {
  getBulkRenamePreview: () =>
    fetchApi<BulkRenamePreview>('/books/bulk/rename/preview'),

  getBulkRetagCount: () =>
    fetchApi<{ total: number }>('/books/bulk/retag/count'),

  getActiveBulkJob: () =>
    fetchApi<BulkJobStatus | null>('/books/bulk/active'),

  startBulkRename: () =>
    fetchApi<{ jobId: string }>('/books/bulk/rename', { method: 'POST' }),

  startBulkRetag: () =>
    fetchApi<{ jobId: string }>('/books/bulk/retag', { method: 'POST' }),

  startBulkConvert: () =>
    fetchApi<{ jobId: string }>('/books/bulk/convert', { method: 'POST' }),

  startBulkWriteMetadataSidecars: () =>
    fetchApi<{ jobId: string }>('/books/bulk/write-metadata-sidecars', { method: 'POST' }),

  getBulkJob: (jobId: string) =>
    fetchApi<BulkJobStatus>(`/books/bulk/${jobId}`),
};
