import { ApiError } from '@/lib/api';

/**
 * Match-phase failure recovery contract (#1864). Extracted from the engine so the
 * classification, the closed `PausedReason` union, and the reason→copy mapping are
 * pure and independently testable (the shared banner and its tests consume these).
 */

/** How many retries follow the initial attempt on a retryable poll failure (§1). */
export const MATCH_RETRY_LIMIT = 3;
/** Base backoff between serialized retry polls (~10-15s over 1 + 3 attempts, §1). */
export const MATCH_RETRY_BACKOFF_MS = 3000;
/** Interval between live status polls of an active job. */
export const MATCH_POLL_INTERVAL_MS = 2000;

/**
 * Transport/lifecycle classification of a rejected poll or probe (§1). Per-book
 * metadata failures never reach here — they are contained server-side.
 * - `transport` — fetch rejected with no HTTP status (network layer). Retryable.
 * - `server`    — 5xx. Retryable.
 * - `gone`      — 404. Deterministic "job gone"; never retried (§2).
 * - `rejected`  — any other 4xx. Never retried; pauses `request-rejected`.
 */
export type PollErrorClass = 'transport' | 'server' | 'gone' | 'rejected';

export function classifyPollError(error: unknown): PollErrorClass {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'gone';
    if (error.status >= 500) return 'server';
    if (error.status >= 400) return 'rejected';
    // A non-4xx/5xx ApiError is not a normal outcome — treat as transport so it
    // still gets the bounded retry rather than a silent dead-end.
    return 'transport';
  }
  return 'transport';
}

/** A retryable class (bounded backoff) vs a non-retryable one (short-circuit). */
export function isRetryableClass(cls: PollErrorClass): boolean {
  return cls === 'transport' || cls === 'server';
}

/**
 * Closed union — every pause path maps to exactly one member, and every member
 * maps to exactly one user-facing detail string (§5a). Asserted total in tests.
 */
export type PausedReason =
  | 'start-failed'
  | 'unreachable'
  | 'request-rejected'
  | 'run-expired'
  | 'cancelled';

/**
 * Total reason→detail mapping. Domain copy ONLY — book counts, never raw
 * error/server text and none of the forbidden vocabulary ("chunk", "job",
 * "poll", "404", "HTTP", status codes). Asserted in the shared banner's tests.
 */
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

/** Recovery state surfaced by `useMatchJob`, superseding the old bare `error` string. */
export interface MatchPausedState {
  paused: boolean;
  reason: PausedReason | null;
  /** Original candidates with no observed result yet — the resume target count. */
  remaining: number;
  /** Observed results so far across the whole logical run. */
  matchedCount: number;
  /** The logical run's original candidate count. */
  total: number;
}
