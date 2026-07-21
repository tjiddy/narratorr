import { ApiError, type Api, type SubmissionResponse } from '@/lib/api';
import { runWithRetry, type RetryOptions } from './retry.js';
import type { StagedBannerKey } from './messages.js';

/**
 * Processing-poll lifecycle for a finalized submission (#1902, F2/F62/F65/F67/F68).
 *
 * Polls the SUMMARY (`includeItems=false`) at {@link POLL_INTERVAL_MS}, SINGLE-FLIGHT:
 * a tick that fires while a poll / its backoff / the terminal detail chain is still
 * active is skipped (a `busy` guard over `setInterval`, mirroring the match-engine
 * scheduler). On `status='complete'` exactly ONE terminal DETAIL fetch
 * (`includeItems=true`) runs — a second `complete` observation from a queued tick
 * cannot launch a duplicate. Transient failures retry per the shared constants; an
 * epoch/abort guard discards results from a stopped chain so a late resolve can't
 * clobber newer state.
 *
 * Failure copy is state-accurate: a processing-poll transport exhaustion says the run
 * CONTINUES on the server (hint retained); a terminal-detail exhaustion says the
 * import FINISHED but its results failed to load (hint retained, reattempt on
 * remount); a finalized (processing/complete) 404 is an invariant/data-loss error,
 * surfaced once, then the hint auto-evicts.
 */

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
      // A finalized header is never GC'd, so a 404 on the terminal-detail arm is the SAME
      // invariant/data-loss signal as a summary-poll 404 (F3): surface `finalizedMissing`
      // once, evict the now-dead hint, and stop — not a retryable results-load failure.
      if (error instanceof ApiError && error.status === 404) {
        onBanner('finalizedMissing');
        onEvictHint?.();
        stop();
        return;
      }
      // Otherwise the import IS done; only its results failed to load. Hint retained, reattempt on remount.
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
        clearTimer(); // the detail chain supersedes polling
        await runTerminalDetail();
      }
    } catch (error: unknown) {
      if (stopped) return;
      if (error instanceof ApiError && error.status === 404) {
        // A finalized header is never GC'd → a 404 is invariant/data-loss. Surface once, evict.
        onBanner('finalizedMissing');
        onEvictHint?.();
        stop();
        return;
      }
      // Transport/5xx/429 exhaustion → the run continues server-side; hint retained.
      onBanner('pollLostContact');
      stop();
    } finally {
      busy = false;
    }
  }

  const start = () => {
    if (stopped || intervalId !== undefined) return;
    intervalId = setInterval(() => void tick(), POLL_INTERVAL_MS);
    void tick(); // immediate first poll
  };

  return { start, stop };
}
