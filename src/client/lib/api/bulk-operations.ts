import { fetchApi } from './client.js';

// The bulk wire contract is declared ONCE in `src/shared` (#2063) and re-exported here so every
// existing `@/lib/api` consumer keeps its import unchanged. The local `import type` is what the
// call signatures below bind to — a bare `export … from` re-export creates no local binding.
import type { BulkJobStatus } from '@shared/bulk-operation-types.js';

export type { BulkOpType, BulkJobFailure, BulkJobStatus } from '@shared/bulk-operation-types.js';

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

  startBulkWriteMetadataSidecars: () =>
    fetchApi<{ jobId: string }>('/books/bulk/write-metadata-sidecars', { method: 'POST' }),

  getBulkJob: (jobId: string) =>
    fetchApi<BulkJobStatus>(`/books/bulk/${jobId}`),
};
