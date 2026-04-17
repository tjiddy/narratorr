import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DownloadUrl, extractInfoHashFromTorrent, base32ToHex } from './download-url.js';
import type { DownloadArtifact } from './download-url.js';
import { createHash } from 'node:crypto';

// ── Fixtures ──────────────────────────────────────────────────────────
const KNOWN_HEX_HASH = 'aabbccddee00112233445566778899aabbccddee';
const KNOWN_BASE32_HASH = 'VK54ZXPOACISGNCEKVTHO4EZTK54ZXPO'; // base32 of same

function buildMagnetUri(hash: string): string {
  return `magnet:?xt=urn:btih:${hash}&dn=Test+File`;
}

/** Minimal valid torrent file with a known info dict. */
function fakeTorrentBuffer(): { buffer: Buffer; expectedHash: string } {
  // Build a minimal bencoded torrent: d8:announce5:x.com4:infod6:lengthi1024e4:name8:test.mp3ee
  const inner = Buffer.from('d6:lengthi1024e4:name8:test.mp3e');
  const expectedHash = createHash('sha1').update(inner).digest('hex');
  const torrent = Buffer.from(`d8:announce5:x.com4:info${inner.toString()}e`);
  return { buffer: torrent, expectedHash };
}

function fakeDataUri(torrentBuffer: Buffer): string {
  return `data:application/x-bittorrent;base64,${torrentBuffer.toString('base64')}`;
}

// ── Mock fetch ────────────────────────────────────────────────────────
const mockFetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  // restoreAllMocks doesn't clear manual vi.fn() call history
  mockFetch.mockClear();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockResponse(body: Buffer | string, init?: ResponseInit): Response {
  const bodyData = typeof body === 'string' ? body : new Uint8Array(body);
  return new Response(bodyData, init);
}

// ── Tests ─────────────────────────────────────────────────────────────
describe('DownloadUrl', () => {
  describe('type discrimination', () => {
    it('isMagnet returns true for magnet: scheme', () => {
      const dl = new DownloadUrl('magnet:?xt=urn:btih:abc', 'torrent');
      expect(dl.isMagnet).toBe(true);
    });

    it('isMagnet returns false for http:, https:, data: schemes', () => {
      expect(new DownloadUrl('http://example.com/t.torrent', 'torrent').isMagnet).toBe(false);
      expect(new DownloadUrl('https://example.com/t.torrent', 'torrent').isMagnet).toBe(false);
      expect(new DownloadUrl('data:application/x-bittorrent;base64,AA==', 'torrent').isMagnet).toBe(false);
    });

    it('isHttp returns true for http: and https: schemes', () => {
      expect(new DownloadUrl('http://example.com/t.torrent', 'torrent').isHttp).toBe(true);
      expect(new DownloadUrl('https://example.com/t.torrent', 'torrent').isHttp).toBe(true);
    });

    it('isHttp returns false for magnet: and data: schemes', () => {
      expect(new DownloadUrl('magnet:?xt=urn:btih:abc', 'torrent').isHttp).toBe(false);
      expect(new DownloadUrl('data:application/x-bittorrent;base64,AA==', 'torrent').isHttp).toBe(false);
    });

    it('isDataUri returns true for data:application/x-bittorrent;base64, prefix', () => {
      expect(new DownloadUrl('data:application/x-bittorrent;base64,AA==', 'torrent').isDataUri).toBe(true);
    });

    it('isDataUri returns false for http:, magnet: schemes', () => {
      expect(new DownloadUrl('http://example.com', 'torrent').isDataUri).toBe(false);
      expect(new DownloadUrl('magnet:?xt=urn:btih:abc', 'torrent').isDataUri).toBe(false);
    });
  });

  describe('resolve() — magnet URIs', () => {
    it('returns magnet-uri artifact with extracted info hash (SHA-1 hex)', async () => {
      const dl = new DownloadUrl(buildMagnetUri(KNOWN_HEX_HASH), 'torrent');
      const artifact = await dl.resolve();

      expect(artifact.type).toBe('magnet-uri');
      expect(artifact).toEqual({
        type: 'magnet-uri',
        uri: buildMagnetUri(KNOWN_HEX_HASH),
        infoHash: KNOWN_HEX_HASH,
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('extracts info hash from uppercase base32 magnet URI', async () => {
      const dl = new DownloadUrl(buildMagnetUri(KNOWN_BASE32_HASH), 'torrent');
      const artifact = await dl.resolve();

      expect(artifact.type).toBe('magnet-uri');
      expect((artifact as Extract<DownloadArtifact, { type: 'magnet-uri' }>).infoHash).toBe(
        base32ToHex(KNOWN_BASE32_HASH).toLowerCase(),
      );
    });

    it('throws descriptive error for magnet URI missing xt parameter', async () => {
      const dl = new DownloadUrl('magnet:?dn=Test+File', 'torrent');
      await expect(dl.resolve()).rejects.toThrow(/info hash/i);
    });

    it('does not make any HTTP fetch for magnet URIs', async () => {
      const dl = new DownloadUrl(buildMagnetUri(KNOWN_HEX_HASH), 'torrent');
      await dl.resolve();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('resolve() — data: URIs', () => {
    it('decodes base64 torrent buffer and returns torrent-bytes artifact', async () => {
      const { buffer, expectedHash } = fakeTorrentBuffer();
      const dl = new DownloadUrl(fakeDataUri(buffer), 'torrent');
      const artifact = await dl.resolve();

      expect(artifact.type).toBe('torrent-bytes');
      const tb = artifact as Extract<DownloadArtifact, { type: 'torrent-bytes' }>;
      expect(tb.data).toEqual(buffer);
      expect(tb.infoHash).toBe(expectedHash);
    });

    it('throws when decoded buffer has no valid info dict', async () => {
      const badBuffer = Buffer.from('d8:announce5:x.come'); // no 4:info
      const dl = new DownloadUrl(fakeDataUri(badBuffer), 'torrent');
      await expect(dl.resolve()).rejects.toThrow(/info hash/i);
    });

    it('does not make any HTTP fetch for data: URIs', async () => {
      const { buffer } = fakeTorrentBuffer();
      const dl = new DownloadUrl(fakeDataUri(buffer), 'torrent');
      await dl.resolve();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('resolve() — usenet HTTP URLs', () => {
    it('returns nzb-url passthrough without any HTTP fetch', async () => {
      const dl = new DownloadUrl('https://indexer.example.com/dl/12345.nzb', 'usenet');
      const artifact = await dl.resolve();

      expect(artifact).toEqual({
        type: 'nzb-url',
        url: 'https://indexer.example.com/dl/12345.nzb',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('resolve() — torrent HTTP URLs (direct response)', () => {
    it('fetches URL and returns torrent-bytes artifact with info hash', async () => {
      const { buffer, expectedHash } = fakeTorrentBuffer();
      mockFetch.mockResolvedValueOnce(mockResponse(buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/x-bittorrent' },
      }));

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      const artifact = await dl.resolve();

      expect(artifact.type).toBe('torrent-bytes');
      const tb = artifact as Extract<DownloadArtifact, { type: 'torrent-bytes' }>;
      expect(tb.infoHash).toBe(expectedHash);
      expect(tb.data).toEqual(buffer);
    });

    it('throws auth proxy error when response is HTML (content-type text/html)', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('<html><body>Login</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }));

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      await expect(dl.resolve()).rejects.toThrow(/auth proxy/i);
    });

    it('throws auth proxy error when response body starts with HTML markers', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('<!DOCTYPE html><html>', {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }));

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      await expect(dl.resolve()).rejects.toThrow(/auth proxy/i);
    });

    it('throws descriptive error for empty response body (0 bytes)', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(Buffer.alloc(0), {
        status: 200,
        headers: { 'Content-Type': 'application/x-bittorrent' },
      }));

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      await expect(dl.resolve()).rejects.toThrow(/empty/i);
    });

    it('throws error with status code for 4xx response, no URL in message', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Not Found', { status: 404 }));

      const dl = new DownloadUrl('https://indexer.example.com/dl/secret-passkey-12345', 'torrent');
      const error = await dl.resolve().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('404');
      expect((error as Error).message).not.toContain('secret-passkey');
    });

    it('throws error with status code for 5xx response, no URL in message', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Server Error', { status: 500 }));

      const dl = new DownloadUrl('https://indexer.example.com/dl/secret-passkey-12345', 'torrent');
      const error = await dl.resolve().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('500');
      expect((error as Error).message).not.toContain('secret-passkey');
    });
  });

  describe('resolve() — torrent HTTP URLs (redirect handling)', () => {
    it('301 redirect to magnet: URI returns magnet-uri artifact with info hash', async () => {
      const magnetUri = buildMagnetUri(KNOWN_HEX_HASH);
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { Location: magnetUri } }),
      );

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      const artifact = await dl.resolve();

      expect(artifact).toEqual({
        type: 'magnet-uri',
        uri: magnetUri,
        infoHash: KNOWN_HEX_HASH,
      });
    });

    it('302 redirect to magnet: URI returns magnet-uri artifact', async () => {
      const magnetUri = buildMagnetUri(KNOWN_HEX_HASH);
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: magnetUri } }),
      );

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      const artifact = await dl.resolve();

      expect(artifact.type).toBe('magnet-uri');
    });

    it('301 redirect to http: URL follows redirect and returns torrent-bytes', async () => {
      const { buffer, expectedHash } = fakeTorrentBuffer();

      // First fetch: redirect
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { Location: 'https://cdn.example.com/file.torrent' } }),
      );
      // Second fetch: actual file
      mockFetch.mockResolvedValueOnce(mockResponse(buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/x-bittorrent' },
      }));

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      const artifact = await dl.resolve();

      expect(artifact.type).toBe('torrent-bytes');
      expect((artifact as Extract<DownloadArtifact, { type: 'torrent-bytes' }>).infoHash).toBe(expectedHash);
    });

    it('follows redirect chain (HTTP → HTTP → file) and returns bytes', async () => {
      const { buffer, expectedHash } = fakeTorrentBuffer();

      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://hop1.example.com' } }),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://hop2.example.com' } }),
      );
      mockFetch.mockResolvedValueOnce(mockResponse(buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/x-bittorrent' },
      }));

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      const artifact = await dl.resolve();

      expect(artifact.type).toBe('torrent-bytes');
      expect((artifact as Extract<DownloadArtifact, { type: 'torrent-bytes' }>).infoHash).toBe(expectedHash);
    });

    it('throws descriptive error for redirect to unknown scheme (ftp:)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { Location: 'ftp://files.example.com/t.torrent' } }),
      );

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      await expect(dl.resolve()).rejects.toThrow(/unsupported.*scheme/i);
    });

    it('throws descriptive error for 3xx with no Location header', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 301 }),
      );

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      await expect(dl.resolve()).rejects.toThrow(/no location/i);
    });

    it('detects redirect loop (A → B → A) and throws', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { Location: 'https://hop.example.com' } }),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { Location: 'https://indexer.example.com/dl/12345' } }),
      );

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      await expect(dl.resolve()).rejects.toThrow(/redirect loop/i);
    });

    it('follows relative Location header by resolving against current URL', async () => {
      const { buffer, expectedHash } = fakeTorrentBuffer();

      // First fetch: redirect with relative Location
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { Location: '/file.torrent' } }),
      );
      // Second fetch: actual file at resolved absolute URL
      mockFetch.mockResolvedValueOnce(mockResponse(buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/x-bittorrent' },
      }));

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      const artifact = await dl.resolve();

      expect(artifact.type).toBe('torrent-bytes');
      expect((artifact as Extract<DownloadArtifact, { type: 'torrent-bytes' }>).infoHash).toBe(expectedHash);
      // Verify the second fetch used the resolved absolute URL
      expect(mockFetch).toHaveBeenCalledWith('https://indexer.example.com/file.torrent', expect.any(Object));
    });

    it('throws after max redirect depth (>5 hops)', async () => {
      // Create a chain of unique URLs exceeding 5 redirects
      for (let i = 0; i < 6; i++) {
        mockFetch.mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { Location: `https://hop${i}.example.com` } }),
        );
      }

      const dl = new DownloadUrl('https://indexer.example.com/dl/12345', 'torrent');
      await expect(dl.resolve()).rejects.toThrow(/too many redirects/i);
    });
  });

  describe('resolve() — error security', () => {
    it('network timeout error does not contain the raw URL', async () => {
      const secretUrl = 'https://indexer.example.com/dl/secret-passkey-12345';
      mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted', 'TimeoutError'));

      const dl = new DownloadUrl(secretUrl, 'torrent');
      const error = await dl.resolve().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('secret-passkey');
    });

    it('DNS resolution failure does not contain the raw URL', async () => {
      const secretUrl = 'https://indexer.example.com/dl/secret-passkey-12345';
      const err = new Error('getaddrinfo ENOTFOUND indexer.example.com');
      (err as NodeJS.ErrnoException).code = 'ENOTFOUND';
      mockFetch.mockRejectedValueOnce(err);

      const dl = new DownloadUrl(secretUrl, 'torrent');
      const error = await dl.resolve().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('secret-passkey');
    });

    it('connection refused error does not contain the raw URL', async () => {
      const secretUrl = 'https://indexer.example.com/dl/secret-passkey-12345';
      const err = new Error('connect ECONNREFUSED');
      (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      mockFetch.mockRejectedValueOnce(err);

      const dl = new DownloadUrl(secretUrl, 'torrent');
      const error = await dl.resolve().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('secret-passkey');
    });

    it('unwraps undici TypeError("fetch failed") with ENOTFOUND on cause', async () => {
      const secretUrl = 'https://indexer.example.com/dl/secret-passkey-12345';
      const cause = new Error('getaddrinfo ENOTFOUND indexer.example.com') as NodeJS.ErrnoException;
      cause.code = 'ENOTFOUND';
      const err = new TypeError('fetch failed', { cause });
      mockFetch.mockRejectedValueOnce(err);

      const dl = new DownloadUrl(secretUrl, 'torrent');
      const error = await dl.resolve().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Download failed: could not resolve hostname');
      expect((error as Error).message).not.toContain('secret-passkey');
    });

    it('unwraps undici TypeError("fetch failed") with ECONNREFUSED on cause', async () => {
      const secretUrl = 'https://indexer.example.com/dl/secret-passkey-12345';
      const cause = new Error('connect ECONNREFUSED') as NodeJS.ErrnoException;
      cause.code = 'ECONNREFUSED';
      const err = new TypeError('fetch failed', { cause });
      mockFetch.mockRejectedValueOnce(err);

      const dl = new DownloadUrl(secretUrl, 'torrent');
      const error = await dl.resolve().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Download failed: connection refused');
    });

    // #541 — sanitizeNetworkError URL redaction for non-undici errors
    it('redacts URL with passkey/token from unknown error message', async () => {
      const secretUrl = 'https://indexer.example.com/dl/secret-passkey-12345';
      const err = new Error('connect ECONNREFUSED https://indexer.example.com/api?apikey=SECRET123');
      mockFetch.mockRejectedValueOnce(err);

      const dl = new DownloadUrl(secretUrl, 'torrent');
      const error = await dl.resolve().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('https://');
      expect((error as Error).message).not.toContain('SECRET123');
      expect((error as Error).message).toMatch(/^Download failed:/);
    });

    it('redacts URL without credentials from unknown error message', async () => {
      const secretUrl = 'https://indexer.example.com/dl/secret-passkey-12345';
      const err = new Error('Failed to fetch https://example.com/file.nzb');
      mockFetch.mockRejectedValueOnce(err);

      const dl = new DownloadUrl(secretUrl, 'torrent');
      const error = await dl.resolve().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('https://');
      expect((error as Error).message).toMatch(/^Download failed:/);
    });

    it('passes through error message with no URL unchanged', async () => {
      const secretUrl = 'https://indexer.example.com/dl/secret-passkey-12345';
      const err = new Error('socket hang up');
      mockFetch.mockRejectedValueOnce(err);

      const dl = new DownloadUrl(secretUrl, 'torrent');
      const error = await dl.resolve().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Download failed: socket hang up');
    });

    it('redacts bare URL string as error message', async () => {
      const secretUrl = 'https://indexer.example.com/dl/secret-passkey-12345';
      const err = new Error('https://indexer.example.com/dl/secret-passkey-12345');
      mockFetch.mockRejectedValueOnce(err);

      const dl = new DownloadUrl(secretUrl, 'torrent');
      const error = await dl.resolve().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('https://');
      expect((error as Error).message).toMatch(/^Download failed:/);
    });
  });
});

describe('extractInfoHashFromTorrent', () => {
  it('extracts correct SHA-1 info hash from valid .torrent buffer', () => {
    const { buffer, expectedHash } = fakeTorrentBuffer();
    expect(extractInfoHashFromTorrent(buffer)).toBe(expectedHash);
  });

  it('returns null for truncated .torrent file', () => {
    const { buffer } = fakeTorrentBuffer();
    const truncated = buffer.subarray(0, 10);
    expect(extractInfoHashFromTorrent(truncated)).toBeNull();
  });

  it('skips false 4:info markers in string payloads', () => {
    // Build a torrent where a string contains "4:info" bytes before the real info dict
    const inner = Buffer.from('d6:lengthi1024e4:name8:test.mp3e');
    const expectedHash = createHash('sha1').update(inner).digest('hex');
    // "7:x4:info" is a string payload of 7 bytes that contains "4:info" — should be skipped
    const torrent = Buffer.from(`d8:announce5:x.com7:y4:info4:5:dummy4:info${inner.toString()}e`);
    const result = extractInfoHashFromTorrent(torrent);
    // Should still find the real info dict
    expect(result).toBe(expectedHash);
  });

  it('returns null for empty buffer', () => {
    expect(extractInfoHashFromTorrent(Buffer.alloc(0))).toBeNull();
  });
});

describe('resolve() — nzb-bytes data URI', () => {
  const nzbContent = '<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file></file></nzb>';
  const nzbBase64 = Buffer.from(nzbContent).toString('base64');
  const nzbDataUri = `data:application/x-nzb;base64,${nzbBase64}`;

  it('resolves data:application/x-nzb;base64 URI to nzb-bytes artifact with correct decoded content', async () => {
    const dl = new DownloadUrl(nzbDataUri, 'usenet');
    const artifact = await dl.resolve();

    expect(artifact.type).toBe('nzb-bytes');
    const nb = artifact as Extract<DownloadArtifact, { type: 'nzb-bytes' }>;
    expect(nb.data.toString('utf-8')).toBe(nzbContent);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('usenet HTTP URLs still produce nzb-url (passthrough unchanged)', async () => {
    const dl = new DownloadUrl('https://indexer.example.com/dl/12345.nzb', 'usenet');
    const artifact = await dl.resolve();

    expect(artifact).toEqual({ type: 'nzb-url', url: 'https://indexer.example.com/dl/12345.nzb' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('data:application/x-bittorrent;base64 still produces torrent-bytes (no regression)', async () => {
    const { buffer, expectedHash } = fakeTorrentBuffer();
    const dl = new DownloadUrl(fakeDataUri(buffer), 'torrent');
    const artifact = await dl.resolve();

    expect(artifact.type).toBe('torrent-bytes');
    const tb = artifact as Extract<DownloadArtifact, { type: 'torrent-bytes' }>;
    expect(tb.infoHash).toBe(expectedHash);
  });
});

describe('base32ToHex', () => {
  it('converts base32-encoded hash to hex', () => {
    // "JBSWY3DPEHPK3PXP" → "48656c6c6f21deadbeef" (Hello!...)
    // AAAA = 20 bits = 5 hex digits: 00000
    const result = base32ToHex('AAAA');
    expect(result).toBe('00000');
  });

  it('handles uppercase and lowercase base32 input', () => {
    const upper = base32ToHex('JBSWY3DP');
    const lower = base32ToHex('jbswy3dp');
    expect(upper).toBe(lower);
  });
});
