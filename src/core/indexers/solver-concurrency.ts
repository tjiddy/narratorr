import { BoundedSemaphore, type SlotRelease } from '../utils/bounded-semaphore.js';
import { SOLVER_MAX_CONCURRENT_REQUESTS, SOLVER_SLOT_WAIT_TIMEOUT_MS } from '../utils/constants.js';
import { ProxyError } from './errors.js';
import { markSolverFailure } from './solver-failure.js';
import { solverEndpoint } from './solver-endpoint.js';

/**
 * The request target `fetchViaProxy` puts on the wire, which is the only thing this code knows about
 * which solver *process* it is addressing — and the process is what owns the browser memory the
 * bound protects. Two spellings share a bound if and only if they POST to the same target, so the
 * key follows the transport automatically: it is built from the same `solverEndpoint` the transport
 * fetches, and `URL` canonicalization is what makes two spellings of it one string.
 *
 * The fragment is cleared because the Fetch Standard never transmits it; keying on raw `.href` would
 * give `…/v1#one` and `…/v1#two` a pool of N each against one process. Query is kept — it *is*
 * transmitted. Credentials are kept too, and are the one place the key is not a wire target: `fetch`
 * refuses such a URL outright, so it has no target to be equated with, and its own uncontended pool
 * is what preserves its immediate `FlareSolverr proxy unreachable` failure instead of stalling it
 * behind a saturated bound.
 *
 * Never throws, on `mamThrottleKey`'s discipline: a throw at the transport boundary would turn a
 * working search into a failure, so an unparseable endpoint keys on the raw string it was given.
 */
export function solverConcurrencyKey(proxyUrl: string): string {
  try {
    const endpoint = new URL(solverEndpoint(proxyUrl));
    endpoint.hash = '';
    return endpoint.href;
  } catch {
    return proxyUrl;
  }
}

/**
 * Process-global, one entry per solver endpoint: Narratorr runs as one Node process and adapter
 * instances are cached and evicted, so the bound belongs to the destination rather than the object.
 * Size is bounded by operator configuration, so no eviction runs — dropping a live entry would hand
 * the next caller a fresh pool while the old one is still occupied, which is the bound's failure.
 */
const pools = new Map<string, BoundedSemaphore>();

/**
 * Resolves with the releaser for one slot at `proxyUrl`'s solver. Rejects with `signal.reason`
 * verbatim if the caller cancels, or with a `ProxyError` if no slot frees within
 * `SOLVER_SLOT_WAIT_TIMEOUT_MS`.
 *
 * `ProxyError` is load-bearing, not cosmetic: ABB's search loop and `enrichAndCollect` rethrow only
 * what `isProxyRelatedError` accepts and swallow everything else, and a swallowed slot-wait failure
 * would read downstream as an answered zero and send the query ladder on to more solver requests.
 */
export function acquireSolverSlot(proxyUrl: string, signal?: AbortSignal): Promise<SlotRelease> {
  const key = solverConcurrencyKey(proxyUrl);
  let pool = pools.get(key);
  if (!pool) {
    pool = new BoundedSemaphore(SOLVER_MAX_CONCURRENT_REQUESTS);
    pools.set(key, pool);
  }

  return pool.acquire({
    signal,
    waitTimeoutMs: SOLVER_SLOT_WAIT_TIMEOUT_MS,
    // Deliberately not prefixed "FlareSolverr": `isProxyRelatedError` matches that prefix on any
    // Error, which would make the ProxyError type non-load-bearing and unfalsifiable.
    // Marked `slot-wait` so the #2374 diagnosis can see the request never left for the solver: this
    // message already names the right component, and re-attributing it — or spending a probe on
    // it — would be a regression.
    waitTimeoutReason: () =>
      markSolverFailure(
        new ProxyError(
          `Timed out after ${Math.round(SOLVER_SLOT_WAIT_TIMEOUT_MS / 1000)}s waiting for a request slot at solver ${proxyUrl}`,
        ),
        'slot-wait',
      ),
  });
}

/**
 * Rejects every queued waiter with the stated reason, clears every pending wait timer, detaches
 * every abort listener and drops every pool. A bare `Map.clear()` would leave those promises
 * permanently pending and those timers armed, which surfaces later as flake.
 *
 * It holds no handle on in-flight solver fetches and does not abort them — it restores bookkeeping,
 * not the world, so a test must settle or abort its own requests before calling it. Releasers are
 * bound to the instance that issued them, so a pre-reset occupant's release decrements its detached
 * pool and can neither inflate nor corrupt the fresh one. Production has no reset caller.
 */
export function _resetSolverConcurrencyForTesting(): void {
  for (const pool of pools.values()) {
    pool.drainWaiters(new Error('solver concurrency reset'));
  }
  pools.clear();
}
