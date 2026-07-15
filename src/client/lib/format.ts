export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'Invalid Date';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return 'Invalid Date';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDurationMinutes(minutes?: number | null): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Single home is now `src/shared/format-duration.ts` (#1854) so the client and the
// server match-job reason string share one floor-based "Xh Ym" semantic. Re-exported
// here so the existing `@/lib/format` call sites are unchanged.
export { formatDurationSeconds } from '../../shared/format-duration.js';

export function formatYear(input?: string | null): string | null {
  if (!input) return null;
  const leading = input.slice(0, 4);
  if (!/^\d{4}$/.test(leading)) return null;
  if (input.length > 4 && input[4] !== '-') return null;
  return leading;
}

export function formatChannels(channels: number | null, fallback?: string): string {
  if (channels === null) return fallback ?? '';
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  return `${channels}ch`;
}
