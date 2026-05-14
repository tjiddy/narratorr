import type { RetagPlan, RetagPlanFile, RetagPlanFileDiff, RetagExcludableField } from '@/lib/api';

export const FIELD_LABELS: Record<RetagExcludableField, string> = {
  artist: 'Artist',
  albumArtist: 'Album Artist',
  album: 'Album',
  title: 'Title',
  composer: 'Composer',
  grouping: 'Grouping',
  track: 'Track',
};

/** Display order for the canonical card AND per-file diff rows. */
export const FIELD_ORDER: RetagExcludableField[] = [
  'artist',
  'albumArtist',
  'album',
  'title',
  'composer',
  'grouping',
  'track',
];

export function canonicalRows(plan: RetagPlan): { field: RetagExcludableField; value: string }[] {
  const rows: { field: RetagExcludableField; value: string }[] = [];
  for (const field of FIELD_ORDER) {
    if (field === 'track') {
      if (plan.isSingleFile) continue;
      rows.push({ field, value: 'sequential per file' });
      continue;
    }
    const value = plan.canonical[field];
    if (value !== undefined) rows.push({ field, value });
  }
  return rows;
}

/**
 * Given a plan file and the user's exclude selection, compute what the apply
 * path WOULD do — the file's "effective outcome". For a server `will-tag`
 * file with every metadata diff excluded and no cover-embed pending, the
 * apply path will actually short-circuit to skipped. Surfacing that here keeps
 * the per-file label, empty state, and apply count in lockstep with the
 * server's short-circuit logic in `resolveTags` + `tagFile`.
 */
export function effectiveOutcome(
  file: RetagPlanFile,
  excludeSet: Set<RetagExcludableField>,
): RetagPlanFile['outcome'] {
  if (file.outcome !== 'will-tag') return file.outcome;
  const visibleDiff = visibleDiffOf(file, excludeSet);
  if (visibleDiff.length > 0 || file.coverPending) return 'will-tag';
  return 'skip-populated';
}

export function visibleDiffOf(
  file: RetagPlanFile,
  excludeSet: Set<RetagExcludableField>,
): RetagPlanFileDiff[] {
  return (file.diff ?? []).filter(d => !excludeSet.has(d.field as RetagExcludableField));
}

/**
 * Count files that will be tagged given the user's exclude selection.
 * A file counts when its effective outcome is `will-tag`.
 */
export function countApplyFiles(plan: RetagPlan, excludeSet: Set<RetagExcludableField>): number {
  let count = 0;
  for (const file of plan.files) {
    if (effectiveOutcome(file, excludeSet) === 'will-tag') count++;
  }
  return count;
}
