import { ApiError, type Api, type SubmissionResponse } from '@/lib/api';
import { runWithRetry, type RetryOptions } from './retry.js';
import type { StagedBannerKey } from './messages.js';

// Summary polling is single-flight; the first complete result stops polling and fetches detail once.
// Finalized 404s evict as data loss; other exhausted summary/detail requests retain the hint.

export const POLL_INTERVAL_MS = 2_000;

type PollApi = Pick<Api, 'getImportSubmission'>;

export interface PollControllerDeps {
  api: PollApi;
  submissionId: number;
  retry?: Omit<RetryOptions, 'signal'>;
  /** Live summary snapshot each successful poll — drives "Registering X of Y…". */
  onSummary?: (summary: SubmissionResponse) => void;
  /** The one successful terminal-detail projection. */
  onComplete: (detail: SubmissionResponse) => void | Promise<void>;
  /** Surface a pinned banner (poll lost-contact / detail-load-failed / finalized-missing). */
  onBanner: (key: StagedBannerKey) => void;
  /** Called on a finalized-404 invariant so the caller evicts the (now-dead) hint. */
  onEvictHint?: () => void;
}

export interface PollController {
  start: () => void;
  stop: () => void;
}

export function createPollController(deps: PollControllerDeps): PollController {
  const { api, submissionId, retry, onSummary, onComplete, onBanner, onEvictHint } = deps;
  const abort = new AbortController();
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let completeHandled = false;
  let stopped = false;

  const clearTimer = () => {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
      intervalId = undefined;
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    clearTimer();
  };

  async function runTerminalDetail(): Promise<void> {
    try {
      const detail = await runWithRetry(() => api.getImportSubmission(submissionId, true), { ...retry, signal: abort.signal });
      if (stopped) return;
      await onComplete(detail);
    } catch (error: unknown) {
      if (stopped) return;
      // A finalized record cannot legitimately 404; evict the dead hint.
      if (error instanceof ApiError && error.status === 404) {
        onBanner('finalizedMissing');
        onEvictHint?.();
        stop();
        return;
      }
      // Import is complete; retain the hint so remount can retry detail.
      onBanner('detailLoadFailed');
    }
  }

  async function tick(): Promise<void> {
    if (stopped || busy || completeHandled) return;
    busy = true;
    try {
      const summary = await runWithRetry(() => api.getImportSubmission(submissionId, false), { ...retry, signal: abort.signal });
      if (stopped) return;
      onSummary?.(summary);
      if (summary.status === 'complete' && !completeHandled) {
        completeHandled = true;
        clearTimer();
        await runTerminalDetail();
      }
    } catch (error: unknown) {
      if (stopped) return;
      if (error instanceof ApiError && error.status === 404) {
        onBanner('finalizedMissing');
        onEvictHint?.();
        stop();
        return;
      }
      // The run continues server-side; retain the hint.
      onBanner('pollLostContact');
      stop();
    } finally {
      busy = false;
    }
  }

  const start = () => {
    if (stopped || intervalId !== undefined) return;
    intervalId = setInterval(() => void tick(), POLL_INTERVAL_MS);
    void tick();
  };

  return { start, stop };
}
