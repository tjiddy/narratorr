import { fetchApi } from './client.js';
import type { DownloadProtocol } from '@core/indexers/types.js';
import type { ClientStatus, DownloadStatus, PipelineStage, QualityGateReason } from '@shared/schemas.js';

export interface Download {
  id: number;
  bookId?: number | null;
  indexerId?: number | null;
  indexerName: string | null;
  downloadClientId?: number;
  title: string;
  protocol: DownloadProtocol;
  infoHash?: string;
  downloadUrl?: string;
  size?: number;
  seeders: number | null;
  /** Derived UI status; clientStatus and pipelineStage remain the two-axis truth. */
  status: DownloadStatus;
  clientStatus: ClientStatus;
  pipelineStage: PipelineStage;
  /** Present only for pending_review. */
  qualityGate?: QualityGateData;
  progress: number;
  /** SSE-only bytes/sec: nullish means unreported; zero means active but stalled. */
  downloadSpeed?: number | null;
  externalId?: string;
  errorMessage?: string;
  addedAt: string;
  completedAt: string | null;
}

export type QualityGateData = QualityGateReason;

export interface ActivityCounts {
  active: number;
  completed: number;
}

export type RetryResponse =
  | Download
  | { status: 'no_candidates' }
  | { status: 'retry_error' }
  | { status: 'already_active' };

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
