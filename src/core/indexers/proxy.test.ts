import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProxyError, isProxyRelatedError, IndexerAuthError } from './errors.js';
import type * as NetworkServiceModule from '../utils/network-service.js';

// Route fetchWithOptionalDispatcher through globalThis.fetch in tests so
// existing MSW handlers and `vi.spyOn(globalThis, 'fetch')` continue to
// intercept the proxy path. Production still uses the real helper (which
// routes through undici's fetch when a dispatcher is attached) — the
// call-site contract is asserted in proxy.dispatcher-routing.test.ts and
// the helper's routing is asserted in network-service.test.ts.
vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithOptionalDispatcher: ((url, options) => globalThis.fetch(url, options as RequestInit)) as typeof actual.fetchWithOptionalDispatcher,
  };
});

import { createProxyAgent, fetchWithProxyAgent, resolveProxyIp } from './proxy.js';
import { ProxyAgent } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';

describe('ProxyError', () => {
  it('is instanceof Error', () => {
    const err = new ProxyError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name "ProxyError"', () => {
    const err = new ProxyError('test');
    expect(err.name).toBe('ProxyError');
  });

  it('stores descriptive message', () => {
    const err = new ProxyError('connection refused');
    expect(err.message).toBe('connection refused');
  });
});

describe('isProxyRelatedError', () => {
  it('returns true for ProxyError instances', () => {
    expect(isProxyRelatedError(new ProxyError('fail'))).toBe(true);
  });

  it('returns true for FlareSolverr errors (message starts with "FlareSolverr")', () => {
    expect(isProxyRelatedError(new Error('FlareSolverr timed out'))).toBe(true);
  });

  it('returns false for generic Error', () => {
    expect(isProxyRelatedError(new Error('something else'))).toBe(false);
  });

  it('returns false for IndexerAuthError', () => {
    expect(isProxyRelatedError(new IndexerAuthError('test-indexer'))).toBe(false);
  });
});

describe('createProxyAgent', () => {
  it('creates undici ProxyAgent for http:// URL', () => {
    const agent = createProxyAgent('http://proxy.example.com:8080');
    expect(agent).toBeInstanceOf(ProxyAgent);
  });

  it('creates undici ProxyAgent for https:// URL', () => {
    const agent = createProxyAgent('https://proxy.example.com:8443');
    expect(agent).toBeInstanceOf(ProxyAgent);
  });

  it('creates socks-proxy-agent for socks5:// URL', () => {
    const agent = createProxyAgent('socks5://proxy.example.com:1080');
    expect(agent).toBeInstanceOf(SocksProxyAgent);
  });

  it('returns undefined when no proxy URL provided', () => {
    expect(createProxyAgent(undefined)).toBeUndefined();
  });

  it('returns undefined when proxy URL is empty string', () => {
    expect(createProxyAgent('')).toBeUndefined();
  });
});

describe('fetchWithProxyAgent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('performs direct fetch when no proxy URL provided', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('hello', { status: 200 }),
    );
    const result = await fetchWithProxyAgent('https://example.com');
    expect(result).toBe('hello');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  describe('no-proxy network error mapping (#227)', () => {
    it('maps ECONNREFUSED to actionable message when no proxy configured', async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9090'), { code: 'ECONNREFUSED' });
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), { cause }),
      );
      await expect(fetchWithProxyAgent('https://example.com')).rejects.toThrow(/connection refused/i);
      await expect(fetchWithProxyAgent('https://example.com')).rejects.toThrow(/9090/);
    });

    it('maps ENOTFOUND to actionable message when no proxy configured', async () => {
      const cause = Object.assign(new Error('getaddrinfo ENOTFOUND badhost.local'), { code: 'ENOTFOUND' });
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), { cause }),
      );
      await expect(fetchWithProxyAgent('https://example.com')).rejects.toThrow(/dns/i);
      await expect(fetchWithProxyAgent('https://example.com')).rejects.toThrow(/badhost\.local/);
    });

    it('maps TimeoutError to actionable message when no proxy configured', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      );
      await expect(fetchWithProxyAgent('https://example.com')).rejects.toThrow(/timed out/i);
    });

    it('no-proxy mapped errors are NOT ProxyError instances', async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9090'), { code: 'ECONNREFUSED' });
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), { cause }),
      );
      await expect(fetchWithProxyAgent('https://example.com')).rejects.not.toBeInstanceOf(ProxyError);
    });
  });

  it('throws ProxyError when proxy connection fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      fetchWithProxyAgent('https://example.com', { proxyUrl: 'http://bad-proxy:8080' }),
    ).rejects.toThrow(ProxyError);
  });

  it('throws ProxyError on proxy connection timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new DOMException('signal is aborted', 'AbortError')),
    );
    await expect(
      fetchWithProxyAgent('https://example.com', { proxyUrl: 'http://proxy:8080', timeoutMs: 100 }),
    ).rejects.toThrow(ProxyError);
  });

  it('throws ProxyError on proxy HTTP 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' }),
    );
    await expect(
      fetchWithProxyAgent('https://example.com', { proxyUrl: 'http://proxy:8080' }),
    ).rejects.toThrow(ProxyError);
  });

  it('throws generic Error on non-proxy HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );
    await expect(
      fetchWithProxyAgent('https://example.com', { proxyUrl: 'http://proxy:8080' }),
    ).rejects.toThrow('HTTP 404: Not Found');
  });

  it('returns response body on success through proxy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<xml>data</xml>', { status: 200 }),
    );
    const result = await fetchWithProxyAgent('https://indexer.com/api', {
      proxyUrl: 'http://proxy:8080',
    });
    expect(result).toBe('<xml>data</xml>');
  });

  it('surfaces error.cause on dispatcher failures (debuggability after undici upgrades)', async () => {
    const cause = Object.assign(new Error('invalid onRequestStart method'), { code: 'UND_ERR_INVALID_ARG' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause }),
    );

    await expect(
      fetchWithProxyAgent('https://example.com', { proxyUrl: 'http://proxy:8080' }),
    ).rejects.toThrow(/invalid onRequestStart method/);
  });
});

describe('fetchWithProxyAgent — AbortSignal threading', () => {
  it('composes caller signal with timeout — caller abort propagates', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response('ok');
    });

    const controller = new AbortController();
    await fetchWithProxyAgent('https://example.com', { signal: controller.signal });

    expect(capturedSignal).toBeDefined();
    controller.abort();
    expect(capturedSignal!.aborted).toBe(true);

    vi.restoreAllMocks();
  });

  it('works without caller signal (backward compat)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    const result = await fetchWithProxyAgent('https://example.com');
    expect(result).toBe('ok');

    vi.restoreAllMocks();
  });
});

describe('resolveProxyIp', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves exit IP via ipify API through proxy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ip: '1.2.3.4' }), { status: 200 }),
    );
    const ip = await resolveProxyIp('http://proxy:8080');
    expect(ip).toBe('1.2.3.4');
  });

  it('throws ProxyError on ipify DNS failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await expect(resolveProxyIp('http://proxy:8080')).rejects.toThrow(ProxyError);
  });

  it('throws ProxyError on ipify timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new DOMException('signal is aborted', 'AbortError')),
    );
    await expect(resolveProxyIp('http://proxy:8080')).rejects.toThrow(ProxyError);
  });

  it('throws ProxyError when IP field is missing from response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await expect(resolveProxyIp('http://proxy:8080')).rejects.toThrow(/IP lookup returned unexpected response/);
  });

  it('throws ProxyError when ip is a number (wrong type)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ip: 12345 }), { status: 200 }),
    );
    await expect(resolveProxyIp('http://proxy:8080')).rejects.toThrow(ProxyError);
  });

  it('throws ProxyError on non-JSON ipify response (cause is the JSON SyntaxError)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not-json', { status: 200 }),
    );
    await expect(resolveProxyIp('http://proxy:8080')).rejects.toThrow(ProxyError);
  });

  it('passes through unknown extra fields and still extracts ip', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ip: '1.2.3.4', extra_field: 'unknown' }), { status: 200 }),
    );
    const ip = await resolveProxyIp('http://proxy:8080');
    expect(ip).toBe('1.2.3.4');
  });
});
