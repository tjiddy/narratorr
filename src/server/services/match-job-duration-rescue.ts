import type { FastifyBaseLogger } from 'fastify';
import type { BookMetadata } from '../../core/metadata/index.js';
import { withinDurationTolerance } from '../../shared/duration-tolerance.js';
import type { DurationConfidenceResult } from './match-job.helpers.js';

export interface ChapterRescueDeps {
  /** Lazy Audnexus chapter-runtime lookup — returns MILLISECONDS or null; never throws. */
  getChapterRuntimeMs: (asin: string) => Promise<number | null>;
  log: FastifyBaseLogger;
}

export interface ChapterRescueInput {
  /** The PURE duration verdict from the helpers (scalar-only). */
  verdict: DurationConfidenceResult;
  bestMatch: BookMetadata;
  /** Unrounded scanner runtime in SECONDS (the same value the scalar verdict used). */
  scannedSeconds: number | undefined;
  /** Whether the scalar already corroborated the edition (`isDurationVerified`). */
  scalarVerified: boolean;
}

export interface ChapterRescueOutput {
  verdict: DurationConfidenceResult;
  /** Final narrator-cap signal: scalar-verified OR chapter-rescued. */
  durationVerified: boolean;
}

/**
 * Chapter-runtime rescue for a duration-mismatch false positive (#1932).
 *
 * The rescue fires ONLY when the pure verdict carries `reasonKind:
 * 'duration-mismatch'` (a positive scan AND positive scalar that compare outside
 * the band — the exact "scalar fails" state, F12/AC4) AND a matched ASIN is
 * present. It is deliberately NOT gated on `!isDurationVerified`, which is also
 * true for the no-signal states (missing/non-positive scan or scalar) — those make
 * ZERO chapter calls and keep their pure verdict unchanged.
 *
 * On the single triggering path it makes EXACTLY one lazy chapter call. When a
 * usable chapter runtime (ms) comes back and the scanned runtime is within the
 * SAME `withinDurationTolerance` band around `runtimeLengthMs / 1000`, the duration
 * verdict upgrades to `high` (duration reason/reasonKind cleared) and
 * `durationVerified` becomes true. Every other result — miss, out-of-band, no
 * usable runtime — preserves the scalar verdict exactly as today (AC3/AC7). This is
 * the same class of whole-edition total-runtime signal the scalar already is,
 * applied to a more accurate reference; it does not widen the band.
 */
export async function applyChapterRuntimeRescue(
  deps: ChapterRescueDeps,
  input: ChapterRescueInput,
): Promise<ChapterRescueOutput> {
  const { verdict, bestMatch, scannedSeconds, scalarVerified } = input;
  if (verdict.reasonKind !== 'duration-mismatch' || !bestMatch.asin) {
    return { verdict, durationVerified: scalarVerified };
  }
  // A duration-mismatch verdict implies a positive scan, but guard so a non-positive
  // seconds value can never enter the band (book-duration-minutes-vs-quality-seconds).
  if (!scannedSeconds || scannedSeconds <= 0) {
    return { verdict, durationVerified: scalarVerified };
  }

  const chapterRuntimeMs = await deps.getChapterRuntimeMs(bestMatch.asin);
  if (chapterRuntimeMs === null) {
    return { verdict, durationVerified: scalarVerified };
  }

  // Chapter runtime is MILLISECONDS → SECONDS before the seconds band (AC5).
  if (withinDurationTolerance(chapterRuntimeMs / 1000, scannedSeconds)) {
    deps.log.debug(
      { asin: bestMatch.asin, chapterRuntimeMs, scannedSeconds },
      'Duration mismatch rescued by Audnexus chapter runtime — high (duration reason cleared)',
    );
    return { verdict: { confidence: 'high' }, durationVerified: true };
  }
  return { verdict, durationVerified: scalarVerified };
}
