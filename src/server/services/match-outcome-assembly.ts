import type { FastifyBaseLogger } from 'fastify';
import type { AudioScanResult } from '@core/utils/audio-scanner.js';
import type { MatchReasonKind } from '@shared/match-reason-kind.js';
import type { Confidence, MatchResult } from './match-job.types.js';
import {
  applyAttemptCap,
  isDurationVerified,
  resolveConfidenceFromDuration,
  resolveSingleResultConfidence,
  type ChapterRuntimeSeconds,
  type DurationConfidenceResult,
  type NarratorCapContext,
} from './match-job.helpers.js';
import type { TagSearchOutcome } from './tag-search-planner.js';
import { corroborateDurationVerdict } from './chapter-corroboration.js';

export interface OutcomeAssemblyDeps {
  log: FastifyBaseLogger;
  lookupChapterSeconds(asin: string): Promise<ChapterRuntimeSeconds>;
}

/**
 * The converge point shared by the ASIN identification rung and the tag-search planner: corroborate
 * the duration, apply the attempt cap, and hand the narrator cap its context. Keeping both callers
 * on one exit is what stops an ASIN-identified book from acquiring its own edition-safety semantics.
 *
 * A null `audioResult` is the same no-signal zero a zero-duration scan produces — the planner path
 * bails before it can happen, the ASIN rung cannot.
 */
export async function assembleMatchOutcome(
  deps: OutcomeAssemblyDeps,
  path: string,
  audioResult: AudioScanResult | null,
  outcome: TagSearchOutcome,
): Promise<{ result: MatchResult; ctx: NarratorCapContext }> {
  // Confidence helpers compare raw seconds against provider minutes × 60.
  const scannedSeconds = audioResult?.totalDuration ?? 0;
  const { scored, attempt } = outcome;
  const top = scored[0]!;

  const single = scored.length === 1;
  // Resolve duration before the attempt cap: mismatches stay medium; missing runtime may still be capped.
  const resolveVerdict = (chapterRuntimes?: ChapterRuntimeSeconds): DurationConfidenceResult => single
    ? resolveSingleResultConfidence(top.meta, scannedSeconds, chapterRuntimes)
    : resolveConfidenceFromDuration(scored, scannedSeconds, chapterRuntimes);
  // Give a would-be mismatch one lazy chapter-table check before either cap.
  const { verdict, chapterRuntimes } = await corroborateDurationVerdict({
    verdict: resolveVerdict(),
    asin: top.meta.asin,
    path,
    log: deps.log,
    lookupChapterSeconds: deps.lookupChapterSeconds,
    recheck: resolveVerdict,
  });

  // durationVerified feeds narrator capping; capBypassedByDuration only bypasses medium attempt caps.
  const durationVerified = isDurationVerified(top.meta, scannedSeconds, chapterRuntimes);
  const capBypassedByDuration = attempt.maxConfidence === 'medium' && durationVerified;
  const cap = (raw: Confidence, reason: string | undefined, reasonKind: MatchReasonKind | undefined): { confidence: Confidence; reason?: string; reasonKind?: MatchReasonKind } =>
    capBypassedByDuration ? { confidence: 'high' } : applyAttemptCap(raw, attempt.maxConfidence, reason, reasonKind);

  const { confidence, reason, reasonKind } = verdict;
  const result: MatchResult = { path, ...cap(confidence, reason, reasonKind), bestMatch: top.meta, alternatives: single ? [] : scored.slice(1).map(s => s.meta) };
  return { result, ctx: { log: deps.log, matchSource: attempt.source, durationVerified } };
}
