export type QualityTier = 'Low' | 'Fair' | 'Good' | 'High' | 'Lossless';

export interface QualityInfo {
  mbPerHour: number;
  tier: QualityTier;
}

/**
 * Calculate audio quality from release size and book duration.
 * Returns null if duration is unknown or zero.
 *
 * @param sizeBytes - release size in bytes
 * @param durationSeconds - book duration in seconds
 */
export function calculateQuality(sizeBytes: number, durationSeconds: number): QualityInfo | null {
  if (!durationSeconds || durationSeconds <= 0 || !sizeBytes || sizeBytes <= 0) return null;

  const sizeMb = sizeBytes / (1024 * 1024);
  const durationHours = durationSeconds / 3600;
  const mbPerHour = sizeMb / durationHours;

  return {
    mbPerHour: Math.round(mbPerHour),
    tier: getTier(mbPerHour),
  };
}

function getTier(mbPerHour: number): QualityTier {
  if (mbPerHour < 30) return 'Low';
  if (mbPerHour < 80) return 'Fair';
  if (mbPerHour < 200) return 'Good';
  if (mbPerHour < 400) return 'High';
  return 'Lossless';
}

/** Color class for each quality tier (Tailwind). */
export function qualityTierColor(tier: QualityTier): string {
  switch (tier) {
    case 'Low': return 'text-red-400';
    case 'Fair': return 'text-yellow-400';
    case 'Good': return 'text-green-400';
    case 'High': return 'text-blue-400';
    case 'Lossless': return 'text-purple-400';
  }
}

/** Background color class for quality tier pill. */
export function qualityTierBg(tier: QualityTier): string {
  switch (tier) {
    case 'Low': return 'bg-red-500/20 text-red-300';
    case 'Fair': return 'bg-yellow-500/20 text-yellow-300';
    case 'Good': return 'bg-green-500/20 text-green-300';
    case 'High': return 'bg-blue-500/20 text-blue-300';
    case 'Lossless': return 'bg-purple-500/20 text-purple-300';
  }
}
