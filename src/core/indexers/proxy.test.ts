import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProxyError, isProxyRelatedError, IndexerAuthError } from './errors.js';
import type * as NetworkServiceModule from '../utils/network-service.js';

// Keep MSW/fetch spies on this test path; dedicated routing tests cover dispatchers.
vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithOptionalDispatcher: ((url, options) => globalThis.fetch(url, options as RequestInit)) as typeof actual.fetchWithOptionalDispatcher,
  };
});

import { createProxyAgent, fetchWithProxyAgent, resolveProxyIp } from './proxy.js';
import { Dispatcher, ProxyAgent, Socks5ProxyAgent } from 'undici';

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

const TARGET = 'https://indexer.example.org/api';

describe('createProxyAgent', () => {
  // Every branch is asserted against `Dispatcher`, not a concrete class: class identity is what let
  // a non-dispatcher SOCKS agent ship (#2484), and only the base-class assertion would have caught it.
  it('creates an undici Dispatcher for http:// URL', () => {
    const agent = createProxyAgent('http://proxy.example.com:8080', TARGET);
    expect(agent).toBeInstanceOf(ProxyAgent);
    expect(agent).toBeInstanceOf(Dispatcher);
  });

  it('creates an undici Dispatcher for https:// URL', () => {
    const agent = createProxyAgent('https://proxy.example.com:8443', TARGET);
    expect(agent).toBeInstanceOf(ProxyAgent);
    expect(agent).toBeInstanceOf(Dispatcher);
  });

  it("creates undici's Socks5ProxyAgent — an undici Dispatcher — for socks5:// URL", () => {
    const agent = createProxyAgent('socks5://proxy.example.com:1080', TARGET);
    expect(agent).toBeInstanceOf(Socks5ProxyAgent);
    expect(agent).toBeInstanceOf(Dispatcher);
  });

  it('returns undefined when no proxy URL provided', () => {
    expect(createProxyAgent(undefined, TARGET)).toBeUndefined();
    // The AC9 guard must run AFTER this early return: with no proxy there is no SOCKS path to
    // protect, and firing first would refuse ordinary direct IPv6 requests.
    expect(createProxyAgent(undefined, 'http://[::1]:8080/x')).toBeUndefined();
  });

  it('returns undefined when proxy URL is empty string', () => {
    expect(createProxyAgent('', TARGET)).toBeUndefined();
    expect(createProxyAgent('', 'http://[::1]:8080/x')).toBeUndefined();
  });
});

describe('createProxyAgent — IPv6-literal targets over SOCKS5 (#2484 AC9)', () => {
  it('refuses an IPv6-literal target with a message naming the target and the limitation', () => {
    expect(() => createProxyAgent('socks5://p:1080', 'http://[::1]:8080/x')).toThrow(ProxyError);
    // The factory's bare catch rewrites everything it catches as "Invalid proxy URL"; only an
    // assertion on the text catches a guard that drifted inside the try.
    expect(() => createProxyAgent('socks5://p:1080', 'http://[::1]:8080/x')).toThrow(/\[::1\]/);
    expect(() => createProxyAgent('socks5://p:1080', 'http://[::1]:8080/x')).toThrow(/SOCKS5/);
    expect(() => createProxyAgent('socks5://p:1080', 'http://[::1]:8080/x')).not.toThrow(/Invalid proxy URL/);
  });

  it('does not fire for http:// or https:// proxies, which tunnel bracketed IPv6 fine', () => {
    expect(createProxyAgent('http://p:8080', 'http://[::1]:8080/x')).toBeInstanceOf(ProxyAgent);
    expect(createProxyAgent('https://p:8443', 'http://[::1]:8080/x')).toBeInstanceOf(ProxyAgent);
  });

  it('leaves IPv4 and hostname targets on the SOCKS5 path untouched', () => {
    expect(createProxyAgent('socks5://p:1080', 'http://127.0.0.1:8080/x')).toBeInstanceOf(Socks5ProxyAgent);
    expect(createProxyAgent('socks5://p:1080', 'https://tracker.example.org/x')).toBeInstanceOf(Socks5ProxyAgent);
  });

  it('does not turn an unparseable target into an IPv6 refusal', () => {
    expect(createProxyAgent('socks5://p:1080', 'not a url')).toBeInstanceOf(Socks5ProxyAgent);
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
    expect(result.body).toBe('hello');
    expect(result.requestUrl).toBe('https://example.com');
    expect(result.httpStatus).toBe(200);
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
    expect(result.body).toBe('<xml>data</xml>');
    expect(result.requestUrl).toBe('https://indexer.com/api');
    expect(result.httpStatus).toBe(200);
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
    expect(result.body).toBe('ok');

    vi.restoreAllMocks();
  });
});

/**
 * #2539: the caller's signal is the only thing that can tell a cancellation from an expiry — the
 * composed signal this helper hands to fetch is aborted by its own timeout too. Every case below
 * pairs its verdict with a control on the arm it must not have widened.
 */
describe('fetchWithProxyAgent — caller-abort attribution (#2539 AC1-AC4)', () => {
  const PROXIED = { proxyUrl: 'http://proxy:8080' } as const;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => { throw new Error('expected a rejection'); },
      (error: unknown) => error,
    );
  }

  it('rethrows a proxied caller abort verbatim instead of calling it a proxy timeout', async () => {
    const abortError = new DOMException('This operation was aborted', 'AbortError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);
    const controller = new AbortController();
    controller.abort();

    const rejection = await rejectionOf(
      fetchWithProxyAgent('https://example.com', { ...PROXIED, signal: controller.signal }),
    );

    expect(rejection).toBe(abortError);
    expect(rejection).not.toBeInstanceOf(ProxyError);
    expect((rejection as Error).message).not.toMatch(/Proxy timed out/);
  });

  it('propagates a custom abort reason object unchanged (AC2)', async () => {
    const reason = new Error('search deadline reached');
    const controller = new AbortController();
    controller.abort(reason);
    // undici forwards the signal's reason as the rejection, so a custom reason arrives as `error`.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(reason);

    const rejection = await rejectionOf(
      fetchWithProxyAgent('https://example.com', { ...PROXIED, signal: controller.signal }),
    );

    expect(rejection).toBe(reason);
    expect(rejection).not.toBeInstanceOf(ProxyError);
    expect((rejection as Error).message).not.toMatch(/Proxy connection failed/);
  });

  it('rethrows a caller abort on the DIRECT path rather than fabricating an ETIMEDOUT timeout', async () => {
    const abortError = new DOMException('This operation was aborted', 'AbortError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);
    const controller = new AbortController();
    controller.abort();

    const rejection = await rejectionOf(
      fetchWithProxyAgent('https://example.com', { signal: controller.signal }),
    );

    expect(rejection).toBe(abortError);
    expect((rejection as Error).message).not.toMatch(/Request timed out/);
    // A DOMException carries the native ABORT_ERR code 20; what must NOT appear is the transport
    // code mapNetworkError fabricates for its timeout arm.
    expect((rejection as { code?: unknown }).code).not.toBe('ETIMEDOUT');
  });

  it('gives the caller attribution when the caller abort and the internal timeout have both fired (AC4)', async () => {
    const abortError = new DOMException('This operation was aborted', 'AbortError');
    const controller = new AbortController();
    let composedWasAborted = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      // Let the 1ms internal timer fire first, THEN cancel: both signals are aborted by the time
      // the catch classifies, so the verdict cannot be decided by which one happened to win.
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      composedWasAborted = (init as RequestInit).signal?.aborted ?? false;
      throw abortError;
    });

    const rejection = await rejectionOf(
      fetchWithProxyAgent('https://example.com', { ...PROXIED, timeoutMs: 1, signal: controller.signal }),
    );

    expect(composedWasAborted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(rejection).toBe(abortError);
    expect(rejection).not.toBeInstanceOf(ProxyError);
  });

  it('control: a LIVE caller signal leaves a genuine dispatcher failure as ProxyError', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1080'), { code: 'ECONNREFUSED' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause }));
    const controller = new AbortController();

    const rejection = await rejectionOf(
      fetchWithProxyAgent('https://example.com', { ...PROXIED, signal: controller.signal }),
    );

    expect(rejection).toBeInstanceOf(ProxyError);
    expect((rejection as Error).message).toMatch(/Proxy connection failed: .*ECONNREFUSED/);
  });

  it('control: with no caller signal the internal timeout still reads as the proxy timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('signal is aborted', 'AbortError'));

    const rejection = await rejectionOf(
      fetchWithProxyAgent('https://example.com', { ...PROXIED, timeoutMs: 30_000 }),
    );

    expect(rejection).toBeInstanceOf(ProxyError);
    expect((rejection as Error).message).toBe('Proxy timed out after 30s');
  });

  it('control: with no caller signal the direct arm keeps mapNetworkError\'s message AND its code', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );

    const rejection = await rejectionOf(fetchWithProxyAgent('https://example.com'));

    expect(rejection).not.toBeInstanceOf(ProxyError);
    expect((rejection as Error).message).toBe('Request timed out');
    // The code is the load-bearing half: a classifier downstream reads it, never the string.
    expect((rejection as { code?: string }).code).toBe('ETIMEDOUT');
  });

  it('control: an explicitly undefined caller signal behaves exactly as an absent one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await expect(fetchWithProxyAgent('https://example.com', { ...PROXIED, signal: undefined }))
      .resolves.toMatchObject({ body: 'ok' });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const rejection = await rejectionOf(
      fetchWithProxyAgent('https://example.com', { ...PROXIED, signal: undefined }),
    );

    expect(rejection).toBeInstanceOf(ProxyError);
    expect((rejection as Error).message).toMatch(/Proxy connection failed/);
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
