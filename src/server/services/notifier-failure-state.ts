/**
 * Per-notifier delivery state: the cross-event backoff and terminal stop that keep a broken
 * notification channel from failing silently (#2312).
 *
 * The state machine itself lives in `failure-backoff-tracker.ts`, shared with the indexer
 * breaker (#2376 AC19). Only the constants and the health wording are notifier-specific: the
 * symbols stay separate from the indexer's so retuning one domain cannot retune the other,
 * even where the values coincide today.
 */
import {
  FailureTracker,
  computeBackoffDelayMs,
  type FailureSnapshot,
  type FailureState,
} from './failure-backoff-tracker.js';

/** One minute — below the five-minute health cadence, so a recovery is visible within one cycle. */
export const NOTIFIER_BACKOFF_BASE_MS = 60_000;
/** One hour — the bound of the doubling schedule (1, 2, 4, 8, 16, 32, 60, 60 … minutes). */
export const NOTIFIER_BACKOFF_MAX_MS = 3_600_000;
/** A transient blip is not worth an operator alert; three consecutive is. */
export const NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES = 3;

/** Ordered by severity: ok < backing-off < stopped. */
export type NotifierDeliveryState = FailureState;

export type NotifierFailureSnapshot = FailureSnapshot;

export function backoffDelayMs(consecutiveFailures: number): number {
  return computeBackoffDelayMs(consecutiveFailures, NOTIFIER_BACKOFF_BASE_MS, NOTIFIER_BACKOFF_MAX_MS);
}

/**
 * No count-based terminal promotion: only `classifyFailure` can stop a notifier, because a
 * suppressed notification is lost outright while a suppressed search merely waits.
 */
export class NotifierFailureTracker extends FailureTracker {
  constructor(now: () => number = Date.now) {
    super({ baseDelayMs: NOTIFIER_BACKOFF_BASE_MS, maxDelayMs: NOTIFIER_BACKOFF_MAX_MS, now });
  }
}

export interface NotifierDeliveryHealth {
  state: 'healthy' | 'warning' | 'error';
  message?: string;
}

/** Map delivery state onto the existing three-value HealthState; no new literal is introduced. */
export function describeNotifierDelivery(snapshot: NotifierFailureSnapshot): NotifierDeliveryHealth {
  const { suppressedCount, suppressedSince } = snapshot;
  // suppressedCount is the delivery observable: how much was lost, not merely that the
  // channel is unwell. It rides EVERY state — a one- or two-failure streak is still
  // `healthy` by AC6, but the notifications it dropped have to be visible on the card.
  const suppressed = suppressedCount > 0 && suppressedSince !== null
    ? `${suppressedCount} notification${suppressedCount === 1 ? '' : 's'} suppressed since ${new Date(suppressedSince).toISOString()}.`
    : '';

  if (snapshot.state === 'stopped') {
    return {
      state: 'error',
      message: join(`Delivery stopped: ${snapshot.reason ?? 'the notifier failed permanently'}.`, suppressed),
    };
  }
  if (snapshot.consecutiveFailures >= NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES) {
    return {
      state: 'warning',
      message: join(`${snapshot.consecutiveFailures} consecutive delivery failures: ${snapshot.reason ?? 'delivery is failing'}.`, suppressed),
    };
  }
  return suppressed ? { state: 'healthy', message: suppressed } : { state: 'healthy' };
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join(' ');
}
