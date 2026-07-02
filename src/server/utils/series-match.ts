import { normalizeSeriesName } from './series-normalize.js';
import type { BookMetadata } from '../../core/metadata/index.js';

/**
 * Identity used to scope a same-series lookup. Prefer `asin` (Audible series
 * ASIN) when available — it's the strongest identifier since two series can
 * share a normalized name across providers. `normalizedName` is the
 * dedupe-friendly form computed by `normalizeSeriesName`. Either field can be
 * null; matching is best-effort.
 *
 * Used by `discovery-candidates` for cross-author series gap matching and (at
 * a lower frequency) by callers reasoning about provider-product series refs.
 */
export interface TargetSeriesIdentity {
  asin: string | null;
  normalizedName: string | null;
}

export interface MatchedSeriesRef {
  name: string;
  asin: string | null;
  position: number | null;
}

/**
 * Strip a leading `the ` so series names like `Stormlight Archive` and
 * `The Stormlight Archive` cross-match. Provider sources drop the leading
 * article inconsistently; a strict-equality compare on `normalizeSeriesName`
 * output misses real same-series matches.
 */
function looseNormalize(normalized: string): string {
  return normalized.startsWith('the ') ? normalized.slice(4) : normalized;
}

function toMatchedRef(ref: { name?: string | undefined; asin?: string | undefined; position?: number | undefined }): MatchedSeriesRef {
  const validPosition = ref.position != null && Number.isFinite(ref.position) ? ref.position : null;
  return {
    name: ref.name ?? '',
    asin: ref.asin ?? null,
    position: validPosition,
  };
}

/**
 * Find the `series` ref on a provider product that belongs to the target
 * series. Returns the matched ref (with name/asin/position) or `null` when
 * the product is not a member of the target series. Provider series ASIN
 * match wins over normalized-name match; we never fall back to
 * `product.series[0]` — a multi-series book on Audible commonly lists a
 * broader universe (e.g. `The Cosmere`) before the actual target series, and
 * importing the universe ref would pollute results with wrong positions.
 */
export function findMatchingSeriesRef(
  product: BookMetadata,
  target: TargetSeriesIdentity,
): MatchedSeriesRef | null {
  // When the candidate has an Audnexus-derived `seriesPrimary`, that is the
  // canonical primary-series identity for that book and the match rule must
  // pin to it — a non-matching primary means the candidate is at best a
  // secondary / broader-universe member of the target series and must NOT
  // fall through to the raw Audible `series[]` match.
  if (product.seriesPrimary) {
    if (target.asin && product.seriesPrimary.asin === target.asin) {
      return toMatchedRef(product.seriesPrimary);
    }
    if (target.normalizedName && typeof product.seriesPrimary.name === 'string' && product.seriesPrimary.name.length > 0) {
      const candidate = normalizeSeriesName(product.seriesPrimary.name);
      const targetLoose = looseNormalize(target.normalizedName);
      if (candidate === target.normalizedName || looseNormalize(candidate) === targetLoose) {
        return toMatchedRef(product.seriesPrimary);
      }
    }
    return null;
  }
  if (!product.series || product.series.length === 0) return null;
  if (target.asin) {
    const byAsin = product.series.find((s) => s.asin && s.asin === target.asin);
    if (byAsin) return toMatchedRef(byAsin);
  }
  if (target.normalizedName) {
    const targetLoose = looseNormalize(target.normalizedName);
    const byName = product.series.find((s) => {
      if (typeof s.name !== 'string' || s.name.length === 0) return false;
      const candidate = normalizeSeriesName(s.name);
      return candidate === target.normalizedName || looseNormalize(candidate) === targetLoose;
    });
    if (byName) return toMatchedRef(byName);
  }
  return null;
}
