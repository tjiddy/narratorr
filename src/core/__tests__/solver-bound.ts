/**
 * Shared harness for the solver concurrency bound (#2373), used by `fetch.test.ts` and by the three
 * indexer adapters that reach a solver. It exists because every case has the same two needs: park
 * requests at the solver so "did this reach it?" is an exact observation rather than a race, and
 * drive the slot-wait deadline on demand rather than waiting a real minute for it.
 *
 * Teardown ordering is the harness's job precisely because it is easy to get wrong:
 * `_resetSolverConcurrencyForTesting` restores bookkeeping but holds no handle on in-flight solver
 * fetches, so every parked request is released and awaited before the reset runs.
 */

import { http } from 'msw';
import type { setupServer } from 'msw/node';
import { afterEach, vi } from 'vitest';

import { fetchWithProxy, type FetchResult } from '../indexers/fetch.js';
import { _resetSolverConcurrencyForTesting } from '../indexers/solver-concurrency.js';
import { SOLVER_MAX_CONCURRENT_REQUESTS, SOLVER_SLOT_WAIT_TIMEOUT_MS } from '../utils/constants.js';

/** Answers a request the moment it arrives, or returns `undefined` to let it park. */
export type SolverReply = (targetUrl: string) => Response | undefined;

export interface SolverStubOptions {
  /** Lets specific target URLs through untouched — an adapter's first page, say. */
  immediate?: SolverReply;
  /** The outcome a parked request gets once released; may throw to model a failing solver. */
  parked?: () => Response;
}

export interface SolverStub {
  /** The target URL each request that reached the solver carried, in arrival order. */
  readonly targets: string[];
  readonly observed: number;
  readonly live: number;
  readonly peak: number;
  /** Frees the longest-parked request. */
  releaseOne(): void;
  /** Frees every parked request and stops parking new ones. */
  releaseAll(): void;
}

export interface SolverRequestOptions {
  url?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function solverOk(body = 'ok'): Response {
  return Response.json({ status: 'ok', solution: { response: body, status: 200 } });
}

/**
 * Registers the bound's teardown and returns the observation tools. Call once per `describe`, after
 * `useMswServer()`.
 */
export function useSolverBound(server: ReturnType<typeof setupServer>) {
  const max = SOLVER_MAX_CONCURRENT_REQUESTS;
  /** Captured before any spy replaces it, so pacing is immune to the timer spy below. */
  const nativeSetTimeout = globalThis.setTimeout;

  const openStubs: SolverStub[] = [];
  const outstanding: Array<Promise<unknown>> = [];
  let timerSpy: { mockRestore: () => void } | undefined;

  function settle(ms = 20): Promise<void> {
    return new Promise((resolve) => nativeSetTimeout(resolve, ms));
  }

  /** Lets a rejection be observed later without ever going unhandled. */
  function track<T>(promise: Promise<T>): Promise<T> {
    outstanding.push(promise.catch(() => undefined));
    return promise;
  }

  function stub(endpoint: string, options: SolverStubOptions = {}): SolverStub {
    const { immediate, parked = () => solverOk() } = options;
    const gates: Array<() => void> = [];
    let parking = true;
    const state = { observed: 0, live: 0, peak: 0, targets: [] as string[] };

    const handle: SolverStub = {
      get observed() { return state.observed; },
      get live() { return state.live; },
      get peak() { return state.peak; },
      get targets() { return state.targets; },
      releaseOne: () => gates.shift()?.(),
      releaseAll: () => {
        parking = false;
        for (const open of gates.splice(0)) open();
      },
    };

    server.use(
      http.post(endpoint, async ({ request }) => {
        const body = await request.json() as { url?: string };
        const targetUrl = body.url ?? '';
        state.observed++;
        state.targets.push(targetUrl);
        state.live++;
        state.peak = Math.max(state.peak, state.live);

        const answer = immediate?.(targetUrl);
        if (answer) {
          state.live--;
          return answer;
        }

        if (parking) await new Promise<void>((resolve) => gates.push(resolve));
        state.live--;
        return parked();
      }),
    );

    openStubs.push(handle);
    return handle;
  }

  function request(proxyUrl: string, options: SolverRequestOptions = {}): Promise<FetchResult> {
    return track(fetchWithProxy({
      url: options.url ?? 'https://indexer.test/api?q=test',
      proxyUrl,
      ...(options.signal !== undefined && { signal: options.signal }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    }));
  }

  /**
   * Fills every slot at `proxyUrl` with parked requests. Their own request timeout is deliberately
   * not `PROXY_TIMEOUT_MS`: that value equals `SOLVER_SLOT_WAIT_TIMEOUT_MS`, and `captureSlotWait`
   * keys on the delay to tell the two timers apart.
   */
  async function saturate(proxyUrl: string, options: SolverRequestOptions = {}): Promise<void> {
    for (let i = 0; i < max; i++) {
      request(proxyUrl, { timeoutMs: 25_000, url: `https://saturate.test/slot-${i}`, ...options });
    }
    await settle();
  }

  /**
   * Redirects only the slot-wait deadline so it can be fired on demand while MSW keeps running on
   * real timers. The deadline is a hand-rolled `setTimeout`, not `AbortSignal.timeout`, which is
   * what makes it visible to the spy at all.
   */
  function captureSlotWait(): { fire: () => void; delays: number[] } {
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];

    timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
      delays.push(delay ?? 0);
      if (delay === SOLVER_SLOT_WAIT_TIMEOUT_MS) {
        callbacks.push(handler as () => void);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return nativeSetTimeout(handler as () => void, delay, ...rest);
    }) as typeof globalThis.setTimeout);

    return { delays, fire: () => callbacks.splice(0).forEach((callback) => callback()) };
  }

  afterEach(async () => {
    timerSpy?.mockRestore();
    timerSpy = undefined;
    for (const open of openStubs.splice(0)) open.releaseAll();
    await Promise.allSettled(outstanding.splice(0));
    _resetSolverConcurrencyForTesting();
  });

  return { max, settle, track, stub, request, saturate, captureSlotWait };
}
