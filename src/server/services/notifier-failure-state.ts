/**
 * Per-notifier delivery state: the cross-event backoff and terminal stop that keep a broken
 * notification channel from failing silently (#2312).
 *
 * In-memory and keyed by notifier row id, mirroring the AdapterCache that NotifierService
 * already evicts on update/delete. Deliberately NOT persisted: a restart clears `stopped`,
 * the notifier attempts once on the next event, a genuinely terminal failure re-commits
 * immediately, and the health roster reports `error` again within one five-minute cycle —
 * so nothing is hidden and a channel repaired during downtime gets to prove it.
 */

/** One minute — below the five-minute health cadence, so a recovery is visible within one cycle. */
export const NOTIFIER_BACKOFF_BASE_MS = 60_000;
/** One hour — the bound of the doubling schedule (1, 2, 4, 8, 16, 32, 60, 60 … minutes). */
export const NOTIFIER_BACKOFF_MAX_MS = 3_600_000;
/** A transient blip is not worth an operator alert; three consecutive is. */
export const NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES = 3;

/** Ordered by severity: ok < backing-off < stopped. */
export type NotifierDeliveryState = 'ok' | 'backing-off' | 'stopped';

export interface NotifierFailureSnapshot {
  state: NotifierDeliveryState;
  consecutiveFailures: number;
  /** Epoch ms; an attempt is allowed only at or after it. Never scheduled by a timer. */
  nextAttemptAt: number;
  suppressedCount: number;
  suppressedSince: number | null;
  /** Operator-language reason for the most recent failure. */
  reason: string | null;
}

const PRISTINE: NotifierFailureSnapshot = {
  state: 'ok',
  consecutiveFailures: 0,
  nextAttemptAt: 0,
  suppressedCount: 0,
  suppressedSince: null,
  reason: null,
};

export function backoffDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(NOTIFIER_BACKOFF_BASE_MS * 2 ** exponent, NOTIFIER_BACKOFF_MAX_MS);
}

export class NotifierFailureTracker {
  // A notifier in `ok` holds no entry, so the common path allocates nothing.
  private entries = new Map<number, NotifierFailureSnapshot>();

  constructor(private now: () => number = Date.now) {}

  get(id: number): NotifierFailureSnapshot {
    return { ...(this.entries.get(id) ?? PRISTINE) };
  }

  /**
   * The attempt gate, and — at a reopened gate — the reservation.
   *
   * Callers must invoke this BEFORE their first `await`: two `notify()` calls that both find
   * the window open would otherwise both read `now >= nextAttemptAt` before either wrote, and
   * both would send, hammering the very server the backoff exists to spare. Advancing the gate
   * here makes the sibling's own check fail; the attempt's real outcome supersedes the
   * reservation, so the 1, 2, 4, 8 … sequence is unaffected.
   *
   * Never applied in `ok`: reserving on the healthy path would drop legitimate notifications.
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

    entry.nextAttemptAt = now + backoffDelayMs(entry.consecutiveFailures + 1);
    return true;
  }

  /** An attempt may raise severity, never lower it — except a success out of `backing-off`. */
  recordSuccess(id: number): void {
    const entry = this.entries.get(id);
    if (!entry || entry.state === 'stopped') return;
    this.entries.delete(id);
  }

  recordTransientFailure(id: number, reason: string): void {
    const entry = this.entryFor(id);
    if (entry.state === 'stopped') return;
    entry.state = 'backing-off';
    entry.consecutiveFailures += 1;
    entry.reason = reason;
    entry.nextAttemptAt = this.now() + backoffDelayMs(entry.consecutiveFailures);
  }

  /** No backoff schedule: retrying cannot succeed, and spacing attempts only delays discovery. */
  recordTerminalFailure(id: number, reason: string): void {
    const entry = this.entryFor(id);
    entry.state = 'stopped';
    entry.consecutiveFailures += 1;
    entry.reason = reason;
    entry.nextAttemptAt = 0;
  }

  clear(id: number): void {
    this.entries.delete(id);
  }

  clearAll(): void {
    this.entries.clear();
  }

  private entryFor(id: number): NotifierFailureSnapshot {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const created = { ...PRISTINE };
    this.entries.set(id, created);
    return created;
  }

  private countSuppressed(entry: NotifierFailureSnapshot): void {
    entry.suppressedCount += 1;
    entry.suppressedSince ??= this.now();
  }
}

export interface NotifierDeliveryHealth {
  state: 'healthy' | 'warning' | 'error';
  message?: string;
}

/** Map delivery state onto the existing three-value HealthState; no new literal is introduced. */
export function describeNotifierDelivery(snapshot: NotifierFailureSnapshot): NotifierDeliveryHealth {
  const { suppressedCount, suppressedSince } = snapshot;
  const suppressed = suppressedCount > 0 && suppressedSince !== null
    ? ` ${suppressedCount} notification${suppressedCount === 1 ? '' : 's'} suppressed since ${new Date(suppressedSince).toISOString()}.`
    : '';

  if (snapshot.state === 'stopped') {
    return {
      state: 'error',
      message: `Delivery stopped: ${snapshot.reason ?? 'the notifier failed permanently'}.${suppressed}`,
    };
  }
  if (snapshot.consecutiveFailures >= NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES) {
    return {
      state: 'warning',
      message: `${snapshot.consecutiveFailures} consecutive delivery failures: ${snapshot.reason ?? 'delivery is failing'}.${suppressed}`,
    };
  }
  return { state: 'healthy' };
}
