import { ApiError, type Api } from '@/lib/api';
import { runWithRetry, withSignal, type RetryOptions } from './retry.js';

/**
 * Mount by-client reconciliation (#1902, F18/F25/F69). The stored outbox hint is a
 * best-effort pointer; on remount the tab looks the durable header up by
 * `clientSubmissionId` (summary arm) and routes by lifecycle:
 *  - `processing` → rejoin the poll;
 *  - `complete` → rejoin the poll, which triggers the one-time detail fetch + surface,
 *    the caller evicting the hint ONLY after that detail projection succeeds;
 *  - `receiving` → evict (an inert, safely re-runnable upload);
 *  - 404 → never-landed / expired → evict + safe re-run.
 *
 * The lookup ITSELF is subject to the retry contract: retryable classes (network /
 * 5xx / 429, `Retry-After` honored) retry per the shared constants with abort+epoch
 * guards; on exhaustion or a persistent non-404 error the lookup STOPS, the pointer is
 * RETAINED (never evicted on a failed lookup), and a recoverable banner shows. A 404
 * is NOT a lookup failure — it is the never-landed evict arm.
 */

export type ReconcileResult =
  | { action: 'rejoin'; submissionId: number; status: 'processing' | 'complete' }
  | { action: 'evict'; reason: 'receiving' | 'never-landed' }
  | { action: 'lookup-failed' } // pointer retained; caller shows the "reload to retry" banner
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
    // 404 is the lifecycle signal (never-landed / expired) — evict, not a lookup failure.
    if (error instanceof ApiError && error.status === 404) return { action: 'evict', reason: 'never-landed' };
    // Exhaustion or persistent non-404 → retain the pointer, recoverable banner.
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
