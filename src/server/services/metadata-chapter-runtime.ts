import type { FastifyBaseLogger } from 'fastify';
import type { ChapterRuntimeOutcome } from '../../core/metadata/audnexus.js';
import { serializeError } from '../utils/serialize-error.js';

/** Narrow chapter-capable slice of `AudnexusProvider` (#1932). Kept off
 * `MetadataEnrichmentProvider` so widening the enrichment interface doesn't force
 * every consumer/mock to implement chapters. */
export interface ChapterRuntimeProvider {
  readonly name: string;
  getChaptersDetailed(asin: string): Promise<ChapterRuntimeOutcome>;
}

export interface ChapterRuntimeDeps {
  audnexus: ChapterRuntimeProvider;
  log: FastifyBaseLogger;
  acquireThrottle: () => Promise<void>;
  isRateLimited: (provider: string) => boolean;
  setRateLimited: (provider: string, durationMs: number) => void;
}

/**
 * Best-effort Audnexus chapter-runtime lookup for the duration-mismatch rescue
 * (#1932). Returns the usable chapter runtime in MILLISECONDS, or `null` for every
 * non-usable outcome (miss, non-`ok`, unusable record, active/fresh backoff). It
 * NEVER throws — a throw would reach `matchSingleBook`'s broad catch and turn the
 * whole match into `confidence: 'none'`.
 *
 * Two-point backoff check (F11): `MatchJob` runs up to 5 workers over a shared,
 * delay-only `RequestThrottle` (not a mutex), so backoff is checked twice — once on
 * entry, and again immediately after `acquireThrottle()` returns. If a sibling
 * rescue established Audnexus backoff while this call waited in the throttle, the
 * second check skips the provider call. A fresh `429` seeds the shared backoff via
 * `setRateLimited` before returning `null`.
 */
export async function lookupChapterRuntimeMs(deps: ChapterRuntimeDeps, asin: string): Promise<number | null> {
  const { name } = deps.audnexus;
  if (deps.isRateLimited(name)) {
    deps.log.debug({ asin }, 'Chapter-runtime rescue skipped — Audnexus rate limited (entry)');
    return null;
  }
  await deps.acquireThrottle();
  // Re-check AFTER the throttle: a sibling worker may have recorded backoff while
  // this call was waiting in the delay-only throttle queue (F11).
  if (deps.isRateLimited(name)) {
    deps.log.debug({ asin }, 'Chapter-runtime rescue skipped — Audnexus rate limited (post-acquire)');
    return null;
  }

  let outcome: ChapterRuntimeOutcome;
  try {
    outcome = await deps.audnexus.getChaptersDetailed(asin);
  } catch (error: unknown) {
    // The adapter is non-throwing by contract; this is a defensive backstop so a
    // surprise throw never propagates into the match's broad catch.
    deps.log.warn({ error: serializeError(error), asin }, 'Chapter-runtime lookup threw unexpectedly — treating as miss');
    return null;
  }

  if (outcome.kind === 'rate_limited') {
    deps.setRateLimited(name, outcome.retryAfterMs);
    deps.log.warn({ asin, retryAfterMs: outcome.retryAfterMs }, 'Chapter-runtime rescue hit rate limit — backoff recorded');
    return null;
  }
  if (outcome.kind === 'ok') return outcome.runtimeMs;
  deps.log.debug({ asin, kind: outcome.kind }, 'Chapter-runtime rescue: no usable runtime');
  return null;
}
