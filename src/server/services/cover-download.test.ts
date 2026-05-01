import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { MAX_COVER_SIZE } from '../../shared/constants.js';
import type * as NetworkServiceModule from '../../core/utils/network-service.js';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

// Route fetchWithOptionalDispatcher through globalThis.fetch so the existing
// `vi.stubGlobal('fetch', mockFetch)` continues to intercept the cover-download
// hop. Production routes through undici's fetch when a dispatcher is attached
// — the helper's routing is asserted in network-service.test.ts and the call
// site is exercised end-to-end in cover-download.e2e.test.ts.
vi.mock('../../core/utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithOptionalDispatcher: ((url, options) => globalThis.fetch(url, options as RequestInit)) as typeof actual.fetchWithOptionalDispatcher,
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import { downloadRemoteCover, isRemoteCoverUrl } from './cover-download.js';

// dns.lookup is overloaded; cast to a permissive Mock so resolved arrays type-check.
const mockedDnsLookup = vi.mocked(dnsLookup) as unknown as Mock;

function createMockLogger() {
  return inject<FastifyBaseLogger>({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
    level: 'info',
  });
}

function createMockDb() {
  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

function createImageResponse(contentType = 'image/jpeg', body: BodyInit = Buffer.from('fake-image-data')) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

function createRedirectResponse(location: string, status = 302) {
  return new Response(null, {
    status,
    headers: { location },
  });
}

/** Default to a public IP so most tests proceed past the SSRF gate. */
function mockPublicDns() {
  mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
}

describe('downloadRemoteCover', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    // mockReset clears queued mockResolvedValueOnce responses; clearAllMocks alone leaves them.
    mockFetch.mockReset();
    mockedDnsLookup.mockReset();
    mockDb = createMockDb();
    log = createMockLogger();
    mockPublicDns();
  });

  it('downloads image and saves to {bookPath}/cover.{ext} with atomic write', async () => {
    mockFetch.mockResolvedValue(createImageResponse('image/jpeg'));

    const result = await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(true);
    const writePath = String(vi.mocked(writeFile).mock.calls[0][0]).split('\\').join('/');
    expect(writePath).toContain('/books/test/');
    expect(vi.mocked(writeFile).mock.calls[0][1]).toBeInstanceOf(Buffer);
    const renameDest = String(vi.mocked(rename).mock.calls[0][1]).split('\\').join('/');
    expect(renameDest).toBe('/books/test/cover.jpg');
  });

  it('updates coverUrl to /api/books/{id}/cover in DB after successful download', async () => {
    mockFetch.mockResolvedValue(createImageResponse());

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    const setCall = mockDb.update.mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        coverUrl: '/api/books/42/cover',
        updatedAt: expect.any(Date),
      }),
    );
  });

  it('skips download when coverUrl is null', async () => {
    const result = await downloadRemoteCover(
      1, '/books/test', null as unknown as string,
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips download when coverUrl is empty string', async () => {
    const result = await downloadRemoteCover(
      1, '/books/test', '',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips download when coverUrl is already local (/api/books/:id/cover)', async () => {
    const result = await downloadRemoteCover(
      1, '/books/test', '/api/books/1/cover',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips download when book.path is null', async () => {
    const result = await downloadRemoteCover(
      1, null as unknown as string, 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('preserves external coverUrl when network error occurs', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('preserves external coverUrl when write error occurs', async () => {
    mockFetch.mockResolvedValue(createImageResponse());
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('Disk full'));

    const result = await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('logs warning on download failure without throwing', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const result = await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      expect.stringContaining('cover'),
    );
  });

  it('rejects non-image content-type responses', async () => {
    mockFetch.mockResolvedValue(new Response('<html>Error</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));

    const result = await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('uses manual redirects and walks one 302 → 200 hop successfully', async () => {
    mockFetch
      .mockResolvedValueOnce(createRedirectResponse('https://cdn.example.com/final.jpg'))
      .mockResolvedValueOnce(createImageResponse('image/jpeg'));

    const result = await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://cdn.example.com/cover.jpg',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example.com/final.jpg',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('infers extension from content-type header', async () => {
    mockFetch.mockResolvedValue(createImageResponse('image/png'));

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover.png',
      inject<Db>(mockDb), log,
    );

    const renameDest = String(vi.mocked(rename).mock.calls[0][1]).split('\\').join('/');
    expect(renameDest).toBe('/books/test/cover.png');
  });

  it('strips charset suffix from content-type before extension mapping', async () => {
    mockFetch.mockResolvedValue(new Response(Buffer.from('data'), {
      status: 200,
      headers: { 'content-type': 'image/png; charset=utf-8' },
    }));

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover',
      inject<Db>(mockDb), log,
    );

    const renameDest = String(vi.mocked(rename).mock.calls[0][1]).split('\\').join('/');
    expect(renameDest).toBe('/books/test/cover.png');
  });

  it('defaults to jpg when content-type is a generic image type', async () => {
    mockFetch.mockResolvedValue(new Response(Buffer.from('data'), {
      status: 200,
      headers: { 'content-type': 'image/bmp' },
    }));

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover',
      inject<Db>(mockDb), log,
    );

    const renameDest = String(vi.mocked(rename).mock.calls[0][1]).split('\\').join('/');
    expect(renameDest).toBe('/books/test/cover.jpg');
  });

  it('overwrites existing cover via atomic rename on re-enrichment', async () => {
    mockFetch.mockResolvedValue(createImageResponse());

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/new-cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(rename).toHaveBeenCalled();
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(1);
  });

  describe('SSRF refusals', () => {
    it.each([
      { name: 'private IPv4 192.168.1.1', address: '192.168.1.1', family: 4 },
      { name: 'loopback 127.0.0.1', address: '127.0.0.1', family: 4 },
      { name: 'AWS metadata 169.254.169.254', address: '169.254.169.254', family: 4 },
      { name: 'IPv4 unspecified 0.0.0.0', address: '0.0.0.0', family: 4 },
      { name: 'IPv6 unspecified ::', address: '::', family: 6 },
      { name: 'IPv6 ULA fd00::1', address: 'fd00::1', family: 6 },
      { name: 'IPv4-mapped ::ffff:192.168.1.1', address: '::ffff:192.168.1.1', family: 6 },
    ])('refuses URL whose lookup returns $name', async ({ address, family }) => {
      mockedDnsLookup.mockReset();
      mockedDnsLookup.mockResolvedValueOnce([{ address, family }]);

      const result = await downloadRemoteCover(
        1, '/books/test', 'https://attacker.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
      expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 1,
          error: expect.objectContaining({ message: expect.stringMatching(/Refused/) }),
        }),
        expect.stringContaining('Failed to download'),
      );
    });

    it('refuses mixed-answer DNS where any answer is private', async () => {
      mockedDnsLookup.mockReset();
      mockedDnsLookup.mockResolvedValueOnce([
        { address: '1.2.3.4', family: 4 },
        { address: '192.168.1.1', family: 4 },
      ]);

      const result = await downloadRemoteCover(
        1, '/books/test', 'https://rebind.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([
      'http://[::1]/cover.jpg',
      'http://[fd00::1]/cover.jpg',
      'http://[fe80::1]/cover.jpg',
      'http://[::]/cover.jpg',
    ])('refuses bracketed IPv6 literal URL %s without doing DNS', async (url) => {
      const result = await downloadRemoteCover(
        1, '/books/test', url,
        inject<Db>(mockDb), log,
      );

      expect(result).toBe(false);
      expect(mockedDnsLookup).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('refuses metadata.google.internal hostname pre-check (no DNS lookup)', async () => {
      const result = await downloadRemoteCover(
        1, '/books/test', 'https://metadata.google.internal/computeMetadata/v1/',
        inject<Db>(mockDb), log,
      );

      expect(result).toBe(false);
      expect(mockedDnsLookup).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('refuses redirect chain whose 2nd hop resolves to a private IP', async () => {
      mockedDnsLookup.mockReset();
      mockedDnsLookup
        .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
        .mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);

      mockFetch.mockResolvedValueOnce(createRedirectResponse('https://internal.attacker.example/admin'));

      const result = await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      expect(result).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(writeFile).not.toHaveBeenCalled();
    });
  });

  describe('size cap', () => {
    it('refuses when Content-Length header exceeds MAX_COVER_SIZE without reading body', async () => {
      const tooBig = MAX_COVER_SIZE + 1;
      // Stub the body so we can assert getReader() was NEVER called — that's
      // the actual "body read" boundary AC7 protects. cancel() is allowed
      // (used to drain the connection without consuming bytes).
      const cancelSpy = vi.fn().mockResolvedValue(undefined);
      const getReaderSpy = vi.fn(() => {
        throw new Error('getReader() must not be called when Content-Length exceeds the cap');
      });
      const fakeBody = {
        cancel: cancelSpy,
        getReader: getReaderSpy,
      };
      const response = new Response('placeholder', {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(tooBig),
        },
      });
      Object.defineProperty(response, 'body', { configurable: true, get: () => fakeBody });
      mockFetch.mockResolvedValue(response);

      const result = await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/huge.jpg',
        inject<Db>(mockDb), log,
      );

      expect(result).toBe(false);
      expect(getReaderSpy).not.toHaveBeenCalled();
      expect(cancelSpy).toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('refuses when streamed body exceeds MAX_COVER_SIZE mid-flight and cancels the reader (server lies about Content-Length)', async () => {
      // Spy directly on reader.cancel to assert AC7's required cancellation
      // contract. Wrapping response.body lets us mock the reader the service
      // sees without depending on whether the host stream wrapper forwards
      // `getReader().cancel()` to a custom underlying-source `cancel` callback.
      const cancelSpy = vi.fn().mockResolvedValue(undefined);
      const fakeReader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array(MAX_COVER_SIZE + 1) })
          .mockResolvedValue({ done: true, value: undefined }),
        cancel: cancelSpy,
      };
      const fakeBody = { getReader: () => fakeReader };

      const response = new Response('placeholder', {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
      Object.defineProperty(response, 'body', { configurable: true, get: () => fakeBody });
      mockFetch.mockResolvedValue(response);

      const result = await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      expect(result).toBe(false);
      expect(cancelSpy).toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('accepts Content-Length within MAX_COVER_SIZE', async () => {
      const small = Buffer.from('fake-image-data');
      const response = new Response(small, {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(small.byteLength),
        },
      });
      mockFetch.mockResolvedValue(response);

      const result = await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      expect(result).toBe(true);
      expect((log.warn as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('does not warn when Content-Length header is absent', async () => {
      mockFetch.mockResolvedValue(createImageResponse('image/jpeg'));

      const result = await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      expect(result).toBe(true);
      expect((log.warn as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    describe('malformed Content-Length', () => {
      it.each([
        { name: 'non-numeric', value: 'abc' },
        { name: 'negative', value: '-100' },
        { name: 'zero', value: '0' },
        { name: 'multi-value RFC violation', value: '100, 200' },
      ])('warns and continues streaming on $name header', async ({ value }) => {
        const body = Buffer.from('fake-image-data');
        const response = new Response(body, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': value,
          },
        });
        mockFetch.mockResolvedValue(response);

        const result = await downloadRemoteCover(
          7, '/books/test', 'https://cdn.example.com/cover.jpg',
          inject<Db>(mockDb), log,
        );

        expect(result).toBe(true);
        expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
          expect.objectContaining({
            bookId: 7,
            url: 'https://cdn.example.com/cover.jpg',
            contentLength: value,
          }),
          expect.stringContaining('malformed Content-Length'),
        );
        expect(writeFile).toHaveBeenCalledTimes(1);
      });

      it('logs the sanitized URL, not the raw URL with credentials', async () => {
        const body = Buffer.from('fake-image-data');
        const response = new Response(body, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': 'abc',
          },
        });
        mockFetch.mockResolvedValue(response);

        await downloadRemoteCover(
          1, '/books/test', 'https://user:secret@cdn.example.com/cover.jpg',
          inject<Db>(mockDb), log,
        );

        const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls;
        const malformedCall = warnCalls.find(([, msg]) =>
          typeof msg === 'string' && msg.includes('malformed Content-Length'),
        );
        expect(malformedCall).toBeDefined();
        const payload = malformedCall![0] as { url: string };
        expect(payload.url).not.toContain('secret');
        expect(payload.url).not.toContain('user:');
      });

      it('streaming cap still rejects when malformed Content-Length is paired with an oversized body', async () => {
        const cancelSpy = vi.fn().mockResolvedValue(undefined);
        const fakeReader = {
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new Uint8Array(MAX_COVER_SIZE + 1) })
            .mockResolvedValue({ done: true, value: undefined }),
          cancel: cancelSpy,
        };
        const fakeBody = { getReader: () => fakeReader };

        const response = new Response('placeholder', {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': 'abc',
          },
        });
        Object.defineProperty(response, 'body', { configurable: true, get: () => fakeBody });
        mockFetch.mockResolvedValue(response);

        const result = await downloadRemoteCover(
          1, '/books/test', 'https://cdn.example.com/cover.jpg',
          inject<Db>(mockDb), log,
        );

        expect(result).toBe(false);
        expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
          expect.objectContaining({ contentLength: 'abc' }),
          expect.stringContaining('malformed Content-Length'),
        );
        expect(cancelSpy).toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
        expect(mockDb.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('redirect handling', () => {
    it('refuses chain of 6 hops (exceeds MAX_REDIRECTS=5)', async () => {
      mockedDnsLookup.mockReset();
      // 6 lookups will be needed (one per hop until limit exceeded)
      for (let i = 0; i < 7; i++) {
        mockedDnsLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
      }
      for (let i = 0; i < 6; i++) {
        mockFetch.mockResolvedValueOnce(createRedirectResponse(`https://cdn${i + 2}.example.com/cover.jpg`));
      }
      mockFetch.mockResolvedValueOnce(createImageResponse('image/jpeg'));

      const result = await downloadRemoteCover(
        1, '/books/test', 'https://cdn1.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      expect(result).toBe(false);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('detects redirect loop A → B → A', async () => {
      mockFetch
        .mockResolvedValueOnce(createRedirectResponse('https://b.example.com/cover.jpg'))
        .mockResolvedValueOnce(createRedirectResponse('https://a.example.com/cover.jpg'))
        .mockResolvedValueOnce(createRedirectResponse('https://b.example.com/cover.jpg'));

      const result = await downloadRemoteCover(
        1, '/books/test', 'https://a.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      expect(result).toBe(false);
      expect(writeFile).not.toHaveBeenCalled();
    });
  });

  describe('URL sanitization in logs', () => {
    it('sanitizes URL with query params in non-OK status warning log', async () => {
      mockFetch.mockResolvedValue(new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      }));

      await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg?apikey=secret',
        inject<Db>(mockDb), log,
      );

      const warnCall = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('non-OK'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![0].url).toBe('https://cdn.example.com/cover.jpg');
      expect(warnCall![0].url).not.toContain('secret');
    });

    it('sanitizes URL with query params in non-image content-type warning log', async () => {
      mockFetch.mockResolvedValue(new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }));

      await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg?apikey=secret',
        inject<Db>(mockDb), log,
      );

      const warnCall = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('not an image'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![0].url).toBe('https://cdn.example.com/cover.jpg');
      expect(warnCall![0].url).not.toContain('secret');
    });

    it('sanitizes URL with query params in exception path warning log', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg?apikey=secret',
        inject<Db>(mockDb), log,
      );

      const warnCall = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('Failed to download'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![0].url).toBe('https://cdn.example.com/cover.jpg');
      expect(warnCall![0].url).not.toContain('secret');
    });

    it('passes through clean URL unchanged in log output', async () => {
      mockFetch.mockResolvedValue(new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      }));

      await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      const warnCall = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('non-OK'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![0].url).toBe('https://cdn.example.com/cover.jpg');
    });

    it('sanitizes URL with userinfo credentials in log output', async () => {
      mockFetch.mockResolvedValue(new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      }));

      await downloadRemoteCover(
        1, '/books/test', 'https://user:pass@cdn.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      const warnCall = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('non-OK'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![0].url).not.toContain('user:pass');
      expect(warnCall![0].url).toBe('https://cdn.example.com/cover.jpg');
    });
  });

  describe('timeout constant', () => {
    it('passes HTTP_DOWNLOAD_TIMEOUT_MS to AbortSignal.timeout', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      mockFetch.mockResolvedValue(createImageResponse());

      await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      timeoutSpy.mockRestore();
    });
  });

  it('returns false and warns on non-OK HTTP status without writing files', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    }));

    const result = await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1, status: 404 }),
      expect.stringContaining('non-OK'),
    );
  });

  it('cleans up stale cover siblings when re-downloading with different extension', async () => {
    mockFetch.mockResolvedValue(createImageResponse('image/jpeg'));
    vi.mocked(readdir).mockResolvedValueOnce(['cover.png', 'cover.jpg', 'audiofile.mp3'] as never);

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    const unlinkPath = String(vi.mocked(unlink).mock.calls[0][0]).split('\\').join('/');
    expect(unlinkPath).toBe('/books/test/cover.png');
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('uses unique temp filenames to prevent concurrent download collision', async () => {
    mockFetch.mockResolvedValue(createImageResponse());

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    const tempPath = vi.mocked(writeFile).mock.calls[0][0] as string;
    expect(tempPath).toMatch(/\.cover-download-[0-9a-f-]+\.tmp$/);
    expect(tempPath).not.toContain(`-${42}.tmp`);
  });

  it('uses AbortSignal.timeout for download timeout', async () => {
    mockFetch.mockResolvedValue(createImageResponse());

    await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('passes a dispatcher option to fetch (SSRF-safe agent)', async () => {
    mockFetch.mockResolvedValue(createImageResponse());

    await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ dispatcher: expect.anything() }),
    );
  });
});

describe('isRemoteCoverUrl', () => {
  it('returns true for http:// URLs', () => {
    expect(isRemoteCoverUrl('http://example.com/cover.jpg')).toBe(true);
  });

  it('returns true for https:// URLs', () => {
    expect(isRemoteCoverUrl('https://m.media-amazon.com/images/cover.jpg')).toBe(true);
  });

  it('returns false for local /api/books/:id/cover URLs', () => {
    expect(isRemoteCoverUrl('/api/books/42/cover')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRemoteCoverUrl(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isRemoteCoverUrl('')).toBe(false);
  });
});
