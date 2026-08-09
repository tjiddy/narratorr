import type { FastifyBaseLogger } from 'fastify';
import type { ChapterRuntimeOutcome } from '@core/index.js';
import type { ChapterRuntimeSeconds, DurationConfidenceResult } from './match-job.helpers.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * Chapter totals lazily corroborate scalar mismatches. Measured incidence was 1/227 books;
 * eager lookup would add roughly 230 requests per scan.
 */
export interface ChapterCorroborationDeps {
  provider: { readonly name: string; getChapterRuntime(asin: string): Promise<ChapterRuntimeOutcome> };
  log: FastifyBaseLogger;
  acquireThrottle(): Promise<void>;
  isRateLimited(providerName: string): boolean;
  getRateLimitRemainingMs(providerName: string): number;
  setRateLimited(providerName: string, durationMs: number): void;
}

export interface ChapterCorroborator {
  /** Return trusted edition runtimes in seconds; `{}` means unavailable. Never rejects. */
  getChapterRuntimeSeconds(asin: string): Promise<ChapterRuntimeSeconds>;
}

const NO_CHAPTER_RUNTIMES: ChapterRuntimeSeconds = Object.freeze({});

/**
 * Accept only provider-trusted, finite positive runtimes.
 * This is the sole validity gate for both full and trimmed values; trimming stays pure.
 */
function usableChapterSeconds(ms: number | null | undefined, isAccurate: boolean | null | undefined): number | undefined {
  if (isAccurate !== true) return undefined;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  return ms / 1000;
}

function chapterRuntimesFrom(outcome: Extract<ChapterRuntimeOutcome, { kind: 'ok' }>): ChapterRuntimeSeconds {
  const fullSeconds = usableChapterSeconds(outcome.runtimeLengthMs, outcome.isAccurate);
  const trimmedSeconds = usableChapterSeconds(outcome.trimmedRuntimeMs, outcome.isAccurate);
  return {
    ...(fullSeconds !== undefined && { fullSeconds }),
    ...(trimmedSeconds !== undefined && { trimmedSeconds }),
  };
}

/**
 * Cache per MetadataService because ASINs are region-scoped. Only authoritative ok/not_found
 * outcomes settle; invalid, rate-limited, and transient outcomes retry. Same-ASIN calls coalesce
 * with throttle acquisition inside the shared operation.
 */
export function createChapterCorroborator(deps: ChapterCorroborationDeps): ChapterCorroborator {
  // Presence of the key, not its empty value, means the verdict settled.
  const settled = new Map<string, ChapterRuntimeSeconds>();
  const inFlight = new Map<string, Promise<ChapterRuntimeSeconds>>();

  async function classify(asin: string): Promise<ChapterRuntimeSeconds> {
    const outcome = await deps.provider.getChapterRuntime(asin);
    switch (outcome.kind) {
      case 'ok': {
        const runtimes = chapterRuntimesFrom(outcome);
        settled.set(asin, runtimes);
        // Equal runtimes can still mean the adapter removed a zero-length trailing chapter.
        deps.log.debug(
          {
            asin,
            runtimeLengthMs: outcome.runtimeLengthMs,
            isAccurate: outcome.isAccurate,
            chapterSeconds: runtimes.fullSeconds,
            trimmedRuntimeMs: outcome.trimmedRuntimeMs,
            trimmedChapterSeconds: runtimes.trimmedSeconds,
            trimmedChapterCount: outcome.trimmedChapterCount,
          },
          runtimes.fullSeconds === undefined && runtimes.trimmedSeconds === undefined
            ? 'Chapter runtime not usable (trust gate) — settled'
            : 'Chapter runtime resolved — settled',
        );
        return runtimes;
      }
      case 'not_found':
        settled.set(asin, NO_CHAPTER_RUNTIMES);
        deps.log.debug({ asin }, 'Chapter runtime unavailable for ASIN (documented 400/404) — settled');
        return NO_CHAPTER_RUNTIMES;
      case 'rate_limited':
        // Feed the finite window into the provider-wide gate to stop follow-up calls.
        deps.setRateLimited(deps.provider.name, outcome.retryAfterMs);
        return NO_CHAPTER_RUNTIMES;
      case 'invalid_record':
        deps.log.debug({ asin, reason: outcome.reason }, 'Chapter response was not this edition\'s complete record — not settled');
        return NO_CHAPTER_RUNTIMES;
      case 'transient_failure':
        deps.log.debug({ asin, message: outcome.message }, 'Chapter lookup failed transiently — not settled');
        return NO_CHAPTER_RUNTIMES;
    }
  }

  async function lookup(asin: string): Promise<ChapterRuntimeSeconds> {
    try {
      if (deps.isRateLimited(deps.provider.name)) {
        deps.log.debug(
          { asin, remainingMs: deps.getRateLimitRemainingMs(deps.provider.name) },
          'Chapter lookup skipped — provider rate limited',
        );
        return NO_CHAPTER_RUNTIMES;
      }
      // Inside the coalesced operation, so waiters consume no throttle slot.
      await deps.acquireThrottle();
      return await classify(asin);
    } catch (error: unknown) {
      // Never let optional corroboration erase the scalar match.
      deps.log.debug({ error: serializeError(error), asin }, 'Chapter corroboration failed — falling back to the scalar verdict');
      return NO_CHAPTER_RUNTIMES;
    }
  }

  return {
    async getChapterRuntimeSeconds(asin: string): Promise<ChapterRuntimeSeconds> {
      if (settled.has(asin)) return settled.get(asin) ?? NO_CHAPTER_RUNTIMES;

      const existing = inFlight.get(asin);
      if (existing) return existing;

      const promise = lookup(asin);
      inFlight.set(asin, promise);
      try {
        return await promise;
      } finally {
        if (inFlight.get(asin) === promise) inFlight.delete(asin);
      }
    },
  };
}

export interface CorroborateDurationArgs {
  verdict: DurationConfidenceResult;
  asin: string | undefined;
  path: string;
  log: FastifyBaseLogger;
  lookupChapterSeconds(asin: string): Promise<ChapterRuntimeSeconds>;
  recheck(chapterRuntimes: ChapterRuntimeSeconds): DurationConfidenceResult;
}

export interface CorroboratedDuration {
  verdict: DurationConfidenceResult;
  // Reuse this object for durationVerified or a trimmed-only promotion can be demoted again.
  chapterRuntimes: ChapterRuntimeSeconds;
}

/**
 * Recheck only ASIN-backed duration mismatches. Extra references can suppress a mismatch;
 * failures preserve the scalar verdict and other verdict classes issue no lookup.
 */
export async function corroborateDurationVerdict(args: CorroborateDurationArgs): Promise<CorroboratedDuration> {
  const { verdict, path, log } = args;
  if (verdict.reasonKind !== 'duration-mismatch') return { verdict, chapterRuntimes: NO_CHAPTER_RUNTIMES };

  const asin = args.asin?.trim();
  if (!asin) {
    log.debug({ path }, 'Duration mismatch with no ASIN — skipping chapter corroboration');
    return { verdict, chapterRuntimes: NO_CHAPTER_RUNTIMES };
  }

  let chapterRuntimes: ChapterRuntimeSeconds;
  try {
    chapterRuntimes = await args.lookupChapterSeconds(asin);
  } catch (error: unknown) {
    log.debug({ error: serializeError(error), path, asin }, 'Chapter corroboration failed — keeping the scalar duration verdict');
    return { verdict, chapterRuntimes: NO_CHAPTER_RUNTIMES };
  }
  const { fullSeconds, trimmedSeconds } = chapterRuntimes;
  if (fullSeconds === undefined && trimmedSeconds === undefined) {
    return { verdict, chapterRuntimes: NO_CHAPTER_RUNTIMES };
  }

  const rechecked = args.recheck(chapterRuntimes);
  log.debug(
    { path, asin, chapterSeconds: fullSeconds, trimmedChapterSeconds: trimmedSeconds, promoted: rechecked.reasonKind !== 'duration-mismatch' },
    'Chapter-runtime corroboration applied to a would-be duration mismatch',
  );
  return { verdict: rechecked, chapterRuntimes };
}
