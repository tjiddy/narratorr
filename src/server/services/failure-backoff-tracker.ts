/**
 * The cross-attempt backoff, terminal stop and generation fencing shared by every connector
 * breaker: notifier delivery (#2312) and indexer search (#2376).
 *
 * In-memory and keyed by row id, mirroring the AdapterCache each owning service already evicts
 * on update/delete. Deliberately NOT persisted: a restart clears `stopped`, the connector gets
 * one attempt on the next call, a genuinely terminal failure re-commits immediately, and the
 * health roster reports `error` again within one five-minute cycle — so nothing is hidden and a
 * connector repaired during downtime gets to prove it.
 */

/** Ordered by severity: ok < backing-off < stopped. */
export type FailureState = 'ok' | 'backing-off' | 'stopped';

export interface FailureSnapshot {
  state: FailureState;
  consecutiveFailures: number;
  /** Epoch ms; an attempt is allowed only at or after it. Never scheduled by a timer. */
  nextAttemptAt: number;
  suppressedCount: number;
  suppressedSince: number | null;
  /** Operator-language reason for the most recent failure. */
  reason: string | null;
}

export interface FailureTrackerOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Consecutive-failure count that promotes straight to `stopped`. Omitted means only an
   * explicitly terminal failure can stop the connector — unbounded backoff alone eventually
   * produces retries so rare they look like a hang, which is why the indexer breaker sets it.
   */
  stopAfterConsecutiveFailures?: number | undefined;
  now?: (() => number) | undefined;
}

const PRISTINE: FailureSnapshot = {
  state: 'ok',
  consecutiveFailures: 0,
  nextAttemptAt: 0,
  suppressedCount: 0,
  suppressedSince: null,
  reason: null,
};

export function computeBackoffDelayMs(consecutiveFailures: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(baseDelayMs * 2 ** exponent, maxDelayMs);
}

export class FailureTracker {
  // A connector in `ok` holds no entry, so the common path allocates nothing.
  private entries = new Map<number, FailureSnapshot>();
  // Bumped whenever an entry is invalidated, so an in-flight attempt from the previous
  // lifetime cannot commit its outcome — otherwise an attempt that started before an operator
  // repair could re-stop a connector the operator has just fixed.
  private generations = new Map<number, number>();
  private now: () => number;

  constructor(private options: FailureTrackerOptions) {
    this.now = options.now ?? Date.now;
  }

  backoffDelayMs(consecutiveFailures: number): number {
    return computeBackoffDelayMs(consecutiveFailures, this.options.baseDelayMs, this.options.maxDelayMs);
  }

  get(id: number): FailureSnapshot {
    return { ...(this.entries.get(id) ?? PRISTINE) };
  }

  /** Read at reserve time and passed back at commit time to detect an intervening clear. */
  generation(id: number): number {
    return this.generations.get(id) ?? 0;
  }

  /**
   * The attempt gate, and — at a reopened gate — the reservation.
   *
   * Callers must invoke this BEFORE their first `await`: two attempts that both find the window
   * open would otherwise both read `now >= nextAttemptAt` before either wrote, and both would
   * dispatch, hammering the very server the backoff exists to spare. Advancing the gate here
   * makes the sibling's own check fail; the attempt's real outcome supersedes the reservation
   * and computes the same instant, so the 1, 2, 4, 8 … sequence is unaffected.
   *
   * Never applied in `ok`: reserving on the healthy path would serialize ordinary traffic.
   */
  reserveAttempt(id: number): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.state === 'ok') return true;

    if (entry.state === 'stopped') {
      this.countSuppressed(entry);
      return false;
    }

    const now = this.now();
    if (now < entry.nextAttemptAt) {
      this.countSuppressed(entry);
      return false;
    }

    entry.nextAttemptAt = now + this.backoffDelayMs(entry.consecutiveFailures + 1);
    return true;
  }

  /** An attempt may raise severity, never lower it — except a success out of `backing-off`. */
  recordSuccess(id: number, generation?: number): void {
    if (this.isStale(id, generation)) return;
    const entry = this.entries.get(id);
    if (!entry || entry.state === 'stopped') return;
    this.entries.delete(id);
  }

  recordTransientFailure(id: number, reason: string, generation?: number): void {
    if (this.isStale(id, generation)) return;
    const entry = this.entryFor(id);
    if (entry.state === 'stopped') return;
    entry.consecutiveFailures += 1;
    entry.reason = reason;
    const stopAfter = this.options.stopAfterConsecutiveFailures;
    const promote = stopAfter !== undefined && entry.consecutiveFailures >= stopAfter;
    entry.state = promote ? 'stopped' : 'backing-off';
    // A stop carries no schedule: no elapsed time reopens the gate, so a delay would be a lie.
    entry.nextAttemptAt = promote ? 0 : this.now() + this.backoffDelayMs(entry.consecutiveFailures);
  }

  /** No backoff schedule: retrying cannot succeed, and spacing attempts only delays discovery. */
  recordTerminalFailure(id: number, reason: string, generation?: number): void {
    if (this.isStale(id, generation)) return;
    const entry = this.entryFor(id);
    entry.state = 'stopped';
    entry.consecutiveFailures += 1;
    entry.reason = reason;
    entry.nextAttemptAt = 0;
  }

  clear(id: number): void {
    this.generations.set(id, this.generation(id) + 1);
    this.entries.delete(id);
  }

  clearAll(): void {
    for (const id of [...this.entries.keys()]) this.clear(id);
    this.entries.clear();
  }

  private isStale(id: number, generation: number | undefined): boolean {
    return generation !== undefined && generation !== this.generation(id);
  }

  private entryFor(id: number): FailureSnapshot {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const created = { ...PRISTINE };
    this.entries.set(id, created);
    return created;
  }

  private countSuppressed(entry: FailureSnapshot): void {
    entry.suppressedCount += 1;
    entry.suppressedSince ??= this.now();
  }
}
