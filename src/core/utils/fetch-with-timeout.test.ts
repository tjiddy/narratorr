import { describe, expect, it, vi, afterEach, beforeEach, type Mock } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup as dnsLookup } from 'node:dns/promises';
import { fetchWithTimeout } from './fetch-with-timeout.js';
import { SsrfRefusedError } from './blocked-fetch-address.js';
import {
  RESPONSE_CAP_NOTIFIER,
  RESPONSE_CAP_METADATA,
  RESPONSE_CAP_DOWNLOAD_CLIENT_RPC,
} from './response-caps.js';

const mockedDnsLookup = vi.mocked(dnsLookup) as unknown as Mock;

beforeEach(() => {
  mockedDnsLookup.mockReset();
  // Default to a public IP so tests proceed past the SSRF gate.
  mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

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

  describe('SSRF preflight (#769)', () => {
    it('refuses RFC 1918 IP literal with SsrfRefusedError before invoking fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(fetchWithTimeout('http://192.168.1.10/', {}, 5000)).rejects.toBeInstanceOf(
        SsrfRefusedError,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://172.16.5.5/',
      'http://192.168.1.1/',
      'http://169.254.169.254/',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[ff02::1]/',
      'http://[::]/',
    ])('refuses %s without invoking fetch', async (url) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(fetchWithTimeout(url, {}, 5000)).rejects.toBeInstanceOf(SsrfRefusedError);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses metadata.google.internal at hostname stage (no DNS lookup)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(
        fetchWithTimeout('http://metadata.google.internal/', {}, 5000),
      ).rejects.toBeInstanceOf(SsrfRefusedError);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockedDnsLookup).not.toHaveBeenCalled();
    });

    it('refuses mixed-answer DNS smuggling (any private answer fails)', async () => {
      mockedDnsLookup.mockReset();
      mockedDnsLookup.mockResolvedValueOnce([
        { address: '1.2.3.4', family: 4 },
        { address: '192.168.1.1', family: 4 },
      ]);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(fetchWithTimeout('http://rebind.example.com/', {}, 5000)).rejects.toBeInstanceOf(
        SsrfRefusedError,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('allowPrivateNetwork', () => {
    it('with allowPrivateNetwork=true, requests to 127.0.0.1 succeed (no SSRF refusal)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );
      const response = await fetchWithTimeout(
        'http://127.0.0.1:8080/',
        { allowPrivateNetwork: true },
        5000,
      );
      expect(response.status).toBe(200);
    });

    it('with allowPrivateNetwork=true, Docker service names succeed', async () => {
      mockedDnsLookup.mockReset();
      mockedDnsLookup.mockResolvedValue([{ address: '172.17.0.5', family: 4 }]);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );
      const response = await fetchWithTimeout(
        'http://qbittorrent:8080/',
        { allowPrivateNetwork: true },
        5000,
      );
      expect(response.status).toBe(200);
    });

    it('with allowPrivateNetwork=false (default), 127.0.0.1 is refused', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(fetchWithTimeout('http://127.0.0.1:8080/', {}, 5000)).rejects.toBeInstanceOf(
        SsrfRefusedError,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('with allowPrivateNetwork=true, redirect rejection still applies', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { Location: 'http://192.168.1.1/' },
        }),
      );
      await expect(
        fetchWithTimeout('http://127.0.0.1/', { allowPrivateNetwork: true }, 5000),
      ).rejects.toThrow(/redirected/i);
    });
  });

  describe('body cap (maxBodyBytes)', () => {
    it('default cap is RESPONSE_CAP_NOTIFIER when maxBodyBytes is omitted', async () => {
      const oversizedDeclared = new Response(null, {
        status: 200,
        headers: { 'content-length': String(RESPONSE_CAP_NOTIFIER + 1) },
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(oversizedDeclared);
      await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(/exceeds cap/);
    });

    it('overrides default cap when maxBodyBytes is provided', async () => {
      const slightlyOverNotifier = new Response('x'.repeat(RESPONSE_CAP_NOTIFIER + 100), {
        status: 200,
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(slightlyOverNotifier);

      const response = await fetchWithTimeout(
        'https://example.com',
        { maxBodyBytes: RESPONSE_CAP_METADATA },
        5000,
      );
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBe(RESPONSE_CAP_NOTIFIER + 100);
    });

    it('throws when body exceeds the named cap requested', async () => {
      const overMetadata = new Response('x'.repeat(RESPONSE_CAP_METADATA + 1), { status: 200 });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(overMetadata);
      await expect(
        fetchWithTimeout(
          'https://example.com',
          { maxBodyBytes: RESPONSE_CAP_METADATA },
          5000,
        ),
      ).rejects.toThrow(/exceeded cap/);
    });

    it('honors RESPONSE_CAP_DOWNLOAD_CLIENT_RPC when set on a private-network call', async () => {
      const ten = new Response('x'.repeat(1024), { status: 200 });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(ten);
      const response = await fetchWithTimeout(
        'http://127.0.0.1:8080/',
        {
          allowPrivateNetwork: true,
          maxBodyBytes: RESPONSE_CAP_DOWNLOAD_CLIENT_RPC,
        },
        5000,
      );
      expect(response.status).toBe(200);
    });
  });

  describe('public-contract preservation after cap', () => {
    it('reconstructed Response.text() returns the full body verbatim', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('hello world', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      );
      const response = await fetchWithTimeout('https://example.com', {}, 5000);
      expect(await response.text()).toBe('hello world');
    });

    it('reconstructed Response.json() parses the body', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ foo: 'bar' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const response = await fetchWithTimeout('https://example.com', {}, 5000);
      expect(await response.json()).toEqual({ foo: 'bar' });
    });

    it('reconstructed Response.arrayBuffer() returns the bytes', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), { status: 200 }),
      );
      const response = await fetchWithTimeout('https://example.com', {}, 5000);
      const ab = await response.arrayBuffer();
      expect(new Uint8Array(ab)).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    });

    it('preserves status, statusText, and a representative header', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', {
          status: 201,
          statusText: 'Created',
          headers: { 'content-type': 'text/custom' },
        }),
      );
      const response = await fetchWithTimeout('https://example.com', {}, 5000);
      expect(response.status).toBe(201);
      expect(response.statusText).toBe('Created');
      expect(response.headers.get('content-type')).toBe('text/custom');
    });
  });
});
