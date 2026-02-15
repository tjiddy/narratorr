import { fetchApi } from './client.js';

export interface Download {
  id: number;
  bookId?: number;
  indexerId?: number;
  downloadClientId?: number;
  title: string;
  protocol: 'torrent' | 'usenet';
  infoHash?: string;
  downloadUrl?: string;
  size?: number;
  seeders?: number;
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'importing' | 'imported' | 'failed';
  progress: number;
  externalId?: string;
  errorMessage?: string;
  addedAt: string;
  completedAt?: string;
}

export interface ActivityCounts {
  active: number;
  completed: number;
}

export const activityApi = {
  getActivity: () => fetchApi<Download[]>('/activity'),
  getActiveDownloads: () => fetchApi<Download[]>('/activity/active'),
  getActivityCounts: () => fetchApi<ActivityCounts>('/activity/counts'),
  cancelDownload: (id: number) =>
    fetchApi<{ success: boolean }>(`/activity/${id}`, { method: 'DELETE' }),
  retryDownload: (id: number) =>
    fetchApi<Download>(`/activity/${id}/retry`, { method: 'POST' }),
};
