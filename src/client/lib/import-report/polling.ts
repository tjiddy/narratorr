/**
 * Uses a baseline interval while idle because global query defaults will not discover work
 * started elsewhere; this cadence never stops completely.
 */
export const FAST_POLL_MS = 3_000;
export const BASELINE_POLL_MS = 30_000;

export function pollCadence(active: boolean): number {
  return active ? FAST_POLL_MS : BASELINE_POLL_MS;
}
