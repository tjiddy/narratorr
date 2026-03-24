import { fetchApi } from './client.js';

export interface RecyclingBinEntry {
  id: number;
  bookId: number | null;
  title: string;
  authorName: string[] | null;
  authorAsin: string | null;
  narrator: string[] | null;
  description: string | null;
  coverUrl: string | null;
  asin: string | null;
  isbn: string | null;
  seriesName: string | null;
  seriesPosition: number | null;
  duration: number | null;
  publishedDate: string | null;
  genres: string[] | null;
  monitorForUpgrades: boolean;
  originalPath: string;
  recyclePath: string;
  deletedAt: string;
}

export const recyclingBinApi = {
  getRecyclingBinEntries: () =>
    fetchApi<RecyclingBinEntry[]>('/system/recycling-bin'),
  restoreRecyclingBinEntry: (id: number) =>
    fetchApi<{ bookId: number }>(`/system/recycling-bin/${id}/restore`, { method: 'POST' }),
  purgeRecyclingBinEntry: (id: number) =>
    fetchApi<void>(`/system/recycling-bin/${id}`, { method: 'DELETE' }),
  emptyRecyclingBin: () =>
    fetchApi<{ purged: number; failed: number }>('/system/recycling-bin/empty', { method: 'POST' }),
};
