/**
 * #2420 — the pacer through the REAL AudioBookBay adapter and the REAL shared transport, measured
 * on the requests that actually reach the wire.
 *
 * **Why a scaled interval.** The production floor is 6.1s, so an honest wall-clock assertion at
 * that value would cost 6-12s per case. The gate is swapped for a real `AbbRequestThrottle` at a
 * test-scale interval, so every scheduling property under test — FIFO order, one interval between
 * dispatches, the position of the wait relative to the solver slot — is the production code's, and
 * only the magnitude is scaled. The 6100 constant itself is pinned in `abb-throttle.test.ts`.
 *
 * **Why the warm-up.** Both stamps are taken inside a handler, so the measured quantity is the
 * interval PLUS the difference of two fetch-to-handler latencies. The run's first intercepted
 * fetch pays a one-time interception cost the second does not, biasing the gap short by ~5-11ms.
 * Warm the path and drop the warm-up's stamp before measuring.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '@core/__tests__/msw/server.js';
import { useSolverBound, solverOk } from '@core/__tests__/solver-bound.js';
import { AudioBookBayIndexer } from '@core/indexers/abb.js';
import { abbDetailsSentinel } from '@core/indexers/abb-sentinel.js';
import {
  AbbRequestThrottle,
  abbThrottle,
  acquireAbbSolverMutex,
  _resetAbbThrottleForTesting,
} from '@core/indexers/abb-throttle.js';
import { IndexerError } from '@core/indexers/errors.js';

/** Small enough to keep the suite fast, large enough to survive Date.now() granularity. */
const INTERVAL = 120;
/** Date.now() is ~15.6ms-granular on Windows, so a strict `>= INTERVAL` flakes there. */
const TOLERANCE = 20;

const ABB_HOST = 'audiobookbay.test';
const ABB_BASE = `https://${ABB_HOST}`;
const OTHER_HOST = 'audiobookbay.other';
const DETAILS_URL = `${ABB_BASE}/audio-books/murder-in-the-new-forest/`;
const FIXTURE_HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

const SEARCH_HTML = `<html><body><div class="post"><div class="postTitle">
  <h2><a href="/audio-books/murder-in-the-new-forest/" rel="bookmark">Murder in the New Forest</a></h2>
</div></div></body></html>`;
const DETAIL_HTML = `<html><body><h1>Murder</h1><pre>Info Hash: ${FIXTURE_HASH}</pre></body></html>`;

describe('#2420 — the real ABB adapter is actually paced', () => {
  const server = useMswServer();
  let scaled: AbbRequestThrottle;
  let dispatched: Array<{ label: string; at: number }>;

  beforeEach(() => {
    _resetAbbThrottleForTesting();
    scaled = new AbbRequestThrottle(INTERVAL);
    // The real gate, at a scaled interval: FIFO order, abort identity and clock repair are all the
    // production implementation's, so what these cases pin is the wiring plus the ordering.
    vi.spyOn(abbThrottle, 'acquire').mockImplementation((url, signal) => scaled.acquire(url, signal));
    dispatched = [];
  });

  afterEach(() => {
    scaled.reset();
    _resetAbbThrottleForTesting();
    vi.restoreAllMocks();
  });

  function stamp(label: string): void {
    dispatched.push({ label, at: Date.now() });
  }

  function gapBetween(first: string, second: string): number {
    const a = dispatched.find((d) => d.label === first)!;
    const b = dispatched.find((d) => d.label === second)!;
    return b.at - a.at;
  }

  /** Pays the one-time interception cost outside the measured window and leaves no gate stamp. */
  async function warmFetchPath(): Promise<void> {
    server.use(http.get(`${ABB_BASE}/warm-up`, () => new HttpResponse('ok')));
    await fetch(`${ABB_BASE}/warm-up`);
    dispatched.length = 0;
  }

  describe('over the direct transport', () => {
    beforeEach(() => {
      server.use(
        http.get(`${ABB_BASE}/`, () => { stamp('page1'); return new HttpResponse(SEARCH_HTML, { headers: { 'Content-Type': 'text/html' } }); }),
        http.get(`${ABB_BASE}/page/:page/`, () => { stamp('page2'); return new HttpResponse(SEARCH_HTML, { headers: { 'Content-Type': 'text/html' } }); }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => { stamp('detail'); return new HttpResponse(DETAIL_HTML, { headers: { 'Content-Type': 'text/html' } }); }),
        http.head(`${ABB_BASE}/`, () => { stamp('test'); return new HttpResponse(null, { status: 200 }); }),
      );
    });

    it('spaces the two pages of one search by the floor', async () => {
      await warmFetchPath();
      const indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });

      await indexer.search('murder');

      expect(dispatched.map((d) => d.label)).toEqual(['page1', 'page2']);
      expect(gapBetween('page1', 'page2')).toBeGreaterThanOrEqual(INTERVAL - TOLERANCE);
    });

    it('makes a grab that follows a search wait out the floor', async () => {
      await warmFetchPath();
      const indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });

      await indexer.search('murder');
      await indexer.resolveDownloadUrl({ downloadUrl: abbDetailsSentinel(DETAILS_URL), protocol: 'torrent', isFreeleech: false });

      expect(gapBetween('page1', 'detail')).toBeGreaterThanOrEqual(INTERVAL - TOLERANCE);
    });

    // The throwaway `test()` adapter used to bypass the queue entirely.
    it('makes a connection test immediately after a search wait out the floor', async () => {
      await warmFetchPath();
      const indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });

      await indexer.search('murder');
      const result = await indexer.test();

      expect(result.success).toBe(true);
      expect(gapBetween('page1', 'test')).toBeGreaterThanOrEqual(INTERVAL - TOLERANCE);
    });

    /**
     * The module-level, destination-keyed shape's whole point: two indexer rows pointing at one
     * hostname share a floor, and the adapter cache is free to evict and rebuild either of them.
     */
    it('gives two separate indexer instances on the same hostname one floor', async () => {
      await warmFetchPath();
      const first = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });
      const second = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });

      await first.search('murder');
      await second.search('forest');

      expect(dispatched.filter((d) => d.label === 'page1')).toHaveLength(2);
      expect(dispatched[1]!.at - dispatched[0]!.at).toBeGreaterThanOrEqual(INTERVAL - TOLERANCE);
    });

    // The control: without it, "paced" also passes against a gate that simply serializes everything.
    it('control: a different hostname does not wait behind ABB\'s floor', async () => {
      server.use(http.get(`https://${OTHER_HOST}/`, () => {
        stamp('other');
        return new HttpResponse(SEARCH_HTML, { headers: { 'Content-Type': 'text/html' } });
      }));
      await warmFetchPath();
      const primary = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });
      const mirror = new AudioBookBayIndexer({ hostname: OTHER_HOST, pageLimit: 1 });

      const startedAt = Date.now();
      await Promise.all([primary.search('murder'), mirror.search('murder')]);

      const other = dispatched.find((d) => d.label === 'other')!;
      expect(other.at - startedAt).toBeLessThan(INTERVAL);
    });
  });

  /**
   * The finding this block exists for. A pacer that runs BEFORE the solver slot is not a pacer:
   * two requests spaced 6.1s apart can both stall behind a saturated pool and be admitted together
   * the moment slots free — the ban-producing burst, reintroduced on exactly the transport an
   * operator adds *because* ABB is blocking them.
   */
  describe('through a saturated FlareSolverr pool', () => {
    const SOLVER_URL = 'http://flaresolverr.test:8191';
    const bound = useSolverBound(server);

    function stubSolver() {
      return bound.stub(`${SOLVER_URL}/v1`, {
        // Stamped at the solver target POST, not at the adapter call: the POST is the request that
        // reaches ABB, and it is the only thing the interval is supposed to space.
        immediate: (targetUrl) => {
          if (!targetUrl.startsWith(ABB_BASE)) return undefined;
          stamp(targetUrl.includes('/audio-books/') ? 'detail' : 'search');
          return solverOk(targetUrl.includes('/audio-books/') ? DETAIL_HTML : SEARCH_HTML);
        },
      });
    }

    /**
     * The stall has to outlast the floor, or the property is unobservable: an acquire taken BEFORE
     * the slot only loses its spacing when the wait it already paid expires while the request is
     * still queued. Held for two intervals, the pre-slot form dispatches both the instant slots
     * free — the exact burst — while the post-slot form still owes the second one a full interval.
     */
    async function holdPastTheFloor(): Promise<void> {
      await new Promise((settle) => setTimeout(settle, INTERVAL * 2));
    }

    it('keeps two ABB requests a full interval apart when slots free after a long stall', async () => {
      const stub = stubSolver();
      const inFlight = await bound.saturate(stub, SOLVER_URL);
      await warmFetchPath();

      const indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: SOLVER_URL });
      const searching = bound.track(indexer.search('murder'));
      const grabbing = bound.track(indexer.resolveDownloadUrl({
        downloadUrl: abbDetailsSentinel(DETAILS_URL), protocol: 'torrent', isFreeleech: false,
      }));

      await holdPastTheFloor();
      stub.releaseAll();
      await Promise.allSettled(inFlight);
      await searching;
      await grabbing;

      expect(dispatched.map((d) => d.label)).toEqual(['search', 'detail']);
      expect(gapBetween('search', 'detail')).toBeGreaterThanOrEqual(INTERVAL - TOLERANCE);
    });

    // F9 — `test()` is solver-bound too, and used to reach `fetchWithProxy` on a path of its own.
    it('paces a connection test that follows a search on the same solver', async () => {
      const stub = stubSolver();
      const inFlight = await bound.saturate(stub, SOLVER_URL);
      await warmFetchPath();

      const indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: SOLVER_URL });
      const searching = bound.track(indexer.search('murder'));
      const testing = bound.track(indexer.test());

      await holdPastTheFloor();
      stub.releaseAll();
      await Promise.allSettled(inFlight);
      await searching;
      const result = await testing;

      expect(result.success).toBe(true);
      expect(dispatched).toHaveLength(2);
      expect(dispatched[1]!.at - dispatched[0]!.at).toBeGreaterThanOrEqual(INTERVAL - TOLERANCE);
    });

    /**
     * ABB's own mutex is what stops its pacing waits from eating the pool. The observation point
     * has to PARK the requests at the solver: with an instant reply nothing ever overlaps, so
     * `peak` reads 1 whether the mutex exists or not. Parked, an unmutexed ABB takes a second slot
     * one interval later and a third after that — three of three, starving every other indexer.
     */
    it('occupies exactly one solver slot while its other requests wait out the floor', async () => {
      const parked = bound.stub(`${SOLVER_URL}/v1`);
      await warmFetchPath();

      const indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: SOLVER_URL });
      const issued = [
        bound.track(indexer.search('one')),
        bound.track(indexer.search('two')),
        bound.track(indexer.search('three')),
      ];
      await parked.reaches(1);
      // Long enough that an unmutexed second and third request would both have dispatched.
      await new Promise((settle) => setTimeout(settle, INTERVAL * 3));

      expect(parked.observed).toBe(1);
      expect(parked.live).toBe(1);

      parked.releaseAll();
      await Promise.allSettled(issued);
    });
  });

  describe('cancellation in each of the three queues', () => {
    const SOLVER_URL = 'http://flaresolverr.test:8191';
    const bound = useSolverBound(server);

    it('rejects with the caller\'s own reason while queued on the interval gate', async () => {
      const reason = { cancelled: 'gate' };
      const controller = new AbortController();
      server.use(http.get(`${ABB_BASE}/`, () => { stamp('page1'); return new HttpResponse(SEARCH_HTML, { headers: { 'Content-Type': 'text/html' } }); }));
      const indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });

      // Spend the floor, so the next acquire genuinely queues.
      await indexer.search('warm');
      const queued = indexer.search('cancelled', { signal: controller.signal });
      controller.abort(reason);

      await expect(queued).rejects.toBe(reason);
    });

    it('rejects with the caller\'s own reason while queued on the solver semaphore', async () => {
      const reason = { cancelled: 'solver slot' };
      const controller = new AbortController();
      const stub = bound.stub(`${SOLVER_URL}/v1`);
      const inFlight = await bound.saturate(stub, SOLVER_URL);
      const indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: SOLVER_URL });

      const queued = bound.track(indexer.search('cancelled', { signal: controller.signal }));
      // The request is behind the bound: nothing ABB-shaped has reached the solver.
      expect(stub.targets.some((t) => t.startsWith(ABB_BASE))).toBe(false);
      controller.abort(reason);

      await expect(queued).rejects.toBe(reason);
      stub.releaseAll();
      await Promise.allSettled(inFlight);
    });

    it('rejects with the caller\'s own reason while queued on ABB\'s own solver mutex', async () => {
      const reason = { cancelled: 'mutex' };
      const controller = new AbortController();
      bound.stub(`${SOLVER_URL}/v1`, { immediate: () => solverOk(SEARCH_HTML) });
      const indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: SOLVER_URL });

      // Hold ABB's mutex from outside the adapter, so its next solver-bound request queues on it.
      const held = await acquireAbbSolverMutex(`${ABB_BASE}/?s=x`);
      const queued = bound.track(indexer.search('cancelled', { signal: controller.signal }));
      controller.abort(reason);

      await expect(queued).rejects.toBe(reason);

      // The abandoned waiter released nothing it did not hold: a successor still gets the mutex.
      held();
      await expect(bound.track(indexer.search('after'))).resolves.toMatchObject({ results: expect.any(Array) });
    });

    it('releases the solver slot when the pacing wait inside it is aborted', async () => {
      const reason = { cancelled: 'inside the slot' };
      const controller = new AbortController();
      const stub = bound.stub(`${SOLVER_URL}/v1`, { immediate: () => solverOk(SEARCH_HTML) });
      const indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: SOLVER_URL });

      // Spend the floor so the second request holds a slot while waiting on the gate.
      await bound.track(indexer.search('warm'));
      const queued = bound.track(indexer.search('cancelled', { signal: controller.signal }));
      controller.abort(reason);
      await expect(queued).rejects.toBe(reason);

      // A leaked slot would permanently shrink the pool; the next batch must still fill it.
      const parking = bound.stub(`${SOLVER_URL}/v1`);
      const inFlight = await bound.saturate(parking, SOLVER_URL);
      expect(parking.observed).toBe(bound.max);
      parking.releaseAll();
      await Promise.allSettled(inFlight);
      expect(stub.observed).toBeGreaterThan(0);
    });
  });

  it('surfaces a gate rejection from the grab path as an IndexerError, not a silent success', async () => {
    server.use(http.get(`${ABB_BASE}/audio-books/:slug/`, () => new HttpResponse(DETAIL_HTML, { headers: { 'Content-Type': 'text/html' } })));
    const indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });
    vi.spyOn(abbThrottle, 'acquire').mockRejectedValue(new Error('ABB throttle reset'));

    const error = await indexer.resolveDownloadUrl({
      downloadUrl: abbDetailsSentinel(DETAILS_URL), protocol: 'torrent', isFreeleech: false,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IndexerError);
    expect((error as IndexerError).message).toContain('ABB throttle reset');
  });
});
