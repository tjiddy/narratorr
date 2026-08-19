import type { FastifyBaseLogger } from 'fastify';
import { runImmediateSearch, type ImmediateSearchBook, type ImmediateSearchDeps } from './trigger-immediate-search.js';

/**
 * The single-flight policy every batch caller shares (#2304): N concurrent search-and-grab
 * pipelines rate-limit the operator's trackers — one ~109-book import list produced 43 MAM HTTP
 * 429s and 294 Prowlarr timeouts. Containment stays with `runImmediateSearch`, so one rejection
 * cannot break the chain; nothing else is awaited here — no timer, retry, or deadline — and each
 * book's search terminates exactly as it does in the scheduled cycle.
 *
 * Callers differ only in what they do with the returned promise: `await` it where a task guard or
 * cron re-entrancy check must span the searches, `void` it where an HTTP response must not.
 */
export async function runImmediateSearchChain(
  books: readonly ImmediateSearchBook[],
  deps: ImmediateSearchDeps,
  log: FastifyBaseLogger,
): Promise<void> {
  for (const book of books) {
    await runImmediateSearch(book, deps, log);
  }
}
