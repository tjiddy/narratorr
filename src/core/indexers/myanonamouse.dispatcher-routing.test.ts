/** Non-forwarding mock verifies both MAM proxy call sites pass their dispatcher. */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type * as NetworkServiceModule from '../utils/network-service.js';

vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return { ...actual, fetchWithOptionalDispatcher: vi.fn() };
});

import { MyAnonamouseIndexer } from './myanonamouse.js';
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
