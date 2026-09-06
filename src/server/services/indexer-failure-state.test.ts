import { describe, it, expect } from 'vitest';
import { IndexerAuthError } from '@core/indexers/errors.js';
import { expectNoLeak, makeLeakyDrizzleError } from '../__tests__/drizzle-error.fixture.js';
import {
  IndexerFailureTracker,
  backoffDelayMs,
  classifyIndexerFailure,
  describeIndexerBreaker,
  formatIndexerSkip,
  INDEXER_BACKOFF_BASE_MS,
  INDEXER_BACKOFF_MAX_MS,
  INDEXER_STOP_AFTER_CONSECUTIVE_FAILURES,
} from './indexer-failure-state.js';

const MINUTE = 60_000;

/** Hand-driven clock: `nextAttemptAt` is an epoch comparison, so no fake timers are needed. */
function makeTracker(start = 1_700_000_000_000) {
  const clock = { now: start };
  const tracker = new IndexerFailureTracker(() => clock.now);
  return { tracker, clock };
}

describe('backoffDelayMs (#2376 AC1)', () => {
  // Literals read off the AC1 table, never recomputed from the production expression.
  it.each([
    [1, 1],
    [2, 2],
    [3, 4],
    [4, 8],
    [5, 16],
    [6, 32],
    [7, 60],
    [8, 60],
  ])('failure %i schedules %i minute(s)', (failures, minutes) => {
    expect(backoffDelayMs(failures)).toBe(minutes * MINUTE);
  });

  it('binds the cap first at seven and never overflows past it', () => {
    expect(backoffDelayMs(6)).toBe(32 * MINUTE);
    expect(backoffDelayMs(7)).toBe(INDEXER_BACKOFF_MAX_MS);
    expect(backoffDelayMs(80)).toBe(INDEXER_BACKOFF_MAX_MS);
  });

  it('makes the first failure the base delay rather than double it', () => {
    expect(backoffDelayMs(0)).toBe(INDEXER_BACKOFF_BASE_MS);
    expect(backoffDelayMs(1)).toBe(INDEXER_BACKOFF_BASE_MS);
  });

  it('keeps the indexer constants as their own symbols even where the values coincide', () => {
    expect(INDEXER_BACKOFF_BASE_MS).toBe(MINUTE);
    expect(INDEXER_BACKOFF_MAX_MS).toBe(60 * MINUTE);
    expect(INDEXER_STOP_AFTER_CONSECUTIVE_FAILURES).toBe(8);
  });
});

describe('IndexerFailureTracker — the transient ladder (#2376 AC1, AC2)', () => {
  it('leaves a pristine indexer with no entry at all and lets it attempt', () => {
    const { tracker } = makeTracker();
    expect(tracker.get(1)).toEqual({
      state: 'ok',
      consecutiveFailures: 0,
      nextAttemptAt: 0,
      suppressedCount: 0,
      suppressedSince: null,
      reason: null,
    });
    expect(tracker.reserveAttempt(1)).toBe(true);
    // The healthy path is never reserved: a second concurrent leg proceeds too (AC21).
    expect(tracker.reserveAttempt(1)).toBe(true);
    expect(tracker.get(1).state).toBe('ok');
  });

  it('applies the table delay for failures one through seven and stays backing-off', () => {
    const { tracker, clock } = makeTracker();
    const applied: number[] = [];

    for (let n = 1; n <= 7; n++) {
      tracker.recordTransientFailure(1, 'Connection refused on port 443');
      applied.push(tracker.get(1).nextAttemptAt - clock.now);
    }

    expect(applied.map((ms) => ms / MINUTE)).toEqual([1, 2, 4, 8, 16, 32, 60]);
    expect(tracker.get(1)).toMatchObject({ state: 'backing-off', consecutiveFailures: 7 });
  });

  it('suppresses while the gate is shut and admits exactly at nextAttemptAt', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTransientFailure(1, 'Connection refused on port 443');
    const gateAt = tracker.get(1).nextAttemptAt;

    clock.now = gateAt - 1;
    expect(tracker.reserveAttempt(1)).toBe(false);

    // Inclusive at the instant itself — an exclusive comparison would cost a whole extra cycle.
    clock.now = gateAt;
    expect(tracker.reserveAttempt(1)).toBe(true);
  });

  it('counts every suppressed attempt and stamps when suppression began', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');
    const suppressedAt = (clock.now += 5_000);

    expect(tracker.reserveAttempt(1)).toBe(false);
    clock.now += 5_000;
    expect(tracker.reserveAttempt(1)).toBe(false);

    expect(tracker.get(1)).toMatchObject({ suppressedCount: 2, suppressedSince: suppressedAt });
  });
});

describe('IndexerFailureTracker — the count-based terminal promotion (#2376 AC4)', () => {
  it('stays backing-off at seven and promotes to stopped on the eighth', () => {
    const { tracker } = makeTracker();
    for (let n = 1; n <= 7; n++) tracker.recordTransientFailure(1, 'Connection refused on port 443');
    expect(tracker.get(1).state).toBe('backing-off');

    tracker.recordTransientFailure(1, 'Connection refused on port 443');
    expect(tracker.get(1)).toMatchObject({ state: 'stopped', consecutiveFailures: 8 });
  });

  it('records no delay on the promoting failure — a schedule no elapsed time honours would lie', () => {
    const { tracker } = makeTracker();
    for (let n = 1; n <= 8; n++) tracker.recordTransientFailure(1, 'Connection refused on port 443');

    expect(tracker.get(1).nextAttemptAt).toBe(0);
  });

  it('suppresses a stopped indexer no matter how far the clock advances', () => {
    const { tracker, clock } = makeTracker();
    for (let n = 1; n <= 8; n++) tracker.recordTransientFailure(1, 'Connection refused on port 443');

    clock.now += 24 * 60 * 60_000;
    expect(tracker.reserveAttempt(1)).toBe(false);
    clock.now += 365 * 24 * 60 * 60_000;
    expect(tracker.reserveAttempt(1)).toBe(false);
  });

  it('only the clear reopens a stopped indexer', () => {
    const { tracker } = makeTracker();
    for (let n = 1; n <= 8; n++) tracker.recordTransientFailure(1, 'Connection refused on port 443');

    tracker.clear(1);
    expect(tracker.get(1).state).toBe('ok');
    expect(tracker.reserveAttempt(1)).toBe(true);
  });
});

describe('IndexerFailureTracker — reset and outcome precedence (#2376 AC3, AC22)', () => {
  it('is a no-op on a success while ok — no entry is ever created', () => {
    const { tracker } = makeTracker();
    tracker.recordSuccess(1);

    expect(tracker.get(1).state).toBe('ok');
    expect(tracker.generation(1)).toBe(0);
  });

  it('deletes the entry entirely on a success out of backing-off', () => {
    const { tracker } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');
    tracker.recordSuccess(1);

    expect(tracker.get(1)).toEqual({
      state: 'ok',
      consecutiveFailures: 0,
      nextAttemptAt: 0,
      suppressedCount: 0,
      suppressedSince: null,
      reason: null,
    });
  });

  it('restarts the ladder at one minute after a success at the brink of terminal', () => {
    const { tracker, clock } = makeTracker();
    for (let n = 1; n <= 7; n++) tracker.recordTransientFailure(1, 'boom');
    tracker.recordSuccess(1);

    tracker.recordTransientFailure(1, 'boom');
    expect(tracker.get(1).nextAttemptAt - clock.now).toBe(INDEXER_BACKOFF_BASE_MS);
    expect(tracker.get(1).consecutiveFailures).toBe(1);
  });

  it('ignores an ordinary success while stopped — the stop stands', () => {
    const { tracker } = makeTracker();
    for (let n = 1; n <= 8; n++) tracker.recordTransientFailure(1, 'Connection refused on port 443');
    const before = tracker.get(1);

    tracker.recordSuccess(1);

    expect(tracker.get(1)).toEqual(before);
  });

  it('ignores a further transient failure while stopped — no counter growth, no reason churn', () => {
    const { tracker, clock } = makeTracker();
    for (let n = 1; n <= 8; n++) tracker.recordTransientFailure(1, 'Connection refused on port 443');
    const before = tracker.get(1);

    clock.now += 10 * MINUTE;
    tracker.recordTransientFailure(1, 'a completely different reason');

    expect(tracker.get(1)).toEqual(before);
  });

  it('a terminal failure stops from any state and updates the reason', () => {
    const { tracker } = makeTracker();
    tracker.recordTransientFailure(1, 'Connection refused on port 443');

    tracker.recordTerminalFailure(1, 'Authentication failed for indexer: MAM');

    expect(tracker.get(1)).toMatchObject({
      state: 'stopped',
      reason: 'Authentication failed for indexer: MAM',
      nextAttemptAt: 0,
    });
  });

  it('keeps one indexer’s state entirely independent of another’s', () => {
    const { tracker } = makeTracker();
    for (let n = 1; n <= 8; n++) tracker.recordTransientFailure(1, 'boom');

    expect(tracker.get(2).state).toBe('ok');
    expect(tracker.reserveAttempt(2)).toBe(true);
  });
});

describe('IndexerFailureTracker — the reopened-gate reservation (#2376 AC21)', () => {
  it('admits exactly one of two concurrent legs at a reopened gate', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');
    clock.now = tracker.get(1).nextAttemptAt;

    const verdicts = [tracker.reserveAttempt(1), tracker.reserveAttempt(1), tracker.reserveAttempt(1)];

    expect(verdicts).toEqual([true, false, false]);
  });

  it('reserves the instant the failure alone would have produced, leaving the schedule intact', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');
    clock.now = tracker.get(1).nextAttemptAt;

    tracker.reserveAttempt(1);
    const reserved = tracker.get(1).nextAttemptAt;
    tracker.recordTransientFailure(1, 'boom');

    expect(tracker.get(1).nextAttemptAt).toBe(reserved);
    expect(tracker.get(1).nextAttemptAt - clock.now).toBe(2 * MINUTE);
  });
});

describe('IndexerFailureTracker — generation fencing (#2376 AC5)', () => {
  it('drops a stale failure committed across a clear', () => {
    const { tracker } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');
    const generation = tracker.generation(1);

    tracker.clear(1);
    tracker.recordTransientFailure(1, 'a late in-flight failure', generation);

    expect(tracker.get(1).state).toBe('ok');
  });

  it('drops a stale success committed across a clear, so it cannot resurrect discarded state', () => {
    const { tracker } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');
    tracker.reserveAttempt(1);
    const generation = tracker.generation(1);

    tracker.clear(1);
    tracker.recordTransientFailure(1, 'a fresh failure');
    const fresh = tracker.get(1);
    tracker.recordSuccess(1, generation);

    expect(tracker.get(1)).toEqual(fresh);
  });

  it('drops a stale terminal failure committed across a clear', () => {
    const { tracker } = makeTracker();
    const generation = tracker.generation(1);

    tracker.clear(1);
    tracker.recordTerminalFailure(1, 'Authentication failed', generation);

    expect(tracker.get(1).state).toBe('ok');
  });

  it('commits an outcome whose generation still matches', () => {
    const { tracker } = makeTracker();
    const generation = tracker.generation(1);

    tracker.recordTransientFailure(1, 'boom', generation);

    expect(tracker.get(1).consecutiveFailures).toBe(1);
  });
});

describe('IndexerFailureTracker — in-memory lifetime (#2376 AC10)', () => {
  it('reports every indexer pristine after a restart', () => {
    const { tracker } = makeTracker();
    for (let n = 1; n <= 8; n++) tracker.recordTransientFailure(1, 'boom');

    const restarted = new IndexerFailureTracker(() => 1_700_000_000_000);

    expect(restarted.get(1).state).toBe('ok');
    expect(restarted.reserveAttempt(1)).toBe(true);
  });
});

describe('classifyIndexerFailure (#2376 AC11, AC12)', () => {
  it('trips terminally on IndexerAuthError at the first occurrence', () => {
    const verdict = classifyIndexerFailure(new IndexerAuthError('MAM'));

    expect(verdict).toEqual({ terminal: true, reason: 'Authentication failed for indexer: MAM' });
  });

  // fetch.ts:71-73 produces this for torznab/newznab/ABB, which never construct IndexerAuthError.
  it('takes the transient ladder for a plain HTTP 401 Error, so the narrow rule is deliberate', () => {
    expect(classifyIndexerFailure(new Error('HTTP 401: Unauthorized'))).toEqual({
      terminal: false,
      reason: 'HTTP 401: Unauthorized',
    });
  });

  it('keeps the mapped operator sentence for a transport failure rather than a stack', () => {
    const mapped = Object.assign(new Error('Connection refused on port 443'), { code: 'ECONNREFUSED' });

    const verdict = classifyIndexerFailure(mapped);

    expect(verdict.terminal).toBe(false);
    expect(verdict.reason).toBe('Connection refused on port 443');
    expect(verdict.reason).not.toContain('at ');
  });

  it('falls back to the shared transport vocabulary when the throw carries no message', () => {
    const verdict = classifyIndexerFailure(Object.assign(new Error(''), { code: 'UND_ERR_CONNECT_TIMEOUT' }));

    expect(verdict).toEqual({ terminal: false, reason: 'the request timed out' });
  });

  it('does not misclassify a code-less throw as terminal', () => {
    expect(classifyIndexerFailure({ nope: true })).toEqual({ terminal: false, reason: 'the server could not be reached' });
  });

  // T44 (#2604 AC6). `reason` is rendered on the health page via `recordSearchFailure`, and the
  // `error instanceof Error` narrowing does NOT exclude a DrizzleQueryError — it extends Error.
  it('summarizes a leaky DB error rather than publishing the failed query', () => {
    const verdict = classifyIndexerFailure(makeLeakyDrizzleError());

    expect(verdict.terminal).toBe(false);
    expectNoLeak(verdict.reason);
    expect(verdict.reason).toContain('FOREIGN KEY constraint failed');
  });

  it('leaves the non-Error arm on the shared vocabulary, not on [object Object]', () => {
    expect(classifyIndexerFailure({})).toEqual({ terminal: false, reason: 'the server could not be reached' });
  });
});

describe('formatIndexerSkip (#2376 AC6)', () => {
  it('words a skip identically for every entry point', () => {
    expect(formatIndexerSkip('stopped', 'Connection refused on port 443')).toBe(
      'Skipped — stopped: Connection refused on port 443',
    );
    expect(formatIndexerSkip('backing-off', 'the request timed out')).toBe(
      'Skipped — backing-off: the request timed out',
    );
  });
});

describe('describeIndexerBreaker (#2376 AC9)', () => {
  it('reports a stopped indexer as an error naming the breaker reason', () => {
    const { tracker } = makeTracker();
    for (let n = 1; n <= 8; n++) tracker.recordTransientFailure(1, 'Connection refused on port 443');
    tracker.reserveAttempt(1);

    const health = describeIndexerBreaker(tracker.get(1));

    expect(health?.state).toBe('error');
    expect(health?.message).toContain('Connection refused on port 443');
    expect(health?.message).toContain('1 search suppressed since');
  });

  it('says nothing while backing-off — the probe’s own verdict is the fresher evidence', () => {
    const { tracker } = makeTracker();
    tracker.recordTransientFailure(1, 'boom');

    expect(describeIndexerBreaker(tracker.get(1))).toBeNull();
    expect(describeIndexerBreaker(tracker.get(2))).toBeNull();
  });
});
