import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchWithTimeout } from './fetch-with-timeout.js';

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns response for successful fetch within timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    const response = await fetchWithTimeout('https://example.com', {}, 5000);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('passes through request options (method, headers, body)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await fetchWithTimeout(
      'https://example.com/api',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"key":"value"}',
      },
      5000,
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/api',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"key":"value"}',
      }),
    );
  });

  it('attaches an abort signal to the fetch call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await fetchWithTimeout('https://example.com', {}, 3000);

    const calledOptions = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(calledOptions.signal).toBeDefined();
  });

  it('uses custom timeout value', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await fetchWithTimeout('https://example.com', {}, 7500);

    // Signal should exist with the timeout
    const calledOptions = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(calledOptions.signal).toBeDefined();
  });

  describe('redirect detection', () => {
    it('throws descriptive error on 302 response with Location header', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://auth.example.com/login' },
        }),
      );

      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(
        'https://auth.example.com/login',
      );
      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(
        /auth proxy/i,
      );
      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(
        /internal address|whitelist/i,
      );
    });

    it('throws descriptive error on all 3xx status codes (301, 303, 307, 308)', async () => {
      for (const status of [301, 303, 307, 308]) {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(null, {
            status,
            headers: { Location: 'https://auth.example.com/login' },
          }),
        );
        await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(
          'https://auth.example.com/login',
        );
      }
    });

    it('throws descriptive error on 3xx with no Location header without crashing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 302 }),
      );

      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(
        /redirect/i,
      );
    });

    it('throws graceful error on 3xx with empty Location header', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { Location: '' },
        }),
      );

      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(
        /redirect/i,
      );
    });

    it('returns response normally for 2xx — redirect detection does not interfere', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      const response = await fetchWithTimeout('https://example.com', {}, 5000);
      expect(response.status).toBe(200);
    });

    it('returns response normally for 4xx/5xx — redirect detection does not interfere', async () => {
      for (const status of [400, 401, 404, 500, 503]) {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(null, { status }),
        );
        const response = await fetchWithTimeout('https://example.com', {}, 5000);
        expect(response.status).toBe(status);
      }
    });

    it('uses redirect: manual option so fetch does not follow redirects automatically', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      await fetchWithTimeout('https://example.com', {}, 5000);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ redirect: 'manual' }),
      );
    });
  });

  describe('network error mapping (#227)', () => {
    it('maps ECONNREFUSED to actionable message with port', async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9999'), { code: 'ECONNREFUSED' });
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), { cause }),
      );
      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(/connection refused/i);
      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(/9999/);
    });

    it('maps ENOTFOUND to actionable message with hostname', async () => {
      const cause = Object.assign(new Error('getaddrinfo ENOTFOUND badhost.example'), { code: 'ENOTFOUND' });
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), { cause }),
      );
      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(/dns/i);
      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(/badhost\.example/);
    });

    it('maps TimeoutError (AbortSignal.timeout) to actionable message', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      );
      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(/timed out/i);
    });

    it('maps AbortError (manual abort) to actionable message', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new DOMException('The operation was aborted', 'AbortError'),
      );
      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(/timed out/i);
    });

    it('passes through non-network errors unchanged', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Some other error'));
      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow('Some other error');
    });
  });
});
