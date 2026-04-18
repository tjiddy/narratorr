import { fetchApi } from './client.js';
import type { PhaseHistoryEntry } from '../../../server/services/import-queue-worker.js';

export interface ImportJobBook {
  title: string;
  coverUrl: string | null;
  primaryAuthorName: string | null;
}

export interface ImportJobWithBook {
  id: number;
  bookId: number | null;
  type: 'manual' | 'auto';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  phase: string | null;
  phaseHistory: PhaseHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  book: ImportJobBook;
}

export interface ImportJobsParams {
  status?: string;
}

export const importJobsApi = {
  getImportJobs: (params?: ImportJobsParams) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set('status', params.status);
    const qs = searchParams.toString();
    return fetchApi<ImportJobWithBook[]>(`/import-jobs${qs ? `?${qs}` : ''}`);
  },
};
