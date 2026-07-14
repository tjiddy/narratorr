/**
 * The MatchEngine's single poll/retry timer, behind a tiny injectable seam (#1864).
 *
 * The recovery loop is `setTimeout`-driven and runs inside TanStack Query-backed pages.
 * Globally faking `setTimeout` deadlocks Query's internal timers
 * (vitest-faketimers-react-query), so Query-backed suites cannot use `vi.useFakeTimers`
 * to advance the poll. Routing the engine's ONLY timer through this module lets those
 * suites mock `@/hooks/match-timer` with a deterministic clock and advance polling
 * without touching real time or Query's timers. Production simply delegates to the globals.
 */
export function matchSetTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  return setTimeout(fn, ms);
}

export function matchClearTimeout(handle: ReturnType<typeof setTimeout>): void {
  clearTimeout(handle);
}
