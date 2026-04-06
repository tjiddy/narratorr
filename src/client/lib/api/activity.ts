import { fetchApi } from './client.js';
import type { DownloadStatus } from '../../../shared/schemas.js';

export interface Download {
  id: number;
  bookId?: number | null;
  indexerId?: number | null;
  indexerName: string | null;
  downloadClientId?: number;
  title: string;
  protocol: 'torrent' | 'usenet';
  infoHash?: string;
  downloadUrl?: string;
  size?: number;
  seeders: number | null;
  status: DownloadStatus;
  /** Quality gate comparison data, present when status is pending_review */
  qualityGate?: QualityGateData;
  progress: number;
  externalId?: string;
  errorMessage?: string;
  addedAt: string;
  completedAt: string | null;
}

export interface QualityGateData {
  action: 'imported' | 'rejected' | 'held';
  mbPerHour: number | null;
  existingMbPerHour: number | null;
  narratorMatch: boolean | null;
  existingNarrator: string | null;
  downloadNarrator: string | null;
  durationDelta: number | null;
  existingDuration: number | null;
  downloadedDuration: number | null;
  codec: string | null;
  channels: number | null;
  existingCodec: string | null;
  existingChannels: number | null;
  probeFailure: boolean;
  probeError: string | null;
  holdReasons: string[];
}

export interface ActivityCounts {
  active: number;
  completed: number;
}

export type RetryResponse = Download | { status: 'no_candidates' } | { status: 'retry_error' };

export interface ActivityListParams {
  status?: string;
  section?: 'queue' | 'history';
  limit?: number;
  offset?: number;
}

export const activityApi = {
  getActivity: (params?: ActivityListParams) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set('status', params.status);
    if (params?.section) searchParams.set('section', params.section);
    if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
    if (params?.offset !== undefined) searchParams.set('offset', String(params.offset));
    const qs = searchParams.toString();
    return fetchApi<{ data: Download[]; total: number }>(`/activity${qs ? `?${qs}` : ''}`);
  },
  getActiveDownloads: () => fetchApi<Download[]>('/activity/active'),
  getActivityCounts: () => fetchApi<ActivityCounts>('/activity/counts'),
  cancelDownload: (id: number) =>
    fetchApi<{ success: boolean }>(`/activity/${id}`, { method: 'DELETE' }),
  retryDownload: (id: number) =>
    fetchApi<RetryResponse>(`/activity/${id}/retry`, { method: 'POST' }),
  approveDownload: (id: number) =>
    fetchApi<{ id: number; status: string }>(`/activity/${id}/approve`, { method: 'POST' }),
  rejectDownload: (id: number, options?: { retry?: boolean }) =>
    fetchApi<{ id: number; status: string }>(`/activity/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ retry: options?.retry ?? false }),
      headers: { 'Content-Type': 'application/json' },
    }),
  deleteHistoryDownload: (id: number) =>
    fetchApi<{ success: boolean }>(`/activity/${id}/history`, { method: 'DELETE' }),
  deleteDownloadHistory: () =>
    fetchApi<{ deleted: number }>('/activity/history', { method: 'DELETE' }),
};
