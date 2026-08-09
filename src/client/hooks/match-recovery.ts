import { ApiError } from '@/lib/api';

/** How many retries follow the initial attempt on a retryable poll failure (§1). */
export const MATCH_RETRY_LIMIT = 3;
/** Base backoff between serialized retry polls (~10-15s over 1 + 3 attempts, §1). */
export const MATCH_RETRY_BACKOFF_MS = 3000;
/** Interval between live status polls of an active job. */
export const MATCH_POLL_INTERVAL_MS = 2000;

// Network failures and 5xx retry; 404 (`gone`) and other 4xx (`rejected`) do not.
export type PollErrorClass = 'transport' | 'server' | 'gone' | 'rejected';

export function classifyPollError(error: unknown): PollErrorClass {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'gone';
    if (error.status >= 500) return 'server';
    if (error.status >= 400) return 'rejected';
    // An abnormal status gets the bounded transport retry instead of silently dead-ending.
    return 'transport';
  }
  return 'transport';
}

export function isRetryableClass(cls: PollErrorClass): boolean {
  return cls === 'transport' || cls === 'server';
}

// A closed union keeps every pause path mapped to one user-facing detail.
export type PausedReason =
  | 'start-failed'
  | 'unreachable'
  | 'request-rejected'
  | 'run-expired'
  | 'cancelled';

// Domain copy only: never expose raw errors, transport terms, or status codes.
export const PAUSED_REASON_DETAIL: Record<PausedReason, string> = {
  'start-failed': "We couldn't start matching the remaining books. Resume to try again.",
  unreachable: "The server couldn't be reached while matching. Resume to try again.",
  'request-rejected': 'The matching request was rejected. Resume to try again.',
  'run-expired': 'Matching ended before every book was checked. Resume to finish the rest.',
  cancelled: 'Matching was stopped. Resume to finish the remaining books.',
};

export function pausedReasonDetail(reason: PausedReason): string {
  return PAUSED_REASON_DETAIL[reason];
}

export interface MatchPausedState {
  paused: boolean;
  reason: PausedReason | null;
  remaining: number;
  matchedCount: number;
  total: number;
}
