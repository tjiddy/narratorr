import type { FastifyBaseLogger } from 'fastify';
import {
  RateLimitError,
  type AudibleSeriesChild,
  type BookMetadata,
  type MetadataEnrichmentProvider,
  type MetadataSearchProvider,
} from '../../core/index.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * Dependencies for `resolveSeriesMembers` — the inputs the function needs from
 * `MetadataService` (providers, throttle, rate-limit state, logger). Factored
 * out so the orchestration logic lives outside `metadata.service.ts` and the
 * service stays within the project's max-lines budget.
 */
export interface SeriesMembersDeps {
  audnexus: MetadataEnrichmentProvider;
  searchProvider: MetadataSearchProvider | null;
  log: FastifyBaseLogger;
  region: string;
  acquireThrottle: () => Promise<void>;
  isRateLimited: (providerName: string) => boolean;
  setRateLimited: (providerName: string, durationMs: number) => void;
}

export interface SeriesMembersResult {
  seed: BookMetadata | null;
  members: BookMetadata[];
  seriesAsin: string | null;
}

export async function resolveSeriesMembers(
  deps: SeriesMembersDeps,
  seedAsin: string,
): Promise<SeriesMembersResult> {
  deps.log.debug({ seedAsin, region: deps.region }, 'Series members lookup — fetching seed via Audnexus');
  const audnexusSeed = await fetchSeedAudnexus(deps, seedAsin);
  const derivation = await deriveSeriesAsin(deps, seedAsin, audnexusSeed);

  const seed = audnexusSeed ?? derivation.audibleSeed ?? (await fetchSeedAudible(deps, seedAsin));
  if (!seed) {
    deps.log.warn({ seedAsin }, 'Series members lookup — seed book metadata unavailable');
    return { seed: null, members: [], seriesAsin: derivation.seriesAsin };
  }

  if (!derivation.seriesAsin) {
    deps.log.debug({ seedAsin }, 'Series members lookup — no series ASIN derivable; routing to empty outcome');
    return { seed, members: [], seriesAsin: null };
  }

  deps.log.debug({ seedAsin, seriesAsin: derivation.seriesAsin }, 'Series members lookup — fetching Audible relationships');
  const children = await fetchSeriesRelationships(deps, derivation.seriesAsin);
  if (children.length === 0) {
    deps.log.debug({ seedAsin, seriesAsin: derivation.seriesAsin }, 'Series members lookup — relationships empty; routing to empty outcome');
    return { seed, members: [], seriesAsin: derivation.seriesAsin };
  }

  const members = await collectChildMembers(deps, seed, seedAsin, derivation.seriesAsin, children);
  deps.log.debug(
    { seedAsin, seriesAsin: derivation.seriesAsin, memberCount: members.length, relationshipChildren: children.length },
    'Series members lookup — completed',
  );
  return { seed, members, seriesAsin: derivation.seriesAsin };
}

/** Walk relationship children, fetching detail+enrichment for each non-seed ASIN. */
async function collectChildMembers(
  deps: SeriesMembersDeps,
  seed: BookMetadata,
  seedAsin: string,
  seriesAsin: string,
  children: AudibleSeriesChild[],
): Promise<BookMetadata[]> {
  const members: BookMetadata[] = [seed];
  for (const child of children) {
    if (child.asin === seedAsin) continue;
    const detail = await fetchSeriesChild(deps, child.asin, seriesAsin, child.sequence);
    if (detail) members.push(detail);
  }
  return members;
}

async function deriveSeriesAsin(
  deps: SeriesMembersDeps,
  seedAsin: string,
  audnexusSeed: BookMetadata | null,
): Promise<{ seriesAsin: string | null; audibleSeed: BookMetadata | null }> {
  const fromAudnexus = audnexusSeed?.seriesPrimary?.asin ?? null;
  if (fromAudnexus) return { seriesAsin: fromAudnexus, audibleSeed: null };
  const audibleSeed = await fetchSeedAudible(deps, seedAsin);
  const fallback = (audibleSeed?.series ?? []).find(
    (s) => s.position != null && Number.isFinite(s.position) && s.asin,
  );
  return { seriesAsin: fallback?.asin ?? null, audibleSeed };
}

async function fetchSeedAudnexus(deps: SeriesMembersDeps, asin: string): Promise<BookMetadata | null> {
  if (deps.isRateLimited('Audnexus')) {
    deps.log.warn({ asin }, 'Series seed Audnexus lookup skipped — provider rate limited');
    return null;
  }
  try {
    await deps.acquireThrottle();
    return await deps.audnexus.getBook(asin);
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      deps.setRateLimited(error.provider, error.retryAfterMs);
    }
    throw error;
  }
}

async function fetchSeedAudible(deps: SeriesMembersDeps, asin: string): Promise<BookMetadata | null> {
  const provider = deps.searchProvider;
  if (!provider) return null;
  if (deps.isRateLimited(provider.name)) {
    deps.log.warn({ asin, provider: provider.name }, 'Series seed Audible lookup skipped — provider rate limited');
    return null;
  }
  try {
    await deps.acquireThrottle();
    return await provider.getBook(asin);
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      deps.setRateLimited(error.provider, error.retryAfterMs);
    }
    throw error;
  }
}

async function fetchSeriesRelationships(deps: SeriesMembersDeps, seriesAsin: string): Promise<AudibleSeriesChild[]> {
  const provider = deps.searchProvider;
  if (!provider) return [];
  const audible = provider as Partial<{ getSeriesRelationships: (asin: string) => Promise<AudibleSeriesChild[]> }>;
  if (typeof audible.getSeriesRelationships !== 'function') return [];
  if (deps.isRateLimited(provider.name)) {
    deps.log.warn({ seriesAsin, provider: provider.name }, 'Series relationships skipped — provider rate limited');
    return [];
  }
  try {
    await deps.acquireThrottle();
    return await audible.getSeriesRelationships(seriesAsin);
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      deps.setRateLimited(error.provider, error.retryAfterMs);
    }
    throw error;
  }
}

async function fetchSeriesChild(
  deps: SeriesMembersDeps,
  childAsin: string,
  seriesAsin: string,
  sequence: string | null,
): Promise<BookMetadata | null> {
  let audible: BookMetadata | null;
  try {
    audible = await fetchSeedAudible(deps, childAsin);
  } catch (error: unknown) {
    if (error instanceof RateLimitError) throw error;
    deps.log.debug({ error: serializeError(error), asin: childAsin }, 'Series child Audible detail failed — skipping');
    return null;
  }
  if (!audible) return null;

  let audnexus: BookMetadata | null = null;
  try {
    audnexus = await fetchSeedAudnexus(deps, childAsin);
  } catch (error: unknown) {
    if (error instanceof RateLimitError) throw error;
    deps.log.debug({ error: serializeError(error), asin: childAsin }, 'Series child Audnexus enrichment failed — using Audible-only mapping');
  }

  const parsedSeq = sequence !== null ? parseFloat(sequence) : NaN;
  const overridePosition: number | undefined = Number.isFinite(parsedSeq) ? parsedSeq : undefined;
  const series = (audible.series ?? []).map((s) => applySeriesPositionOverride(s, seriesAsin, overridePosition));
  const seriesPrimary = audnexus?.seriesPrimary
    ? applySeriesPositionOverride(audnexus.seriesPrimary, seriesAsin, overridePosition)
    : undefined;
  return {
    ...audible,
    ...(series.length > 0 && { series }),
    ...(seriesPrimary && { seriesPrimary }),
  };
}

/**
 * Override a series ref's position when its ASIN matches the target series.
 * The relationships endpoint is the canonical source for sequence — Audible's
 * book-detail `series.sequence` can drift from it for non-default editions.
 * (#1088 F2)
 */
function applySeriesPositionOverride(
  ref: { name: string; position?: number | undefined; asin?: string | undefined },
  targetAsin: string,
  overridePosition: number | undefined,
): { name: string; position?: number; asin?: string } {
  if (ref.asin !== targetAsin) {
    const passthrough: { name: string; position?: number; asin?: string } = { name: ref.name };
    if (ref.position !== undefined) passthrough.position = ref.position;
    if (ref.asin !== undefined) passthrough.asin = ref.asin;
    return passthrough;
  }
  const next: { name: string; position?: number; asin?: string } = { name: ref.name };
  if (ref.asin !== undefined) next.asin = ref.asin;
  if (overridePosition !== undefined) next.position = overridePosition;
  return next;
}
