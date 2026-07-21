/**
 * Two-tier live-data poll cadence for the import-report reads (#1894, F69/F70).
 *
 * The production `QueryClient` sets `staleTime: 60_000` + `refetchOnWindowFocus:false`
 * (`main.tsx`), so nothing polls or refetches on mount by default — the import-report
 * hooks override those explicitly. The `refetchInterval` is a FUNCTION returning:
 *  - `FAST_POLL_MS` while the query has active work (panel: latest status non-complete;
 *    banner: `watch===true`; detail: its own status non-complete), and
 *  - `BASELINE_POLL_MS` while idle.
 * It NEVER returns `false`, so a mounted host never fully stops and always discovers a
 * run that starts/completes later (same tab, another tab, or a boot auto-resume).
 */
export const FAST_POLL_MS = 3_000;
export const BASELINE_POLL_MS = 30_000;

/** Fast while there is active work; baseline otherwise. Never stops. */
export function pollCadence(active: boolean): number {
  return active ? FAST_POLL_MS : BASELINE_POLL_MS;
}
