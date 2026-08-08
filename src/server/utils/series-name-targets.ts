import { normalizeSeriesName } from './series-normalize.js';

/**
 * Precomputed membership rule for a set of target series names (#2175).
 *
 * The series card resolves its `series` row through {@link normalizeSeriesName},
 * so its library pool has to be the SAME equivalence class or a normalized-equal
 * but byte-different book ('the band' vs 'The Band') is structurally absent from
 * it and renders '+ Add' for a book the operator owns.
 *
 * Two arms, always a union — never a mode switch:
 *
 *   - **normalized** — the class of every target whose normalized form survives.
 *   - **exact** — the raw spelling of every target that normalizes to EMPTY.
 *     `normalizeSeriesName` keeps only `[a-z0-9]`, so 'Дозоры', '三体', '!!!' and
 *     '' all fold to ''. Pooling by that would put every non-Latin-script series
 *     in the library into one pool, and on the bind path that becomes a durable
 *     cross-series rewrite of `books.series_name`. Such a target therefore only
 *     ever accepts its own byte-identical spelling.
 */
export interface SeriesNameTargets {
  normalized: ReadonlySet<string>;
  exact: ReadonlySet<string>;
}

/**
 * Dedupe is per-arm and on what that arm keys on: the normalized form for the
 * normalized arm (so a canonical/prior pair differing only by case is ONE entry),
 * the raw string for the exact arm (which is what its membership test compares).
 */
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

/** Whether a stored `books.series_name` belongs to the pool the targets describe. */
export function seriesNameMatchesTargets(targets: SeriesNameTargets, seriesName: string): boolean {
  if (targets.exact.has(seriesName)) return true;
  const folded = normalizeSeriesName(seriesName);
  // An empty fold can only ever be accepted by the exact arm above; guarding it
  // here keeps that true even if a caller ever hands the normalized arm an ''.
  return folded !== '' && targets.normalized.has(folded);
}
