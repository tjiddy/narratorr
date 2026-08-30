import type { FastifyBaseLogger } from 'fastify';
import {
  RateLimitError,
  type MetadataSearchProvider,
  type BookMetadata,
  type SearchBooksResult,
} from '@core/index.js';
import { normalizeTitleLosslessly } from '@core/utils/title-variants.js';
import { canonicalizeAsin } from '@shared/asin.js';
import { serializeError } from '../utils/serialize-error.js';
import { matchPassesValidation, type MatchValidationItem } from './match-validation.js';
import {
  collapsesToOneRecording,
  mergeAlternateAsins,
  selectCanonicalRecording,
} from './metadata-recording-collapse.js';

export interface ResolveBookInput {
  asin?: string | undefined;
  title: string;
  author?: string | undefined;
  /** Other ASINs naming the same recording, probed in order after `asin` misses. */
  alternateAsins?: string[] | undefined;
}

/**
 * Provider filtering preserves order rather than relevance-ranking, so validate a small result
 * window instead of trusting the first item. Order therefore carries no relevance signal either:
 * when several candidates pass, the first one is an arbitrary pick among siblings of the same
 * series, so the window is disambiguated on identity-preserving exact title where that names
 * exactly one candidate — or where the several it names are provably one recording — and is
 * otherwise held for the existing retry/Fix Match path.
 */
const VALIDATION_WINDOW = 5;

/** Log message for the hold branch; the only signal an operator has for the live hold rate. */
export const AMBIGUOUS_WINDOW_HELD = 'Ambiguous metadata window held — no unique title match';

/**
 * Log message for the collapse branch. Diagnostic rather than `info`: an operator needs the hold
 * rate because a hold silently blocks acquisition, while a resolved window is an ordinary success.
 */
export const AMBIGUOUS_WINDOW_COLLAPSED = 'Ambiguous metadata window collapsed — duplicate listings of one recording';

/**
 * Bounds this public port, which any caller may populate — the Hardcover mapper's own
 * `MAX_ALTERNATE_ASINS` bounds only the array it reads off an external payload. Counts the primary,
 * so the worst case a missed resolve costs is six Audnexus round-trips against the shared throttle.
 */
const MAX_ASIN_PROBES = 6;

/**
 * Log message for the fall-through win — the only signal an operator has that a source's primary
 * ASINs are dead at Audnexus while its siblings resolve.
 */
export const ALTERNATE_ASIN_RESOLVED = 'Primary ASIN did not resolve; an alternate edition ASIN did';

export interface ResolveBookDeps {
  provider: MetadataSearchProvider | undefined;
  enrichBook(asin: string): Promise<BookMetadata | null>;
  acquireThrottle(): Promise<void>;
  isRateLimited(providerName: string): boolean;
  getRateLimitRemainingMs(providerName: string): number;
  setRateLimited(providerName: string, durationMs: number): void;
  applyBookFilters(books: BookMetadata[], preferAsin?: string | undefined): Promise<BookMetadata[]>;
  logParseDrop(result: SearchBooksResult, providerName: string | undefined): void;
  log: FastifyBaseLogger;
}

/**
 * Try a nonblank ASIN, then validate a small title/author search window; format-specific ASIN
 * misses can therefore recover the audiobook edition. Null means a genuine miss, while transient
 * provider failures propagate for retry. Several passing candidates are disambiguated on exact
 * title, or held as a miss rather than guessed, because the window is not relevance-ranked and a
 * guess among siblings writes durable metadata onto the wrong book. Exact title naming SEVERAL
 * candidates is only a guess when they are different books: a set proven to be one recording
 * resolves (#2219), because holding it blocks the row from ever enriching.
 */
export async function resolveBook(deps: ResolveBookDeps, input: ResolveBookInput): Promise<BookMetadata | null> {
  const candidates = probeCandidates(input);
  for (const [index, candidate] of candidates.entries()) {
    // A RateLimitError propagates rather than advancing: further probes at a provider that just
    // answered 429 would turn a retryable `pending` row into a durable `failed` one. Every other
    // outcome — a miss or a failure `enrichBook` already logged and nulled — tries the next identity.
    const match = await deps.enrichBook(candidate);
    if (!match) continue;
    if (index > 0) {
      deps.log.debug({ primaryAsin: candidates[0], alternateAsin: candidate, probed: index + 1 }, ALTERNATE_ASIN_RESOLVED);
    }
    return match;
  }

  const author = input.author?.trim() || undefined;
  const query = author ? `${input.title} ${author}` : input.title;
  // The filter chain now collapses duplicate listings itself (#1597); handing it the requested ASIN
  // keeps this call site's override authoritative over the richness ranking, as it was before.
  const books = await searchBooksThrowing(deps, query, input.asin);

  const passing = distinctPassingCandidates(books.slice(0, VALIDATION_WINDOW), { title: input.title, author });
  if (passing.length === 0) return null;
  if (passing.length === 1) return passing[0]!;

  return disambiguateWindow(deps, input, query, passing);
}

/**
 * The identities to probe, in order: trim, drop blanks, deduplicate canonically keeping the first
 * occurrence, then cap. That order matters — capping first would let a padded twin or a blank spend
 * a probe slot a genuine candidate needed.
 *
 * The emitted value is trimmed but case-preserved, because `AudnexusProvider.getBookDetailed`
 * interpolates it straight into the request path: padding would request `/books/%20b0…%20` and miss.
 * `canonicalizeAsin` also uppercases, so it is the dedup key only and never reaches the wire.
 */
function probeCandidates(input: ResolveBookInput): string[] {
  const seen = new Set<string>();
  const probes: string[] = [];
  for (const raw of [input.asin, ...(input.alternateAsins ?? [])]) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const key = canonicalizeAsin(trimmed);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    probes.push(trimmed);
    if (probes.length === MAX_ASIN_PROBES) break;
  }
  return probes;
}

/**
 * The exact-title arm. One candidate is the row's book. Several are its duplicate listings only if
 * every pair is provably the same recording; anything less holds, because the alternative is a
 * durable write onto a sibling.
 */
function disambiguateWindow(
  deps: ResolveBookDeps,
  input: ResolveBookInput,
  query: string,
  passing: BookMetadata[],
): BookMetadata | null {
  const exact = exactTitleCandidates(passing, input.title);
  if (exact.length === 1) return exact[0]!;

  if (collapsesToOneRecording(exact)) {
    const selected = selectCanonicalRecording(exact, input.asin);
    deps.log.debug({
      query,
      passing: passing.length,
      exact: exact.length,
      selectedAsin: canonicalizeAsin(selected.asin),
      // Sorted so the payload is independent of provider order, like the pick itself.
      equivalentAsins: exact.map((candidate) => canonicalizeAsin(candidate.asin)).sort(),
    }, AMBIGUOUS_WINDOW_COLLAPSED);
    // The peers are still discarded, but their ASINs ride along so the enrichment fallback chain can
    // recover a series or cover this window's canonical never carried (#1597 AC7).
    return mergeAlternateAsins(selected, exact);
  }

  // `exact` splits the surviving holds into the two populations that need opposite fixes: 0 means
  // no candidate survived the lossless title fold (a title/normalization miss), >=2 means candidates
  // were found but could not be proven one recording. Without it the two are indistinguishable in
  // the logs, which is the only signal an operator has for a row that silently never acquires.
  deps.log.info({ query, passing: passing.length, exact: exact.length, window: VALIDATION_WINDOW }, AMBIGUOUS_WINDOW_HELD);
  return null;
}

/**
 * Candidates the gate admits, keyed by canonical ASIN so the same book listed twice is one
 * candidate rather than an ambiguity. A null key is identity-less: such candidates never collapse
 * with each other or with a keyed one, so a window of ASIN-less siblings still holds.
 */
function distinctPassingCandidates(candidates: BookMetadata[], item: MatchValidationItem): BookMetadata[] {
  const seen = new Set<string>();
  const distinct: BookMetadata[] = [];
  for (const candidate of candidates) {
    if (!matchPassesValidation(item, candidate)) continue;
    const key = canonicalizeAsin(candidate.asin);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    distinct.push(candidate);
  }
  return distinct;
}

/**
 * Every candidate whose title IS the row's title; empty when none qualifies.
 *
 * The fold must be `normalizeTitleLosslessly` and NOT `normalizeTitleCore`: the latter is
 * deliberately tolerant for library-work dedup, where it strips every trailing parenthetical and
 * every `Book N`/`Vol N` marker — so it names `Saga Book 2` as a match for row `Saga Book 1`,
 * which is the wrong-sibling write this selector exists to prevent. Do not "DRY" the two folds
 * together. Requiring agreement under both was rejected too: only the lossless fold matches the
 * bracketed `[Audible]` edition tail, so a conjunction would forfeit a correct match.
 *
 * This set — never the wider passing window — is also the only collapse scope the recording check
 * may run over (#2219). Recording SCOPE uses that same tolerant dedup fold, so `Saga Book 2`
 * compares `same-recording` with both `Saga Book 1` listings; exactness here is the only thing
 * keeping it out. Any implementation that reorders the two filters is wrong.
 *
 * An empty fold is outside the domain — untitled rows would otherwise claim each other, the same
 * restriction the series matcher places on its reflexivity arm.
 */
export function exactTitleCandidates(candidates: BookMetadata[], title: string): BookMetadata[] {
  const key = normalizeTitleLosslessly(title);
  if (key === '') return [];
  return candidates.filter((candidate) => normalizeTitleLosslessly(candidate.title) === key);
}

/**
 * Unlike discovery search, propagate provider failures; reserve an empty array for no provider or
 * a genuine empty result.
 */
async function searchBooksThrowing(
  deps: ResolveBookDeps,
  query: string,
  preferAsin: string | undefined,
): Promise<BookMetadata[]> {
  const { provider } = deps;
  if (!provider) return [];

  if (deps.isRateLimited(provider.name)) {
    throw new RateLimitError(deps.getRateLimitRemainingMs(provider.name), provider.name);
  }

  try {
    await deps.acquireThrottle();
    const result = await provider.searchBooks(query);
    deps.logParseDrop(result, provider.name);
    return await deps.applyBookFilters(result.books, preferAsin);
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      deps.setRateLimited(error.provider, error.retryAfterMs);
    } else {
      deps.log.warn({ query, error: serializeError(error) }, 'Resolver fallback search failed (transient)');
    }
    throw error;
  }
}
