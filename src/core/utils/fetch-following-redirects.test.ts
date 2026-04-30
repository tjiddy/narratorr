import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup as dnsLookup } from 'node:dns/promises';
import { fetchFollowingRedirects } from './fetch-following-redirects.js';
import { SsrfRefusedError } from './blocked-fetch-address.js';

const mockedDnsLookup = vi.mocked(dnsLookup) as unknown as Mock;
const mockFetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  mockedDnsLookup.mockReset();
  // Default to a public IP — tests for SSRF refusal override per-test.
  mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('fetchFollowingRedirects (#769 / #877 F2)', () => {
  describe('happy path', () => {
    it('returns body buffer, status, finalUrl, and headers under the cap', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(Buffer.from('hello'), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      );

      const result = await fetchFollowingRedirects('https://example.com/file', {
        maxBodyBytes: 1024,
      });

      expect(result.status).toBe(200);
      expect(result.finalUrl).toBe('https://example.com/file');
      expect(Buffer.compare(result.buffer, Buffer.from('hello'))).toBe(0);
      expect(result.headers.get('content-type')).toBe('application/octet-stream');
    });
  });

  describe('redirect following with per-hop validation', () => {
    it('follows a 302 redirect and returns the final body', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example.com/final' },
          }),
        )
        .mockResolvedValueOnce(new Response(Buffer.from('payload'), { status: 200 }));

      const result = await fetchFollowingRedirects('https://indexer.example.com/getnzb', {
        maxBodyBytes: 1024,
      });

      expect(result.status).toBe(200);
      expect(result.finalUrl).toBe('https://cdn.example.com/final');
      expect(Buffer.compare(result.buffer, Buffer.from('payload'))).toBe(0);
    });

    it('runs resolveAndValidate on every hop (rejects when a redirect Location resolves to a blocked address)', async () => {
      // First hop's hostname resolves public; second hop's hostname resolves to RFC 1918.
      mockedDnsLookup.mockReset();
      mockedDnsLookup
        .mockResolvedValueOnce([{ address: '1.2.3.4', family: 4 }])
        .mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);

      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://internal.example.com/secret' },
        }),
      );

      await expect(
        fetchFollowingRedirects('https://indexer.example.com/getnzb', { maxBodyBytes: 1024 }),
      ).rejects.toBeInstanceOf(SsrfRefusedError);
    });

    it('refuses an initial private/blocked target before issuing fetch', async () => {
      await expect(
        fetchFollowingRedirects('http://192.168.1.1/file', { maxBodyBytes: 1024 }),
      ).rejects.toBeInstanceOf(SsrfRefusedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('refuses metadata.google.internal at hostname stage (no DNS lookup)', async () => {
      await expect(
        fetchFollowingRedirects('http://metadata.google.internal/', { maxBodyBytes: 1024 }),
      ).rejects.toBeInstanceOf(SsrfRefusedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws on >MAX_REDIRECTS (5) hop limit', async () => {
      // Six 302 responses in a row — should exceed the hop limit (1 initial + 5 redirects).
      for (let i = 0; i < 7; i++) {
        mockFetch.mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: `https://hop${i + 1}.example.com/` },
          }),
        );
      }

      await expect(
        fetchFollowingRedirects('https://hop0.example.com/', { maxBodyBytes: 1024 }),
      ).rejects.toThrow(/Too many redirects/);
    });

    it('throws on a redirect loop (visited URL revisited)', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: 'https://b.example.com/' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: 'https://a.example.com/' },
          }),
        );

      await expect(
        fetchFollowingRedirects('https://a.example.com/', { maxBodyBytes: 1024 }),
      ).rejects.toThrow(/Redirect loop/);
    });

    it('throws on a redirect with no Location header', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 302 }));
      await expect(
        fetchFollowingRedirects('https://example.com/', { maxBodyBytes: 1024 }),
      ).rejects.toThrow(/Redirect with no location/);
    });

    it('rejects redirects to unsupported schemes (e.g. file:, magnet:)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'file:///etc/passwd' },
        }),
      );
      await expect(
        fetchFollowingRedirects('https://example.com/', { maxBodyBytes: 1024 }),
      ).rejects.toThrow(/unsupported scheme/);
    });
  });

  describe('cap application', () => {
    it('throws when the final body exceeds maxBodyBytes', async () => {
      const oversized = Buffer.alloc(1025);
      mockFetch.mockResolvedValueOnce(
        new Response(oversized, {
          status: 200,
          headers: { 'content-length': String(oversized.length) },
        }),
      );
      await expect(
        fetchFollowingRedirects('https://example.com/', { maxBodyBytes: 1024 }),
      ).rejects.toThrow(/exceeds cap/);
    });

    it('throws when streamed body exceeds maxBodyBytes mid-read', async () => {
      const stream = new ReadableStream({
        start(controller) {
          // Single chunk over the cap; no Content-Length header (server lying).
          controller.enqueue(new Uint8Array(1025));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));
      await expect(
        fetchFollowingRedirects('https://example.com/', { maxBodyBytes: 1024 }),
      ).rejects.toThrow(/exceeded cap/);
    });
  });
});
