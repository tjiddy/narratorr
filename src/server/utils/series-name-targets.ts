import { normalizeSeriesName } from './series-normalize.js';

// Names that normalize empty (non-Latin or punctuation-only) must match byte-for-byte.
// Grouping them under '' would merge unrelated series and enable durable cross-series rewrites.
export interface SeriesNameTargets {
  normalized: ReadonlySet<string>;
  exact: ReadonlySet<string>;
}

export function buildSeriesNameTargets(names: readonly string[]): SeriesNameTargets {
  const normalized = new Set<string>();
  const exact = new Set<string>();
  for (const name of names) {
    const folded = normalizeSeriesName(name);
    if (folded === '') exact.add(name);
    else normalized.add(folded);
  }
  return { normalized, exact };
}

export function seriesNameMatchesTargets(targets: SeriesNameTargets, seriesName: string): boolean {
  if (targets.exact.has(seriesName)) return true;
  const folded = normalizeSeriesName(seriesName);
  // Empty folds are accepted only by the exact arm, even if normalized accidentally contains ''.
  return folded !== '' && targets.normalized.has(folded);
}
