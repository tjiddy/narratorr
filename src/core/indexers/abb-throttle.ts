import { ABB_MIN_REQUEST_INTERVAL_MS } from '../utils/constants.js';
import { BoundedSemaphore, type SlotRelease } from '../utils/bounded-semaphore.js';
import { IntervalGate } from '../utils/interval-gate.js';
import { normalizedHostPortFromUrl } from '../utils/network-service.js';

const RESET_REASON = 'ABB throttle reset';

/**
 * Canonical destination identity for the gate. ABB rate-limits a client per site, so the search
 * page, page two and a detail page are one destination — path, query, host case and an explicit
 * default port are all aliases of one key. Never throws: a throw at the transport boundary would
 * turn a working search into a failure, so an unparseable URL keys on the raw string it was given.
 */
export function abbThrottleKey(url: string): string {
  try {
    return normalizedHostPortFromUrl(new URL(url));
  } catch {
    return url;
  }
}

/**
 * ABB's minimum interval, held per canonical destination. Only the destination-key rule and the
 * reset reason are ABB's own; the FIFO scheduling, clock-step repair and abort handling are
 * `IntervalGate`'s, shared with MAM's floor and MetadataService's provider floor.
 */
export class AbbRequestThrottle {
  private readonly gate: IntervalGate;

  constructor(intervalMs: number = ABB_MIN_REQUEST_INTERVAL_MS) {
    this.gate = new IntervalGate(intervalMs);
  }

  /**
   * Resolves when the caller may dispatch to `url`. Rejects only when `signal` aborts — with that
   * signal's own reason, whatever its shape — or when the testing reset drains the queue.
   */
  acquire(url: string, signal?: AbortSignal): Promise<void> {
    return this.gate.acquire(abbThrottleKey(url), signal);
  }

  /** Drains every queue; see `_resetAbbThrottleForTesting` for the contract. */
  reset(): void {
    this.gate.reset(new Error(RESET_REASON));
  }
}

/** Process-local because Narratorr runs as one Node process; the floor belongs to the destination. */
export const abbThrottle = new AbbRequestThrottle();

const solverMutexes = new Map<string, BoundedSemaphore>();

/**
 * Serializes ABB's own solver-bound requests, one per destination, so its pacing waits cannot eat
 * the process-global solver pool. Three concurrent ABB requests would otherwise hold all
 * `SOLVER_MAX_CONCURRENT_REQUESTS` slots while waiting out 0/6.1/12.2s of pacing, starving every
 * other indexer for the whole window — on exactly the transport an operator adds *because* ABB is
 * blocking them. With it, at most one ABB request occupies a slot while paced.
 *
 * Deliberately not a scheduler and not generic: it bounds ABB's own occupancy and nothing else.
 */
export function acquireAbbSolverMutex(url: string, signal?: AbortSignal): Promise<SlotRelease> {
  const key = abbThrottleKey(url);
  let mutex = solverMutexes.get(key);
  if (!mutex) {
    mutex = new BoundedSemaphore(1);
    solverMutexes.set(key, mutex);
  }
  return mutex.acquire({ signal });
}

/**
 * Clears every stamp, cancels every pending delay timer, detaches every abort listener and rejects
 * every still-queued waiter in both queues. A bare `Map.clear()` would leave timer closures armed
 * and promises permanently pending, which surfaces later as flake. Production has no reset caller.
 */
export function _resetAbbThrottleForTesting(): void {
  abbThrottle.reset();
  for (const mutex of solverMutexes.values()) {
    mutex.drainWaiters(new Error(RESET_REASON));
  }
  solverMutexes.clear();
}
