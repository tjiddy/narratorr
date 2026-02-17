import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useMswServer } from '../__tests__/msw/server.js';
import { NewznabIndexer } from './newznab.js';

const fixturesDir = resolve(import.meta.dirname, '../__tests__/fixtures');
const searchXml = readFileSync(resolve(fixturesDir, 'newznab-search.xml'), 'utf-8');
const capsXml = readFileSync(resolve(fixturesDir, 'newznab-caps.xml'), 'utf-8');

const API_BASE = 'https://indexer.test';

describe('NewznabIndexer', () => {
  const server = useMswServer();
  let indexer: NewznabIndexer;

  beforeEach(() => {
    indexer = new NewznabIndexer({ apiUrl: API_BASE, apiKey: 'testapikey' });
  });

  describe('properties', () => {
    it('has correct type and name', () => {
      expect(indexer.type).toBe('newznab');
      expect(indexer.name).toBe('indexer.test');
    });

    it('uses custom name when provided', () => {
      const named = new NewznabIndexer(
        { apiUrl: API_BASE, apiKey: 'key' },
        'My Indexer',
      );
      expect(named.name).toBe('My Indexer');
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
      expect(results[0].protocol).toBe('usenet');
      expect(results[0].indexer).toBe('indexer.test');
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
        'https://indexer.test/getnzb/abc123.nzb?i=1&r=testapikey',
      );
    });

    it('extracts size from newznab:attr', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].size).toBe(1073741824); // 1 GB
      expect(results[1].size).toBe(2147483648); // 2 GB
    });

    it('extracts grabs from newznab:attr', async () => {
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

    it('extracts details URL from guid', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].detailsUrl).toBe('https://indexer.test/details/abc123');
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
      expect(result.message).toContain('Test Newznab Indexer');
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
      expect(result.message).toContain('indexer.test');
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

  describe('edge cases — NaN parsing', () => {
    it('handles NaN size from invalid attr value', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>NaN Size Book</title>
            <enclosure url="https://indexer.test/dl/1.nzb" length="abc"/>
            <newznab:attr name="size" value="notanumber"/>
            <newznab:attr name="grabs" value="10"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toHaveLength(1);
      // Number('notanumber') = NaN, size || undefined = undefined
      expect(results[0].size).toBeUndefined();
    });

    it('handles NaN grabs from invalid attr value', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>NaN Grabs</title>
            <enclosure url="https://indexer.test/dl/1.nzb" length="1000"/>
            <newznab:attr name="grabs" value="xyz"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0].grabs).toBeNaN();
    });

    it('skips items with empty title', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title></title>
            <enclosure url="https://indexer.test/dl/empty.nzb"/>
          </item>
          <item>
            <title>Valid Title</title>
            <enclosure url="https://indexer.test/dl/valid.nzb"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Valid Title');
    });

    it('falls back to enclosure length when no size attr', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>Enclosure Size</title>
            <enclosure url="https://indexer.test/dl/1.nzb" length="5000000"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results[0].size).toBe(5000000);
    });

    it('uses usenet protocol for all results', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>Usenet Book</title>
            <enclosure url="https://indexer.test/dl/1.nzb" length="1000"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results[0].protocol).toBe('usenet');
    });

    it('strips trailing slashes from apiUrl', () => {
      const idx = new NewznabIndexer({
        apiUrl: 'https://indexer.test///',
        apiKey: 'key',
      });
      expect(idx.name).toBe('indexer.test');
    });
  });
});
