import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useMswServer } from '../__tests__/msw/server.js';
import { AudioBookBayIndexer } from './abb.js';

const fixturesDir = resolve(import.meta.dirname, '../__tests__/fixtures');
const searchHtml = readFileSync(resolve(fixturesDir, 'abb-search.html'), 'utf-8');
const detailHtml = readFileSync(resolve(fixturesDir, 'abb-detail.html'), 'utf-8');
const noResultsHtml = readFileSync(resolve(fixturesDir, 'abb-no-results.html'), 'utf-8');

const ABB_HOST = 'audiobookbay.test';
const ABB_BASE = `https://${ABB_HOST}`;

describe('AudioBookBayIndexer', () => {
  const server = useMswServer();
  let indexer: AudioBookBayIndexer;

  beforeEach(() => {
    indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });
    // Speed up tests by removing delays
    vi.spyOn(indexer as any, 'delay').mockResolvedValue(undefined);
  });

  describe('properties', () => {
    it('has correct type and name', () => {
      expect(indexer.type).toBe('abb');
      expect(indexer.name).toBe('AudioBookBay');
    });
  });

  describe('search', () => {
    it('parses search results from HTML', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].indexer).toBe('AudioBookBay');
    });

    it('extracts info hash from detail page', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].infoHash).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
      expect(results[0].downloadUrl).toContain('magnet:?');
    });

    it('extracts size, seeders, leechers from detail page', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      // 1.23 GB
      expect(results[0].size).toBeGreaterThan(1_000_000_000);
      expect(results[0].seeders).toBe(42);
      expect(results[0].leechers).toBe(5);
    });

    it('returns empty array when no results found', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(noResultsHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('nonexistent book');
      expect(results).toEqual([]);
    });

    it('only includes results with download URLs', async () => {
      // Detail page without info hash
      const noHashHtml = `
        <html><body>
          <h1>Some Book</h1>
          <p>No hash here</p>
        </body></html>
      `;

      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(noHashHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toEqual([]);
    });

    it('respects limit option', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson', { limit: 1 });
      expect(results).toHaveLength(1);
    });

    it('handles search page fetch error gracefully', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(null, { status: 503 });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toEqual([]);
    });

    it('handles detail page fetch error gracefully', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      // Should not throw, just skip results without magnet URIs
      const results = await indexer.search('test');
      expect(results).toEqual([]);
    });
  });

  describe('test', () => {
    it('returns success on HTTP 200', async () => {
      server.use(
        http.head(`${ABB_BASE}/`, () => {
          return new HttpResponse(null, { status: 200 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain(ABB_HOST);
    });

    it('returns success on HTTP 405 (Method Not Allowed)', async () => {
      server.use(
        http.head(`${ABB_BASE}/`, () => {
          return new HttpResponse(null, { status: 405 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(true);
    });

    it('returns failure on HTTP error', async () => {
      server.use(
        http.head(`${ABB_BASE}/`, () => {
          return new HttpResponse(null, { status: 503 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('503');
    });

    it('returns failure on network error', async () => {
      server.use(
        http.head(`${ABB_BASE}/`, () => {
          return HttpResponse.error();
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
    });
  });
});
