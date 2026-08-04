import { LoadingSpinner, HourglassIcon } from '@/components/icons';
import type { BookActivity } from '@/hooks/useBookActivity.js';

function chipTitle(activity: BookActivity): string {
  return activity.percentage !== undefined
    ? `${activity.label.replace(/…$/, '')} — ${Math.round(activity.percentage)}%`
    : activity.label;
}

/**
 * Presentational activity indicator (approved mock 2026-08-03, v4).
 * `chip` — cover-overlay square for the grid card's top-left stack, styled as
 * a sibling of the missing/failed chips. `inline` — mini icon + label for the
 * table view's status cell. Renders nothing when activity is null so callers
 * can pass the hook result straight through.
 */
export function BookActivityBadge({ activity, variant }: { activity: BookActivity | null; variant: 'chip' | 'inline' }) {
  if (!activity) return null;
  const working = activity.state === 'working';

  if (variant === 'chip') {
    return (
      <div
        className="w-7 h-7 flex items-center justify-center rounded-lg backdrop-blur-md bg-black/40 ring-1 ring-amber-400/30 shadow-[0_0_8px_-2px_rgba(245,158,11,0.35)]"
        title={chipTitle(activity)}
        data-testid="activity-chip"
        role="status"
        aria-label={chipTitle(activity)}
      >
        {working ? (
          <LoadingSpinner className="w-3.5 h-3.5 text-amber-300" />
        ) : (
          <HourglassIcon className="w-3.5 h-3.5 text-amber-200/90 animate-pulse" />
        )}
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-300/90" data-testid="activity-inline" role="status" aria-label={chipTitle(activity)}>
      {working ? (
        <LoadingSpinner className="w-3 h-3 text-amber-300" />
      ) : (
        <HourglassIcon className="w-3 h-3 text-amber-200/90 animate-pulse" />
      )}
      <span className="truncate">
        {activity.label}
        {activity.percentage !== undefined && ` ${Math.round(activity.percentage)}%`}
      </span>
    </span>
  );
}
