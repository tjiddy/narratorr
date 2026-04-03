/** Milliseconds per minute — used for seed time calculations. */
const MS_PER_MINUTE = 60_000;

interface DeferralDownload {
  completedAt: Date | null;
  protocol: string;
}

interface DeferralSettings {
  minSeedTime: number;
  minSeedRatio: number;
}

/**
 * Determines whether torrent removal should be deferred based on seed time and ratio thresholds.
 *
 * Uses strictly-less-than semantics: at-threshold values mean "condition met" (removal proceeds).
 * Non-torrent protocols always return false (no deferral).
 *
 * @returns true if removal should be deferred (conditions not yet met), false if removal can proceed
 */
export function isTorrentRemovalDeferred(
  download: DeferralDownload,
  settings: DeferralSettings,
  currentRatio: number,
): boolean {
  if (download.protocol !== 'torrent') return false;

  // Seed time check: if minSeedTime > 0 and completedAt exists, verify elapsed time
  if (settings.minSeedTime > 0 && download.completedAt) {
    const elapsedMs = Date.now() - download.completedAt.getTime();
    const minSeedMs = settings.minSeedTime * MS_PER_MINUTE;
    if (elapsedMs < minSeedMs) return true;
  }

  // Seed ratio check: if minSeedRatio > 0, verify current ratio
  if (settings.minSeedRatio > 0 && currentRatio < settings.minSeedRatio) {
    return true;
  }

  return false;
}
