import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useMswServer } from '../__tests__/msw/server.js';
import { TorznabIndexer } from './torznab.js';

const fixturesDir = resolve(import.meta.dirname, '../__tests__/fixtures');
const searchXml = readFileSync(resolve(fixturesDir, 'torznab-search.xml'), 'utf-8');
const capsXml = readFileSync(resolve(fixturesDir, 'torznab-caps.xml'), 'utf-8');

const API_BASE = 'https://tracker.test';

describe('TorznabIndexer', () => {
  const server = useMswServer();
  let indexer: TorznabIndexer;

  beforeEach(() => {
    indexer = new TorznabIndexer({ apiUrl: API_BASE, apiKey: 'testapikey' });
  });

  describe('properties', () => {
    it('has correct type and name', () => {
      expect(indexer.type).toBe('torznab');
      expect(indexer.name).toBe('tracker.test');
    });

    it('uses custom name when provided', () => {
      const named = new TorznabIndexer(
        { apiUrl: API_BASE, apiKey: 'key' },
        'My Tracker',
      );
      expect(named.name).toBe('My Tracker');
    });
  });

  describe('search', () => {
    it('parses search results from XML', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results).toHaveLength(3);
      expect(results[0].title).toBe(
        'The Way of Kings - Brandon Sanderson (Unabridged)',
      );
      expect(results[0].protocol).toBe('torrent');
      expect(results[0].indexer).toBe('tracker.test');
    });

    it('extracts download URL from enclosure', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].downloadUrl).toBe(
        'https://tracker.test/download/abc123.torrent',
      );
    });

    it('extracts seeders and leechers from torznab:attr', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].seeders).toBe(15);
      expect(results[0].leechers).toBe(3);
      expect(results[1].seeders).toBe(8);
      expect(results[1].leechers).toBe(1);
    });

    it('extracts infoHash from torznab:attr', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].infoHash).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
      expect(results[1].infoHash).toBe('b1d5781111d84f7b3fe45a0852e59758cd7a87e5');
    });

    it('extracts size from torznab:attr', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].size).toBe(1073741824);
      expect(results[1].size).toBe(2147483648);
    });

    it('extracts grabs from torznab:attr', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].grabs).toBe(42);
      expect(results[1].grabs).toBe(18);
    });

    it('builds magnet URI when no download URL but infoHash present', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      // Third item has no enclosure or link, only infoHash
      expect(results[2].downloadUrl).toContain('magnet:?');
      expect(results[2].downloadUrl).toContain('da4b9237bacccdf19c0760cab7aec4a8359010b0');
      expect(results[2].infoHash).toBe('da4b9237bacccdf19c0760cab7aec4a8359010b0');
    });

    it('extracts details URL from guid', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].detailsUrl).toBe('https://tracker.test/details/abc123');
    });

    it('respects limit option', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson', { limit: 1 });

      expect(results).toHaveLength(1);
    });

    it('sends author param when provided', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrl = request.url;
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      await indexer.search('Stormlight', { author: 'Brandon Sanderson' });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('author')).toBe('Brandon Sanderson');
      expect(url.searchParams.get('q')).toBe('Stormlight');
    });

    it('sends correct API params', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrl = request.url;
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      await indexer.search('test query');

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('t')).toBe('search');
      expect(url.searchParams.get('apikey')).toBe('testapikey');
      expect(url.searchParams.get('cat')).toBe('3030');
      expect(url.searchParams.get('q')).toBe('test query');
    });

    it('returns empty array on network error', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return HttpResponse.error();
        }),
      );

      const results = await indexer.search('test');
      expect(results).toEqual([]);
    });

    it('returns empty array on non-200 response', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toEqual([]);
    });

    it('returns empty array on empty response', async () => {
      const emptyXml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel><title>Empty</title></channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(emptyXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('nonexistent');
      expect(results).toEqual([]);
    });
  });

  describe('test', () => {
    it('returns success on valid caps response', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(capsXml, {
            headers: { 'Content-Type': 'application/xml' },
          });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain('Test Torznab Indexer');
    });

    it('returns success with fallback name when no server title', async () => {
      const minimalCaps = `<?xml version="1.0"?><caps><searching/></caps>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(minimalCaps, {
            headers: { 'Content-Type': 'application/xml' },
          });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain('tracker.test');
    });

    it('returns failure on HTTP error', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('401');
    });

    it('returns failure on network error', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return HttpResponse.error();
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
    });
  });
});
