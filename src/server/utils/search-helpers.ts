import type { BookMetadata } from '../../core/metadata/index.js';
import type { FastifyBaseLogger } from 'fastify';

interface SearchOptions {
  title?: string;
  author?: string;
}

type SearchFn = (query: string, options?: SearchOptions) => Promise<BookMetadata[]>;

export interface SearchTraceResult {
  initialQuery: string;
  initialResultCount: number;
  swapRetry: boolean;
  swapQuery: string | null;
  results: BookMetadata[];
}

/**
 * Search for books with automatic author/title swap retry on zero results,
 * returning a trace of the queries issued and whether the swap path fired.
 *
 * Builds the initial query as `${title} ${author}` (or `title` alone when no
 * author is provided). When the initial search returns zero results and an
 * author is present, retries with title and author swapped — this handles
 * folder names where author and title are in the wrong order. The returned
 * `SearchTraceResult` captures `initialQuery`, `initialResultCount`,
 * `swapRetry`, and `swapQuery` so callers can replay the search→enrich
 * pipeline from the audit log.
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
