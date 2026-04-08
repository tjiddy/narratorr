import { describe, expect, it } from 'vitest';
import type { SearchResult } from '../../core/indexers/types.js';
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
      });
    });

    it('forwards bookId argument (not from SearchResult)', () => {
      const payload = buildGrabPayload(baseResult, 99);

      expect(payload.bookId).toBe(99);
    });

    it('does not include guid in base output', () => {
      const payload = buildGrabPayload(baseResult, 1);

      expect(payload).not.toHaveProperty('guid');
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

    it('includes guid only when explicitly provided as override', () => {
      const payload = buildGrabPayload(baseResult, 1, { guid: 'abc-123' });

      expect(payload.guid).toBe('abc-123');
    });

    it('omits undefined optional fields from SearchResult', () => {
      const sparse: SearchResult = {
        title: 'Sparse',
        protocol: 'usenet',
        indexer: 'Nzb',
      };

      const payload = buildGrabPayload(sparse, 10);

      // Only defined fields should be present (downloadUrl is always included via non-null assertion)
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

      // Strict exact-shape assertion — no extra fields allowed
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
