import { fetchApi } from './client.js';
import type {
  AttentionResponse,
  SubmissionListResponse,
  SubmissionResponse,
  SubmissionSource,
} from '../../../core/import-staging/schemas.js';

export type {
  AttentionResponse,
  AttentionSubmission,
  SubmissionAttention,
  SubmissionListResponse,
  SubmissionResponse,
  SubmissionSummary,
  StagedItemResultDto,
  SubmissionAggregates,
} from '../../../core/import-staging/schemas.js';

export interface ImportSubmissionListParams {
  source?: SubmissionSource;
  limit?: number;
  offset?: number;
}

/**
 * Client wrapper over the durable import-report read side (#1894). The "latest"
 * panel read is just `listImportSubmissions({ source, limit: 1 })`. All reads
 * return a JSON body (never 204) so `fetchApi` can parse them.
 */
export const submissionsApi = {
  listImportSubmissions: (params?: ImportSubmissionListParams) => {
    const q = new URLSearchParams();
    if (params?.source) q.set('source', params.source);
    if (params?.limit !== undefined) q.set('limit', String(params.limit));
    if (params?.offset !== undefined) q.set('offset', String(params.offset));
    const qs = q.toString();
    return fetchApi<SubmissionListResponse>(`/import/submissions${qs ? `?${qs}` : ''}`);
  },
  getImportSubmissionAttention: (params?: { source?: SubmissionSource }) => {
    const q = new URLSearchParams();
    if (params?.source) q.set('source', params.source);
    const qs = q.toString();
    return fetchApi<AttentionResponse>(`/import/submissions/attention${qs ? `?${qs}` : ''}`);
  },
  getImportSubmissionDetail: (id: number) =>
    fetchApi<SubmissionResponse>(`/import/submissions/${id}?includeItems=true`),
  discardImportSubmission: (id: number) =>
    fetchApi<{ success: true }>(`/import/submissions/${id}`, { method: 'DELETE' }),
};
