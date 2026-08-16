/**
 * Shared harness for the solver concurrency bound (#2373), used by `fetch.test.ts` and by the three
 * indexer adapters that reach a solver. It exists because every case has the same two needs: park
 * requests at the solver so "did this reach it?" is an exact observation rather than a race, and
 * drive the slot-wait deadline on demand rather than waiting a real minute for it.
 *
 * **No barrier here is a sleep.** Admission is decided synchronously inside `pool.acquire()` when
 * `fetchWithProxy` is called, so a request's queued-or-admitted verdict is already fixed by the time
 * the call returns; what needs awaiting is only the *observation* that an admitted request reached
 * the stub. That is `reaches`/`receives` — resolved by the stub itself on arrival. `drain` covers the
 * one case an arrival cannot: proving that nothing FURTHER landed, by running a full round trip on an
 * uncontended endpoint and letting anything already admitted overtake it.
 *
 * Teardown ordering is the harness's job precisely because it is easy to get wrong:
 * `_resetSolverConcurrencyForTesting` restores bookkeeping but holds no handle on in-flight solver
 * fetches, so every parked request is released and awaited before the reset runs.
 */

import { http, HttpResponse } from 'msw';
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
  /** Resolves once `count` requests have reached this stub; immediate if already there. */
  reaches(count: number): Promise<void>;
  /** Resolves once a request carrying `targetUrl` has reached this stub. */
  receives(targetUrl: string): Promise<void>;
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

export interface GatedSolverBody {
  /** A body whose bytes are withheld until `complete()`, so headers land long before parsing can. */
  stream: ReadableStream<Uint8Array>;
  /** Resolves once the client starts consuming the body — i.e. `fetch()` has already resolved. */
  reading: Promise<void>;
  complete(): void;
}

/**
 * A solver response whose headers are deliverable immediately but whose body is withheld. This is
 * what separates "the slot is held until the body is read and parsed" from "the slot is held until
 * `fetch()` resolves" — with an already-materialized body the two are indistinguishable.
 *
 * `highWaterMark: 0` is load-bearing: under the default strategy the stream pre-pulls one chunk at
 * construction, so `reading` would resolve before any client existed and the barrier would be a lie.
 */
export function gatedSolverBody(body = 'ok'): GatedSolverBody {
  let announceReading!: () => void;
  const reading = new Promise<void>((resolve) => { announceReading = resolve; });
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => { complete = resolve; });
  let sent = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent) return;
      sent = true;
      announceReading();
      await completed;
      controller.enqueue(new TextEncoder().encode(
        JSON.stringify({ status: 'ok', solution: { response: body, status: 200 } }),
      ));
      controller.close();
    },
  }, { highWaterMark: 0 });

  return { stream, reading, complete };
}

/** A solver response carrying a `gatedSolverBody` stream. */
export function gatedSolverResponse(gated: GatedSolverBody): Response {
  return new HttpResponse(gated.stream, { headers: { 'Content-Type': 'application/json' } });
}

const DRAIN_ENDPOINT = 'http://drain.solver-bound.test';

/**
 * Registers the bound's teardown and returns the observation tools. Call once per `describe`, after
 * `useMswServer()`.
 */
export function useSolverBound(server: ReturnType<typeof setupServer>) {
  const max = SOLVER_MAX_CONCURRENT_REQUESTS;
  /** Captured before any spy replaces it, so the harness never routes through a test's timer spy. */
  const nativeSetTimeout = globalThis.setTimeout;

  const openStubs: SolverStub[] = [];
  const outstanding: Array<Promise<unknown>> = [];
  let timerSpy: { mockRestore: () => void } | undefined;
  let drainStub: SolverStub | undefined;

  /** Lets a rejection be observed later without ever going unhandled. */
  function track<T>(promise: Promise<T>): Promise<T> {
    outstanding.push(promise.catch(() => undefined));
    return promise;
  }

  function stub(endpoint: string, options: SolverStubOptions = {}): SolverStub {
    const { immediate, parked = () => solverOk() } = options;
    const gates: Array<() => void> = [];
    const arrivals: Array<{ satisfied: () => boolean; resolve: () => void }> = [];
    let parking = true;
    const state = { observed: 0, live: 0, peak: 0, targets: [] as string[] };

    function announce(): void {
      for (let i = arrivals.length - 1; i >= 0; i--) {
        if (arrivals[i]!.satisfied()) arrivals.splice(i, 1)[0]!.resolve();
      }
    }

    function when(satisfied: () => boolean): Promise<void> {
      if (satisfied()) return Promise.resolve();
      return new Promise<void>((resolve) => { arrivals.push({ satisfied, resolve }); });
    }

    const handle: SolverStub = {
      get observed() { return state.observed; },
      get live() { return state.live; },
      get peak() { return state.peak; },
      get targets() { return state.targets; },
      reaches: (count) => when(() => state.observed >= count),
      receives: (targetUrl) => when(() => state.targets.includes(targetUrl)),
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
        announce();

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
   * Fills every slot at `proxyUrl` and resolves when all `max` requests have reached `target`,
   * returning them so a caller can await their settlement. Their request timeout is deliberately not
   * `PROXY_TIMEOUT_MS`: that value equals `SOLVER_SLOT_WAIT_TIMEOUT_MS`, and `captureTimer` keys on
   * the delay, so sharing it would make the two timers indistinguishable.
   */
  async function saturate(
    target: SolverStub,
    proxyUrl: string,
    options: SolverRequestOptions = {},
  ): Promise<Array<Promise<FetchResult>>> {
    const before = target.observed;
    const issued = Array.from({ length: max }, (_unused, i) =>
      request(proxyUrl, { timeoutMs: 25_000, url: `https://saturate.test/slot-${i}`, ...options }));
    await target.reaches(before + max);
    return issued;
  }

  /**
   * Resolves once any solver request admitted before this call has reached its stub — the barrier a
   * "nothing further landed" assertion needs, since the absence of an arrival is not itself an event.
   * Two full round trips on an uncontended endpoint, so an admitted request has two chances to
   * overtake; unlike a fixed sleep this scales with the host's actual dispatch latency.
   */
  async function drain(): Promise<void> {
    drainStub ??= stub(`${DRAIN_ENDPOINT}/v1`, { immediate: () => solverOk('drain') });
    await request(DRAIN_ENDPOINT, { url: 'https://drain.test/probe', timeoutMs: 25_000 });
    await request(DRAIN_ENDPOINT, { url: 'https://drain.test/probe', timeoutMs: 25_000 });
  }

  /**
   * Intercepts exactly the timers armed with `delayMs` — the slot-wait deadline by default — so they
   * can be fired on demand while every other timer, MSW's included, keeps running for real. These
   * deadlines are hand-rolled `setTimeout` calls rather than `AbortSignal.timeout`, which is the only
   * reason a spy can see them at all. Keying on the delay is also why a saturating request must not
   * use `PROXY_TIMEOUT_MS`: it equals `SOLVER_SLOT_WAIT_TIMEOUT_MS` and would be captured too.
   */
  function captureTimer(delayMs: number = SOLVER_SLOT_WAIT_TIMEOUT_MS): {
    fire: () => void;
    armed: (count?: number) => Promise<void>;
    delays: number[];
  } {
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    const waiters: Array<{ satisfied: () => boolean; resolve: () => void }> = [];

    timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
      delays.push(delay ?? 0);
      if (delay === delayMs) {
        callbacks.push(handler as () => void);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.satisfied()) waiters.splice(i, 1)[0]!.resolve();
        }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return nativeSetTimeout(handler as () => void, delay, ...rest);
    }) as typeof globalThis.setTimeout);

    return {
      delays,
      fire: () => callbacks.splice(0).forEach((callback) => callback()),
      /** Resolves once `count` such deadlines have been armed — the "it is queued now" barrier. */
      armed: (count = 1) => {
        const satisfied = () => callbacks.length >= count;
        if (satisfied()) return Promise.resolve();
        return new Promise<void>((resolve) => { waiters.push({ satisfied, resolve }); });
      },
    };
  }

  afterEach(async () => {
    timerSpy?.mockRestore();
    timerSpy = undefined;
    drainStub = undefined;
    for (const open of openStubs.splice(0)) open.releaseAll();
    await Promise.allSettled(outstanding.splice(0));
    _resetSolverConcurrencyForTesting();
  });

  return { max, track, stub, request, saturate, drain, captureTimer };
}
