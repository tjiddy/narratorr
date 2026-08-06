import { fetchApi } from './client.js';

export type BulkOpType = 'rename' | 'retag' | 'write_metadata_sidecars';

/**
 * One named per-book failure on a bulk job's record (#2159). Mirrors the server's `BulkJobFailure`
 * (`src/server/services/bulk-job.ts`) the same way `BulkOpType`/`BulkJobStatus` already do —
 * unifying the three is chore #2063, deliberately not attempted here.
 */
export interface BulkJobFailure {
  bookId: number;
  title: string;
  error: string;
}

export interface BulkJobStatus {
  jobId: string;
  type: BulkOpType;
  status: 'running' | 'completed';
  completed: number;
  total: number;
  /** Uncapped count — always `>= failureDetails.length`; the gap is the "…and N more" row. */
  failures: number;
  /** Named failures, capped server-side at the first 50. Always an array, `[]` when clean. */
  failureDetails: BulkJobFailure[];
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

  startBulkWriteMetadataSidecars: () =>
    fetchApi<{ jobId: string }>('/books/bulk/write-metadata-sidecars', { method: 'POST' }),

  getBulkJob: (jobId: string) =>
    fetchApi<BulkJobStatus>(`/books/bulk/${jobId}`),
};
