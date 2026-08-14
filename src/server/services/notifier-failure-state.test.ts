import { describe, it, expect } from 'vitest';
import {
  NotifierFailureTracker,
  describeNotifierDelivery,
  backoffDelayMs,
  NOTIFIER_BACKOFF_BASE_MS,
  NOTIFIER_BACKOFF_MAX_MS,
  NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES,
} from './notifier-failure-state.js';

const MINUTE = 60_000;

/** A hand-driven clock: the schedule is computed arithmetic, so no fake timers are needed. */
function makeTracker(start = 1_000_000) {
  const clock = { now: start };
  const tracker = new NotifierFailureTracker(() => clock.now);
  return { tracker, clock };
}

describe('backoffDelayMs (#2312 AC8)', () => {
  it('doubles from the base and clamps at the bound: 1, 2, 4, 8, 16, 32, 60, 60 minutes', () => {
    const sequence = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n) / MINUTE);
    expect(sequence).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it('uses the bound exactly at the clamp boundary and does not overflow past it', () => {
    expect(backoffDelayMs(7)).toBe(NOTIFIER_BACKOFF_MAX_MS);
    expect(backoffDelayMs(8)).toBe(NOTIFIER_BACKOFF_MAX_MS);
    expect(backoffDelayMs(80)).toBe(NOTIFIER_BACKOFF_MAX_MS);
  });

  it('starts at the base for the first failure', () => {
    expect(backoffDelayMs(1)).toBe(NOTIFIER_BACKOFF_BASE_MS);
  });
});

describe('NotifierFailureTracker — the transient path (#2312 AC8)', () => {
  it('starts every unknown notifier in ok and lets it attempt', () => {
    const { tracker } = makeTracker();
    expect(tracker.get(1).state).toBe('ok');
    expect(tracker.reserveAttempt(1)).toBe(true);
  });

  it('enters backing-off on the first transient failure with the base gate', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTransientFailure(1, 'the server reported a temporary error');

    expect(tracker.get(1)).toMatchObject({
      state: 'backing-off',
      consecutiveFailures: 1,
      nextAttemptAt: clock.now + NOTIFIER_BACKOFF_BASE_MS,
      suppressedCount: 0,
    });
  });

  it('suppresses and counts every event that arrives before the gate reopens', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');

    clock.now += 30_000;
    expect(tracker.reserveAttempt(1)).toBe(false);
    expect(tracker.reserveAttempt(1)).toBe(false);
    expect(tracker.reserveAttempt(1)).toBe(false);

    expect(tracker.get(1).suppressedCount).toBe(3);
    expect(tracker.get(1).suppressedSince).toBe(clock.now);
  });

  it('lets exactly one attempt through once the gate reopens', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');

    clock.now += NOTIFIER_BACKOFF_BASE_MS;
    expect(tracker.reserveAttempt(1)).toBe(true);
    // The reservation is written synchronously, so a concurrent caller fails its own check.
    expect(tracker.reserveAttempt(1)).toBe(false);
    expect(tracker.get(1).suppressedCount).toBe(1);
  });

  it('only the winner of a reopened gate commits an outcome, so no rung is skipped', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');

    clock.now += NOTIFIER_BACKOFF_BASE_MS;
    const winner = tracker.reserveAttempt(1);
    const loser = tracker.reserveAttempt(1);
    expect([winner, loser]).toEqual([true, false]);

    tracker.recordTransientFailure(1, 'boom');
    expect(tracker.get(1).consecutiveFailures).toBe(2);
    expect(tracker.get(1).nextAttemptAt).toBe(clock.now + 2 * MINUTE);
  });

  it('walks the rungs one failure at a time', () => {
    const { tracker, clock } = makeTracker();
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      tracker.recordTransientFailure(1, 'boom');
      delays.push(tracker.get(1).nextAttemptAt - clock.now);
    }
    expect(delays).toEqual([1 * MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE]);
  });

  it('resets counters, gate and suppression on the first success from backing-off', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');
    tracker.recordTransientFailure(1, 'boom');
    clock.now += 10;
    tracker.reserveAttempt(1);

    tracker.recordSuccess(1);
    expect(tracker.get(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0, suppressedCount: 0 });

    // The next failure starts the schedule over rather than continuing the old streak.
    tracker.recordTransientFailure(1, 'boom');
    expect(tracker.get(1).nextAttemptAt - clock.now).toBe(NOTIFIER_BACKOFF_BASE_MS);
  });

  it('two concurrent transient outcomes from ok count as two real failures', () => {
    const { tracker, clock } = makeTracker();
    expect(tracker.reserveAttempt(1)).toBe(true);
    expect(tracker.reserveAttempt(1)).toBe(true);

    tracker.recordTransientFailure(1, 'boom');
    tracker.recordTransientFailure(1, 'boom');

    expect(tracker.get(1).consecutiveFailures).toBe(2);
    expect(tracker.get(1).nextAttemptAt - clock.now).toBe(2 * MINUTE);
  });
});

describe('NotifierFailureTracker — the terminal path (#2312 AC9)', () => {
  it('stops immediately on a terminal failure with no gate to wait out', () => {
    const { tracker } = makeTracker();
    tracker.recordTerminalFailure(1, 'authentication rejected — check credentials');

    expect(tracker.get(1)).toMatchObject({
      state: 'stopped',
      reason: 'authentication rejected — check credentials',
    });
  });

  it('never attempts again while stopped, counting each skipped notification', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTerminalFailure(1, 'nope');

    clock.now += 10 * 60 * MINUTE;
    for (let i = 0; i < 5; i += 1) expect(tracker.reserveAttempt(1)).toBe(false);
    expect(tracker.get(1).suppressedCount).toBe(5);
  });

  it('promotes a backing-off notifier to stopped on a terminal failure', () => {
    const { tracker } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');
    tracker.recordTerminalFailure(1, 'nope');
    expect(tracker.get(1).state).toBe('stopped');
  });
});

describe('NotifierFailureTracker — outcome arbitration (#2312)', () => {
  it.each([
    ['terminal then transient', ['terminal', 'transient']],
    ['transient then terminal', ['transient', 'terminal']],
    ['terminal then success', ['terminal', 'success']],
    ['success then terminal', ['success', 'terminal']],
  ] as const)('%s settles at stopped regardless of completion order', (_label, order) => {
    const { tracker } = makeTracker();
    for (const outcome of order) {
      if (outcome === 'terminal') tracker.recordTerminalFailure(1, 'nope');
      else if (outcome === 'transient') tracker.recordTransientFailure(1, 'boom');
      else tracker.recordSuccess(1);
    }
    expect(tracker.get(1).state).toBe('stopped');
  });

  it('success then transient leaves a streak of one at the first rung', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordSuccess(1);
    tracker.recordTransientFailure(1, 'boom');

    expect(tracker.get(1)).toMatchObject({ state: 'backing-off', consecutiveFailures: 1 });
    expect(tracker.get(1).nextAttemptAt - clock.now).toBe(NOTIFIER_BACKOFF_BASE_MS);
  });

  it('transient then success is the ordinary recovery reset', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');
    tracker.recordSuccess(1);

    expect(tracker.get(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0, suppressedCount: 0 });
    tracker.recordTransientFailure(1, 'boom');
    expect(tracker.get(1).nextAttemptAt - clock.now).toBe(NOTIFIER_BACKOFF_BASE_MS);
  });

  it('reads healthy in both success/transient orders — the order-independent observable', () => {
    const a = makeTracker().tracker;
    a.recordSuccess(1);
    a.recordTransientFailure(1, 'boom');
    const b = makeTracker().tracker;
    b.recordTransientFailure(1, 'boom');
    b.recordSuccess(1);

    expect(describeNotifierDelivery(a.get(1)).state).toBe('healthy');
    expect(describeNotifierDelivery(b.get(1)).state).toBe('healthy');
  });

  it('stopped absorbs a late success or transient commit from an in-flight sibling', () => {
    const { tracker } = makeTracker();
    tracker.recordTerminalFailure(1, 'nope');

    tracker.recordSuccess(1);
    expect(tracker.get(1).state).toBe('stopped');
    tracker.recordTransientFailure(1, 'boom');
    expect(tracker.get(1).state).toBe('stopped');
  });
});

describe('NotifierFailureTracker — identity and lifetime (#2312 AC10/AC11)', () => {
  it('keys state per notifier id, so two entries never merge', () => {
    const { tracker } = makeTracker();
    tracker.recordTerminalFailure(1, 'nope');
    tracker.recordTransientFailure(2, 'boom');

    expect(tracker.get(1).state).toBe('stopped');
    expect(tracker.get(2).state).toBe('backing-off');
    expect(tracker.get(3).state).toBe('ok');
  });

  it('clear() drops one entry and leaves its siblings alone', () => {
    const { tracker } = makeTracker();
    tracker.recordTerminalFailure(1, 'nope');
    tracker.recordTerminalFailure(2, 'nope');

    tracker.clear(1);
    expect(tracker.get(1).state).toBe('ok');
    expect(tracker.get(2).state).toBe('stopped');
  });

  it('clearAll() drops every entry so state cannot leak between suites', () => {
    const { tracker } = makeTracker();
    tracker.recordTerminalFailure(1, 'nope');
    tracker.recordTransientFailure(2, 'boom');

    tracker.clearAll();
    expect(tracker.get(1).state).toBe('ok');
    expect(tracker.get(2).state).toBe('ok');
  });

  it('a fresh tracker starts clean, so a restart re-probes rather than staying silently stopped', () => {
    const { tracker } = makeTracker();
    tracker.recordTerminalFailure(1, 'nope');

    const restarted = new NotifierFailureTracker(() => 0);
    expect(restarted.get(1).state).toBe('ok');
    expect(restarted.reserveAttempt(1)).toBe(true);
  });

  it('hands back a copy, so a caller cannot mutate tracked state through the snapshot', () => {
    const { tracker } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');

    const snapshot = tracker.get(1);
    snapshot.state = 'ok';
    snapshot.consecutiveFailures = 0;

    expect(tracker.get(1)).toMatchObject({ state: 'backing-off', consecutiveFailures: 1 });
  });
});

describe('describeNotifierDelivery (#2312 AC6)', () => {
  function streak(n: number, reason = 'the server reported a temporary error') {
    const { tracker } = makeTracker();
    for (let i = 0; i < n; i += 1) tracker.recordTransientFailure(1, reason);
    return tracker;
  }

  it('reports a notifier that has never fired as healthy with no message', () => {
    const { tracker } = makeTracker();
    expect(describeNotifierDelivery(tracker.get(1))).toEqual({ state: 'healthy' });
  });

  it('reports a recovered notifier as healthy', () => {
    const tracker = streak(4);
    tracker.recordSuccess(1);
    expect(describeNotifierDelivery(tracker.get(1)).state).toBe('healthy');
  });

  it('stays healthy one below the warn threshold', () => {
    const tracker = streak(NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES - 1);
    expect(describeNotifierDelivery(tracker.get(1)).state).toBe('healthy');
  });

  // AC8: suppressedCount is the delivery observable in EVERY state. A below-threshold streak
  // is still healthy, but the notifications it dropped must be visible on the card.
  it('names the suppressed notifications while still below the warn threshold', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTransientFailure(1, 'the server reported a temporary error');
    const suppressedAt = clock.now;
    for (let i = 0; i < 3; i += 1) tracker.reserveAttempt(1);

    const entry = describeNotifierDelivery(tracker.get(1));

    expect(entry.state).toBe('healthy');
    expect(entry.message).toBe(`3 notifications suppressed since ${new Date(suppressedAt).toISOString()}.`);
  });

  it('reports no message for a healthy notifier that has dropped nothing', () => {
    const tracker = streak(NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES - 1);
    expect(describeNotifierDelivery(tracker.get(1)).message).toBeUndefined();
  });

  it('keeps the warning reason and the suppression count in one message', () => {
    const { tracker, clock } = makeTracker();
    for (let i = 0; i < NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES; i += 1) {
      tracker.recordTransientFailure(1, 'the server reported a temporary error');
    }
    const suppressedAt = clock.now;
    tracker.reserveAttempt(1);

    expect(describeNotifierDelivery(tracker.get(1)).message).toBe(
      `3 consecutive delivery failures: the server reported a temporary error. `
      + `1 notification suppressed since ${new Date(suppressedAt).toISOString()}.`,
    );
  });

  it('warns at exactly the warn threshold, naming the streak and the reason', () => {
    const tracker = streak(NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES);
    const entry = describeNotifierDelivery(tracker.get(1));

    expect(entry.state).toBe('warning');
    expect(entry.message).toContain('3 consecutive delivery failures');
    expect(entry.message).toContain('the server reported a temporary error');
  });

  it('errors on a terminal stop, naming the reason in operator language not a raw code', () => {
    const { tracker } = makeTracker();
    tracker.recordTerminalFailure(1, 'authentication rejected — check credentials');
    const entry = describeNotifierDelivery(tracker.get(1));

    expect(entry).toEqual({
      state: 'error',
      message: 'Delivery stopped: authentication rejected — check credentials.',
    });
    expect(entry.message).not.toMatch(/\b(535|554|401)\b/);
  });

  it('names how much was lost once notifications have been suppressed', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTerminalFailure(1, 'nope');
    const suppressedAt = clock.now;
    for (let i = 0; i < 4; i += 1) tracker.reserveAttempt(1);

    const entry = describeNotifierDelivery(tracker.get(1));
    expect(entry.message).toBe(
      `Delivery stopped: nope. 4 notifications suppressed since ${new Date(suppressedAt).toISOString()}.`,
    );
  });

  it('uses the singular for a single suppressed notification', () => {
    const { tracker } = makeTracker();
    tracker.recordTerminalFailure(1, 'nope');
    tracker.reserveAttempt(1);
    expect(describeNotifierDelivery(tracker.get(1)).message).toContain('1 notification suppressed since');
  });
});
