import { ApiError, type Api } from '@/lib/api';
import { runWithRetry, withSignal, type RetryOptions } from './retry.js';

// Resolve hints against durable headers: processing/complete rejoin; receiving/404 evict.
// Lookup failures retain the hint, while aborts publish nothing.

export type ReconcileResult =
  | { action: 'rejoin'; submissionId: number; status: 'processing' | 'complete' }
  | { action: 'evict'; reason: 'receiving' | 'never-landed' }
  | { action: 'lookup-failed' }
  | { action: 'aborted' };

export interface ReconcileParams {
  api: Pick<Api, 'getImportSubmissionByClientId'>;
  clientSubmissionId: string;
  retry?: RetryOptions;
  signal?: AbortSignal;
}

export async function reconcileByClient(params: ReconcileParams): Promise<ReconcileResult> {
  const { api, clientSubmissionId, retry, signal } = params;
  let summary;
  try {
    summary = await runWithRetry(() => api.getImportSubmissionByClientId(clientSubmissionId, false), withSignal(retry, signal));
  } catch (error: unknown) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return { action: 'aborted' };
    // 404 means never landed, not lookup failure.
    if (error instanceof ApiError && error.status === 404) return { action: 'evict', reason: 'never-landed' };
    // Retain the pointer after lookup failure.
    return { action: 'lookup-failed' };
  }

  switch (summary.status) {
    case 'receiving':
      return { action: 'evict', reason: 'receiving' };
    case 'processing':
    case 'complete':
      return { action: 'rejoin', submissionId: summary.id, status: summary.status };
    default:
      return { action: 'lookup-failed' };
  }
}
