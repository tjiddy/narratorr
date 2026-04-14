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

export type QualityComparison = 'lower' | 'higher' | 'similar';

/**
 * Compare two sizes against the same duration to determine relative quality.
 * Returns null if either size or duration is missing/zero.
 *
 * @param existingSizeBytes - size of existing copy in bytes
 * @param resultSizeBytes - size of the search result in bytes
 * @param durationSeconds - shared book duration in seconds
 * @param threshold - similarity threshold as fraction (default 0.1 = ±10%)
 */
export function compareQuality(
  existingSizeBytes: number | null | undefined,
  resultSizeBytes: number | null | undefined,
  durationSeconds: number | null | undefined,
  threshold = 0.1,
): QualityComparison | null {
  if (!existingSizeBytes || existingSizeBytes <= 0) return null;
  if (!resultSizeBytes || resultSizeBytes <= 0) return null;
  if (!durationSeconds || durationSeconds <= 0) return null;

  const existing = calculateQuality(existingSizeBytes, durationSeconds);
  const result = calculateQuality(resultSizeBytes, durationSeconds);
  if (!existing || !result) return null;

  const ratio = result.mbPerHour / existing.mbPerHour;
  if (ratio < 1 - threshold) return 'lower';
  if (ratio > 1 + threshold) return 'higher';
  return 'similar';
}

/**
 * Resolve a book's quality-relevant size and duration from its fields,
 * applying the defined precedence: audioTotalSize ?? size, audioDuration ?? duration * 60.
 */
export function resolveBookQualityInputs(book: {
  size?: number | null;
  audioTotalSize?: number | null;
  duration?: number | null;
  audioDuration?: number | null;
}): { sizeBytes: number | null; durationSeconds: number | null } {
  const sizeBytes = (book.audioTotalSize && book.audioTotalSize > 0 ? book.audioTotalSize : null)
    ?? (book.size && book.size > 0 ? book.size : null);

  const durationSeconds = (book.audioDuration && book.audioDuration > 0 ? book.audioDuration : null)
    ?? (book.duration && book.duration > 0 ? book.duration * 60 : null);

  return { sizeBytes, durationSeconds };
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
