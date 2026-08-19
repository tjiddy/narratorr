import { describe, it, expect, beforeEach } from 'vitest';
import { useMswServer } from '@core/__tests__/msw/server.js';
import { qbGetTorrentHandler, QB_BASE, TORRENT_HASH } from './msw-handlers.js';

/**
 * #2485 AC7c/7e — `qbGetTorrentHandler` is the shared qBittorrent list double for six e2e suites,
 * so its default IS production behavior for all of them ([[shared-test-double-defaults]]). It used
 * to answer `[]` for an absent *and* an empty `hashes`, which modelled a blank hash as a filter
 * that matches nothing — the masking that hid a blank probe adopting an arbitrary torrent. Real
 * qBittorrent answers the FULL list whenever no id part survives the filter.
 */
describe('qbGetTorrentHandler hashes-filter fidelity (#2485)', () => {
  const server = useMswServer();

  beforeEach(() => {
    server.use(qbGetTorrentHandler(TORRENT_HASH));
  });

  async function infoResponse(query: string): Promise<unknown[]> {
    const response = await fetch(`${QB_BASE}/api/v2/torrents/info${query}`);
    return await response.json() as unknown[];
  }

  it.each([
    ['an absent hashes param', ''],
    ['an empty hashes value', '?hashes='],
  ])('answers the seeded torrent for %s', async (_label, query) => {
    const torrents = await infoResponse(query);

    expect(torrents).toHaveLength(1);
    expect((torrents[0] as { hash: string }).hash).toBe(TORRENT_HASH.toLowerCase());
  });

  it('answers the seeded torrent for its own hash, case-insensitively', async () => {
    expect(await infoResponse(`?hashes=${TORRENT_HASH.toUpperCase()}`)).toHaveLength(1);
  });

  it('answers an empty list for a non-matching filter', async () => {
    expect(await infoResponse('?hashes=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toEqual([]);
  });
});
