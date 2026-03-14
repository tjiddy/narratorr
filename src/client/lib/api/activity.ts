import { fetchApi } from './client.js';
import type { DownloadStatus } from '../../../shared/schemas/activity.js';

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
  status: DownloadStatus;
  /** Quality gate comparison data, present when status is pending_review */
  qualityGate?: QualityGateData;
  progress: number;
  externalId?: string;
  errorMessage?: string;
  addedAt: string;
  completedAt?: string;
}

export interface QualityGateData {
  action: 'imported' | 'rejected' | 'held';
  mbPerHour: number | null;
  existingMbPerHour: number | null;
  narratorMatch: boolean | null;
  durationDelta: number | null;
  codec: string | null;
  channels: number | null;
  probeFailure: boolean;
  holdReasons: string[];
}

export interface ActivityCounts {
  active: number;
  completed: number;
}

export type RetryResponse = Download | { status: 'no_candidates' } | { status: 'retry_error' };

export const activityApi = {
  getActivity: (status?: string) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    const qs = params.toString();
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
  rejectDownload: (id: number, reason?: string) =>
    fetchApi<{ id: number; status: string }>(`/activity/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
      headers: { 'Content-Type': 'application/json' },
    }),
};
