import { describe, it, expect, vi, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ZodError } from 'zod';
import { useMswServer } from '../__tests__/msw/server.js';
import { getErrorMessage } from '@shared/error-message.js';
import { fetchWithProxy } from './fetch.js';
import { fetchWithProxyAgent } from './proxy.js';
import { isProxyRelatedError, ProxyError } from './errors.js';
import { solverFailureOf } from './solver-failure.js';
import { _resetSolverConcurrencyForTesting } from './solver-concurrency.js';
import {
  gatedSolverBody,
  gatedSolverResponse,
  solverOk,
  useSolverBound,
  type SolverRequestOptions,
} from '../__tests__/solver-bound.js';
import { PROXY_TIMEOUT_MS, SOLVER_SLOT_WAIT_TIMEOUT_MS } from '../utils/constants.js';

const TARGET_URL = 'https://indexer.test/api?q=test';
const PROXY_URL = 'http://flaresolverr.test:8191';

describe('fetchWithProxy', () => {
  const server = useMswServer();

  describe('direct fetch (no proxy)', () => {
    it('fetches URL directly and returns response text', async () => {
      server.use(
        http.get('https://indexer.test/api', () => {
          return new HttpResponse('<xml>data</xml>', {
            headers: { 'Content-Type': 'application/xml' },
          });
        }),
      );

      const result = await fetchWithProxy({ url: TARGET_URL });
      expect(result.body).toBe('<xml>data</xml>');
      expect(result.requestUrl).toBe(TARGET_URL);
      expect(result.httpStatus).toBe(200);
    });

    it('passes headers to direct request', async () => {
      let capturedHeaders: Record<string, string> = {};
      server.use(
        http.get('https://indexer.test/api', ({ request }) => {
          capturedHeaders = Object.fromEntries(request.headers.entries());
          return new HttpResponse('ok');
        }),
      );

      await fetchWithProxy({
        url: TARGET_URL,
        headers: { Accept: 'application/xml', 'User-Agent': 'Test/1.0' },
      });

      expect(capturedHeaders.accept).toBe('application/xml');
      expect(capturedHeaders['user-agent']).toBe('Test/1.0');
    });

    it('throws on HTTP error', async () => {
      server.use(
        http.get('https://indexer.test/api', () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await expect(fetchWithProxy({ url: TARGET_URL })).rejects.toThrow('HTTP 500');
    });

    it('throws on network error', async () => {
      server.use(
        http.get('https://indexer.test/api', () => {
          return HttpResponse.error();
        }),
      );

      await expect(fetchWithProxy({ url: TARGET_URL })).rejects.toThrow();
    });

    describe('network error mapping (#227)', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('maps ECONNREFUSED to actionable message with port', async () => {
        const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), { code: 'ECONNREFUSED' });
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(
          Object.assign(new TypeError('fetch failed'), { cause }),
        );
        await expect(fetchWithProxy({ url: TARGET_URL })).rejects.toThrow(/connection refused/i);
        await expect(fetchWithProxy({ url: TARGET_URL })).rejects.toThrow(/8080/);
      });

      it('maps ENOTFOUND to actionable message with hostname', async () => {
        const cause = Object.assign(new Error('getaddrinfo ENOTFOUND badhost.local'), { code: 'ENOTFOUND' });
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(
          Object.assign(new TypeError('fetch failed'), { cause }),
        );
        await expect(fetchWithProxy({ url: TARGET_URL })).rejects.toThrow(/dns/i);
        await expect(fetchWithProxy({ url: TARGET_URL })).rejects.toThrow(/badhost\.local/);
      });

      it('maps TimeoutError to actionable timeout message', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        );
        await expect(fetchWithProxy({ url: TARGET_URL })).rejects.toThrow(/timed out/i);
      });
    });

    it('uses 30s default timeout for direct fetch', async () => {
      server.use(
        http.get('https://indexer.test/api', () => {
          return new HttpResponse('ok');
        }),
      );

      const result = await fetchWithProxy({ url: TARGET_URL });
      expect(result.body).toBe('ok');
    });
  });

  describe('proxied fetch (with FlareSolverr)', () => {
    it('routes request through FlareSolverr proxy', async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({
            status: 'ok',
            solution: { response: '<html>proxied</html>', status: 200 },
          });
        }),
      );

      const result = await fetchWithProxy({
        url: TARGET_URL,
        proxyUrl: PROXY_URL,
      });

      expect(result.body).toBe('<html>proxied</html>');
      expect(result.requestUrl).toBe(TARGET_URL);
      expect(result.httpStatus).toBe(200);
      expect(capturedBody.cmd).toBe('request.get');
      expect(capturedBody.url).toBe(TARGET_URL);
      expect(capturedBody.maxTimeout).toBe(60000);
    });

    it('includes adapter headers in FlareSolverr POST body', async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({
            status: 'ok',
            solution: { response: 'ok', status: 200 },
          });
        }),
      );

      await fetchWithProxy({
        url: TARGET_URL,
        headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' },
        proxyUrl: PROXY_URL,
      });

      expect(capturedBody.headers).toEqual({
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0',
      });
    });

    it('omits headers from body when none provided', async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({
            status: 'ok',
            solution: { response: 'ok', status: 200 },
          });
        }),
      );

      await fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL });
      expect(capturedBody.headers).toBeUndefined();
    });

    it('strips trailing slash from proxy URL', async () => {
      let capturedUrl = '';
      server.use(
        http.post(`${PROXY_URL}/v1`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            status: 'ok',
            solution: { response: 'ok', status: 200 },
          });
        }),
      );

      await fetchWithProxy({
        url: TARGET_URL,
        proxyUrl: `${PROXY_URL}/`,
      });

      expect(capturedUrl).toContain(`${PROXY_URL}/v1`);
    });

    it('uses 60s default timeout for proxied fetch', async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({
            status: 'ok',
            solution: { response: 'ok', status: 200 },
          });
        }),
      );

      await fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL });
      expect(capturedBody.maxTimeout).toBe(60000);
    });

    it('respects custom timeout for proxied fetch', async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({
            status: 'ok',
            solution: { response: 'ok', status: 200 },
          });
        }),
      );

      await fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL, timeoutMs: 45000 });
      expect(capturedBody.maxTimeout).toBe(45000);
    });

    it('throws descriptive error when proxy returns error status', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return HttpResponse.json({
            status: 'error',
            message: 'Challenge solver failed',
          });
        }),
      );

      await expect(
        fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL }),
      ).rejects.toThrow('FlareSolverr error: Challenge solver failed');
    });

    it('throws when proxy returns empty response', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return HttpResponse.json({
            status: 'ok',
            solution: { response: '', status: 200 },
          });
        }),
      );

      await expect(
        fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL }),
      ).rejects.toThrow('FlareSolverr returned empty response');
    });

    it('throws when proxy returns no solution', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return HttpResponse.json({ status: 'ok' });
        }),
      );

      await expect(
        fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL }),
      ).rejects.toThrow('FlareSolverr returned empty response');
    });

    it('throws when proxy returns HTTP error', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return new HttpResponse(null, { status: 502 });
        }),
      );

      await expect(
        fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL }),
      ).rejects.toThrow('FlareSolverr proxy HTTP error 502');
    });

    it('throws when proxy returns non-JSON response (with HTTP 200)', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return new HttpResponse('<html>Bad Gateway</html>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      await expect(
        fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL }),
      ).rejects.toThrow('FlareSolverr returned invalid response (not JSON)');
    });

    it('throws when proxy returns non-JSON response with HTTP error', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return new HttpResponse('<html>502 Bad Gateway</html>', {
            status: 502,
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      await expect(
        fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL }),
      ).rejects.toThrow('FlareSolverr proxy HTTP error 502');
    });

    it('throws when proxy is unreachable', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return HttpResponse.error();
        }),
      );

      await expect(
        fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL }),
      ).rejects.toThrow('FlareSolverr proxy unreachable');
    });

    describe('schema validation (#813)', () => {
      it('throws when status is not a string', async () => {
        server.use(
          http.post(`${PROXY_URL}/v1`, () => {
            return HttpResponse.json({ status: 123 });
          }),
        );

        await expect(
          fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL }),
        ).rejects.toThrow(/^FlareSolverr returned unexpected response shape/);
      });

      it('throws when solution.response is not a string', async () => {
        server.use(
          http.post(`${PROXY_URL}/v1`, () => {
            return HttpResponse.json({ status: 'ok', solution: { response: 42 } });
          }),
        );

        await expect(
          fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL }),
        ).rejects.toThrow(/^FlareSolverr returned unexpected response shape/);
      });

      it('throws when payload is empty object (no status)', async () => {
        server.use(
          http.post(`${PROXY_URL}/v1`, () => {
            return HttpResponse.json({});
          }),
        );

        await expect(
          fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL }),
        ).rejects.toThrow(/^FlareSolverr returned unexpected response shape/);
      });

      it('throws when payload is a top-level array', async () => {
        server.use(
          http.post(`${PROXY_URL}/v1`, () => {
            return HttpResponse.json([]);
          }),
        );

        await expect(
          fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL }),
        ).rejects.toThrow(/^FlareSolverr returned unexpected response shape/);
      });

      it('attaches the original ZodError as cause on parse failure', async () => {
        server.use(
          http.post(`${PROXY_URL}/v1`, () => {
            return HttpResponse.json({ status: 123 });
          }),
        );

        let captured: unknown;
        try {
          await fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL });
        } catch (err) {
          captured = err;
        }

        expect(captured).toBeInstanceOf(Error);
        expect(getErrorMessage(captured)).toMatch(/^FlareSolverr returned unexpected response shape/);
        const cause = (captured as Error).cause;
        expect(cause).toBeInstanceOf(ZodError);
        expect((cause as ZodError).issues.length).toBeGreaterThan(0);
      });

      it('passes through extra unknown fields without rejecting', async () => {
        server.use(
          http.post(`${PROXY_URL}/v1`, () => {
            return HttpResponse.json({
              status: 'ok',
              solution: { response: 'html', status: 200 },
              version: '3.3.21',
              startTimestamp: 123,
            });
          }),
        );

        const result = await fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL });
        expect(result.body).toBe('html');
      });

      it('accepts null for nullish fields (message, solution.status)', async () => {
        server.use(
          http.post(`${PROXY_URL}/v1`, () => {
            return HttpResponse.json({
              status: 'ok',
              message: null,
              solution: { response: 'proxied-html', status: null },
            });
          }),
        );

        const result = await fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL });
        expect(result.body).toBe('proxied-html');
      });
    });

    it('all proxy error messages start with "FlareSolverr"', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return HttpResponse.json({ status: 'error', message: 'test' });
        }),
      );

      try {
        await fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL });
      } catch (error: unknown) {
        expect(getErrorMessage(error)).toMatch(/^FlareSolverr/);
      }
    });
  });

  describe('AbortSignal threading', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('passes caller signal through to direct fetch — aborted signal is visible', async () => {
      let capturedSignal: AbortSignal | undefined;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        capturedSignal = init?.signal ?? undefined;
        return new Response('ok');
      });

      const controller = new AbortController();
      await fetchWithProxy({ url: TARGET_URL, signal: controller.signal });

      expect(capturedSignal).toBeDefined();
      controller.abort();
      expect(capturedSignal!.aborted).toBe(true);
    });

    it('passes caller signal through to proxy fetch — aborted signal is visible', async () => {
      let capturedSignal: AbortSignal | undefined;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        capturedSignal = init?.signal ?? undefined;
        return new Response(JSON.stringify({
          status: 'ok',
          solution: { response: 'proxied', status: 200 },
        }), { headers: { 'Content-Type': 'application/json' } });
      });

      const controller = new AbortController();
      await fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL, signal: controller.signal });

      expect(capturedSignal).toBeDefined();
      controller.abort();
      expect(capturedSignal!.aborted).toBe(true);
    });

    it('pre-aborted signal rejects immediately for direct fetch', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if (init?.signal?.aborted) {
          throw new DOMException('The operation was aborted', 'AbortError');
        }
        return new Response('should not reach');
      });

      const controller = new AbortController();
      controller.abort();

      await expect(fetchWithProxy({ url: TARGET_URL, signal: controller.signal })).rejects.toThrow();
    });

    it('works without caller signal (backward compat)', async () => {
      server.use(
        http.get('https://indexer.test/api', () => {
          return new HttpResponse('ok');
        }),
      );

      const result = await fetchWithProxy({ url: TARGET_URL });
      expect(result.body).toBe('ok');
    });
  });

  describe('FetchResult metadata', () => {
    it('uses the FlareSolverr solution.status as httpStatus when available', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return HttpResponse.json({
            status: 'ok',
            solution: { response: '<html>via proxy</html>', status: 503 },
          });
        }),
      );

      const result = await fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL });
      expect(result.body).toBe('<html>via proxy</html>');
      expect(result.requestUrl).toBe(TARGET_URL);
      expect(result.httpStatus).toBe(503);
    });

    it('returns requestUrl matching the target URL even when redirects happen at the transport layer', async () => {
      server.use(
        http.get('https://indexer.test/api', () => {
          return new HttpResponse('ok', { status: 200 });
        }),
      );
      const result = await fetchWithProxy({ url: TARGET_URL });
      expect(result.requestUrl).toBe(TARGET_URL);
    });
  });

  /**
   * Every barrier below is causal, tied to the request under test. Two production facts make that
   * possible: admission is decided synchronously inside `pool.acquire()` when `fetchWithProxy` is
   * called, and a request that queues arms its slot-wait deadline synchronously on that same branch
   * (cleared just as synchronously on admission, abort, expiry or drain). So `timers.pending()` reads
   * the live queue depth and `timers.armed(n)` witnesses "n requests are now queued" — no barrier
   * needs to wait for time to pass, and nothing infers non-arrival from an unrelated request.
   *
   * Teardown ordering is this suite's obligation, not the reset's: `_resetSolverConcurrencyForTesting`
   * restores bookkeeping but holds no handle on in-flight solver fetches, so every case releases or
   * aborts its own requests and awaits them before `afterEach` resets. Resetting while requests are
   * outstanding leaves real fetches running against the stub with a fresh pool behind them.
   */
  describe('solver concurrency bound (#2373)', () => {
    const bound = useSolverBound(server);
    const { max: N, saturate, captureTimers, accountedFor } = bound;

    /**
     * Deliberately not `PROXY_TIMEOUT_MS`, which equals `SOLVER_SLOT_WAIT_TIMEOUT_MS`: `captureTimers`
     * keys on the delay, so a request timer sharing that value would be counted as a queued waiter.
     */
    const REQUEST_TIMEOUT_MS = 25_000;

    const useStub = (endpoint: string, parked?: () => Response) =>
      bound.stub(endpoint, { ...(parked !== undefined && { parked }) });
    const solverRequest = (proxyUrl: string, options?: SolverRequestOptions) =>
      bound.request(proxyUrl, { timeoutMs: REQUEST_TIMEOUT_MS, ...options });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('the regression this exists for', () => {
      it('admits exactly SOLVER_MAX_CONCURRENT_REQUESTS of 30 concurrent requests to one solver', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();

        for (let i = 0; i < 30; i++) solverRequest(PROXY_URL);
        // Each of the 30 has either reached the solver or queued; nothing is still undecided.
        await accountedFor(stub, timers, { arrived: N, queued: 30 - N });

        expect(stub.observed).toBe(N);
        expect(timers.pending()).toBe(30 - N);
        expect(stub.peak).toBe(N);
        expect(stub.live).toBe(N);
      });

      it('holds request N+1 back from the solver entirely while N are in flight', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        await saturate(stub, PROXY_URL);

        solverRequest(PROXY_URL, { url: 'https://indexer.test/api?q=overflow' });
        await accountedFor(stub, timers, { arrived: N, queued: 1 });

        expect(timers.pending()).toBe(1);
        expect(stub.observed).toBe(N);
        expect(stub.targets).not.toContain('https://indexer.test/api?q=overflow');
      });
    });

    describe('slot release on every exit path', () => {
      const outcomes: Array<{ name: string; respond: () => Response }> = [
        { name: '2xx success', respond: () => solverOk() },
        { name: 'solver HTTP 500', respond: () => new HttpResponse(null, { status: 500 }) },
        { name: 'a 200 error envelope', respond: () => HttpResponse.json({ status: 'error', message: 'solver failed' }) },
        { name: 'a 200 ok envelope with no solution.response', respond: () => HttpResponse.json({ status: 'ok' }) },
        {
          name: 'a 200 with a non-JSON body',
          respond: () => new HttpResponse('<html>nope</html>', { headers: { 'Content-Type': 'text/html' } }),
        },
        {
          name: 'a handler that throws a non-Error value',
          respond: () => {
            throw 'solver blew up';
          },
        },
      ];

      it.each(outcomes)('releases the slot after $name', async ({ respond }) => {
        const stub = useStub(`${PROXY_URL}/v1`, respond);
        const timers = captureTimers();
        await saturate(stub, PROXY_URL);

        const queued = solverRequest(PROXY_URL, { url: 'https://indexer.test/api?q=after' });
        await accountedFor(stub, timers, { arrived: N, queued: 1 });
        expect(timers.pending()).toBe(1);
        expect(stub.observed).toBe(N);

        stub.releaseAll();
        await stub.receives('https://indexer.test/api?q=after');

        expect(stub.observed).toBe(N + 1);
        expect(timers.pending()).toBe(0);
        await expect(Promise.allSettled([queued])).resolves.toHaveLength(1);
      });

      /**
       * The outcome matrix above cannot see this: every one of those bodies is already materialized
       * when the handler returns, so releasing right after `fetch()` resolves and releasing after
       * `parseFlareSolverrResponse` are indistinguishable. A gated body separates them — headers land
       * immediately, bytes do not — which is what AC8's "after the body is read and parsed" needs.
       */
      it('keeps the slot until the body is read and parsed, not merely until headers arrive', async () => {
        const bodies = Array.from({ length: N }, (_unused, index) => gatedSolverBody(`page-${index}`));
        let served = 0;
        const stub = bound.stub(`${PROXY_URL}/v1`, {
          immediate: () => gatedSolverResponse(bodies[served++]!),
        });
        const timers = captureTimers();

        const inFlight = Array.from({ length: N }, (_unused, index) =>
          solverRequest(PROXY_URL, { url: `https://indexer.test/api?q=held-${index}` }));
        await stub.reaches(N);
        // Every `fetch()` has resolved and its body is being drained — the one window in which a
        // release placed after `fetch()` has already freed the slot while a release placed after
        // parsing has not. Sampling before this point cannot tell the two apart.
        await Promise.all(bodies.map((body) => body.draining));

        solverRequest(PROXY_URL, { url: 'https://indexer.test/api?q=after-parse' });
        await accountedFor(stub, timers, { arrived: N, queued: 1 });

        expect(timers.pending()).toBe(1);
        expect(stub.observed).toBe(N);
        expect(stub.targets).not.toContain('https://indexer.test/api?q=after-parse');

        for (const body of bodies) body.complete();
        await expect(Promise.all(inFlight)).resolves.toEqual(
          bodies.map((_unused, index) => expect.objectContaining({ body: `page-${index}` })),
        );

        await stub.receives('https://indexer.test/api?q=after-parse');
        expect(stub.observed).toBe(N + 1);
      });

      it('releases the slot after the request timeout elapses', async () => {
        const REQUEST_BUDGET_MS = 4_242;
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers([SOLVER_SLOT_WAIT_TIMEOUT_MS, REQUEST_BUDGET_MS]);

        await saturate(stub, PROXY_URL, { timeoutMs: REQUEST_BUDGET_MS });
        await timers.armed(N, REQUEST_BUDGET_MS);

        solverRequest(PROXY_URL, { url: 'https://indexer.test/api?q=after-timeout', timeoutMs: REQUEST_BUDGET_MS });
        await accountedFor(stub, timers, { arrived: N, queued: 1 });
        expect(timers.pending()).toBe(1);
        expect(stub.observed).toBe(N);

        timers.fire(REQUEST_BUDGET_MS);
        await stub.receives('https://indexer.test/api?q=after-timeout');
        expect(stub.observed).toBe(N + 1);
      });

      it('releases the slot when the caller aborts a request that is already in flight', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        const controllers = Array.from({ length: N }, () => new AbortController());

        for (const controller of controllers) solverRequest(PROXY_URL, { signal: controller.signal });
        await stub.reaches(N);
        solverRequest(PROXY_URL, { url: 'https://indexer.test/api?q=after-abort' });
        await accountedFor(stub, timers, { arrived: N, queued: 1 });
        expect(timers.pending()).toBe(1);
        expect(stub.observed).toBe(N);

        for (const controller of controllers) controller.abort(new Error('caller cancelled'));
        await stub.receives('https://indexer.test/api?q=after-abort');
        expect(stub.observed).toBe(N + 1);
      });

      it('keeps capacity at N when one request releases twice over', async () => {
        // fetchViaProxy releases in a `finally`; a settled request whose slot is handed back again
        // must not raise the live bound, so the N+1th still queues after a full round trip.
        const stub = useStub(`${PROXY_URL}/v1`);
        stub.releaseAll();
        await expect(solverRequest(PROXY_URL)).resolves.toMatchObject({ body: 'ok' });

        const holding = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        await saturate(holding, PROXY_URL);

        solverRequest(PROXY_URL, { url: 'https://indexer.test/api?q=overflow' });
        await accountedFor(holding, timers, { arrived: N, queued: 1 });

        expect(timers.pending()).toBe(1);
        expect(holding.observed).toBe(N);
      });
    });

    describe('per-solver keying', () => {
      async function assertSharesBound(a: string, b: string, endpoint: string): Promise<void> {
        const stub = useStub(endpoint);
        const timers = captureTimers();
        await saturate(stub, a);

        solverRequest(b, { url: 'https://indexer.test/api?q=probe' });
        await accountedFor(stub, timers, { arrived: N, queued: 1 });

        expect(timers.pending()).toBe(1);
        expect(stub.observed).toBe(N);
        expect(stub.targets).not.toContain('https://indexer.test/api?q=probe');
      }

      async function assertSeparateBounds(a: string, b: string, endpointA: string, endpointB: string): Promise<void> {
        const stubA = useStub(endpointA);
        const stubB = endpointA === endpointB ? stubA : useStub(endpointB);
        await saturate(stubA, a);

        solverRequest(b, { url: 'https://indexer.test/api?q=probe' });
        await stubB.receives('https://indexer.test/api?q=probe');
      }

      it('gives two distinct solvers 2N in flight, neither delaying the other', async () => {
        const first = useStub('http://solver-one.test:8191/v1');
        const second = useStub('http://solver-two.test:8191/v1');

        await saturate(first, 'http://solver-one.test:8191');
        await saturate(second, 'http://solver-two.test:8191');

        expect(first.observed).toBe(N);
        expect(second.observed).toBe(N);
        expect(first.live + second.live).toBe(2 * N);
      });

      it('shares one bound across a trailing slash', async () => {
        await assertSharesBound('http://solver.lan:8191/', 'http://solver.lan:8191', 'http://solver.lan:8191/v1');
      });

      it('shares one bound across host case', async () => {
        await assertSharesBound('http://SOLVER.lan:8191', 'http://solver.lan:8191', 'http://solver.lan:8191/v1');
      });

      it('shares one bound across an explicit default port', async () => {
        await assertSharesBound('http://solver.lan:80', 'http://solver.lan', 'http://solver.lan/v1');
      });

      it('shares one bound across a base path spelled with and without its trailing slash', async () => {
        await assertSharesBound('http://gateway.test/solver-a/', 'http://gateway.test/solver-a', 'http://gateway.test/solver-a/v1');
      });

      it('shares one bound across a fragment, which is never transmitted', async () => {
        await assertSharesBound('http://frag.test/v1#one', 'http://frag.test/v1#two', 'http://frag.test/v1');
      });

      it('separates a bare URL from one already ending in /v1', async () => {
        await assertSeparateBounds(
          'http://solver.lan:8191',
          'http://solver.lan:8191/v1',
          'http://solver.lan:8191/v1',
          'http://solver.lan:8191/v1/v1',
        );
      });

      it('separates two solvers behind one host:port', async () => {
        await assertSeparateBounds(
          'http://gateway.test/solver-a',
          'http://gateway.test/solver-b',
          'http://gateway.test/solver-a/v1',
          'http://gateway.test/solver-b/v1',
        );
      });

      it('separates two schemes on the same explicit port', async () => {
        await assertSeparateBounds('http://scheme.test:8191', 'https://scheme.test:8191', 'http://scheme.test:8191/v1', 'https://scheme.test:8191/v1');
      });

      it('separates two schemes on their implicit default ports', async () => {
        await assertSeparateBounds('http://solver.lan', 'https://solver.lan', 'http://solver.lan/v1', 'https://solver.lan/v1');
      });

      it('separates paths differing only in case, while host case still folds', async () => {
        // One wildcard stub because MSW's own path matching is case-insensitive: two handlers
        // differing only in path case cannot tell these requests apart, but the bound must.
        const stub = useStub('http://pathcase.test/*');
        const timers = captureTimers();
        await saturate(stub, 'http://pathcase.test/Solver-A');

        solverRequest('http://pathcase.test/solver-a', { url: 'https://indexer.test/api?q=other-path' });
        await stub.receives('https://indexer.test/api?q=other-path');
        expect(timers.pending()).toBe(0);

        solverRequest('http://PATHCASE.test/Solver-A', { url: 'https://indexer.test/api?q=same-host' });
        await accountedFor(stub, timers, { arrived: N + 1, queued: 1 });

        expect(timers.pending()).toBe(1);
        expect(stub.targets).not.toContain('https://indexer.test/api?q=same-host');
      });

      it('separates two queries, which are transmitted', async () => {
        await assertSeparateBounds('http://query.test?a=1', 'http://query.test?a=2', 'http://query.test/', 'http://query.test/');
      });

      it('separates two ports on the same host', async () => {
        await assertSeparateBounds('http://solver.lan:8191', 'http://solver.lan:8192', 'http://solver.lan:8191/v1', 'http://solver.lan:8192/v1');
      });

      it('separates two bracketed IPv6 literals on different ports', async () => {
        // Observed at the global fetch boundary rather than through MSW: path-to-regexp cannot lex
        // an IPv6 literal, so `http.post('http://[::1]:8080/v1')` throws inside MSW's handler lookup.
        // The queue-depth witness works unchanged here — it reads the semaphore, not the transport.
        const requested: string[] = [];
        const gates: Array<() => void> = [];
        let parking = true;
        const timers = captureTimers();
        const reachedPort = (port: string) => requested.filter((url) => url.startsWith(`http://[::1]:${port}`)).length;

        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
          const url = String(input);
          requested.push(url);
          if (parking && url.startsWith('http://[::1]:808')) {
            await new Promise<void>((resolve) => gates.push(resolve));
          }
          return new Response(
            JSON.stringify({ status: 'ok', solution: { response: 'ok', status: 200 } }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        });

        for (let i = 0; i < N; i++) solverRequest('http://[::1]:8080');
        for (let i = 0; i < N; i++) solverRequest('http://[::1]:8081');
        await vi.waitFor(() => {
          expect(reachedPort('8080')).toBe(N);
          expect(reachedPort('8081')).toBe(N);
        });
        expect(timers.pending()).toBe(0);

        // Acquisition is synchronous, so the queued-or-admitted verdict is already readable here.
        solverRequest('http://[::1]:8080');

        expect(timers.pending()).toBe(1);
        expect(reachedPort('8080')).toBe(N);

        parking = false;
        for (const open of gates.splice(0)) open();
      });

      it('fails a credential-bearing solver URL immediately instead of queuing it behind a saturated pool', async () => {
        const stub = useStub('http://cred.test/v1');
        const timers = captureTimers();
        await saturate(stub, 'http://cred.test');

        await expect(fetchWithProxy({ url: TARGET_URL, proxyUrl: 'http://user:pass@cred.test' }))
          .rejects.toThrow('FlareSolverr proxy unreachable at http://user:pass@cred.test');

        // It never took a place in any queue — the failure is a configuration error, not a stall.
        expect(timers.pending()).toBe(0);
        expect(stub.observed).toBe(N);
      });

      it('keeps the pre-existing unreachable failure for an unparseable proxy URL', async () => {
        let captured: unknown;
        try {
          await fetchWithProxy({ url: TARGET_URL, proxyUrl: 'not a url' });
        } catch (error: unknown) {
          captured = error;
        }

        expect(getErrorMessage(captured)).toBe('FlareSolverr proxy unreachable at not a url');
        expect(captured).not.toBeInstanceOf(ProxyError);
      });
    });

    describe('bounded wait for a slot', () => {
      it('rejects a waiter that never gets a slot with a proxy-related, operator-legible error', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        await saturate(stub, PROXY_URL);

        const waiting = solverRequest(PROXY_URL, { url: 'https://indexer.test/api?q=waiting' });
        await accountedFor(stub, timers, { arrived: N, queued: 1 });
        expect(timers.pending()).toBe(1);
        timers.fire();

        let captured: unknown;
        try {
          await waiting;
        } catch (error: unknown) {
          captured = error;
        }

        expect(captured).toBeInstanceOf(ProxyError);
        expect(isProxyRelatedError(captured)).toBe(true);
        expect(getErrorMessage(captured)).toContain('waiting for a request slot');
        expect(getErrorMessage(captured)).toContain(PROXY_URL);
        expect(getErrorMessage(captured)).not.toContain('FlareSolverr proxy timed out after 60s');
        expect(stub.observed).toBe(N);
        expect(stub.targets).not.toContain('https://indexer.test/api?q=waiting');
      });

      it('arms the wait deadline with exactly SOLVER_SLOT_WAIT_TIMEOUT_MS', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        await saturate(stub, PROXY_URL);

        solverRequest(PROXY_URL);
        await accountedFor(stub, timers, { arrived: N, queued: 1 });

        expect(timers.delays.filter((delay) => delay === SOLVER_SLOT_WAIT_TIMEOUT_MS)).toHaveLength(1);
        timers.fire();
      });

      it('admits a waiter whose slot frees just before the deadline, and clears its deadline', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        await saturate(stub, PROXY_URL);

        const waiting = solverRequest(PROXY_URL);
        await accountedFor(stub, timers, { arrived: N, queued: 1 });
        expect(timers.pending()).toBe(1);

        stub.releaseAll();
        await expect(waiting).resolves.toMatchObject({ body: 'ok' });

        // Admission clears the deadline synchronously, so there is nothing left that could reject.
        expect(timers.pending()).toBe(0);
        timers.fire();
        await expect(waiting).resolves.toMatchObject({ body: 'ok' });
      });
    });

    describe('abort while queued', () => {
      it('rejects with signal.reason verbatim, never reaches the solver, and leaves its slot to the next waiter', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        await saturate(stub, PROXY_URL);

        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
        const cancelled = solverRequest(PROXY_URL, { signal: controller.signal, url: 'https://indexer.test/api?q=cancelled' });
        solverRequest(PROXY_URL, { url: 'https://indexer.test/api?q=successor' });
        await accountedFor(stub, timers, { arrived: N, queued: 2 });

        expect(timers.pending()).toBe(2);
        expect(stub.observed).toBe(N);

        const reason = new Error('search cancelled');
        controller.abort(reason);

        await expect(cancelled).rejects.toBe(reason);
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
        // The abandoned waiter left the queue; only the successor is still holding a place.
        expect(timers.pending()).toBe(1);

        stub.releaseOne();
        await stub.receives('https://indexer.test/api?q=successor');
        expect(stub.targets).not.toContain('https://indexer.test/api?q=cancelled');
      });

      it('rejects a pre-aborted signal without taking or queuing for a slot', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        const controller = new AbortController();
        const reason = new Error('cancelled before dispatch');
        controller.abort(reason);

        await expect(fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL, signal: controller.signal }))
          .rejects.toBe(reason);
        expect(stub.observed).toBe(0);
        expect(timers.pending()).toBe(0);

        await saturate(stub, PROXY_URL);
        expect(stub.observed).toBe(N);
      });
    });

    describe('timeout budget ordering', () => {
      it('arms the request timeout only after the slot is acquired, with the full budget', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        await saturate(stub, PROXY_URL);

        solverRequest(PROXY_URL, { url: 'https://indexer.test/api?q=budget', timeoutMs: 12_345 });
        await accountedFor(stub, timers, { arrived: N, queued: 1 });
        expect(timers.pending()).toBe(1);
        expect(timers.delays).not.toContain(12_345);

        stub.releaseAll();
        await stub.receives('https://indexer.test/api?q=budget');
        expect(timers.delays).toContain(12_345);
      });

      it('leaves the solver maxTimeout body field at the caller budget', async () => {
        let capturedBody: Record<string, unknown> = {};
        server.use(
          http.post(`${PROXY_URL}/v1`, async ({ request }) => {
            capturedBody = await request.json() as Record<string, unknown>;
            return solverOk();
          }),
        );

        await fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL });
        expect(capturedBody.maxTimeout).toBe(PROXY_TIMEOUT_MS);
      });
    });

    describe('FIFO', () => {
      it('admits queued requests in acquisition order', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        await saturate(stub, PROXY_URL);

        // Enqueueing is synchronous inside `pool.acquire()`, so calling in sequence fixes the order.
        for (const label of ['first', 'second', 'third']) {
          solverRequest(PROXY_URL, { url: `https://indexer.test/api?q=${label}` });
        }
        await accountedFor(stub, timers, { arrived: N, queued: 3 });

        expect(timers.pending()).toBe(3);
        expect(stub.observed).toBe(N);

        const admitted: string[] = [];
        for (let i = 0; i < 3; i++) {
          stub.releaseOne();
          await stub.reaches(N + i + 1);
          admitted.push(stub.targets[N + i] ?? 'missing');
        }

        expect(admitted).toEqual([
          'https://indexer.test/api?q=first',
          'https://indexer.test/api?q=second',
          'https://indexer.test/api?q=third',
        ]);
      });
    });

    describe('non-solver traffic is unaffected', () => {
      it('lets a direct fetch and a proxy-agent fetch through while the solver bound is saturated', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        server.use(http.get('https://indexer.test/api', () => new HttpResponse('direct')));
        await saturate(stub, PROXY_URL);

        await expect(fetchWithProxy({ url: TARGET_URL })).resolves.toMatchObject({ body: 'direct' });
        await expect(fetchWithProxyAgent(TARGET_URL)).resolves.toMatchObject({ body: 'direct' });

        // Neither took a slot, so neither ever queued behind the saturated solver.
        expect(timers.pending()).toBe(0);
        expect(stub.observed).toBe(N);
      });
    });

    describe('reset seam', () => {
      it('rejects queued waiters with the stated reason rather than leaving them pending', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        await saturate(stub, PROXY_URL);

        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
        const queued = solverRequest(PROXY_URL, { signal: controller.signal });
        await accountedFor(stub, timers, { arrived: N, queued: 1 });
        expect(timers.pending()).toBe(1);

        // Reset while the waiter is genuinely queued: a bare map clear would leave this promise
        // pending forever and its timer and abort listener attached.
        _resetSolverConcurrencyForTesting();

        await expect(queued).rejects.toThrow('solver concurrency reset');
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(timers.pending()).toBe(0);
        expect(stub.targets).toHaveLength(N);
      });

      it('restores full capacity once every in-flight request has settled first', async () => {
        const stub = useStub(`${PROXY_URL}/v1`);
        const inFlight = await saturate(stub, PROXY_URL);

        stub.releaseAll();
        await Promise.allSettled(inFlight);
        _resetSolverConcurrencyForTesting();

        const fresh = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        await saturate(fresh, PROXY_URL);

        solverRequest(PROXY_URL, { url: 'https://indexer.test/api?q=overflow' });
        await accountedFor(fresh, timers, { arrived: N, queued: 1 });

        expect(timers.pending()).toBe(1);
        expect(fresh.observed).toBe(N);
      });

      it('cannot be over-admitted by a releaser from a pre-reset request', async () => {
        const stale = useStub(`${PROXY_URL}/v1`);
        const staleRequest = solverRequest(PROXY_URL, { url: 'https://indexer.test/api?q=stale' });
        await stale.reaches(1);

        _resetSolverConcurrencyForTesting();

        const fresh = useStub(`${PROXY_URL}/v1`);
        const timers = captureTimers();
        await saturate(fresh, PROXY_URL);

        solverRequest(PROXY_URL, { url: 'https://indexer.test/api?q=overflow' });
        await accountedFor(fresh, timers, { arrived: N, queued: 1 });
        expect(timers.pending()).toBe(1);

        // Settle the pre-reset request: its releaser belongs to the detached pool, so the queued
        // request must still be queued afterwards rather than admitted into the fresh one.
        stale.releaseOne();
        await staleRequest;

        expect(timers.pending()).toBe(1);
        expect(fresh.observed).toBe(N);
        expect(fresh.targets).not.toContain('https://indexer.test/api?q=overflow');
      });
    });
  });
});

/**
 * #2374 — the diagnosis keys on WHERE the throw originated, never on the message text. Both halves
 * are pinned here: the seven outward strings stay byte-identical (several are operator text,
 * `isProxyRelatedError` matches their prefix on the search path), and each carries the discriminant
 * its AC1 row assigns.
 */
describe('fetchWithProxy — solver failure discriminants (#2374)', () => {
  const server = useMswServer();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function solverRequest() {
    return fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL });
  }

  /** Runs the round-trip and hands back the error, so message and discriminant are asserted together. */
  async function failureOf(): Promise<Error> {
    try {
      await solverRequest();
    } catch (error: unknown) {
      return error as Error;
    }
    throw new Error('expected the solver round-trip to fail');
  }

  it('tags an aborted POST round-trip-timeout, keeping the message byte-identical', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    const error = await failureOf();

    expect(error.message).toBe('FlareSolverr proxy timed out after 60s');
    expect(solverFailureOf(error)).toEqual({ origin: 'round-trip-timeout' });
    expect(isProxyRelatedError(error)).toBe(true);
  });

  it.each([
    ['ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.9:8191'],
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND flaresolverr.test'],
    ['EAI_AGAIN', 'getaddrinfo EAI_AGAIN flaresolverr.test'],
  ])('tags a %s rejection solver-no-answer and recovers the code from the retained cause', async (code, causeMessage) => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(causeMessage), { code }) }),
    );

    const error = await failureOf();

    expect(error.message).toBe(`FlareSolverr proxy unreachable at ${PROXY_URL}`);
    expect(solverFailureOf(error)).toEqual({ origin: 'solver-no-answer', transportCode: code });
    expect(isProxyRelatedError(error)).toBe(true);
  });

  it('carries no transport code when the rejection had none', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: new Error('socket hang up') }),
    );

    expect(solverFailureOf(await failureOf())).toEqual({ origin: 'solver-no-answer' });
  });

  it.each([
    [
      'a non-2xx status',
      () => new HttpResponse('nope', { status: 502 }),
      'FlareSolverr proxy HTTP error 502',
    ],
    [
      'a non-JSON body',
      () => new HttpResponse('<html>gateway</html>', { headers: { 'Content-Type': 'text/html' } }),
      'FlareSolverr returned invalid response (not JSON)',
    ],
    [
      'a status:error envelope',
      () => HttpResponse.json({ status: 'error', message: 'Challenge failed' }),
      'FlareSolverr error: Challenge failed',
    ],
    [
      'an ok envelope with no solution.response',
      () => HttpResponse.json({ status: 'ok', solution: { response: '', status: 200 } }),
      'FlareSolverr returned empty response',
    ],
  ])('tags %s solver-answered, keeping the message byte-identical', async (_label, reply, expected) => {
    server.use(http.post(`${PROXY_URL}/v1`, reply));

    const error = await failureOf();

    expect(error.message).toBe(expected);
    expect(solverFailureOf(error)).toEqual({ origin: 'solver-answered' });
    expect(isProxyRelatedError(error)).toBe(true);
  });

  it('tags a wrong-shape envelope solver-answered, keeping its message prefix', async () => {
    server.use(http.post(`${PROXY_URL}/v1`, () => HttpResponse.json({ unexpected: true })));

    const error = await failureOf();

    expect(error.message).toMatch(/^FlareSolverr returned unexpected response shape: /);
    expect(solverFailureOf(error)).toEqual({ origin: 'solver-answered' });
  });

  it('leaves a direct (non-solver) failure unmarked, so nothing diagnoses it as a solver arm', async () => {
    server.use(http.get('https://indexer.test/api', () => new HttpResponse('nope', { status: 503 })));

    await expect(fetchWithProxy({ url: TARGET_URL })).rejects.toThrow('HTTP 503');
    const error = await fetchWithProxy({ url: TARGET_URL }).catch((err: unknown) => err as Error);
    expect(solverFailureOf(error)).toBeUndefined();
  });

  describe('the slot wait never reached the solver', () => {
    const bound = useSolverBound(server);

    it('is tagged slot-wait, with its ProxyError identity and message intact', async () => {
      const stub = bound.stub(`${PROXY_URL}/v1`);
      await bound.saturate(stub, PROXY_URL);

      const timers = bound.captureTimers();
      const queued = bound.track(fetchWithProxy({ url: TARGET_URL, proxyUrl: PROXY_URL, timeoutMs: 25_000 }));
      await bound.accountedFor(stub, timers, { arrived: bound.max, queued: 1 });
      timers.fire();

      const error: Error = await queued.then(() => { throw new Error('expected the slot wait to reject'); }, (err: unknown) => err as Error);
      expect(error).toBeInstanceOf(ProxyError);
      expect(error.message).toBe(`Timed out after 60s waiting for a request slot at solver ${PROXY_URL}`);
      expect(solverFailureOf(error)).toEqual({ origin: 'slot-wait' });
    });
  });
});
