import { fetchApi } from './client.js';

export type BulkOpType = 'rename' | 'retag' | 'convert';

export interface BulkJobStatus {
  jobId: string;
  type: BulkOpType;
  status: 'running' | 'completed';
  completed: number;
  total: number;
  failures: number;
}

export interface RenameCount {
  mismatched: number;
  alreadyMatching: number;
}

export const bulkOperationsApi = {
  getBulkRenameCount: () =>
    fetchApi<RenameCount>('/books/bulk/rename/count'),

  getBulkRetagCount: () =>
    fetchApi<{ total: number }>('/books/bulk/retag/count'),

  getBulkConvertCount: () =>
    fetchApi<{ total: number }>('/books/bulk/convert/count'),

  getActiveBulkJob: () =>
    fetchApi<BulkJobStatus | null>('/books/bulk/active'),

  startBulkRename: () =>
    fetchApi<{ jobId: string }>('/books/bulk/rename', { method: 'POST' }),

  startBulkRetag: () =>
    fetchApi<{ jobId: string }>('/books/bulk/retag', { method: 'POST' }),

  startBulkConvert: () =>
    fetchApi<{ jobId: string }>('/books/bulk/convert', { method: 'POST' }),

  getBulkJob: (jobId: string) =>
    fetchApi<BulkJobStatus>(`/books/bulk/${jobId}`),
};
