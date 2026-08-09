import type { FastifyBaseLogger } from 'fastify';
import {
  RateLimitError,
  type MetadataSearchProvider,
  type BookMetadata,
  type SearchBooksResult,
} from '@core/index.js';
import { serializeError } from '../utils/serialize-error.js';
import { matchPassesValidation } from './match-validation.js';

export interface ResolveBookInput {
  asin?: string | undefined;
  title: string;
  author?: string | undefined;
}

/**
 * Provider filtering preserves order rather than relevance-ranking, so validate a small result
 * window instead of trusting the first item.
 */
const VALIDATION_WINDOW = 5;

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
 * Try a nonblank ASIN, then validate a small title/author search window; format-specific ASIN
 * misses can therefore recover the audiobook edition. Null means a genuine miss, while transient
 * provider failures propagate for retry.
 */
export async function resolveBook(deps: ResolveBookDeps, input: ResolveBookInput): Promise<BookMetadata | null> {
  const asin = input.asin?.trim();
  if (asin) {
    const match = await deps.enrichBook(asin);
    if (match) return match;
  }

  const author = input.author?.trim() || undefined;
  const query = author ? `${input.title} ${author}` : input.title;
  const books = await searchBooksThrowing(deps, query);
  return (
    books
      .slice(0, VALIDATION_WINDOW)
      .find((candidate) => matchPassesValidation({ title: input.title, author }, candidate)) ?? null
  );
}

/**
 * Unlike discovery search, propagate provider failures; reserve an empty array for no provider or
 * a genuine empty result.
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
    } else {
      deps.log.warn({ query, error: serializeError(error) }, 'Resolver fallback search failed (transient)');
    }
    throw error;
  }
}
