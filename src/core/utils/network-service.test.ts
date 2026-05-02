import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup as dnsLookup } from 'node:dns/promises';
import { ProxyAgent } from 'undici';
import {
  fetchWithOptionalDispatcher,
  fetchWithSsrfRedirect,
  fetchWithTimeout,
  isBlockedFetchAddress,
  isBlockedHostname,
  isIpLiteral,
  MAX_REDIRECTS,
  normalizeHostname,
  resolveAndValidate,
  undiciFetch,
  UnsupportedRedirectSchemeError,
  validatingLookup,
} from './network-service.js';
import { Agent as UndiciAgent } from 'undici';

// dns.lookup is overloaded; the all:true variant returns an array. Cast to a
// permissive Mock so resolved-value typing accepts arrays.
const mockedLookup = vi.mocked(dnsLookup) as unknown as Mock;

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

describe('isBlockedFetchAddress', () => {
  describe('IPv4 ranges', () => {
    it('blocks 0.0.0.0 (unspecified)', () => {
      expect(isBlockedFetchAddress('0.0.0.0')).toBe(true);
    });

    it.each([
      '10.0.0.0',
      '10.255.255.255',
      '127.0.0.1',
      '127.255.255.255',
      '169.254.0.1',
      '169.254.169.254',
      '172.16.0.0',
      '172.20.5.5',
      '172.31.255.255',
      '192.168.0.1',
      '192.168.255.255',
    ])('blocks private/loopback/link-local %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(true);
    });

    it.each([
      '100.64.0.0',
      '100.64.0.1',
      '100.100.50.50',
      '100.127.255.255',
    ])('blocks CGNAT %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(true);
    });

    it.each([
      '100.63.255.255',
      '100.128.0.0',
    ])('does not block CGNAT-adjacent %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(false);
    });

    it.each([
      '8.8.8.8',
      '1.1.1.1',
      '172.15.255.255',
      '172.32.0.0',
      '169.253.255.255',
      '169.255.0.0',
      '93.184.216.34',
    ])('does not block public IPv4 %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(false);
    });
  });

  describe('IPv6 ranges', () => {
    it('blocks :: (unspecified)', () => {
      expect(isBlockedFetchAddress('::')).toBe(true);
    });

    it('blocks ::1 (loopback)', () => {
      expect(isBlockedFetchAddress('::1')).toBe(true);
    });

    it.each(['fe80::1', 'fe80::abcd', 'feaf::1', 'febf::1'])('blocks link-local %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(true);
    });

    it.each(['fc00::1', 'fd00::1', 'fdab:cdef::1', 'fcab::1'])('blocks ULA %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(true);
    });

    it.each(['ff00::', 'ff02::1', 'ff05::101', 'ff0e::1', 'FF02::1'])('blocks multicast %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(true);
    });

    it.each(['2001:db8::1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('does not block public IPv6 %s', (ip) => {
      expect(isBlockedFetchAddress(ip)).toBe(false);
    });
  });

  describe('IPv4-mapped IPv6', () => {
    it('blocks ::ffff:127.0.0.1', () => {
      expect(isBlockedFetchAddress('::ffff:127.0.0.1')).toBe(true);
    });

    it('blocks ::ffff:192.168.1.1', () => {
      expect(isBlockedFetchAddress('::ffff:192.168.1.1')).toBe(true);
    });

    it('blocks ::ffff:169.254.169.254', () => {
      expect(isBlockedFetchAddress('::ffff:169.254.169.254')).toBe(true);
    });

    it('blocks ::ffff:0.0.0.0', () => {
      expect(isBlockedFetchAddress('::ffff:0.0.0.0')).toBe(true);
    });

    it('blocks ::ffff:100.64.0.1 (CGNAT)', () => {
      expect(isBlockedFetchAddress('::ffff:100.64.0.1')).toBe(true);
    });

    it('does not block ::ffff:8.8.8.8', () => {
      expect(isBlockedFetchAddress('::ffff:8.8.8.8')).toBe(false);
    });
  });

  describe('case insensitivity / zone IDs', () => {
    it('matches FE80::1 case-insensitively', () => {
      expect(isBlockedFetchAddress('FE80::1')).toBe(true);
    });

    it('strips IPv6 zone IDs before matching', () => {
      expect(isBlockedFetchAddress('fe80::1%eth0')).toBe(true);
    });
  });
});

describe('normalizeHostname', () => {
  it('strips surrounding brackets from IPv6 literal hostnames', () => {
    expect(normalizeHostname('[::1]')).toBe('::1');
    expect(normalizeHostname('[fd00::1]')).toBe('fd00::1');
    expect(normalizeHostname('[fe80::1]')).toBe('fe80::1');
  });

  it('returns hostnames without brackets unchanged', () => {
    expect(normalizeHostname('cdn.example.com')).toBe('cdn.example.com');
    expect(normalizeHostname('192.168.1.1')).toBe('192.168.1.1');
    expect(normalizeHostname('::1')).toBe('::1');
  });
});

describe('isBlockedHostname', () => {
  it('blocks metadata.google.internal', () => {
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
  });

  it('blocks case-insensitively', () => {
    expect(isBlockedHostname('Metadata.Google.Internal')).toBe(true);
  });

  it('does not block other hostnames', () => {
    expect(isBlockedHostname('cdn.example.com')).toBe(false);
  });
});

describe('isIpLiteral', () => {
  it('detects IPv4 literals', () => {
    expect(isIpLiteral('192.168.1.1')).toBe(true);
  });

  it('detects IPv6 literals', () => {
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('fe80::1')).toBe(true);
  });

  it('returns false for hostnames', () => {
    expect(isIpLiteral('cdn.example.com')).toBe(false);
  });
});

describe('resolveAndValidate', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  it('returns the IP literal directly when it is public', async () => {
    const result = await resolveAndValidate('8.8.8.8');
    expect(result).toEqual(['8.8.8.8']);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('throws on blocked IP literal without doing lookup', async () => {
    await expect(resolveAndValidate('192.168.1.1')).rejects.toThrow(/Refused/);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('throws on blocked hostname without doing lookup', async () => {
    await expect(resolveAndValidate('metadata.google.internal')).rejects.toThrow(/Refused/);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('resolves and returns addresses when all are public', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
    const result = await resolveAndValidate('cdn.example.com');
    expect(result).toEqual(['93.184.216.34', '2606:2800:220:1::1']);
  });

  it('throws when any answer is blocked (single private answer)', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);
    await expect(resolveAndValidate('rebind.example.com')).rejects.toThrow(/Refused/);
  });

  it('throws on mixed answers where any is blocked (multi-answer DNS)', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '1.2.3.4', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ]);
    await expect(resolveAndValidate('mixed.example.com')).rejects.toThrow(/Refused/);
  });

  it('throws when DNS returns zero answers', async () => {
    mockedLookup.mockResolvedValueOnce([]);
    await expect(resolveAndValidate('empty.example.com')).rejects.toThrow(/Refused/);
  });

  describe('bracketed IPv6 URL hostnames (URL.hostname returns [::1])', () => {
    it('throws on [::1] (loopback IPv6 in bracketed URL form)', async () => {
      await expect(resolveAndValidate('[::1]')).rejects.toThrow(/Refused/);
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('throws on [fd00::1] (ULA in bracketed URL form)', async () => {
      await expect(resolveAndValidate('[fd00::1]')).rejects.toThrow(/Refused/);
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('throws on [fe80::1] (link-local in bracketed URL form)', async () => {
      await expect(resolveAndValidate('[fe80::1]')).rejects.toThrow(/Refused/);
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('throws on [::] (unspecified in bracketed URL form)', async () => {
      await expect(resolveAndValidate('[::]')).rejects.toThrow(/Refused/);
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('accepts a public IPv6 in bracketed URL form', async () => {
      const result = await resolveAndValidate('[2606:4700:4700::1111]');
      expect(result).toEqual(['2606:4700:4700::1111']);
      expect(mockedLookup).not.toHaveBeenCalled();
    });
  });
});

/**
 * Direct tests for the dispatcher's connect.lookup hook (AC1's socket-bound
 * validation). Service tests stub global fetch and never exercise this path,
 * so the rebinding-protection contract is verified here.
 */
describe('validatingLookup (socket-bound dispatcher hook)', () => {
  function callLookup(hostname: string): Promise<{ err: unknown; address: unknown; family: unknown }> {
    return new Promise((resolve) => {
      validatingLookup(hostname, {}, (err, address, family) => {
        resolve({ err, address, family });
      });
    });
  }

  beforeEach(() => {
    mockedLookup.mockReset();
  });

  it('returns the first public address when DNS answers are all public', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ]);
    const { err, address, family } = await callLookup('cdn.example.com');
    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('rejects via callback when DNS returns a single private answer', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);
    const { err, address } = await callLookup('attacker.example.com');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Refused/);
    expect(address).toBe('');
  });

  it('rejects mixed-answer DNS at socket time (any private answer fails)', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '1.2.3.4', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ]);
    const { err } = await callLookup('rebind.example.com');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Refused/);
  });

  it('rejects loopback IPv6 at socket time', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '::1', family: 6 }]);
    const { err } = await callLookup('loopback.example.com');
    expect(err).toBeInstanceOf(Error);
  });

  it('rejects link-local IPv4 (AWS metadata) at socket time', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const { err } = await callLookup('rebind.example.com');
    expect(err).toBeInstanceOf(Error);
  });

  it('rejects metadata.google.internal hostname pre-check without doing DNS', async () => {
    const { err } = await callLookup('metadata.google.internal');
    expect(err).toBeInstanceOf(Error);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('rejects bracketed IPv6 literal hostname (e.g. [::1]) at socket time', async () => {
    const { err } = await callLookup('[::1]');
    expect(err).toBeInstanceOf(Error);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('returns IP literal directly without DNS lookup when public', async () => {
    const { err, address } = await callLookup('8.8.8.8');
    expect(err).toBeNull();
    expect(address).toBe('8.8.8.8');
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('rejects when DNS returns zero answers', async () => {
    mockedLookup.mockResolvedValueOnce([]);
    const { err } = await callLookup('empty.example.com');
    expect(err).toBeInstanceOf(Error);
  });

  it('propagates DNS errors via callback', async () => {
    const dnsErr = new Error('ENOTFOUND') as NodeJS.ErrnoException;
    dnsErr.code = 'ENOTFOUND';
    mockedLookup.mockRejectedValueOnce(dnsErr);
    const { err } = await callLookup('missing.example.com');
    expect(err).toBe(dnsErr);
  });

  it('rejects on the second resolution when the same hostname rebinds to a blocked address', async () => {
    mockedLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);

    const first = await callLookup('rebind.test');
    expect(first.err).toBeNull();
    expect(first.address).toBe('93.184.216.34');
    expect(first.family).toBe(4);

    const second = await callLookup('rebind.test');
    expect(second.err).toBeInstanceOf(Error);
    expect((second.err as Error).message).toMatch(/Refused.*resolves to blocked address 192\.168\.1\.1/);
    expect(second.address).toBe('');
    expect(second.family).toBe(0);

    expect(mockedLookup).toHaveBeenCalledTimes(2);
  });
});

/**
 * Regression: undici 8 tightened dispatcher type validation and rejects
 * dispatchers built from the npm `undici` package when passed to Node 24's
 * bundled `globalThis.fetch` (different `Dispatcher` class identity), throwing
 * `UND_ERR_INVALID_ARG: invalid onRequestStart method`. `undiciFetch` (also
 * imported from the npm `undici` package) accepts the same package's
 * dispatchers without that mismatch. This test instantiates a real `ProxyAgent`
 * pointed at an unreachable address and asserts the dispatcher is *used*
 * (i.e. the call fails with a connection-shaped error from the dispatcher,
 * not a type-validation error before the dispatcher ran).
 */
describe('undiciFetch + dispatcher (regression: dual-undici instance lineage)', () => {
  it('passes a ProxyAgent dispatcher through without UND_ERR_INVALID_ARG', async () => {
    const dispatcher = new ProxyAgent('http://127.0.0.1:1/');
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      dispatcher,
      signal: AbortSignal.timeout(2000),
    };

    const error = await undiciFetch(
      'http://example.invalid/',
      fetchOptions as Parameters<typeof undiciFetch>[1],
    ).catch((e: unknown) => e);

    // Must be a thrown error of some kind — fetching through an unreachable
    // proxy can't succeed.
    expect(error).toBeInstanceOf(Error);
    // The exact failure shape varies (AbortError, fetch failed, etc.) — what
    // matters is it is NOT the dispatcher-shape mismatch that broke prod.
    const message = (error as Error).message ?? '';
    expect(message).not.toMatch(/invalid onRequestStart method/);
    const code = (error as { cause?: { code?: string } }).cause?.code;
    expect(code).not.toBe('UND_ERR_INVALID_ARG');

    await dispatcher.close();
  });
});

/**
 * Routing contract for `fetchWithOptionalDispatcher`. Together with the
 * dispatcher-routing tests in `proxy.dispatcher-routing.test.ts` and
 * `myanonamouse.dispatcher-routing.test.ts` (which prove the indexer call
 * sites pass the dispatcher into this helper), this asserts the production
 * fix from the undici 7→8 cover-download regression: dispatcher-attached
 * calls MUST go through `undiciFetch` so the package-instance Dispatcher
 * shape matches.
 *
 * The negative `expect(globalThis.fetch).not.toHaveBeenCalled()` assertion
 * is what protects the fix — a regression that swaps the helper back to
 * always-`globalThis.fetch` would fail this test.
 */
describe('fetchWithOptionalDispatcher (call-site routing contract)', () => {
  it('routes through undiciFetch (NOT globalThis.fetch) when dispatcher is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const dispatcher = new UndiciAgent({ connect: { lookup: () => { /* never called */ } } });

    // Trigger an unreachable host so the call fails fast — we don't care
    // about the result, only that `globalThis.fetch` was NOT used.
    await fetchWithOptionalDispatcher('http://127.0.0.1:1/', {
      dispatcher,
      signal: AbortSignal.timeout(500),
    }).catch(() => { /* expected */ });

    expect(fetchSpy).not.toHaveBeenCalled();
    await dispatcher.close();
    vi.restoreAllMocks();
  });

  it('routes through globalThis.fetch (NOT undiciFetch) when dispatcher is undefined', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    const response = await fetchWithOptionalDispatcher('http://example.com/', {
      signal: AbortSignal.timeout(500),
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    vi.restoreAllMocks();
  });
});

describe('fetchWithSsrfRedirect', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    // default: every host resolves to a public IP
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeRedirect(location: string, status = 302): Response {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = new Response(null, { status, headers: location ? { Location: location } : {} });
    Object.defineProperty(response, 'body', {
      configurable: true,
      get: () => ({ cancel }),
    });
    (response as unknown as { __cancelSpy: typeof cancel }).__cancelSpy = cancel;
    return response;
  }

  it('returns directly on first-hop 200 (no redirect walk)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('hello', { status: 200 }),
    );

    const response = await fetchWithSsrfRedirect('https://cdn.example.com/file');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 303, 307, 308])('follows %d redirect to a final 200', async (status) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeRedirect('https://cdn.example.com/final', status))
      .mockResolvedValueOnce(new Response('done', { status: 200 }));

    const response = await fetchWithSsrfRedirect('https://cdn.example.com/start');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('done');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(2, 'https://cdn.example.com/final', expect.objectContaining({ redirect: 'manual' }));
  });

  it('resolves a relative Location against the current URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeRedirect('/file.bin'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await fetchWithSsrfRedirect('https://cdn.example.com/path/start');
    expect(fetchSpy).toHaveBeenNthCalledWith(2, 'https://cdn.example.com/file.bin', expect.any(Object));
  });

  it('detects redirect loop A → B → A', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeRedirect('https://b.example.com/'))
      .mockResolvedValueOnce(makeRedirect('https://a.example.com/'));

    await expect(fetchWithSsrfRedirect('https://a.example.com/')).rejects.toThrow(/Redirect loop detected/);
  });

  it('throws on hop-cap exceeded (default MAX_REDIRECTS=5)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (let i = 0; i < 6; i++) {
      fetchSpy.mockResolvedValueOnce(makeRedirect(`https://hop${i}.example.com/`));
    }

    await expect(fetchWithSsrfRedirect('https://start.example.com/')).rejects.toThrow(/Too many redirects/);
    expect(fetchSpy).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it('honours a custom maxHops', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeRedirect('https://b.example.com/'))
      .mockResolvedValueOnce(makeRedirect('https://c.example.com/'));

    await expect(fetchWithSsrfRedirect('https://a.example.com/', { maxHops: 1 })).rejects.toThrow(/Too many redirects/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('pre-flight resolveAndValidate refuses a private-IP startUrl at hop 0', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(fetchWithSsrfRedirect('https://192.168.1.1/cover.jpg')).rejects.toThrow(/Refused/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pre-flight resolveAndValidate refuses when DNS rebinds to a private IP on hop N', async () => {
    mockedLookup.mockReset();
    mockedLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeRedirect('https://rebind.example.com/admin'));

    await expect(fetchWithSsrfRedirect('https://cdn.example.com/path')).rejects.toThrow(/Refused/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['magnet:?xt=urn:btih:abc', 'file:///etc/passwd', 'gopher://host/', 'data:text/plain,hi'])(
    'throws UnsupportedRedirectSchemeError on Location %s',
    async (target) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeRedirect(target));

      const error = await fetchWithSsrfRedirect('https://torrent.example.com/dl/1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnsupportedRedirectSchemeError);
      const ure = error as UnsupportedRedirectSchemeError;
      expect(ure.fromUrl.href).toBe('https://torrent.example.com/dl/1');
      expect(ure.location.split(':')[0]).toBe(target.split(':')[0]);
    },
  );

  it('throws on missing Location at 3xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeRedirect(''));

    await expect(fetchWithSsrfRedirect('https://cdn.example.com/')).rejects.toThrow(/Location/i);
  });

  it('drains redirect-response bodies via cancel()', async () => {
    const redirect = makeRedirect('https://cdn.example.com/final');
    const cancelSpy = (redirect as unknown as { __cancelSpy: ReturnType<typeof vi.fn> }).__cancelSpy;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(new Response('done', { status: 200 }));

    await fetchWithSsrfRedirect('https://cdn.example.com/start');
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('passes opts.timeoutMs to AbortSignal.timeout per hop', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await fetchWithSsrfRedirect('https://cdn.example.com/file', { timeoutMs: 1234 });

    expect(timeoutSpy).toHaveBeenCalledWith(1234);
  });

  it('defaults to HTTP_DOWNLOAD_TIMEOUT_MS (30_000) when opts.timeoutMs is omitted', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await fetchWithSsrfRedirect('https://cdn.example.com/file');

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it('re-arms AbortSignal.timeout(opts.timeoutMs) on each hop of a redirect chain', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeRedirect('https://cdn.example.com/final'))
      .mockResolvedValueOnce(new Response('done', { status: 200 }));

    await fetchWithSsrfRedirect('https://cdn.example.com/start', { timeoutMs: 7777 });

    const callsWithTimeout = timeoutSpy.mock.calls.filter(([ms]) => ms === 7777);
    expect(callsWithTimeout).toHaveLength(2);
  });

  it('rejects with a timeout-shaped error when the per-hop timeout fires (controlled firing)', async () => {
    // Stub fetch to return a Promise that never resolves on its own — only
    // the AbortSignal can settle it. This proves the helper actually wires the
    // AbortSignal.timeout-driven signal into the fetch call.
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (!signal) {
          reject(new Error('test setup: no signal attached to fetch'));
          return;
        }
        signal.addEventListener('abort', () => {
          // Mirror the real fetch behavior: reject with a TimeoutError DOMException
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        });
      });
    });

    const error = await fetchWithSsrfRedirect('https://cdn.example.com/file', { timeoutMs: 25 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('TimeoutError');
  });

  it('routes through undiciFetch when a dispatcher is supplied', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const dispatcher = new UndiciAgent({ connect: { lookup: validatingLookup } });

    // Hit an unreachable port so the dispatcher's connect path is exercised
    // but the call fails fast — we only care that globalThis.fetch was NOT used.
    await fetchWithSsrfRedirect('http://127.0.0.1:1/', {
      dispatcher,
      timeoutMs: 500,
    }).catch(() => { /* expected */ });

    expect(fetchSpy).not.toHaveBeenCalled();
    await dispatcher.close();
  });

  it('routes through globalThis.fetch when no dispatcher is supplied', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await fetchWithSsrfRedirect('https://cdn.example.com/file');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
