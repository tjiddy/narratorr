/**
 * Per-indexer search state: the cross-search backoff and terminal stop that keep an unreachable
 * indexer from being retried indefinitely at full rate (#2376).
 *
 * The state machine is `failure-backoff-tracker.ts`, shared with the notifier breaker (#2312).
 * The one divergence is the count-based terminal promotion, injected here as an option: a
 * suppressed search merely waits, so an indexer earns a longer transient ladder than a notifier,
 * but an unbounded one eventually produces retries so rare they look like a hang.
 *
 * State is in-memory and keyed by `indexers.id` — `indexers.name` has no unique constraint and
 * is mutable through `IndexerService.update()`, so a name key would merge two same-named rows
 * and reset on rename. A restart clears every breaker and each indexer gets one probe; that is
 * correct behaviour, not a gap, and must not be "fixed" into a table.
 */
import { IndexerAuthError } from '@core/indexers/errors.js';
import { classifyFailure, describeTransportError } from '@core/utils/failure-classification.js';
import { getErrorMessage } from '../utils/error-message.js';
import {
  FailureTracker,
  computeBackoffDelayMs,
  type FailureSnapshot,
  type FailureState,
} from './failure-backoff-tracker.js';

/** One minute — below the five-minute health cadence, so recovery is never more than one cycle away. */
export const INDEXER_BACKOFF_BASE_MS = 60_000;
/** One hour — the bound of the doubling schedule (1, 2, 4, 8, 16, 32, 60 minutes). */
export const INDEXER_BACKOFF_MAX_MS = 3_600_000;
/** The 8th consecutive transient failure goes terminal; the 7th is the last that stays backing-off. */
export const INDEXER_STOP_AFTER_CONSECUTIVE_FAILURES = 8;

export type IndexerBreakerState = FailureState;
export type IndexerFailureSnapshot = FailureSnapshot;

/** A breaker that is not `ok` always carries a reason; this only satisfies the nullable type. */
const UNNAMED_REASON = 'the indexer is failing';

export function backoffDelayMs(consecutiveFailures: number): number {
  return computeBackoffDelayMs(consecutiveFailures, INDEXER_BACKOFF_BASE_MS, INDEXER_BACKOFF_MAX_MS);
}

export class IndexerFailureTracker extends FailureTracker {
  constructor(now: () => number = Date.now) {
    super({
      baseDelayMs: INDEXER_BACKOFF_BASE_MS,
      maxDelayMs: INDEXER_BACKOFF_MAX_MS,
      stopAfterConsecutiveFailures: INDEXER_STOP_AFTER_CONSECUTIVE_FAILURES,
      now,
    });
  }
}

export interface IndexerFailureVerdict {
  terminal: boolean;
  /** Operator language, safe to render on a health card — never a stack or a serialized throw. */
  reason: string;
}

/**
 * Terminal means only the operator can fix it. Today only `myanonamouse.ts` constructs
 * `IndexerAuthError`; the torznab/newznab/ABB adapters raise a plain `Error('HTTP 401: …')` from
 * `fetch.ts`, which deliberately takes the transient ladder. Broadening auth detection to bare
 * status codes is its own change and has not been made.
 */
export function classifyIndexerFailure(error: unknown): IndexerFailureVerdict {
  return { terminal: error instanceof IndexerAuthError, reason: reasonFor(error) };
}

/**
 * `mapNetworkError` already phrases transport throws as operator sentences ("Connection refused
 * on port 443"), so the thrown message is the reason. Only when there is none do we fall back to
 * the shared vocabulary, keyed on the transport CODE rather than the message text.
 */
function reasonFor(error: unknown): string {
  // Only an Error's own message is operator text; String(nonError) yields "[object Object]".
  // The `instanceof` guard stays (String(nonError) is '[object Object]'); only the Error arm is
  // routed, because this reason is operator-visible on the health page (#2604 AC6).
  const message = error instanceof Error ? getErrorMessage(error).trim() : '';
  if (message) return message;
  return classifyFailure(describeTransportError(error)).reason;
}

export interface IndexerSkip {
  indexerId: number;
  name: string;
  state: 'backing-off' | 'stopped';
  reason: string;
}

/** One wording for all three entry points, so a skip cannot read differently per surface. */
export function formatIndexerSkip(state: IndexerBreakerState, reason: string): string {
  return `Skipped — ${state}: ${reason}`;
}

/** The skip descriptor the aggregate path returns and the streaming path words through onError. */
export function describeIndexerSkip(indexerId: number, name: string, snapshot: IndexerFailureSnapshot): IndexerSkip {
  return {
    indexerId,
    name,
    state: snapshot.state === 'stopped' ? 'stopped' : 'backing-off',
    reason: snapshot.reason ?? UNNAMED_REASON,
  };
}

export interface IndexerBreakerHealth {
  state: 'error';
  message: string;
}

/**
 * Only a `stopped` breaker overrides the probe's own verdict on the health card. While
 * backing-off the probe just ran and its result is the fresher evidence; once stopped, searches
 * are suppressed indefinitely and that is the fact the operator has to see.
 */
export function describeIndexerBreaker(snapshot: IndexerFailureSnapshot): IndexerBreakerHealth | null {
  if (snapshot.state !== 'stopped') return null;
  const { suppressedCount, suppressedSince } = snapshot;
  const suppressed = suppressedCount > 0 && suppressedSince !== null
    ? ` ${suppressedCount} search${suppressedCount === 1 ? '' : 'es'} suppressed since ${new Date(suppressedSince).toISOString()}.`
    : '';
  return { state: 'error', message: `Searches stopped: ${snapshot.reason ?? UNNAMED_REASON}.${suppressed}` };
}
