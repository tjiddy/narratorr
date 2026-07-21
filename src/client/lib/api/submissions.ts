import { fetchApi } from './client.js';
import type {
  AttentionResponse,
  CreateSubmissionBody,
  PutItemsBody,
  SubmissionListResponse,
  SubmissionResponse,
  SubmissionSource,
} from '../../../core/import-staging/schemas.js';

export type {
  AttentionResponse,
  AttentionSubmission,
  SubmissionAttention,
  CreateSubmissionBody,
  PutItemsBody,
  PutItemRow,
  SubmissionListResponse,
  SubmissionResponse,
  SubmissionSummary,
  StagedItemResultDto,
  StagedImportItem,
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

  // ── Staged write + poll lane (#1902) ──────────────────────────────────────
  /** create-or-return by clientSubmissionId → the durable header (`receiving`). */
  createSubmission: (body: CreateSubmissionBody) =>
    fetchApi<SubmissionResponse>('/import/submissions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Inert chunked upload of `{ items: [{ ordinal, item }] }` (idempotent per ordinal). */
  putSubmissionItems: (id: number, body: PutItemsBody) =>
    fetchApi<SubmissionResponse>(`/import/submissions/${id}/items`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Digest-verified finalize; CAS-flips `receiving` → `processing`. */
  finalizeSubmission: (id: number) =>
    fetchApi<SubmissionResponse>(`/import/submissions/${id}/finalize`, { method: 'POST' }),
  /** Query-selected read by id — summary (`includeItems=false`) or one-time detail. */
  getSubmission: (id: number, includeItems = false) =>
    fetchApi<SubmissionResponse>(`/import/submissions/${id}?includeItems=${includeItems}`),
  /** by-client recovery lookup — same summary/detail arms as `getSubmission`. */
  getSubmissionByClientId: (clientSubmissionId: string, includeItems = false) =>
    fetchApi<SubmissionResponse>(`/import/submissions/by-client/${clientSubmissionId}?includeItems=${includeItems}`),
};
