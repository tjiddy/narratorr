/**
 * Structural identity for the failures a FlareSolverr-compatible round-trip can raise. The seven
 * `FlareSolverr …` strings `fetch.ts` throws are operator text — `isProxyRelatedError` matches their
 * prefix and several are pinned by tests — so the diagnosis (#2374) cannot key on them. It keys on
 * this discriminant instead, carried beside the message as own properties, the shape
 * `httpStatusError` and `mapNetworkError` already use.
 *
 * The discriminant records ONLY where the throw originated, which is the only thing the transport
 * retains. It is never a diagnosis, a component name, or anything read out of a response body —
 * that is the classifier's job or nobody's.
 */

/** Where in the round-trip the throw was written. Purely positional. */
export type SolverFailureOrigin =
  | 'slot-wait'
  | 'solver-no-answer'
  | 'solver-answered'
  | 'round-trip-timeout';

export interface SolverFailure {
  origin: SolverFailureOrigin;
  /**
   * The transport code recovered from the retained cause, on `solver-no-answer` only. Position alone
   * proves that no `Response` was obtained; it cannot separate "that address refused" from "our own
   * resolver is down", and the code is the only thing that can.
   */
  transportCode?: string;
  /**
   * The upstream status the solver DELIVERED, on `solver-answered` only (#2483). It is the origin's
   * own answer relayed through the solver, so it is conclusive evidence the target responded — the
   * one thing a reachability probe could otherwise have established, already established.
   */
  httpStatus?: number;
}

const ORIGIN_KEY = 'solverFailureOrigin';
const CODE_KEY = 'solverTransportCode';
/** `httpStatusError`'s own property, read here rather than re-attached under a solver-specific key. */
const STATUS_KEY = 'httpStatus';

/**
 * Every arm the round-trip can throw from. Exported so the classifier's table test enumerates the
 * real registry: a fifth arm added to `fetch.ts` then shows up as a failing test rather than
 * silently falling through to whatever the classifier's last branch happens to be.
 */
export const SOLVER_FAILURE_ORIGINS: readonly SolverFailureOrigin[] = Object.freeze([
  'slot-wait',
  'solver-no-answer',
  'solver-answered',
  'round-trip-timeout',
]);

/** Attach the discriminant, leaving the message byte-identical. */
export function markSolverFailure<E extends Error>(
  error: E,
  origin: SolverFailureOrigin,
  transportCode?: string,
): E {
  return Object.assign(error, {
    [ORIGIN_KEY]: origin,
    ...(transportCode !== undefined && { [CODE_KEY]: transportCode }),
  });
}

/** The discriminant an error carries, or `undefined` when it never came from a solver round-trip. */
export function solverFailureOf(error: unknown): SolverFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const marked = error as Error & { [ORIGIN_KEY]?: unknown; [CODE_KEY]?: unknown; [STATUS_KEY]?: unknown };
  const origin = marked[ORIGIN_KEY];
  if (typeof origin !== 'string' || !SOLVER_FAILURE_ORIGINS.includes(origin as SolverFailureOrigin)) return undefined;
  const transportCode = marked[CODE_KEY];
  const httpStatus = marked[STATUS_KEY];
  return {
    origin: origin as SolverFailureOrigin,
    ...(typeof transportCode === 'string' && { transportCode }),
    ...(typeof httpStatus === 'number' && { httpStatus }),
  };
}

/** The own `code` a `mapNetworkError` result carries; classification reads it, never the message. */
export function transportCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
