import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EnrichmentCache,
  enrichmentCache,
  MAX_ENTRIES,
  SUCCESS_TTL_MS,
  FAILURE_TTL_MS,
  type EnrichmentCacheValue,
} from './enrichment-cache.js';

const resolved = (language?: string, nzbName?: string): EnrichmentCacheValue => ({
  outcome: 'resolved',
  language,
  nzbName,
});
const failed = (): EnrichmentCacheValue => ({ outcome: 'fetch-failed', language: undefined, nzbName: undefined });

describe('EnrichmentCache', () => {
  let cache: EnrichmentCache;

  beforeEach(() => {
    cache = new EnrichmentCache();
  });

  describe('get / set basics', () => {
    it('stores and returns a value; absent keys are undefined', () => {
      expect(cache.get('k')).toBeUndefined();
      cache.set('k', resolved('german', 'Pack.part01.rar'));
      expect(cache.get('k')).toEqual({ outcome: 'resolved', language: 'german', nzbName: 'Pack.part01.rar' });
    });

    it('a stored undefined language is a HIT (returned), not a miss', () => {
      cache.set('u', { outcome: 'unresolved', language: undefined, nzbName: 'subject.mp3' });
      expect(cache.get('u')).toEqual({ outcome: 'unresolved', language: undefined, nzbName: 'subject.mp3' });
    });
  });

  describe('TTL expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a resolved entry stays live up to the 24h success TTL, then expires', () => {
      cache.set('s', resolved('german'));
      vi.setSystemTime(SUCCESS_TTL_MS - 1);
      expect(cache.get('s')).toBeDefined();
      vi.setSystemTime(SUCCESS_TTL_MS + 1);
      expect(cache.get('s')).toBeUndefined();
    });

    it('a fetch-failed entry expires after the shorter 1h failure TTL', () => {
      cache.set('f', failed());
      vi.setSystemTime(FAILURE_TTL_MS - 1);
      expect(cache.get('f')).toBeDefined();
      vi.setSystemTime(FAILURE_TTL_MS + 1);
      expect(cache.get('f')).toBeUndefined();
    });
  });

  describe('eviction order (#1328)', () => {
    it('evicts the strictly oldest-inserted key first at the cap', () => {
      for (let i = 0; i < MAX_ENTRIES; i++) cache.set(`k${i}`, resolved('german'));
      expect(cache.size).toBe(MAX_ENTRIES);

      cache.set('k-new', resolved('german'));

      expect(cache.size).toBe(MAX_ENTRIES);
      expect(cache.get('k0')).toBeUndefined(); // oldest-inserted evicted
      expect(cache.get('k1')).toBeDefined();
      expect(cache.get('k-new')).toBeDefined();
    });

    it('overwriting an existing key refreshes its position to the tail, so the next-oldest evicts first', () => {
      for (let i = 0; i < MAX_ENTRIES; i++) cache.set(`k${i}`, resolved('german'));

      // Refresh the genuinely-oldest key in place (e.g. fetch-failed → resolved 23h later).
      cache.set('k0', resolved('french'));
      expect(cache.size).toBe(MAX_ENTRIES); // pure overwrite neither grows nor evicts

      // Insert one more — eviction now targets k1 (next-oldest), NOT the just-refreshed k0.
      cache.set('k-new', resolved('german'));
      expect(cache.get('k1')).toBeUndefined();
      expect(cache.get('k0')).toEqual({ outcome: 'resolved', language: 'french', nzbName: undefined });
      expect(cache.get('k-new')).toBeDefined();
    });

    it('overwriting at the cap neither grows the map nor evicts another entry', () => {
      for (let i = 0; i < MAX_ENTRIES; i++) cache.set(`k${i}`, resolved('german'));

      cache.set('k123', resolved('french'));

      expect(cache.size).toBe(MAX_ENTRIES);
      expect(cache.get('k0')).toBeDefined(); // nothing evicted on a pure overwrite
      expect(cache.get('k123')).toEqual({ outcome: 'resolved', language: 'french', nzbName: undefined });
    });
  });

  describe('clear', () => {
    it('empties the cache', () => {
      cache.set('a', resolved('german'));
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
    });
  });

  it('exposes a process-wide singleton instance', () => {
    expect(enrichmentCache).toBeInstanceOf(EnrichmentCache);
  });
});
