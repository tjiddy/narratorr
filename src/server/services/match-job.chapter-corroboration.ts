import type { FastifyBaseLogger } from 'fastify';
import { withinDurationTolerance } from '../../shared/duration-tolerance.js';
import { serializeError } from '../utils/serialize-error.js';
import type { MatchResult } from './match-job.types.js';
import type { NarratorCapContext } from './match-job.helpers.js';

/** Non-throwing chapter-runtime lookup (`MetadataService.getChapterRuntimeMs`). */
export type ChapterRuntimeLookup = (asin: string) => Promise<number | null>;

/**
 * Chapter-runtime fallback corroboration (#1938). Second duration reference for a
 * `duration-mismatch` top candidate: fetch the edition's chapter-sum runtime and
 * re-check it against the scan through the SAME shared `withinDurationTolerance`
 * band (`runtimeLengthMs / 1000` vs `scannedSeconds`). On agreement, upgrade the
 * result to `high` (dropping the mismatch `reason`/`reasonKind`) and feed
 * `durationVerified: true` into the cap context — the caller then funnels the
 * upgraded result through `applyNarratorCap` exactly like a natively-high match,
 * so a wrong edition with an in-band chapter runtime is still re-capped to Review.
 *
 * The trigger guard lives here (`reasonKind === 'duration-mismatch'` + an ASIN +
 * a positive scan): the happy path returns `unchanged` WITHOUT any fetch, so the
 * caller can invoke this unconditionally (AC4).
 *
 * Fail-safe (AC7): a missing ASIN / scan, an invalid or unavailable chapter
 * runtime, or a leaked provider rejection all leave the pre-fetch `resolved`
 * duration-mismatch result and its `ctx` untouched. The lookup is wrapped so no
 * rejection escapes to `MatchJob.matchSingleBook`'s outer catch (which would
 * convert the whole match to `confidence: 'none'`); the service's non-throwing
 * contract is the primary defense, this try/catch is belt-and-suspenders.
 */
export async function tryChapterRuntimeUpgrade(
  resolved: MatchResult,
  ctx: NarratorCapContext,
  scannedSeconds: number | undefined,
  getChapterRuntimeMs: ChapterRuntimeLookup,
  log: FastifyBaseLogger,
): Promise<{ result: MatchResult; ctx: NarratorCapContext }> {
  const unchanged = { result: resolved, ctx };
  const asin = resolved.bestMatch?.asin;
  if (resolved.reasonKind !== 'duration-mismatch' || !asin || !scannedSeconds || scannedSeconds <= 0) return unchanged;
  try {
    const chapterRuntimeMs = await getChapterRuntimeMs(asin);
    if (chapterRuntimeMs === null || !withinDurationTolerance(chapterRuntimeMs / 1000, scannedSeconds)) {
      return unchanged;
    }
    log.debug(
      { path: resolved.path, asin, chapterRuntimeSeconds: chapterRuntimeMs / 1000, scannedSeconds },
      'Chapter-runtime corroboration verified duration mismatch — upgrading to high',
    );
    // Rebuild with only the core fields so the mismatch `reason`/`reasonKind` are
    // dropped; nothing else is set on `resolved` before the cap runs.
    const upgraded: MatchResult = {
      path: resolved.path,
      confidence: 'high',
      bestMatch: resolved.bestMatch,
      alternatives: resolved.alternatives,
    };
    return { result: upgraded, ctx: { ...ctx, durationVerified: true } };
  } catch (error: unknown) {
    log.warn(
      { error: serializeError(error), path: resolved.path, asin },
      'Chapter-runtime corroboration failed — preserving duration-mismatch result',
    );
    return unchanged;
  }
}
