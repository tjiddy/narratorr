/**
 * A deterministic stand-in for `@/hooks/match-timer` (#1864 F12/F13).
 *
 * The MatchEngine routes its single poll/retry timer through `@/hooks/match-timer`.
 * Query-backed suites cannot fake global `setTimeout` (it deadlocks TanStack Query —
 * vitest-faketimers-react-query), so they mock the engine timer module with this clock
 * instead: real time and Query's timers stay untouched, while the poll advances only when
 * a test flushes it. Usage:
 *
 *   vi.mock('@/hooks/match-timer', async () => {
 *     const { createMatchTimerMock } = await import('@/__tests__/match-timer-mock');
 *     return createMatchTimerMock();
 *   });
 *   import * as matchTimer from '@/hooks/match-timer';
 *   const engineClock = matchTimer as unknown as MatchTimerMock;
 *   // beforeEach(() => engineClock.__reset());
 *   // advance one poll: await act(async () => { engineClock.__flushNext(); });
 */
interface ScheduledTimer {
  fn: () => void;
  at: number;
}

export interface MatchTimerMock {
  matchSetTimeout: (fn: () => void, ms: number) => number;
  matchClearTimeout: (handle: number) => void;
  /** Fire the single earliest pending timer (one poll/retry). Returns false if none pending. */
  __flushNext: () => boolean;
  /** Drop all pending timers and reset the virtual clock (call in `beforeEach`). */
  __reset: () => void;
  /** Count of currently-pending timers (single-flight ⇒ 0 or 1 in practice). */
  __pending: () => number;
}

export function createMatchTimerMock(): MatchTimerMock {
  const timers = new Map<number, ScheduledTimer>();
  let nextId = 0;
  let now = 0;

  return {
    matchSetTimeout(fn, ms) {
      const handle = ++nextId;
      timers.set(handle, { fn, at: now + ms });
      return handle;
    },
    matchClearTimeout(handle) {
      timers.delete(handle);
    },
    __flushNext() {
      const entries = [...timers.entries()].sort((a, b) => a[1].at - b[1].at);
      const next = entries[0];
      if (!next) return false;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      return true;
    },
    __reset() {
      timers.clear();
      nextId = 0;
      now = 0;
    },
    __pending() {
      return timers.size;
    },
  };
}
