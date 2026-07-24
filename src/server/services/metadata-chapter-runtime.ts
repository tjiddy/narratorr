import type { FastifyBaseLogger } from 'fastify';
import type { ChapterRuntimeOutcome } from '../../core/index.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * Collaborators {@link fetchChapterRuntimeMs} needs from {@link MetadataService}.
 * Mirrors the `metadata-resolve-book` deps pattern so the orchestration lives
 * outside the service file (at its `max-lines` budget) while still using the
 * service's shared throttle/rate-limit internals (#1934 F5, F7).
 */
export interface ChapterRuntimeDeps {
  getChaptersDetailed(asin: string): Promise<ChapterRuntimeOutcome>;
  acquireThrottle(): Promise<void>;
  isRateLimited(providerName: string): boolean;
  setRateLimited(providerName: string, durationMs: number): void;
  log: FastifyBaseLogger;
}

/**
 * Usable chapter-runtime lookup for the duration-mismatch rescue (#1934).
 * Returns the trusted chapter runtime in MILLISECONDS when the edition has one,
 * or `null` in every other case (no usable runtime, miss, malformed, thrown, or
 * rate limited) — it NEVER throws, so the match path degrades to the scalar
 * verdict instead of crashing into `matchSingleBook`'s `confidence: 'none'`
 * catch (AC7).
 *
 * Routes through the SHARED Audnexus backoff (F5): the rate-limit map is checked
 * before AND after throttle acquisition so a sibling lookup that seeds backoff
 * while this one is queued short-circuits rather than re-hitting a 429'd endpoint
 * (five match-job workers run concurrently), and a fresh `rate_limited` outcome
 * seeds the same shared map. The provider owns the single "usable" reduction, so
 * an `ok` outcome already carries the reduced value (or `null`).
 */
export async function fetchChapterRuntimeMs(deps: ChapterRuntimeDeps, asin: string): Promise<number | null> {
  if (deps.isRateLimited('Audnexus')) {
    deps.log.debug({ asin }, 'Chapter-runtime lookup skipped — Audnexus rate limited');
    return null;
  }
  await deps.acquireThrottle();
  // Re-check after acquiring the throttle: a queued sibling may have seeded the
  // shared backoff while we waited, so short-circuit instead of re-hitting it.
  if (deps.isRateLimited('Audnexus')) {
    deps.log.debug({ asin }, 'Chapter-runtime lookup skipped after throttle — Audnexus rate limited');
    return null;
  }
  // The provider contract never throws (every failure is a discriminated kind);
  // the try is defensive depth upholding the "never throws out of the match path"
  // doctrine (AC7) even if the transport surprises us.
  try {
    const outcome = await deps.getChaptersDetailed(asin);
    if (outcome.kind === 'rate_limited') {
      deps.setRateLimited('Audnexus', outcome.retryAfterMs);
      deps.log.debug({ asin, retryAfterMs: outcome.retryAfterMs }, 'Chapter-runtime lookup rate limited — seeded shared backoff');
      return null;
    }
    if (outcome.kind !== 'ok') {
      deps.log.debug({ asin, kind: outcome.kind }, 'Chapter-runtime lookup returned no usable runtime');
      return null;
    }
    return outcome.runtimeMs;
  } catch (error: unknown) {
    deps.log.debug({ error: serializeError(error), asin }, 'Chapter-runtime lookup threw — treating as no usable runtime');
    return null;
  }
}
