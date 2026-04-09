import type { BookMetadata } from '../../core/metadata/index.js';
import type { FastifyBaseLogger } from 'fastify';

interface SearchOptions {
  title?: string;
  author?: string;
}

type SearchFn = (query: string, options?: SearchOptions) => Promise<BookMetadata[]>;

/**
 * Search for books with automatic author/title swap retry on zero results.
 *
 * When an initial search returns no results and both title and author are provided,
 * retries the search with title and author swapped. This handles cases where folder
 * names have author and title in the wrong order.
 *
 * Used by both lookupMetadata() and matchSingleBook() to share one retry contract.
 */
export async function searchWithSwapRetry(args: {
  searchFn: SearchFn;
  title: string;
  author: string | undefined;
  log: FastifyBaseLogger;
  options?: SearchOptions;
}): Promise<BookMetadata[]> {
  const { searchFn, title, author, log, options } = args;

  const query = author ? `${title} ${author}` : title;
  const results = await searchFn(query, options);

  if (results.length > 0 || !author) {
    return results;
  }

  // Swap retry: try with author as title and title as author
  log.debug({ title, author }, 'Zero results — retrying with swapped author/title');
  const swappedQuery = `${author} ${title}`;
  const swappedOptions = options
    ? { ...options, title: author, author: title }
    : undefined;

  return searchFn(swappedQuery, swappedOptions);
}

// ─── Trace Types ────────────────────────────────────────────────────

export interface SearchTraceResult {
  initialQuery: string;
  initialResultCount: number;
  swapRetry: boolean;
  swapQuery: string | null;
  results: BookMetadata[];
}

/**
 * Trace-mode variant of searchWithSwapRetry.
 * Returns the same results but also captures query strings and whether swap was triggered.
 * Does NOT modify the existing searchWithSwapRetry contract.
 */
export async function searchWithSwapRetryTrace(args: {
  searchFn: SearchFn;
  title: string;
  author: string | undefined;
  log: FastifyBaseLogger;
  options?: SearchOptions;
}): Promise<SearchTraceResult> {
  const { searchFn, title, author, log, options } = args;

  const initialQuery = author ? `${title} ${author}` : title;
  const initialResults = await searchFn(initialQuery, options);

  if (initialResults.length > 0 || !author) {
    return {
      initialQuery,
      initialResultCount: initialResults.length,
      swapRetry: false,
      swapQuery: null,
      results: initialResults,
    };
  }

  // Swap retry: try with author as title and title as author
  log.debug({ title, author }, 'Zero results — retrying with swapped author/title');
  const swapQuery = `${author} ${title}`;
  const swappedOptions = options
    ? { ...options, title: author, author: title }
    : undefined;

  const swappedResults = await searchFn(swapQuery, swappedOptions);

  return {
    initialQuery,
    initialResultCount: 0,
    swapRetry: true,
    swapQuery,
    results: swappedResults,
  };
}
