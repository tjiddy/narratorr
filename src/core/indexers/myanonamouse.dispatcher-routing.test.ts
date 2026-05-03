/**
 * Dispatcher-routing regression for MyAnonamouse fetchWithCookie /
 * fetchTorrentAsDataUri (F2/F3, PR #907 review).
 *
 * Mocks the production seam — `fetchWithOptionalDispatcher` — with a
 * non-forwarding `vi.fn()` and asserts that BOTH MAM dispatcher-attached
 * call sites pass the proxy dispatcher into the helper. The helper's own
 * routing contract (dispatcher → undiciFetch) is asserted in
 * network-service.test.ts. Search-cookie (F2) and torrent-bytes (F3) paths
 * can regress independently — each is asserted here.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
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
    // Search returns one result so the indexer follows up with a torrent
    // download — that download is the F3 call site we need to protect.
    mockHelper
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: 12345, title: 'Test', seeders: 1, leechers: 0, size: '100 MiB' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from('fake-torrent'), {
          status: 200,
          headers: { 'Content-Type': 'application/x-bittorrent' },
        }),
      );

    await makeProxiedIndexer().search('test');

    // Two helper invocations: search + torrent download. The torrent
    // download is the second call and MUST also carry the dispatcher.
    expect(mockHelper).toHaveBeenCalledTimes(2);
    const torrentUrl = mockHelper.mock.calls[1]![0] as string;
    expect(torrentUrl).toContain('/tor/download.php');
    const torrentInit = mockHelper.mock.calls[1]![1] as { dispatcher?: unknown };
    expect(torrentInit.dispatcher).toBeDefined();
  });
});
