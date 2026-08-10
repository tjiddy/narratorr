import { fetchApi } from './client.js';
import type {
  AttentionResponse,
  CreateSubmissionBody,
  PutItemsBody,
  SubmissionBulkDeleteResponse,
  SubmissionListResponse,
  SubmissionResponse,
  SubmissionSource,
} from '@core/import-staging/schemas.js';

export type {
  AttentionResponse,
  AttentionSubmission,
  SubmissionAttention,
  CreateSubmissionBody,
  PutItemsBody,
  PutItemRow,
  SubmissionBulkDeleteResponse,
  SubmissionListResponse,
  SubmissionResponse,
  SubmissionSummary,
  StagedItemResultDto,
  StagedImportItem,
  SubmissionAggregates,
} from '@core/import-staging/schemas.js';

export interface ImportSubmissionListParams {
  source?: SubmissionSource;
  limit?: number;
  offset?: number;
}

/** Durable import-report transport; every read returns JSON, never 204. */
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
  /** Deletes one run: an abandoned upload from the attention banner, or a finished run from history. */
  discardImportSubmission: (id: number) =>
    fetchApi<{ success: true }>(`/import/submissions/${id}`, { method: 'DELETE' }),
  /** Clears every fully-clean completed run; the server decides eligibility and reports the ids it removed. */
  clearCompletedImportSubmissions: () =>
    fetchApi<SubmissionBulkDeleteResponse>('/import/submissions', { method: 'DELETE' }),

  /** Create-or-return by clientSubmissionId. */
  createImportSubmission: (body: CreateSubmissionBody) =>
    fetchApi<SubmissionResponse>('/import/submissions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Inert chunk upload, idempotent per ordinal. */
  putImportSubmissionItems: (id: number, body: PutItemsBody) =>
    fetchApi<SubmissionResponse>(`/import/submissions/${id}/items`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Digest-verified CAS from receiving to processing. */
  finalizeImportSubmission: (id: number) =>
    fetchApi<SubmissionResponse>(`/import/submissions/${id}/finalize`, { method: 'POST' }),
  /** Summary or one-time detail read by id. */
  getImportSubmission: (id: number, includeItems = false) =>
    fetchApi<SubmissionResponse>(`/import/submissions/${id}?includeItems=${includeItems}`),
  /** Recovery lookup by clientSubmissionId, with the same summary/detail arms. */
  getImportSubmissionByClientId: (clientSubmissionId: string, includeItems = false) =>
    fetchApi<SubmissionResponse>(`/import/submissions/by-client/${clientSubmissionId}?includeItems=${includeItems}`),
};
