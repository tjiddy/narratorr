import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@core/indexers/types.js';
import { buildGrabPayload } from './grab-payload.js';

const baseResult: SearchResult = {
  title: 'The Great Gatsby',
  protocol: 'torrent',
  downloadUrl: 'https://example.com/download/123',
  indexer: 'TestIndexer',
  indexerId: 5,
  size: 500_000_000,
  seeders: 12,
  guid: 'abc-123',
};

describe('buildGrabPayload', () => {
  describe('base field mapping', () => {
    it('maps downloadUrl, title, protocol, indexerId, size, seeders from SearchResult', () => {
      const payload = buildGrabPayload(baseResult, 42);

      expect(payload).toEqual({
        downloadUrl: 'https://example.com/download/123',
        title: 'The Great Gatsby',
        protocol: 'torrent',
        bookId: 42,
        indexerId: 5,
        size: 500_000_000,
        seeders: 12,
        guid: 'abc-123',
      });
    });

    it('forwards bookId argument (not from SearchResult)', () => {
      const payload = buildGrabPayload(baseResult, 99);

      expect(payload.bookId).toBe(99);
    });

    /**
     * #2420 — the helper used to drop guid, so guid survived only where a caller overrode it.
     * `rss.ts` does not, and `insertDownloadRecord` writes `params.guid` straight through, so an
     * RSS-origin grab persisted `guid: null`. For ABB that is now the release's ONLY search-time
     * identity: without it the blacklist entry a later "mark failed" writes can match on nothing,
     * and the same release is re-grabbed on the next RSS pass.
     */
    it('copies guid off the SearchResult with no override needed', () => {
      const payload = buildGrabPayload(baseResult, 1);

      expect(payload.guid).toBe('abc-123');
    });

    it('omits guid entirely when the SearchResult carries none', () => {
      const { guid: _guid, ...noGuid } = baseResult;

      const payload = buildGrabPayload(noGuid, 1);

      expect(payload).not.toHaveProperty('guid');
    });

    it('carries an ABB path-derived guid through verbatim', () => {
      const abbGuid = 'abb:/audio-books/murder-in-the-new-forest/';

      const payload = buildGrabPayload({ ...baseResult, guid: abbGuid }, 1);

      expect(payload.guid).toBe(abbGuid);
    });
  });

  describe('override merging', () => {
    it('includes skipDuplicateCheck when provided as override', () => {
      const payload = buildGrabPayload(baseResult, 1, { skipDuplicateCheck: true });

      expect(payload.skipDuplicateCheck).toBe(true);
    });

    it('includes source when provided as override', () => {
      const payload = buildGrabPayload(baseResult, 1, { source: 'rss' });

      expect(payload.source).toBe('rss');
    });

    it('lets an explicit guid override win over the result\'s own', () => {
      const payload = buildGrabPayload(baseResult, 1, { guid: 'override-guid' });

      expect(payload.guid).toBe('override-guid');
    });

    it('#1156 forwards isFreeleech from SearchResult into the payload', () => {
      const payload = buildGrabPayload({ ...baseResult, isFreeleech: true }, 42);
      expect(payload.isFreeleech).toBe(true);
    });

    it('#1156 omits isFreeleech from the payload when SearchResult does not set it', () => {
      const payload = buildGrabPayload(baseResult, 42);
      expect(payload).not.toHaveProperty('isFreeleech');
    });

    it('omits undefined optional fields from SearchResult', () => {
      const sparse: SearchResult = {
        title: 'Sparse',
        protocol: 'usenet',
        indexer: 'Nzb',
      };

      const payload = buildGrabPayload(sparse, 10);

      expect(Object.keys(payload).sort()).toEqual(['bookId', 'downloadUrl', 'protocol', 'title'].sort());
    });
  });

  describe('type contract', () => {
    it('returns exact shape matching downloadOrchestrator.grab() param type', () => {
      const payload = buildGrabPayload(baseResult, 42, {
        guid: 'abc-123',
        skipDuplicateCheck: true,
        source: 'rss',
      });

      expect(payload).toEqual({
        downloadUrl: 'https://example.com/download/123',
        title: 'The Great Gatsby',
        protocol: 'torrent',
        bookId: 42,
        indexerId: 5,
        size: 500_000_000,
        seeders: 12,
        guid: 'abc-123',
        skipDuplicateCheck: true,
        source: 'rss',
      });
    });
  });
});
