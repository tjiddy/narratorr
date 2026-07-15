/**
 * Single home for the "Xh Ym" runtime formatter (#1854).
 *
 * Previously duplicated between the client (`src/client/lib/format.ts`,
 * floor-based, with the richer options contract) and the server
 * (`match-job.helpers.ts`, round-based). #1854 collapses them onto ONE floor
 * semantic so a duration string means the same thing on both sides of the wire.
 *
 * FLOOR (not round) is the chosen semantic: hours = `Math.floor(seconds/3600)`,
 * minutes = `Math.floor((seconds%3600)/60)`. Minute resolution is load-bearing
 * for the match-job mismatch reason: the mismatch band is absolute seconds-scale (#1850/#1854), and
 * two values a band-width apart can never fall in the same 60-second minute
 * bucket, so this display always shows a visible difference for every mismatch it
 * accompanies (the old one-decimal-hours display rendered both sides of a real
 * mismatch identically).
 */
export function formatDurationSeconds(
  seconds?: number | null,
  opts?: { alwaysShowBoth?: boolean; fallback?: string },
): string {
  if (seconds == null) return opts?.fallback ?? '';
  const alwaysShowBoth = opts?.alwaysShowBoth ?? true;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (alwaysShowBoth) return `${h}h ${m}m`;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
