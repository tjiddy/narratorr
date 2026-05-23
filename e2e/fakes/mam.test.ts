import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMAMFake, type MAMFakeHandle } from './mam.js';

/**
 * Unit tests against the fake MAM server. Port is randomized per test so
 * parallel vitest workers don't collide.
 */

let nextPort = 14100;
function allocatePort(): number {
  return nextPort++;
}

describe('fake MAM indexer', () => {
  let fake: MAMFakeHandle;

  beforeEach(async () => {
    fake = await createMAMFake({ port: allocatePort() });
  });

  afterEach(async () => {
    await fake.close();
  });

  function fetchWithCookie(path: string, init: RequestInit = {}, cookie = 'mam_id=test-mam-id') {
    return fetch(`${fake.url}${path}`, {
      ...init,
      headers: { ...init.headers, Cookie: cookie },
    });
  }

  describe('GET /tor/js/loadSearchJSONbasic.php', () => {
    it('returns seeded results for a matching query', async () => {
      fake.seedResults('e2e test book', [
        {
          id: 42, title: 'E2E Test Book', author: 'E2E Test Author',
          langCode: '1', size: '200.0 MiB', seeders: 10, leechers: 0,
        },
      ]);

      const res = await fetchWithCookie('/tor/js/loadSearchJSONbasic.php?tor%5Btext%5D=E2E+Test+Book');
      expect(res.status).toBe(200);
      const body = await res.json() as { data: Array<{ id: number; title: string; author_info: string }> };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.id).toBe(42);
      expect(body.data[0]!.title).toBe('E2E Test Book');
      // author_info is double-encoded JSON — parseDoubleEncodedNames in myanonamouse.ts expects this shape.
      expect(JSON.parse(JSON.parse(body.data[0]!.author_info))['1']).toBe('E2E Test Author');
    });

    it('returns { error: "Nothing returned..." } when no fixtures match the query', async () => {
      const res = await fetchWithCookie('/tor/js/loadSearchJSONbasic.php?tor%5Btext%5D=unknown');
      expect(res.status).toBe(200);
      const body = await res.json() as { error?: string };
      expect(body.error).toMatch(/^Nothing returned/);
    });

    it('rejects requests missing the mam_id cookie with HTTP 403', async () => {
      const res = await fetch(`${fake.url}/tor/js/loadSearchJSONbasic.php?tor%5Btext%5D=anything`);
      expect(res.status).toBe(403);
    });

    it('rejects requests with a wrong mam_id cookie with HTTP 403 and MAM HTML error shape', async () => {
      const res = await fetchWithCookie('/tor/js/loadSearchJSONbasic.php?tor%5Btext%5D=anything', {}, 'mam_id=wrong');
      expect(res.status).toBe(403);
      const body = await res.text();
      // MyAnonamouseIndexer parses the `<br />\s*(.+)` pattern for the error detail.
      expect(body).toMatch(/<br\s*\/>/);
    });
  });

  describe('GET /tor/download.php', () => {
    it('returns torrent bytes for a known tid', async () => {
      const res = await fetchWithCookie('/tor/download.php?tid=42');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/x-bittorrent/);
      const buf = Buffer.from(await res.arrayBuffer());
      // Minimal bencode sanity: starts with `d4:info`.
      expect(buf.subarray(0, 7).toString()).toBe('d4:info');
    });

    it('returns HTTP 404 for a non-numeric tid', async () => {
      const res = await fetchWithCookie('/tor/download.php?tid=abc');
      expect(res.status).toBe(404);
    });

    it('rejects requests missing the mam_id cookie with HTTP 403', async () => {
      const res = await fetch(`${fake.url}/tor/download.php?tid=42`);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /jsonLoad.php', () => {
    it('returns { username, classname } for the indexer test() call', async () => {
      const res = await fetchWithCookie('/jsonLoad.php');
      expect(res.status).toBe(200);
      const body = await res.json() as { username?: string; classname?: string };
      expect(body.username).toBeTruthy();
      expect(body.classname).toBeTruthy();
    });
  });

  describe('seedResults()', () => {
    it('stores fixtures keyed by query term', async () => {
      fake.seedResults('Mistborn', [{
        id: 1, title: 'Mistborn', author: 'Brandon Sanderson',
        langCode: '1', size: '1.1 GiB', seeders: 5, leechers: 0,
      }]);
      const res = await fetchWithCookie('/tor/js/loadSearchJSONbasic.php?tor%5Btext%5D=Mistborn');
      const body = await res.json() as { data?: unknown[] };
      expect(body.data).toHaveLength(1);
    });

    it('overwrites prior seed for the same query', async () => {
      fake.seedResults('shared query', [{
        id: 1, title: 'First', author: 'A', langCode: '1', size: '1 MiB', seeders: 1, leechers: 0,
      }]);
      fake.seedResults('shared query', [{
        id: 2, title: 'Second', author: 'B', langCode: '1', size: '1 MiB', seeders: 1, leechers: 0,
      }, {
        id: 3, title: 'Third', author: 'C', langCode: '1', size: '1 MiB', seeders: 1, leechers: 0,
      }]);
      const res = await fetchWithCookie('/tor/js/loadSearchJSONbasic.php?tor%5Btext%5D=shared+query');
      const body = await res.json() as { data: Array<{ id: number }> };
      expect(body.data.map((d) => d.id)).toEqual([2, 3]);
    });
  });

  describe('reset()', () => {
    it('clears all previously seeded results', async () => {
      fake.seedResults('a', [{
        id: 1, title: 'A', author: 'A', langCode: '1', size: '1 MiB', seeders: 1, leechers: 0,
      }]);
      fake.reset();
      const res = await fetchWithCookie('/tor/js/loadSearchJSONbasic.php?tor%5Btext%5D=a');
      const body = await res.json() as { error?: string };
      expect(body.error).toMatch(/^Nothing returned/);
    });
  });

  describe('server lifecycle', () => {
    it('listens on the configured port and returns a close() handle', async () => {
      // Already covered by setup/teardown working at all — assert url shape.
      expect(fake.url).toMatch(/^http:\/\/localhost:\d+$/);
    });
  });

  // #1156 F5 — HTTP control endpoints added with the wedge fix must be exercised
  // directly so future deletion of the handlers can't pass silently.
  describe('POST /__control/wedges', () => {
    async function postWedges(body: unknown) {
      return fetch(`${fake.url}/__control/wedges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('seeds wedge count surfaced via /jsonLoad.php', async () => {
      const res = await postWedges({ count: 11 });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; wedges: number };
      expect(body).toEqual({ ok: true, wedges: 11 });

      const status = await fetchWithCookie('/jsonLoad.php');
      const statusBody = await status.json() as { wedges?: number };
      expect(statusBody.wedges).toBe(11);
    });

    it('accepts 0 as a valid seed', async () => {
      const res = await postWedges({ count: 0 });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; wedges: number };
      expect(body.wedges).toBe(0);
    });

    it('rejects negative count with HTTP 400', async () => {
      const res = await postWedges({ count: -1 });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/non-negative integer/);
    });

    it('rejects non-integer count with HTTP 400', async () => {
      const res = await postWedges({ count: 1.5 });
      expect(res.status).toBe(400);
    });

    it('rejects non-numeric count with HTTP 400', async () => {
      const res = await postWedges({ count: 'lots' });
      expect(res.status).toBe(400);
    });

    it('rejects missing count field with HTTP 400', async () => {
      const res = await postWedges({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /__control/bonus-buy', () => {
    async function postBonusBuy(body: unknown) {
      return fetch(`${fake.url}/__control/bonus-buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    async function callBonusBuy() {
      return fetch(`${fake.url}/json/bonusBuy.php/12345?spendtype=personalFL&torrentid=1&timestamp=12345`, {
        method: 'POST',
        headers: { Cookie: 'mam_id=test-mam-id' },
      });
    }

    it('applies an override that forces success=true regardless of wedge inventory', async () => {
      await postBonusBuy({}); // ensure cleared
      await fetch(`${fake.url}/__control/wedges`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 0 }),
      });

      const override = await postBonusBuy({ success: true });
      expect(override.status).toBe(200);
      const overrideBody = await override.json() as { ok: boolean; override: { success: boolean } };
      expect(overrideBody.override).toEqual({ success: true });

      const buy = await callBonusBuy();
      const buyBody = await buy.json() as { success: boolean };
      expect(buyBody.success).toBe(true);
    });

    it('applies an override that forces an error string', async () => {
      const override = await postBonusBuy({ success: false, error: 'This Torrent is VIP only' });
      expect(override.status).toBe(200);

      const buy = await callBonusBuy();
      const buyBody = await buy.json() as { success: boolean; error?: string };
      expect(buyBody).toEqual({ success: false, error: 'This Torrent is VIP only' });
    });

    it('clears an override when posted with an empty body — restores wedge-count-aware default', async () => {
      // Seed an override forcing failure, then clear it.
      await postBonusBuy({ success: false, error: 'forced' });
      const cleared = await postBonusBuy({});
      expect(cleared.status).toBe(200);
      const clearedBody = await cleared.json() as { ok: boolean; cleared: boolean };
      expect(clearedBody.cleared).toBe(true);

      // Seed wedges > 0 so the default path returns success.
      await fetch(`${fake.url}/__control/wedges`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 3 }),
      });
      const buy = await callBonusBuy();
      const buyBody = await buy.json() as { success: boolean };
      expect(buyBody.success).toBe(true);
    });

    it('rejects non-boolean success with HTTP 400', async () => {
      const res = await postBonusBuy({ success: 'yes' });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/success must be boolean/);
    });

    it('rejects non-string error with HTTP 400', async () => {
      const res = await postBonusBuy({ error: 42 });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/error must be string/);
    });
  });
});
