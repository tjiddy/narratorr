import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type * as NetworkServiceModule from '../utils/network-service.js';
import { BlackholeClient } from './blackhole.js';
import type { DownloadArtifact } from './types.js';
import { DownloadClientError, DownloadClientTimeoutError } from './errors.js';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  constants: { R_OK: 4, W_OK: 2 },
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

const dispatcherCloseSpy = vi.fn().mockResolvedValue(undefined);
const createDispatcherSpy = vi.fn((_hostnameAllowlist?: Set<string>) => ({ close: dispatcherCloseSpy }));

// Override `fetchWithSsrfRedirect` with a `globalThis.fetch`-based walker so the
// `vi.stubGlobal('fetch', mockFetch)` below intercepts download hops. Production
// routes through undici's fetch when a dispatcher is attached (which bypasses
// MSW); the helper's redirect routing is asserted in network-service.test.ts.
// `createSsrfSafeDispatcher` is stubbed so we can spy on dispatcher.close() and on
// the hostname allowlist it receives without standing up a real undici Agent.
const ssrfRedirectWalker = vi.fn(async (startUrl: string, opts: NetworkServiceModule.FetchWithSsrfRedirectOptions = {}) => {
  const actual = await import('../utils/network-service.js');
  const MAX = 5;
  const visited = new Set<string>();
  let cur = startUrl;
  const maxHops = opts.maxHops ?? MAX;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (visited.has(cur)) throw new Error('Redirect loop detected');
    visited.add(cur);
    const parsed = new URL(cur);
    await actual.resolveAndValidate(parsed.hostname, {
      ...(opts.lanAllowlist && { lanAllowlist: opts.lanAllowlist }),
      normalizedHostPort: actual.normalizedHostPortFromUrl(parsed),
    });
    const response = await globalThis.fetch(cur, {
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      dispatcher: opts.dispatcher,
    } as RequestInit);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) {
      await response.body?.cancel().catch(() => { /* best-effort */ });
      throw new Error('Redirect with no Location header');
    }
    const nextHref = new URL(location, cur).href;
    await response.body?.cancel().catch(() => { /* best-effort */ });
    cur = nextHref;
  }
  throw new Error('Too many redirects');
});

vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithSsrfRedirect: ((url: string, opts?: NetworkServiceModule.FetchWithSsrfRedirectOptions) =>
      ssrfRedirectWalker(url, opts)) as unknown as typeof actual.fetchWithSsrfRedirect,
    createSsrfSafeDispatcher: ((hostname?: Set<string>) =>
      createDispatcherSpy(hostname)) as unknown as typeof actual.createSsrfSafeDispatcher,
  };
});

const { writeFile, access } = await import('node:fs/promises');
const { lookup: dnsLookup } = await import('node:dns/promises');
const mockedDnsLookup = vi.mocked(dnsLookup) as unknown as Mock;

const mockFetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();

function nzbResponse(body: Uint8Array | string, init?: ResponseInit): Response {
  return new Response(body as BodyInit, init);
}

describe('BlackholeClient', () => {
  let client: BlackholeClient;

  beforeEach(() => {
    vi.mocked(writeFile).mockClear();
    vi.mocked(access).mockClear();
    mockFetch.mockClear();
    dispatcherCloseSpy.mockClear();
    createDispatcherSpy.mockClear();
    ssrfRedirectWalker.mockClear();
    mockedDnsLookup.mockReset();
    // Default every host to a public IP so the SSRF pre-flight gate is open.
    mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    vi.stubGlobal('fetch', mockFetch);
    client = new BlackholeClient({ watchDir: '/downloads/watch', protocol: 'torrent' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('addDownload', () => {
    it('writes torrent-bytes artifact as .torrent file', async () => {
      const artifact: DownloadArtifact = {
        type: 'torrent-bytes',
        data: Buffer.from([0x64, 0x38]),
        infoHash: 'abc123',
      };

      await client.addDownload(artifact);
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/download-\d+\.torrent$/),
        artifact.data,
      );
    });

    it('writes magnet-uri artifact as .magnet file', async () => {
      const magnetUri = 'magnet:?xt=urn:btih:abc123&dn=test';
      const artifact: DownloadArtifact = {
        type: 'magnet-uri',
        uri: magnetUri,
        infoHash: 'abc123',
      };

      await client.addDownload(artifact);
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/\d+\.magnet$/),
        magnetUri,
      );
    });

    it('fetches nzb-url artifact and writes .nzb file', async () => {
      const nzbContent = new Uint8Array([0x3c, 0x6e, 0x7a, 0x62]);
      mockFetch.mockResolvedValueOnce(nzbResponse(nzbContent, { status: 200 }));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/api/download/123',
      };

      await client.addDownload(artifact);
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/download-\d+\.nzb$/),
        expect.any(Buffer),
      );
    });

    // #1243 — follow indexer download redirects (302 getnzb links).
    it('follows a 302 redirect to the real .nzb and writes the followed-redirect bytes', async () => {
      const nzbContent = new Uint8Array([0x3c, 0x6e, 0x7a, 0x62, 0x3e]); // <nzb>
      mockFetch
        .mockResolvedValueOnce(new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.drunkenslug.com/getnzb/abc.nzb' },
        }))
        .mockResolvedValueOnce(nzbResponse(nzbContent, { status: 200 }));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://drunkenslug.com/getnzb/abc.nzb',
      };

      await client.addDownload(artifact);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/download-\d+\.nzb$/),
        Buffer.from(nzbContent),
      );
    });

    it('writes the exact bytes from a non-redirecting (direct 200) NZB URL', async () => {
      const nzbContent = new Uint8Array([0x00, 0x01, 0xff, 0xfe]);
      mockFetch.mockResolvedValueOnce(nzbResponse(nzbContent, { status: 200 }));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      await client.addDownload(artifact);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/download-\d+\.nzb$/),
        Buffer.from(nzbContent),
      );
    });

    // #1243 (F2) — LAN allowlist threaded through dispatcher + fetch options so a
    // private/loopback configured-indexer NZB URL still resolves.
    it('threads the LAN allowlist into the dispatcher and fetch for a private-host NZB URL', async () => {
      mockedDnsLookup.mockReset();
      mockedDnsLookup.mockResolvedValue([{ address: '192.168.0.22', family: 4 }]);
      const nzbContent = new Uint8Array([0x3c, 0x6e, 0x7a, 0x62]);
      mockFetch.mockResolvedValueOnce(nzbResponse(nzbContent, { status: 200 }));

      const hostname = new Set(['192.168.0.22']);
      const hostPort = new Set(['192.168.0.22:9696']);
      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'http://192.168.0.22:9696/getnzb/abc.nzb',
        lanAllowlist: { hostPort, hostname },
      };

      await client.addDownload(artifact);

      expect(createDispatcherSpy).toHaveBeenCalledWith(hostname);
      expect(ssrfRedirectWalker).toHaveBeenCalledWith(
        'http://192.168.0.22:9696/getnzb/abc.nzb',
        expect.objectContaining({ lanAllowlist: hostPort }),
      );
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/download-\d+\.nzb$/),
        Buffer.from(nzbContent),
      );
    });

    it('refuses a private-host NZB URL with no allowlist (SSRF default → DownloadClientError)', async () => {
      mockedDnsLookup.mockReset();
      mockedDnsLookup.mockResolvedValue([{ address: '192.168.0.22', family: 4 }]);

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'http://192.168.0.22:9696/getnzb/abc.nzb',
      };

      await expect(client.addDownload(artifact)).rejects.toBeInstanceOf(DownloadClientError);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(dispatcherCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null externalId for torrent-bytes', async () => {
      const artifact: DownloadArtifact = {
        type: 'torrent-bytes',
        data: Buffer.from([0x64]),
        infoHash: 'abc123',
      };

      const result = await client.addDownload(artifact);
      expect(result).toBeNull();
    });

    it('returns null externalId for magnet-uri', async () => {
      const artifact: DownloadArtifact = {
        type: 'magnet-uri',
        uri: 'magnet:?xt=urn:btih:abc123',
        infoHash: 'abc123',
      };

      const result = await client.addDownload(artifact);
      expect(result).toBeNull();
    });

    it('returns null externalId for nzb-url', async () => {
      mockFetch.mockResolvedValueOnce(nzbResponse(new Uint8Array([0x3c]), { status: 200 }));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      const result = await client.addDownload(artifact);
      expect(result).toBeNull();
    });

    it('throws DownloadClientError on nzb-url non-OK final status and drains the body + closes dispatcher', async () => {
      const resp = new Response('Not Found', { status: 404 });
      const cancelSpy = vi.spyOn(resp.body!, 'cancel');
      mockFetch.mockResolvedValueOnce(resp);

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      const error = await client.addDownload(artifact).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toContain('HTTP 404');
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(dispatcherCloseSpy).toHaveBeenCalledTimes(1);
    });

    // #1243 (F1) — raw AbortSignal.timeout DOMException maps to DownloadClientTimeoutError.
    it('maps a per-hop timeout (DOMException TimeoutError) to DownloadClientTimeoutError', async () => {
      mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted', 'TimeoutError'));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      await expect(client.addDownload(artifact)).rejects.toBeInstanceOf(DownloadClientTimeoutError);
      expect(dispatcherCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('throws DownloadClientError on nzb-url network error', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      await expect(client.addDownload(artifact)).rejects.toBeInstanceOf(DownloadClientError);
    });

    it('closes the dispatcher on a successful nzb-url download', async () => {
      mockFetch.mockResolvedValueOnce(nzbResponse(new Uint8Array([0x3c]), { status: 200 }));

      await client.addDownload({ type: 'nzb-url', url: 'https://example.com/file.nzb' });
      expect(dispatcherCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('closes the dispatcher when the fetch rejects', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      await client.addDownload({ type: 'nzb-url', url: 'https://example.com/file.nzb' }).catch(() => { /* expected */ });
      expect(dispatcherCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('throws when writeFile fails', async () => {
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

      const artifact: DownloadArtifact = {
        type: 'torrent-bytes',
        data: Buffer.from([0x64]),
        infoHash: 'abc123',
      };

      await expect(client.addDownload(artifact)).rejects.toThrow('ENOSPC');
    });
  });

  describe('getDownload', () => {
    it('returns null (no progress monitoring)', async () => {
      const result = await client.getDownload('any-id');
      expect(result).toBeNull();
    });
  });

  describe('getAllDownloads', () => {
    it('returns empty array', async () => {
      const result = await client.getAllDownloads();
      expect(result).toEqual([]);
    });
  });

  describe('removeDownload', () => {
    it('is a no-op', async () => {
      await expect(client.removeDownload('any-id', true)).resolves.toBeUndefined();
    });
  });

  describe('supportsCategories', () => {
    it('is false', () => {
      expect(client.supportsCategories).toBe(false);
    });
  });

  describe('test', () => {
    it('succeeds when watchDir exists and is writable', async () => {
      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain('watch');
    });

    it('fails when watchDir does not exist', async () => {
      const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(access).mockRejectedValueOnce(err);

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('does not exist');
    });

    it('fails when watchDir is not writable', async () => {
      const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      vi.mocked(access).mockRejectedValueOnce(err);

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('not writable');
    });

    // #197 — NodeJS.ErrnoException.code checks (ERR-1)
    it('detects ENOENT via error.code property (not message string matching)', async () => {
      const err = new Error('some unrelated message') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(access).mockRejectedValueOnce(err);

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('does not exist');
    });

    it('detects EACCES via error.code property (not message string matching)', async () => {
      const err = new Error('some unrelated message') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      vi.mocked(access).mockRejectedValueOnce(err);

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('not writable');
    });

    it('returns generic error message for other fs errors', async () => {
      const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      vi.mocked(access).mockRejectedValueOnce(err);

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toBe('EPERM: operation not permitted');
    });
  });

  describe('addDownload — nzb-bytes', () => {
    let usenetClient: BlackholeClient;

    beforeEach(() => {
      usenetClient = new BlackholeClient({ watchDir: '/downloads/watch', protocol: 'usenet' });
    });

    it('writes nzb-bytes data directly to watch dir as .nzb file (no HTTP fetch)', async () => {
      const nzbData = Buffer.from('<nzb><file subject="test"/></nzb>');
      await usenetClient.addDownload({ type: 'nzb-bytes', data: nzbData });

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/download-\d+\.nzb$/),
        nzbData,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('file contents match the original buffer exactly', async () => {
      const binaryData = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x80, 0x7F]);
      await usenetClient.addDownload({ type: 'nzb-bytes', data: binaryData });

      expect(writeFile).toHaveBeenCalledWith(
        expect.any(String),
        binaryData,
      );
    });

    it('rejects zero-length nzb-bytes with DownloadClientError before any filesystem write', async () => {
      const emptyBuffer = Buffer.alloc(0);
      await expect(
        usenetClient.addDownload({ type: 'nzb-bytes', data: emptyBuffer }),
      ).rejects.toThrow(DownloadClientError);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('existing nzb-url path unchanged (still fetches URL and writes)', async () => {
      mockFetch.mockResolvedValueOnce(nzbResponse(Buffer.from('<nzb/>'), { status: 200 }));

      await usenetClient.addDownload({ type: 'nzb-url', url: 'https://indexer.test/nzb' });

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/download-\d+\.nzb$/),
        expect.any(Buffer),
      );
    });
  });

  describe('timeout constant', () => {
    it('uses HTTP_DOWNLOAD_TIMEOUT_MS (30s) for nzb-url fetch timeout', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      mockFetch.mockResolvedValueOnce(nzbResponse(new Uint8Array([0x3c]), { status: 200 }));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      await client.addDownload(artifact);
      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      timeoutSpy.mockRestore();
    });
  });

  describe('protocol', () => {
    it('reflects configured protocol', () => {
      expect(client.protocol).toBe('torrent');

      const usenetClient = new BlackholeClient({ watchDir: '/watch', protocol: 'usenet' });
      expect(usenetClient.protocol).toBe('usenet');
    });
  });
});
