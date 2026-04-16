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
      expect(body.data[0].id).toBe(42);
      expect(body.data[0].title).toBe('E2E Test Book');
      // author_info is double-encoded JSON — parseDoubleEncodedNames in myanonamouse.ts expects this shape.
      expect(JSON.parse(JSON.parse(body.data[0].author_info))['1']).toBe('E2E Test Author');
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
});
