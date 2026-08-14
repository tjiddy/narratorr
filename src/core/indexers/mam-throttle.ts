import { MAM_MIN_REQUEST_INTERVAL_MS } from '../utils/constants.js';
import { IntervalGate } from '../utils/interval-gate.js';
import { normalizedHostPortFromUrl } from '../utils/network-service.js';

/**
 * Canonical destination identity for the gate. The tracker rate-limits a listener, so path, query,
 * host case and an explicit default port are all aliases of one key, while a differing scheme
 * separates through its default port. Never throws: a throw at the transport boundary would turn a
 * working search into a failure, so an unparseable base URL keys on the raw string it was given.
 */
export function mamThrottleKey(baseUrl: string): string {
  try {
    return normalizedHostPortFromUrl(new URL(baseUrl));
  } catch {
    return baseUrl;
  }
}

/**
 * MAM's minimum interval, held per canonical destination. Only the destination-key rule and the
 * reset reason are MAM's own; the FIFO scheduling, clock-step repair and abort handling are
 * `IntervalGate`'s, shared with MetadataService's provider floor.
 */
export class MamRequestThrottle {
  private readonly gate: IntervalGate;

  constructor(intervalMs: number = MAM_MIN_REQUEST_INTERVAL_MS) {
    this.gate = new IntervalGate(intervalMs);
  }

  /**
   * Resolves when the caller may dispatch to `baseUrl`. Rejects only when `signal` aborts — with
   * that signal's own reason, whatever its shape — or when the testing reset drains the queue.
   */
  acquire(baseUrl: string, signal?: AbortSignal): Promise<void> {
    return this.gate.acquire(mamThrottleKey(baseUrl), signal);
  }

  /** Drains every queue; see `_resetMamThrottleForTesting` for the contract. */
  reset(): void {
    this.gate.reset(new Error('MAM throttle reset'));
  }
}

/** Process-local because Narratorr runs as one Node process; see AC5 on why it is not per-adapter. */
export const mamThrottle = new MamRequestThrottle();

/**
 * Clears every stamp, cancels every pending delay timer, detaches every abort listener and rejects
 * every still-queued waiter. A bare `Map.clear()` would leave timer closures armed and promises
 * permanently pending, which surfaces later as flake. Production has no reset caller.
 */
export function _resetMamThrottleForTesting(): void {
  mamThrottle.reset();
}
