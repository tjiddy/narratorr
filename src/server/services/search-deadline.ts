import type { FastifyBaseLogger } from 'fastify';
import { serializeError } from '../utils/serialize-error.js';

/**
 * The canonical expiry failure. `budgetMs`/`bookId` are read off the instance rather than out of
 * `serializeError`, whose key set is fixed; `type` is the log-side discriminator.
 */
export class SearchDeadlineError extends Error {
  constructor(readonly budgetMs: number, readonly bookId: number) {
    super(`Search for book ${bookId} exceeded its ${budgetMs}ms deadline`);
    this.name = 'SearchDeadlineError';
  }
}

export interface SearchDeadlineOptions {
  /** `<= 0` disables the outer guard; the registry still applies. */
  budgetMs: number;
  bookId: number;
  log: FastifyBaseLogger;
}

// Process-local for the same reason `bookAdmissionLocks` is: Narratorr runs as one Node process.
// The slot holds the WORK promise, so it survives its own deadline and is freed only when the
// abandoned operation finally settles.
const inFlightSearches = new Map<number, Promise<unknown>>();

/**
 * Bound how long a caller waits on `fn` without cancelling it: at expiry the race rejects and the
 * still-running work is abandoned, never torn. One operation per book — a concurrent caller for a
 * book that already has one resolves `null` rather than queueing behind it.
 */
export function withSearchDeadline<T>(
  opts: SearchDeadlineOptions,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const { budgetMs, bookId, log } = opts;

  // Check and reserve with no await in between; single-threaded execution is what makes it atomic.
  if (inFlightSearches.has(bookId)) return Promise.resolve(null);

  const controller = new AbortController();
  let work: Promise<T>;
  try {
    work = fn(controller.signal);
  } catch (error: unknown) {
    return Promise.reject(error);
  }
  inFlightSearches.set(bookId, work);

  let expired = false;
  const release = () => {
    if (inFlightSearches.get(bookId) === work) inFlightSearches.delete(bookId);
  };
  // Also the rejection reaction that keeps an abandoned failure out of Node's unhandled accounting.
  void work.then(
    () => {
      release();
      if (expired) log.debug({ bookId, budgetMs }, 'Abandoned search work resolved after its deadline');
    },
    (error: unknown) => {
      release();
      if (expired) log.warn({ bookId, budgetMs, error: serializeError(error) }, 'Abandoned search work failed after its deadline');
    },
  );

  if (budgetMs <= 0) return work;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      // Reject BEFORE aborting, inverting `ConnectorRefreshQueue.withTimeout`: abort listeners run
      // synchronously, so a leaf that rejects from one would otherwise win the race and deliver a
      // leaf error where the caller must see the canonical deadline failure.
      reject(new SearchDeadlineError(budgetMs, bookId));
      controller.abort();
    }, budgetMs);
    timer.unref();
  });

  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** The registry is module-level state; suites that exercise it must start from empty. */
export function _resetSearchRegistryForTesting(): void {
  inFlightSearches.clear();
}
