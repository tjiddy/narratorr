import type { RetagPlan, RetagExcludableField } from '@/lib/api';

/**
 * Count files that will be tagged given the user's exclude selection.
 * A file counts when its outcome is `will-tag` AND (it has at least one
 * non-excluded diff row OR a cover-embed write is pending).
 */
export function countApplyFiles(plan: RetagPlan, excludeSet: Set<RetagExcludableField>): number {
  let count = 0;
  for (const file of plan.files) {
    if (file.outcome !== 'will-tag') continue;
    const visibleDiff = (file.diff ?? []).filter(d => !excludeSet.has(d.field as RetagExcludableField));
    if (visibleDiff.length > 0 || file.coverPending) count++;
  }
  return count;
}
