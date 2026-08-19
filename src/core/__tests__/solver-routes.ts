/**
 * Aims one specific transport outcome at one specific address, for the #2374 diagnosis suites.
 *
 * MSW cannot express what these tests need. `HttpResponse.error()` produces a network error with
 * **no** `code`, which is AC12's *inconclusive* case rather than the refusal case the incident was,
 * and it cannot produce the `AbortError` the solver round-trip's own deadline raises. So the stub
 * goes at the fetch boundary — the same place `abb.test.ts` already mocks
 * `fetchWithOptionalDispatcher` towards — and anything the route declines falls through to whatever
 * `globalThis.fetch` was, so MSW keeps serving the rest.
 *
 * The route sees the method as well as the URL because the solver probe and the solver round-trip
 * share an address: `HEAD` on `/v1` is the probe, `POST` is the round-trip.
 */

import { vi } from 'vitest';

/**
 * A response to deliver, an error to reject with, a promise to adopt (for a request that must not
 * answer until its caller's own deadline fires), or `undefined` to fall through.
 */
export type RouteOutcome = Response | Error | Promise<Response> | undefined;

export interface FetchCall {
  url: string;
  method: string;
  init: RequestInit & { dispatcher?: unknown };
}

export interface RoutedFetch {
  /** Every call this route saw, in order — including the ones it declined. */
  readonly calls: FetchCall[];
  /** The calls whose method matches, for "was a probe issued?" assertions. */
  probes(): FetchCall[];
  restore(): void;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/**
 * Replaces `globalThis.fetch` with a router. Capture happens at call time, so this must run after
 * MSW's `server.listen()` for the fall-through path to reach MSW.
 */
export function routeFetch(
  route: (url: string, method: string, init: RequestInit | undefined) => RouteOutcome,
): RoutedFetch {
  const realFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, init: (init ?? {}) as FetchCall['init'] });

    const outcome = route(url, method, init as RequestInit | undefined);
    if (outcome instanceof Error) return Promise.reject(outcome);
    if (outcome) return Promise.resolve(outcome);
    return realFetch(input, init);
  });

  return {
    calls,
    probes: () => calls.filter((call) => call.method === 'HEAD'),
    restore: () => spy.mockRestore(),
  };
}

/** The shape undici surfaces a real transport failure in: wrapped `TypeError`, coded cause. */
export function codedRejection(code: string, causeMessage = `connect ${code} 10.0.0.7:443`): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(causeMessage), { code }),
  });
}

/** A rejection with no transport code at all — AC12's total default. */
export function uncodedRejection(causeMessage = 'socket hang up'): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: new Error(causeMessage) });
}

/** What an expiring `AbortController` deadline rejects with, which is the round-trip-timeout arm. */
export function abortRejection(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

/**
 * A request that answers nothing until the caller's own signal aborts it — the blackhole case, and
 * the only way to prove a probe is bounded by its own deadline rather than by the round-trip's.
 */
export function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(abortRejection()));
  });
}

/** A FlareSolverr protocol envelope, deliverable at any HTTP status. */
export function solverEnvelope(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
