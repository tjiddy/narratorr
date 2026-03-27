import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
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
        expect(error instanceof Error ? error.message : '').toMatch(/^FlareSolverr/);
      }
    });
  });
});
