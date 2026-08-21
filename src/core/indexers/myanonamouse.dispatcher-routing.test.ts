/** Non-forwarding mock verifies both MAM proxy call sites pass their dispatcher. */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type * as NetworkServiceModule from '../utils/network-service.js';
import { captureDispatcher } from '../__tests__/dispatcher-capture.js';

vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return { ...actual, fetchWithOptionalDispatcher: vi.fn() };
});

import { MyAnonamouseIndexer } from './myanonamouse.js';
import { ProxyError } from './errors.js';
import { fetchWithOptionalDispatcher } from '../utils/network-service.js';

const mockHelper = vi.mocked(fetchWithOptionalDispatcher) as unknown as Mock;

const MAM_BASE = 'https://mam.test';
const PROXY_URL = 'http://proxy.example.com:8080';

function makeProxiedIndexer(): MyAnonamouseIndexer {
  return new MyAnonamouseIndexer({
    mamId: 'test-mam-id',
    baseUrl: MAM_BASE,
    proxyUrl: PROXY_URL,
    searchLanguages: [1],
    searchType: 'active',
  });
}

function makeDirectIndexer(): MyAnonamouseIndexer {
  return new MyAnonamouseIndexer({
    mamId: 'test-mam-id',
    baseUrl: MAM_BASE,
    searchLanguages: [1],
    searchType: 'active',
  });
}

describe('MAM dispatcher-routing regression — fetchWithCookie (F2)', () => {
  beforeEach(() => {
    mockHelper.mockReset();
  });

  it('passes the dispatcher into fetchWithOptionalDispatcher when proxyUrl is set', async () => {
    mockHelper.mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await makeProxiedIndexer().search('test');

    expect(mockHelper).toHaveBeenCalled();
    const url = mockHelper.mock.calls[0]![0] as string;
    expect(url).toContain('loadSearchJSONbasic.php');
    const init = mockHelper.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeDefined();
  });

  it('does NOT pass a dispatcher when no proxyUrl is configured', async () => {
    mockHelper.mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await makeDirectIndexer().search('test');

    expect(mockHelper).toHaveBeenCalled();
    const init = mockHelper.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeUndefined();
  });
});

describe('MAM dispatcher-routing regression — fetchTorrentAsDataUri (F3)', () => {
  beforeEach(() => {
    mockHelper.mockReset();
  });

  it('passes the dispatcher into fetchWithOptionalDispatcher on the torrent download', async () => {
    // Exercise grab-time fetch without wedge behavior.
    mockHelper.mockResolvedValueOnce(
      new Response(Buffer.from('fake-torrent'), {
        status: 200,
        headers: { 'Content-Type': 'application/x-bittorrent' },
      }),
    );

    await makeProxiedIndexer().resolveDownloadUrl({
      guid: '12345',
      downloadUrl: 'mam-torrent://12345',
      protocol: 'torrent',
      isFreeleech: true,
    });

    expect(mockHelper).toHaveBeenCalledTimes(1);
    const torrentUrl = mockHelper.mock.calls[0]![0] as string;
    expect(torrentUrl).toContain('/tor/download.php');
    const torrentInit = mockHelper.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(torrentInit.dispatcher).toBeDefined();
  });
});

describe('MAM .torrent grab User-Agent (#1329)', () => {
  beforeEach(() => {
    mockHelper.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends the canonical User-Agent alongside the mam_id Cookie on the torrent fetch', async () => {
    vi.stubEnv('GIT_TAG', 'v9.9.9');
    mockHelper.mockResolvedValueOnce(
      new Response(Buffer.from('fake-torrent'), {
        status: 200,
        headers: { 'Content-Type': 'application/x-bittorrent' },
      }),
    );

    await makeDirectIndexer().resolveDownloadUrl({
      guid: '12345',
      downloadUrl: 'mam-torrent://12345',
      protocol: 'torrent',
      isFreeleech: true,
    });

    expect(mockHelper).toHaveBeenCalledTimes(1);
    const init = mockHelper.mock.calls[0]![1] as { headers?: Record<string, string> };
    expect(init.headers).toMatchObject({
      'User-Agent': 'Narratorr/v9.9.9',
      Cookie: 'mam_id=test-mam-id',
    });
  });
});

describe('MAM search/JSON API User-Agent (#1423)', () => {
  beforeEach(() => {
    mockHelper.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends the canonical User-Agent alongside the mam_id Cookie on the search fetch', async () => {
    vi.stubEnv('GIT_TAG', 'v9.9.9');
    mockHelper.mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await makeDirectIndexer().search('test');

    expect(mockHelper).toHaveBeenCalled();
    const url = mockHelper.mock.calls[0]![0] as string;
    expect(url).toContain('loadSearchJSONbasic.php');
    const init = mockHelper.mock.calls[0]![1] as { headers?: Record<string, string> };
    expect(init.headers).toMatchObject({
      'User-Agent': 'Narratorr/v9.9.9',
      Cookie: 'mam_id=test-mam-id',
    });
  });
});

/**
 * #2539 — both MAM sites mint their own dispatcher per call, so both must release it. The mocked
 * helper is the only seam that can see the instance; `myanonamouse.test.ts` rewires the helper down
 * to `globalThis.fetch` and never constructs one on the path it drives.
 */
describe('MAM dispatcher lifecycle (#2539 AC8, AC9)', () => {
  beforeEach(() => {
    mockHelper.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchWithCookieMeta', () => {
    it('closes the dispatcher exactly once on a successful search', async () => {
      const captured = captureDispatcher(mockHelper, async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));

      await makeProxiedIndexer().search('test');

      expect(captured.dispatcher).toBeDefined();
      expect(captured.closeCalls()).toBe(1);
    });

    it('closes the dispatcher exactly once when the search throws', async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8080'), { code: 'ECONNREFUSED' });
      const captured = captureDispatcher(mockHelper, async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause });
      });

      await expect(makeProxiedIndexer().search('test')).rejects.toBeInstanceOf(ProxyError);

      expect(captured.closeCalls()).toBe(1);
    });
  });

  describe('fetchTorrentAsDataUri', () => {
    const GRAB = {
      guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: true,
    } as const;

    it('closes the dispatcher exactly once on a successful grab', async () => {
      const captured = captureDispatcher(mockHelper, async () =>
        new Response(Buffer.from('fake-torrent'), {
          status: 200, headers: { 'Content-Type': 'application/x-bittorrent' },
        }));

      await makeProxiedIndexer().resolveDownloadUrl({ ...GRAB });

      expect(captured.dispatcher).toBeDefined();
      expect(captured.closeCalls()).toBe(1);
    });

    it('closes the dispatcher exactly once when the grab throws', async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8080'), { code: 'ECONNREFUSED' });
      const captured = captureDispatcher(mockHelper, async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause });
      });

      await expect(makeProxiedIndexer().resolveDownloadUrl({ ...GRAB })).rejects.toThrow(/ECONNREFUSED/);

      expect(captured.closeCalls()).toBe(1);
    });

    // The degrade arm returns rather than throws, and a `finally` that only ran on the throw path
    // would leak exactly here.
    it('closes the dispatcher exactly once when the grab degrades to no data', async () => {
      const captured = captureDispatcher(mockHelper, async () =>
        new Response('nope', { status: 500, statusText: 'Server Error' }));

      await expect(makeProxiedIndexer().resolveDownloadUrl({ ...GRAB }))
        .rejects.toThrow(/returned no data/);

      expect(captured.closeCalls()).toBe(1);
    });
  });
});
