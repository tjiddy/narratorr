import type { FastifyBaseLogger } from 'fastify';
import {
  RateLimitError,
  type MetadataSearchProvider,
  type BookMetadata,
  type SearchBooksResult,
} from '../../core/index.js';
import { serializeError } from '../utils/serialize-error.js';
import { matchPassesValidation } from './match-validation.js';

/** Input to {@link resolveBook}. */
export interface ResolveBookInput {
  asin?: string | undefined;
  title: string;
  author?: string | undefined;
  isbn?: string | undefined;
}

/**
 * Collaborators {@link resolveBook} needs from {@link MetadataService}. Mirrors
 * the `metadata-fix-match` deps pattern so the orchestration lives outside the
 * service file (which is at its `max-lines` budget) while still using the
 * service's throttle/rate-limit/provider-selection internals.
 */
export interface ResolveBookDeps {
  provider: MetadataSearchProvider | undefined;
  enrichBook(asin: string): Promise<BookMetadata | null>;
  acquireThrottle(): Promise<void>;
  isRateLimited(providerName: string): boolean;
  getRateLimitRemainingMs(providerName: string): number;
  setRateLimited(providerName: string, durationMs: number): void;
  applyBookFilters(books: BookMetadata[]): Promise<BookMetadata[]>;
  logParseDrop(result: SearchBooksResult, providerName: string | undefined): void;
  log: FastifyBaseLogger;
}

/**
 * Robust audiobook resolution — the ONE shared path used by both the
 * import-list add flow and the background enrichment job, so "how to resolve a
 * book to audiobook metadata" no longer lives in two inconsistent
 * implementations.
 *
 * 1. A (trimmed, non-empty) `asin` is tried first via `enrichBook` — the precise
 *    identity fast path. A blank/whitespace ASIN is treated as absent.
 * 2. On miss (or no ASIN) it falls back to a **title + author** search and
 *    validates the top candidate with {@link matchPassesValidation}. Amazon
 *    assigns a separate ASIN per format, so a print/Kindle ASIN 404s on the
 *    audiobook-only Audnexus service — the search re-finds the real audiobook.
 * 3. Returns the matched {@link BookMetadata} (carrying the correct audiobook
 *    ASIN it resolved) or `null` when genuinely unresolvable.
 *
 * Rate limits propagate: a provider {@link RateLimitError} is re-thrown (on BOTH
 * the `enrichBook` path and the fallback search via {@link searchBooksThrowing})
 * so the caller can distinguish a transient provider state from a real no-match.
 * An empty search result is a no-match (`null`); a rate limit throws.
 */
export async function resolveBook(deps: ResolveBookDeps, input: ResolveBookInput): Promise<BookMetadata | null> {
  const asin = input.asin?.trim();
  if (asin) {
    const match = await deps.enrichBook(asin);
    if (match) return match;
  }

  const query = input.author ? `${input.title} ${input.author}` : input.title;
  const books = await searchBooksThrowing(deps, query);
  const candidate = books[0];
  if (!candidate) return null;
  return matchPassesValidation({ title: input.title, author: input.author }, candidate)
    ? candidate
    : null;
}

/**
 * Provider search that PROPAGATES `RateLimitError` instead of swallowing it to
 * `[]` like the public `search`/`searchBooks` (which exist for discovery/UI
 * where a rate limit is just an incomplete result). Used only by
 * {@link resolveBook}, where a rate limit must be distinguishable from a real
 * no-match (an empty result still returns `[]`; only the rate limit throws).
 */
async function searchBooksThrowing(deps: ResolveBookDeps, query: string): Promise<BookMetadata[]> {
  const { provider } = deps;
  if (!provider) return [];

  if (deps.isRateLimited(provider.name)) {
    throw new RateLimitError(deps.getRateLimitRemainingMs(provider.name), provider.name);
  }

  try {
    await deps.acquireThrottle();
    const result = await provider.searchBooks(query);
    deps.logParseDrop(result, provider.name);
    return await deps.applyBookFilters(result.books);
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      deps.setRateLimited(error.provider, error.retryAfterMs);
      throw error;
    }
    deps.log.warn({ query, error: serializeError(error) }, 'Resolver fallback search failed');
    return [];
  }
}
