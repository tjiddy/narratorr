import { normalizeBaseUrl } from '@shared/normalize-base-url.js';

/**
 * The URL a FlareSolverr-compatible solver request is POSTed to. Single-homed because two things
 * read it: the transport in `fetch.ts` and the concurrency key in `solver-concurrency.ts`. The key
 * is defined as the request target that goes on the wire, so a second copy of this expression would
 * let the two drift — one solver could then be split across two pools of N, or two solvers merged
 * into one, both of which defeat the bound (#2373).
 */
export function solverEndpoint(proxyUrl: string): string {
  return `${normalizeBaseUrl(proxyUrl)}/v1`;
}
