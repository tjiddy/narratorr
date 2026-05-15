import type { FastifyBaseLogger } from 'fastify';
import type {
  MetadataSearchProvider,
  MetadataEnrichmentProvider,
  BookMetadata,
  ProviderLookupResult,
} from '../../core/index.js';

/**
 * Outcome of `lookupForFixMatch`. Audible failure modes surface directly;
 * Audnexus failures are absorbed (the merged record falls back to Audible-
 * only fields) and never reach this union.
 */
export type FixMatchLookupResult =
  | { kind: 'ok'; book: BookMetadata }
  | { kind: 'not_found' }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'invalid_record' }
  | { kind: 'transient_failure'; message: string };

/**
 * Overlay Audnexus's richer-than-Audible fields onto Audible's canonical
 * record. Audnexus contributes `seriesPrimary`, `genres`, `isbn`, and (when
 * non-empty and richer than Audible's) `narrators`. Audible is authoritative
 * for all other fields.
 */
export function mergeAudnexusOntoAudible(audible: BookMetadata, audnexus: BookMetadata): BookMetadata {
  const merged: BookMetadata = { ...audible };
  if (audnexus.seriesPrimary && !merged.seriesPrimary) merged.seriesPrimary = audnexus.seriesPrimary;
  if (audnexus.genres && audnexus.genres.length > 0 && (!merged.genres || merged.genres.length === 0)) {
    merged.genres = audnexus.genres;
  }
  if (audnexus.isbn && !merged.isbn) merged.isbn = audnexus.isbn;
  if (audnexus.narrators && audnexus.narrators.length > (merged.narrators?.length ?? 0)) {
    merged.narrators = audnexus.narrators;
  }
  return merged;
}

export interface FixMatchLookupDeps {
  audible: MetadataSearchProvider | undefined;
  audnexus: MetadataEnrichmentProvider;
  log: FastifyBaseLogger;
  acquireThrottle: () => Promise<void>;
  isRateLimited: (provider: string) => boolean;
  getRateLimitRemainingMs: (provider: string) => number;
  setRateLimited: (provider: string, durationMs: number) => void;
}

/**
 * Fix Match canonical lookup. Audible is required; Audnexus is best-effort.
 * - Bypasses `withThrottle` so typed kinds survive (no fallback erasure).
 * - Manually acquires the throttle slot before each provider call.
 * - On `rate_limited` from either provider, mirrors the `withThrottle`
 *   backoff bookkeeping via `setRateLimited(...)`.
 */
export async function lookupForFixMatch(deps: FixMatchLookupDeps, asin: string): Promise<FixMatchLookupResult> {
  const { audible } = deps;
  if (!audible) return { kind: 'not_found' };

  if (deps.isRateLimited(audible.name)) {
    return { kind: 'rate_limited', retryAfterMs: deps.getRateLimitRemainingMs(audible.name) };
  }

  await deps.acquireThrottle();
  const audibleResult = await audible.getBookDetailed(asin);
  const audibleProjected = projectAudibleOutcome(audibleResult, audible.name, deps);
  if (audibleProjected.kind !== 'ok') return audibleProjected;

  const audnexusResult = await callAudnexusBestEffort(deps, asin);

  if (audnexusResult?.kind === 'ok') {
    return { kind: 'ok', book: mergeAudnexusOntoAudible(audibleProjected.book, audnexusResult.book) };
  }
  if (audnexusResult) {
    deps.log.warn({ asin, audnexusKind: audnexusResult.kind }, 'Fix Match: Audnexus failed — committing Audible-only record');
  }
  return { kind: 'ok', book: audibleProjected.book };
}

function projectAudibleOutcome(
  result: ProviderLookupResult,
  providerName: string,
  deps: FixMatchLookupDeps,
): FixMatchLookupResult {
  switch (result.kind) {
    case 'ok': return { kind: 'ok', book: result.book };
    case 'not_found': return { kind: 'not_found' };
    case 'invalid_record': return { kind: 'invalid_record' };
    case 'rate_limited':
      deps.setRateLimited(providerName, result.retryAfterMs);
      return { kind: 'rate_limited', retryAfterMs: result.retryAfterMs };
    case 'transient_failure':
      return { kind: 'transient_failure', message: result.message };
  }
}

async function callAudnexusBestEffort(deps: FixMatchLookupDeps, asin: string): Promise<ProviderLookupResult | null> {
  if (deps.isRateLimited(deps.audnexus.name)) {
    deps.log.warn({ asin }, 'Fix Match: Audnexus skipped (rate limited) — using Audible-only fields');
    return null;
  }
  await deps.acquireThrottle();
  const result = await deps.audnexus.getBookDetailed(asin);
  if (result.kind === 'rate_limited') {
    deps.setRateLimited(deps.audnexus.name, result.retryAfterMs);
  }
  return result;
}
