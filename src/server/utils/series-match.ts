import { normalizeSeriesName } from './series-normalize.js';
import type { BookMetadata } from '@core/metadata/index.js';

export interface TargetSeriesIdentity {
  asin: string | null;
  normalizedName: string | null;
}

export interface MatchedSeriesRef {
  name: string;
  asin: string | null;
  position: number | null;
}

// Providers inconsistently retain a leading "the" in series names.
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

// Match ASIN before normalized name; never fall back to series[0], which may be a broader universe.
export function findMatchingSeriesRef(
  product: BookMetadata,
  target: TargetSeriesIdentity,
): MatchedSeriesRef | null {
  // A nonmatching canonical seriesPrimary must not fall through to a secondary raw series.
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
