// Globally faking setTimeout deadlocks TanStack Query. Isolating MatchEngine's sole
// timer lets tests advance its polling without touching Query's timers.
export function matchSetTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  return setTimeout(fn, ms);
}

export function matchClearTimeout(handle: ReturnType<typeof setTimeout>): void {
  clearTimeout(handle);
}
