import type { FastifyBaseLogger } from 'fastify';
import { withinDurationTolerance } from '../../shared/duration-tolerance.js';
import { serializeError } from '../utils/serialize-error.js';
import type { MatchResult } from './match-job.types.js';
import type { NarratorCapContext } from './match-job.helpers.js';

/**
 * Narrow chapter-runtime capability the rescue depends on (#1934). Kept local so
 * the rescue can be unit-tested with a bare stub and so `MetadataService` (which
 * structurally satisfies it) is not coupled to this module. Returns the trusted
 * chapter runtime in MILLISECONDS, or `null` when there is no usable runtime; it
 * never throws (the service owns the shared backoff and swallows every failure).
 */
export interface ChapterRuntimeSource {
  getChapterRuntimeMs(asin: string): Promise<number | null>;
}

/**
 * Lazy chapter-runtime corroboration for a scalar duration-mismatch (#1934).
 *
 * The scalar `runtimeLengthMin` is the only runtime the sync confidence helpers
 * consult; for a handful of ASINs it understates the edition's own chapter table,
 * false-flagging a pristine, correctly-matched file (Fablehaven/`B00CXXEX8W`:
 * scanned 33219.47s vs scalar 32340s vs chapters 33219490ms). This helper is the
 * ONE seam all four automatic mismatch sites (filename-single, filename-multi,
 * tag-single, tag-multi) funnel through after the sync helper yields a
 * `duration-mismatch` verdict.
 *
 * Laziness (AC4): it fetches chapters ONLY when the resolved verdict already
 * carries `reasonKind === 'duration-mismatch'` for a top candidate with an ASIN.
 * Scalar-verified (`high`) matches, `missing-duration`/`no-duration-data` rows,
 * and attempt/narrator caps never reach the fetch — the common case issues zero
 * chapters requests.
 *
 * Promotion (AC1/AC3/AC5): when the edition has a USABLE chapter runtime (the
 * provider-side reduction — trusted + finite + positive) that agrees with the
 * scanned runtime within the SHARED `withinDurationTolerance` band (240s,
 * inclusive; no new threshold), the verdict is rewritten to `{ confidence: 'high' }`,
 * the `reason`/`reasonKind` are dropped, and `capCtx.durationVerified` is set true.
 *
 * Graceful degradation (AC7): any other state — no ASIN, no usable runtime, an
 * out-of-band runtime, or a thrown lookup — returns the inputs UNCHANGED, so the
 * scalar mismatch stands exactly as today and the failure never escapes the match
 * path. The rescue only ever promotes; it never demotes or suppresses.
 */
export async function applyChapterRuntimeRescue(params: {
  resolved: MatchResult;
  capCtx: NarratorCapContext;
  scannedSeconds: number | undefined;
  chapters: ChapterRuntimeSource;
  log: FastifyBaseLogger;
}): Promise<{ resolved: MatchResult; capCtx: NarratorCapContext }> {
  const { resolved, capCtx, scannedSeconds, chapters, log } = params;

  // Only a genuine scalar duration-mismatch verdict is a rescue candidate — this
  // is the laziness gate (AC4). Everything else short-circuits with no I/O.
  if (resolved.reasonKind !== 'duration-mismatch') return { resolved, capCtx };
  if (!scannedSeconds || scannedSeconds <= 0) return { resolved, capCtx };
  const asin = resolved.bestMatch?.asin;
  if (!asin) return { resolved, capCtx };

  let runtimeMs: number | null;
  try {
    runtimeMs = await chapters.getChapterRuntimeMs(asin);
  } catch (error: unknown) {
    // A chapters-fetch failure must NEVER throw out of the match path (which would
    // convert to `confidence: 'none'` at matchSingleBook's catch) — degrade to the
    // scalar verdict and log at debug (AC7).
    log.debug({ error: serializeError(error), path: resolved.path, asin }, 'Chapter-runtime rescue lookup threw — scalar duration mismatch stands');
    return { resolved, capCtx };
  }

  if (runtimeMs === null) {
    log.debug({ path: resolved.path, asin }, 'No usable chapter runtime — scalar duration mismatch stands');
    return { resolved, capCtx };
  }

  const chapterSeconds = runtimeMs / 1000;
  if (!withinDurationTolerance(chapterSeconds, scannedSeconds)) {
    log.debug({ path: resolved.path, asin, chapterSeconds, scannedSeconds }, 'Chapter runtime out of band — scalar duration mismatch stands');
    return { resolved, capCtx };
  }

  // Corroborated: the file matches the edition's real (chapter-derived) runtime.
  // Promote to high, drop the duration-mismatch reason/reasonKind, and mark the
  // downstream `durationVerified` signal true (AC1/AC6).
  log.debug({ path: resolved.path, asin, chapterSeconds, scannedSeconds }, 'Chapter runtime corroborates scanned duration — rescuing scalar mismatch to high');
  const { reason: _reason, reasonKind: _reasonKind, ...rest } = resolved;
  return {
    resolved: { ...rest, confidence: 'high' },
    capCtx: { ...capCtx, durationVerified: true },
  };
}
