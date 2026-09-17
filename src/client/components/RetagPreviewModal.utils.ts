import type { RetagPlan, RetagPlanFile, RetagPlanFileDiff, RetagExcludableField } from '@/lib/api';

export const FIELD_LABELS: Record<RetagExcludableField, string> = {
  artist: 'Artist',
  albumArtist: 'Album Artist',
  album: 'Album',
  title: 'Title',
  composer: 'Composer',
  grouping: 'Grouping',
  series: 'Series',
  seriesPart: 'Series Part',
  subtitle: 'Subtitle',
  asin: 'ASIN',
  publisher: 'Publisher',
  description: 'Description',
  date: 'Year',
  genre: 'Genre',
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
  'series',
  'seriesPart',
  'subtitle',
  'asin',
  'publisher',
  'description',
  'date',
  'genre',
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
 * Mirrors apply: a will-tag file drops to a skip once nothing it still includes differs and no
 * cover is pending — `skip-populated` when every row is excluded, `skip-unchanged` when the
 * remaining rows already match the file.
 */
export function effectiveOutcome(
  file: RetagPlanFile,
  excludeSet: Set<RetagExcludableField>,
): RetagPlanFile['outcome'] {
  if (file.outcome !== 'will-tag') return file.outcome;
  const visibleDiff = visibleDiffOf(file, excludeSet);
  if (visibleDiff.some(d => d.changed) || file.coverPending) return 'will-tag';
  return visibleDiff.length > 0 ? 'skip-unchanged' : 'skip-populated';
}

export function countChanges(file: RetagPlanFile, excludeSet: Set<RetagExcludableField>): number {
  return visibleDiffOf(file, excludeSet).filter(d => d.changed).length;
}

export function visibleDiffOf(
  file: RetagPlanFile,
  excludeSet: Set<RetagExcludableField>,
): RetagPlanFileDiff[] {
  return (file.diff ?? []).filter(d => !excludeSet.has(d.field as RetagExcludableField));
}

export function countApplyFiles(plan: RetagPlan, excludeSet: Set<RetagExcludableField>): number {
  let count = 0;
  for (const file of plan.files) {
    if (effectiveOutcome(file, excludeSet) === 'will-tag') count++;
  }
  return count;
}
