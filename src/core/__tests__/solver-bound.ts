/**
 * Shared harness for the solver concurrency bound (#2373), used by `fetch.test.ts` and by the three
 * indexer adapters that reach a solver. It exists because every case has the same two needs: park
 * requests at the solver so "did this reach it?" is an exact observation rather than a race, and
 * drive the slot-wait deadline on demand rather than waiting a real minute for it.
 *
 * **Every barrier here is causal — nothing waits "long enough".** The key is that production makes a
 * queued request directly observable: `BoundedSemaphore.acquire` arms its slot-wait deadline
 * synchronously and *only* on the queueing branch, and `pump` (admission), `abandon` (abort/expiry)
 * and `drainWaiters` each clear it synchronously. So an armed-and-uncleared deadline is exactly a
 * request sitting behind the bound, and intercepting `setTimeout`/`clearTimeout` for that delay reads
 * the live queue depth rather than guessing at it.
 *
 * That is what `accountedFor` rests on: a request either reaches the solver or arms a deadline, never
 * neither and never both, so `arrivals + queueDepth` reaching the issued count means the whole batch
 * has been adjudicated. A witness that watched only arrivals would still be sound when the bound
 * works and silently early when it over-admits — which is the failure mode these tests exist to catch.
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

export interface TimerWitness {
  /** Every delay passed to `setTimeout` while this witness was installed, in order. */
  readonly delays: number[];
  /**
   * Timers armed with `delayMs` and not yet cleared or fired. For the slot-wait delay this is the
   * live queue depth behind the bound, read synchronously — production arms on queue and clears on
   * admission, abort, expiry and drain.
   */
  pending(delayMs?: number): number;
  /** Resolves once `count` timers with `delayMs` have been armed, cumulatively. */
  armed(count?: number, delayMs?: number): Promise<void>;
  /** Runs and discards every pending timer armed with `delayMs`. */
  fire(delayMs?: number): void;
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
  /** A body whose tail is withheld until `complete()`, so headers land long before parsing can. */
  stream: ReadableStream<Uint8Array>;
  /**
   * Resolves once `fetch()` has already resolved for this response and the caller is draining its
   * body — the exact window in which a slot released "after fetch" is free but one released "after
   * parsing" is not. See `gatedSolverBody` for why the second pull is what pins that ordering.
   */
  draining: Promise<void>;
  complete(): void;
}

/**
 * A solver response whose headers are deliverable immediately but whose body tail is withheld. This
 * is what separates "the slot is held until the body is read and parsed" from "the slot is held
 * until `fetch()` resolves" — with an already-materialized body the two are indistinguishable.
 *
 * Two details are load-bearing, both measured against Node 24 + msw 2.15:
 *
 * - `highWaterMark: 0`, or the default strategy pre-pulls a chunk at construction and any pull-based
 *   witness fires before a client exists.
 * - The body is emitted in TWO chunks, and `draining` resolves on the SECOND pull. The observed
 *   order is `handler → pull#1 → fetch() resolves → pull#2`, so the first pull is still part of the
 *   Fetch implementation assembling the response and is NOT evidence that the caller holds it. Only
 *   the second pull proves `fetch()` already returned — which is precisely the moment a
 *   release-after-headers bug has fired and a release-after-parse implementation has not.
 */
export function gatedSolverBody(body = 'ok'): GatedSolverBody {
  let announceDraining!: () => void;
  const draining = new Promise<void>((resolve) => { announceDraining = resolve; });
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => { complete = resolve; });

  const encoder = new TextEncoder();
  const payload = JSON.stringify({ status: 'ok', solution: { response: body, status: 200 } });
  const head = payload.slice(0, 1);
  const tail = payload.slice(1);
  let pulls = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulls++;
      if (pulls === 1) {
        controller.enqueue(encoder.encode(head));
        return;
      }
      if (pulls > 2) return;
      announceDraining();
      await completed;
      controller.enqueue(encoder.encode(tail));
      controller.close();
    },
  }, { highWaterMark: 0 });

  return { stream, draining, complete };
}

/** A solver response carrying a `gatedSolverBody` stream. */
export function gatedSolverResponse(gated: GatedSolverBody): Response {
  return new HttpResponse(gated.stream, { headers: { 'Content-Type': 'application/json' } });
}

/** Far above any real timer id, so a captured handle can never be mistaken for a live one. */
const CAPTURED_TIMER_ID_BASE = 1_000_000_000;

/**
 * Registers the bound's teardown and returns the observation tools. Call once per `describe`, after
 * `useMswServer()`.
 */
export function useSolverBound(server: ReturnType<typeof setupServer>) {
  const max = SOLVER_MAX_CONCURRENT_REQUESTS;
  /** Captured before any spy replaces them, so the harness never routes through its own mocks. */
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;

  const openStubs: SolverStub[] = [];
  const outstanding: Array<Promise<unknown>> = [];
  const conditions: Array<{ satisfied: () => boolean; resolve: () => void }> = [];
  const installedSpies: Array<{ mockRestore: () => void }> = [];

  /** Re-checks every pending condition. Called on each observable transition. */
  function announce(): void {
    for (let i = conditions.length - 1; i >= 0; i--) {
      if (conditions[i]!.satisfied()) conditions.splice(i, 1)[0]!.resolve();
    }
  }

  function awaitCondition(satisfied: () => boolean): Promise<void> {
    if (satisfied()) return Promise.resolve();
    return new Promise<void>((resolve) => { conditions.push({ satisfied, resolve }); });
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
      reaches: (count) => awaitCondition(() => state.observed >= count),
      receives: (targetUrl) => awaitCondition(() => state.targets.includes(targetUrl)),
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
   * `PROXY_TIMEOUT_MS`: that value equals `SOLVER_SLOT_WAIT_TIMEOUT_MS`, and `captureTimers` keys on
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
   * Intercepts exactly the timers armed with one of `delaysToCapture` so they can be counted and
   * fired on demand, while every other timer — MSW's included — keeps running for real.
   *
   * Both `setTimeout` and `clearTimeout` are intercepted, which is what makes `pending` a live read
   * of production state rather than a running total: the semaphore clears a waiter's deadline the
   * instant it is admitted, aborted, expired or drained.
   *
   * **Trap when saturating through an adapter:** an adapter does not take `timeoutMs` from the test,
   * so its request timer is armed with `PROXY_TIMEOUT_MS` — the same value as
   * `SOLVER_SLOT_WAIT_TIMEOUT_MS`, and therefore indistinguishable by delay. Install the witness only
   * after that traffic is already in flight, or admitted requests are counted as queued ones. Tests
   * that drive the transport directly avoid this by passing a request timeout of their own.
   */
  function captureTimers(delaysToCapture: number[] = [SOLVER_SLOT_WAIT_TIMEOUT_MS]): TimerWitness {
    const primary = delaysToCapture[0] ?? SOLVER_SLOT_WAIT_TIMEOUT_MS;
    const delays: number[] = [];
    const captured = new Map<number, { delay: number; run: () => void }>();
    const armedTotals = new Map<number, number>();
    let nextId = 0;

    installedSpies.push(
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
        delays.push(delay ?? 0);
        if (delay !== undefined && delaysToCapture.includes(delay)) {
          const id = CAPTURED_TIMER_ID_BASE + nextId++;
          captured.set(id, { delay, run: handler as () => void });
          armedTotals.set(delay, (armedTotals.get(delay) ?? 0) + 1);
          announce();
          return id as unknown as ReturnType<typeof setTimeout>;
        }
        return nativeSetTimeout(handler as () => void, delay, ...rest);
      }) as typeof globalThis.setTimeout),
    );

    installedSpies.push(
      vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle?: unknown) => {
        if (typeof handle === 'number' && captured.delete(handle)) {
          announce();
          return;
        }
        nativeClearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]);
      }) as typeof globalThis.clearTimeout),
    );

    return {
      delays,
      pending: (delayMs = primary) =>
        [...captured.values()].filter((entry) => entry.delay === delayMs).length,
      armed: (count = 1, delayMs = primary) =>
        awaitCondition(() => (armedTotals.get(delayMs) ?? 0) >= count),
      fire: (delayMs = primary) => {
        for (const [id, entry] of [...captured.entries()]) {
          if (entry.delay !== delayMs) continue;
          captured.delete(id);
          entry.run();
        }
        announce();
      },
    };
  }

  /**
   * Resolves once every request issued against `target`'s solver has declared itself: production
   * either dispatches it (an arrival) or arms its slot-wait deadline (a queue entry), synchronously
   * and exclusively. Summing the two is therefore a complete witness that the batch has been
   * adjudicated, and — unlike waiting on arrivals alone — it stays honest when the bound over-admits,
   * because the surplus arrival is counted rather than silently overtaken.
   *
   * Assert the exact split afterwards; this only establishes that everything has landed somewhere.
   */
  function accountedFor(
    target: SolverStub,
    timers: TimerWitness,
    expected: { arrived: number; queued: number },
  ): Promise<void> {
    const total = expected.arrived + expected.queued;
    return awaitCondition(() => target.observed + timers.pending() >= total);
  }

  afterEach(async () => {
    for (const spy of installedSpies.splice(0)) spy.mockRestore();
    for (const open of openStubs.splice(0)) open.releaseAll();
    await Promise.allSettled(outstanding.splice(0));
    conditions.splice(0);
    _resetSolverConcurrencyForTesting();
  });

  return { max, track, stub, request, saturate, captureTimers, accountedFor };
}
