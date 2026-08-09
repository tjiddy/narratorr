import type { BookMetadata } from '@core/metadata/index.js';
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

/** Search once, then retry zero-result author/title inversions while returning an audit trace. */
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
