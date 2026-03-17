import type { SuggestionReason } from '../../shared/schemas/discovery.js';

// ---------------------------------------------------------------------------
// Pure functions — dismissal weight tuning (#406)
// ---------------------------------------------------------------------------

export interface DismissalStats {
  dismissed: number;
  added: number;
  total: number;
}

export type WeightMultipliers = Record<SuggestionReason, number>;

export const DEFAULT_MULTIPLIERS: WeightMultipliers = { author: 1, series: 1, genre: 1, narrator: 1, diversity: 1 };

const MIN_SAMPLE_SIZE = 5;

/**
 * Compute weight multipliers from dismissal stats.
 * Formula: max(0.25, 1 - (ratio - 0.8) * 2) when ratio > 0.80 and total >= 5.
 */
export function computeWeightMultipliers(
  stats: Partial<Record<SuggestionReason, DismissalStats>>,
): WeightMultipliers {
  const result = { ...DEFAULT_MULTIPLIERS };
  for (const [reason, s] of Object.entries(stats) as Array<[SuggestionReason, DismissalStats]>) {
    if (s.total < MIN_SAMPLE_SIZE) continue;
    const ratio = s.dismissed / s.total;
    if (ratio > 0.8) {
      result[reason] = Math.max(0.25, 1 - (ratio - 0.8) * 2);
    }
  }
  return result;
}
