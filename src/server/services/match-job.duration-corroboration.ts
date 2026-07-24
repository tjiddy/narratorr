import type { FastifyBaseLogger } from 'fastify';
import type { BookMetadata } from '../../core/metadata/index.js';
import { withinDurationTolerance } from '../../shared/duration-tolerance.js';
import { isDurationVerified, type DurationConfidenceResult } from './match-job.helpers.js';

/**
 * Shared duration-mismatch corroboration chokepoint (#1936). All four verdict
 * branches (filename-single/-multi, tag-single/-multi) funnel their pure scalar
 * verdict + winning candidate through here before the Review flag lands. The
 * scalar `durationVerified` (`isDurationVerified`) equals the pre-corroboration
 * truth every branch already used (the multi paths' `confidence === 'high'` IS
 * `isDurationVerified` of the top candidate).
 *
 * When — and only when — the pure verdict is a would-be `duration-mismatch`, fetch
 * the winner's chapter-table runtime (`getChapterRuntimeMs`) and re-check the
 * unrounded scanned seconds against it with the SAME 240s band
 * (`runtimeLengthMs / 1000`, never `× 60`). If it agrees: verdict → `high`, no
 * reason, `durationVerified: true` — so the tag cap bypass and
 * `NarratorCapContext.durationVerified` read the corroborated truth, not the
 * scalar-only value (AC6).
 *
 * Lazy + fail-safe: the scalar-agrees happy path makes NO chapters call (AC3); a
 * missing ASIN or a `null` from the bridge (404/transient/rate-limit/redirect/
 * missing-or-zero ms) falls back to the scalar verdict (AC4). `missing-duration` /
 * `no-duration-data` are not `duration-mismatch`, so they never trigger the fetch.
 *
 * The pure confidence helpers stay synchronous; this is the single async
 * orchestration seam, keeping the tolerance band single-homed in `duration-tolerance`.
 */
export async function corroborateDurationVerdict(
  meta: BookMetadata,
  scannedSeconds: number | undefined,
  base: DurationConfidenceResult,
  getChapterRuntimeMs: (asin: string) => Promise<number | null>,
  log: FastifyBaseLogger,
): Promise<{ verdict: DurationConfidenceResult; durationVerified: boolean }> {
  const scalarVerified = isDurationVerified(meta, scannedSeconds);
  const asin = meta.asin;
  if (base.reasonKind !== 'duration-mismatch' || !asin || !scannedSeconds) {
    return { verdict: base, durationVerified: scalarVerified };
  }
  const chapterMs = await getChapterRuntimeMs(asin);
  if (chapterMs && chapterMs > 0 && withinDurationTolerance(chapterMs / 1000, scannedSeconds)) {
    log.debug(
      { asin, scannedSeconds, chapterSeconds: chapterMs / 1000, scalarSeconds: (meta.duration ?? 0) * 60 },
      'Duration mismatch corroborated by chapter-table runtime — rescued to high (#1936)',
    );
    return { verdict: { confidence: 'high' }, durationVerified: true };
  }
  return { verdict: base, durationVerified: scalarVerified };
}
