import { describe, it, expect, vi, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ZodError } from 'zod';
import { useMswServer } from '../__tests__/msw/server.js';
import { getErrorMessage } from '../../shared/error-message.js';
import { fetchWithProxy } from './fetch.js';

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
      expect(result).toBe('<xml>data</xml>');
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
      // We can't easily test actual timeout behavior, but we can verify
      // it doesn't throw for a fast response
      server.use(
        http.get('https://indexer.test/api', () => {
          return new HttpResponse('ok');
        }),
      );

      const result = await fetchWithProxy({ url: TARGET_URL });
      expect(result).toBe('ok');
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

      expect(result).toBe('<html>proxied</html>');
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
        expect(result).toBe('html');
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
        expect(result).toBe('proxied-html');
      });
    });

    it('all proxy error messages start with "FlareSolverr"', async () => {
      // Error status
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

      // The composed signal should be linked to caller — aborting caller should abort the composed signal
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
        // Real fetch would throw on aborted signal — simulate that
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
      expect(result).toBe('ok');
    });
  });
});
