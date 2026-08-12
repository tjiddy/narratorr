// Floor to whole minutes. Match-rejection values differ by more than 90 seconds,
// so they cannot collapse into the same displayed minute.
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
