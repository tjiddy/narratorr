import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type * as NetworkServiceModule from '../utils/network-service.js';
import { BlackholeClient } from './blackhole.js';
import type { DownloadArtifact } from './types.js';
import { DownloadClientError, DownloadClientTimeoutError } from './errors.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  constants: { R_OK: 4, W_OK: 2 },
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

const dispatcherCloseSpy = vi.fn().mockResolvedValue(undefined);
const createDispatcherSpy = vi.fn((_hostnameAllowlist?: Set<string>) => ({ close: dispatcherCloseSpy }));

// Route redirect hops through the stubbed global fetch; production undici routing is
// covered in network-service.test. Stub the dispatcher to observe allowlisting and close.
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

const { writeFile, rename, access } = await import('node:fs/promises');
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const { lookup: dnsLookup } = await import('node:dns/promises');
const mockedDnsLookup = vi.mocked(dnsLookup) as unknown as Mock;

const mockFetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();

function nzbResponse(body: Uint8Array | string, init?: ResponseInit): Response {
  return new Response(body as BodyInit, init);
}

const toPosix = (p: unknown) => String(p).split('\\').join('/');
const TEMP_NAME_RE = /\/\.narratorr-[0-9a-f-]{36}\.part$/;

/**
 * The artifact is only consumable after the rename, so both halves are the contract: the bytes go
 * to a random temp name, and only a completed write reaches the final one.
 */
function expectArtifactWritten(finalName: RegExp, data: unknown): void {
  const lastWrite = vi.mocked(writeFile).mock.calls.at(-1)!;
  expect(toPosix(lastWrite[0])).toMatch(TEMP_NAME_RE);
  expect(lastWrite[1]).toEqual(data);

  const lastRename = vi.mocked(rename).mock.calls.at(-1)!;
  expect(lastRename[0]).toBe(lastWrite[0]);
  expect(toPosix(lastRename[1])).toMatch(finalName);
}

describe('BlackholeClient', () => {
  let client: BlackholeClient;

  beforeEach(() => {
    vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(rename).mockReset().mockResolvedValue(undefined);
    vi.mocked(access).mockClear();
    mockFetch.mockClear();
    dispatcherCloseSpy.mockClear();
    createDispatcherSpy.mockClear();
    ssrfRedirectWalker.mockClear();
    mockedDnsLookup.mockReset();
    // Default hosts to public IPs so SSRF validation reaches each test's fetch stub.
    mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    vi.stubGlobal('fetch', mockFetch);
    client = new BlackholeClient({ watchDir: '/downloads/watch', protocol: 'torrent' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Prevent the User-Agent env stub leaking across tests.
    vi.unstubAllEnvs();
  });

  describe('addDownload', () => {
    it('writes torrent-bytes artifact as .torrent file', async () => {
      const artifact: DownloadArtifact = {
        type: 'torrent-bytes',
        data: Buffer.from([0x64, 0x38]),
        infoHash: 'abc123',
      };

      await client.addDownload(artifact);
      expectArtifactWritten(/download-\d+\.torrent$/, artifact.data);
    });

    it('writes magnet-uri artifact as .magnet file', async () => {
      const magnetUri = 'magnet:?xt=urn:btih:abc123&dn=test';
      const artifact: DownloadArtifact = {
        type: 'magnet-uri',
        uri: magnetUri,
        infoHash: 'abc123',
      };

      await client.addDownload(artifact);
      expectArtifactWritten(/\d+\.magnet$/, magnetUri);
    });

    it('fetches nzb-url artifact and writes .nzb file', async () => {
      const nzbContent = new Uint8Array([0x3c, 0x6e, 0x7a, 0x62]);
      mockFetch.mockResolvedValueOnce(nzbResponse(nzbContent, { status: 200 }));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/api/download/123',
      };

      await client.addDownload(artifact);
      expectArtifactWritten(/download-\d+\.nzb$/, expect.any(Buffer));
    });

    it('sends User-Agent: Narratorr/<version> on the nzb-url self-download (#1315)', async () => {
      // Pin the tag so ambient release/CI state cannot change the assertion.
      vi.stubEnv('GIT_TAG', 'v9.9.9');
      const nzbContent = new Uint8Array([0x3c, 0x6e, 0x7a, 0x62]);
      mockFetch.mockResolvedValueOnce(nzbResponse(nzbContent, { status: 200 }));

      await client.addDownload({ type: 'nzb-url', url: 'https://example.com/api/download/123' });

      expect(ssrfRedirectWalker).toHaveBeenCalledWith(
        'https://example.com/api/download/123',
        expect.objectContaining({ headers: { 'User-Agent': 'Narratorr/v9.9.9' } }),
      );
    });

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
      expectArtifactWritten(/download-\d+\.nzb$/, Buffer.from(nzbContent));
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
      expectArtifactWritten(/download-\d+\.nzb$/, Buffer.from(nzbContent));
    });

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
      expectArtifactWritten(/download-\d+\.nzb$/, Buffer.from(nzbContent));
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

    it('maps a per-hop timeout (DOMException TimeoutError) to DownloadClientTimeoutError', async () => {
      mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted', 'TimeoutError'));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      const error = await client.addDownload(artifact).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientTimeoutError);
      // Timeout classification must happen before generic redaction/wrapping.
      expect((error as DownloadClientTimeoutError).message).toContain('Request timed out');
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

    it('redacts a credentialed URL from an unmapped nzb-url error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED https://indexer.example.com/api?apikey=SECRET123'));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://indexer.example.com/dl/secret',
      };

      const error = await client.addDownload(artifact).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      const message = (error as DownloadClientError).message;
      expect(message).not.toContain('https://');
      expect(message).not.toContain('SECRET123');
      expect(message).toContain('[redacted-url]');
    });

    it('redacts a bare URL from an unmapped nzb-url error message', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Failed to fetch https://example.com/file.nzb'));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      const error = await client.addDownload(artifact).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).not.toContain('https://');
    });

    it('passes a no-URL nzb-url error message through unchanged', async () => {
      mockFetch.mockRejectedValueOnce(new Error('socket hang up'));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      const error = await client.addDownload(artifact).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toContain('socket hang up');
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

      expectArtifactWritten(/download-\d+\.nzb$/, nzbData);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('file contents match the original buffer exactly', async () => {
      const binaryData = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x80, 0x7F]);
      await usenetClient.addDownload({ type: 'nzb-bytes', data: binaryData });

      expectArtifactWritten(/download-\d+\.nzb$/, binaryData);
    });

    it('rejects zero-length nzb-bytes with DownloadClientError before any filesystem write', async () => {
      const emptyBuffer = Buffer.alloc(0);
      await expect(
        usenetClient.addDownload({ type: 'nzb-bytes', data: emptyBuffer }),
      ).rejects.toThrow(DownloadClientError);
      expect(writeFile).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
    });

    it('existing nzb-url path unchanged (still fetches URL and writes)', async () => {
      mockFetch.mockResolvedValueOnce(nzbResponse(Buffer.from('<nzb/>'), { status: 200 }));

      await usenetClient.addDownload({ type: 'nzb-url', url: 'https://indexer.test/nzb' });

      expectArtifactWritten(/download-\d+\.nzb$/, expect.any(Buffer));
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

  // #2310 AC11: a watching client must only ever see a completed artifact. These run against a real
  // watch directory because the property is what the DIRECTORY contains, which a mock cannot show.
  describe('artifact visibility on a real watch directory', () => {
    let watchDir: string;
    let realClient: BlackholeClient;

    const finalNames = async () =>
      (await actualFs.readdir(watchDir)).filter((n) => !n.endsWith('.part'));
    const tempNames = async () =>
      (await actualFs.readdir(watchDir)).filter((n) => n.endsWith('.part'));

    beforeEach(async () => {
      vi.mocked(writeFile).mockImplementation(actualFs.writeFile as never);
      vi.mocked(rename).mockImplementation(actualFs.rename as never);
      watchDir = await actualFs.mkdtemp(join(tmpdir(), 'blackhole-'));
      realClient = new BlackholeClient({ watchDir, protocol: 'torrent' });
    });

    afterEach(async () => {
      try {
        await actualFs.rm(watchDir, { recursive: true, force: true });
      } catch { /* a leaked tmpdir is cheaper than a red suite on Windows */ }
    });

    it.each([
      ['torrent-bytes', { type: 'torrent-bytes', data: Buffer.from('d8:announce'), infoHash: 'a' }, /^download-\d+\.torrent$/, Buffer.from('d8:announce')],
      ['magnet-uri', { type: 'magnet-uri', uri: 'magnet:?xt=urn:btih:abc', infoHash: 'a' }, /^\d+\.magnet$/, Buffer.from('magnet:?xt=urn:btih:abc')],
      ['nzb-bytes', { type: 'nzb-bytes', data: Buffer.from('<nzb/>') }, /^download-\d+\.nzb$/, Buffer.from('<nzb/>')],
    ] as const)('lands %s under its final name with the exact bytes and no temp survivor', async (_label, artifact, namePattern, expected) => {
      await realClient.addDownload(artifact as DownloadArtifact);

      const names = await finalNames();
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(namePattern);
      expect(await actualFs.readFile(join(watchDir, names[0]!))).toEqual(expected);
      expect(await tempNames()).toEqual([]);
    });

    it('lands a fetched nzb-url under its final name', async () => {
      mockFetch.mockResolvedValueOnce(nzbResponse(Buffer.from('<nzb>fetched</nzb>'), { status: 200 }));

      await realClient.addDownload({ type: 'nzb-url', url: 'https://example.com/file.nzb' });

      const names = await finalNames();
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/^download-\d+\.nzb$/);
      expect(await actualFs.readFile(join(watchDir, names[0]!))).toEqual(Buffer.from('<nzb>fetched</nzb>'));
    });

    it('leaves nothing under a final name while the write is still in flight', async () => {
      let releaseWrite!: () => void;
      vi.mocked(writeFile).mockImplementationOnce((async (path: string, data: Parameters<typeof actualFs.writeFile>[1]) => {
        await actualFs.writeFile(path, data);
        await new Promise<void>((resolve) => { releaseWrite = resolve; });
      }) as never);

      const pending = realClient.addDownload({ type: 'torrent-bytes', data: Buffer.from('d8'), infoHash: 'a' });
      await vi.waitFor(async () => { expect(await tempNames()).toHaveLength(1); });

      expect(await finalNames()).toEqual([]);

      releaseWrite();
      await pending;
      expect(await finalNames()).toHaveLength(1);
    });

    it('leaves nothing under a final name when the rename fails', async () => {
      vi.mocked(rename).mockRejectedValueOnce(new Error('EXDEV: cross-device link'));

      await expect(realClient.addDownload({ type: 'torrent-bytes', data: Buffer.from('d8'), infoHash: 'a' }))
        .rejects.toThrow('EXDEV');

      expect(await finalNames()).toEqual([]);
    });

    it('creates no temp file at all when the empty-NZB guard rejects', async () => {
      const usenet = new BlackholeClient({ watchDir, protocol: 'usenet' });

      await expect(usenet.addDownload({ type: 'nzb-bytes', data: Buffer.alloc(0) }))
        .rejects.toThrow(DownloadClientError);

      expect(await actualFs.readdir(watchDir)).toEqual([]);
    });

    // F7: final names are millisecond-stamped, so a deterministic `<final>.tmp` would let two
    // same-millisecond handoffs clobber each other's staging file.
    it('gives concurrent same-millisecond handoffs distinct temp files', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      const first = Buffer.from('first payload');
      const second = Buffer.from('second payload');

      await Promise.all([
        realClient.addDownload({ type: 'torrent-bytes', data: first, infoHash: 'a' }),
        realClient.addDownload({ type: 'torrent-bytes', data: second, infoHash: 'b' }),
      ]);

      const tempPaths = vi.mocked(writeFile).mock.calls.map((c) => String(c[0]));
      expect(tempPaths).toHaveLength(2);
      expect(new Set(tempPaths).size).toBe(2);

      // Both raced for one timestamped final name; whichever landed must be whole, never a mix.
      const names = await finalNames();
      expect(names).toEqual(['download-1700000000000.torrent']);
      const landed = await actualFs.readFile(join(watchDir, names[0]!));
      expect([first.toString(), second.toString()]).toContain(landed.toString());
      expect(await tempNames()).toEqual([]);
    });
  });
});
