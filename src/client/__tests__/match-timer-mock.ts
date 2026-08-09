// Faking global timers deadlocks TanStack Query, so tests advance only MatchEngine's
// poll/retry timers through this clock while Query keeps real time.
interface ScheduledTimer {
  fn: () => void;
  at: number;
}

export interface MatchTimerMock {
  matchSetTimeout: (fn: () => void, ms: number) => number;
  matchClearTimeout: (handle: number) => void;
  /** Fires the earliest timer, or returns false when none is pending. */
  __flushNext: () => boolean;
  __reset: () => void;
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
