import { describe, expect, it } from 'vitest';
import { AdapterCache } from './adapter-cache.js';

describe('AdapterCache', () => {
  it('returns undefined for cache miss', () => {
    const cache = new AdapterCache<string>();
    expect(cache.get(1)).toBeUndefined();
  });

  it('returns cached adapter on hit', () => {
    const cache = new AdapterCache<string>();
    cache.set(1, 'adapter-1');
    expect(cache.get(1)).toBe('adapter-1');
  });

  it('deletes specific adapter by ID', () => {
    const cache = new AdapterCache<string>();
    cache.set(1, 'a');
    cache.set(2, 'b');
    cache.delete(1);
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)).toBe('b');
  });

  it('clears all adapters', () => {
    const cache = new AdapterCache<string>();
    cache.set(1, 'a');
    cache.set(2, 'b');
    cache.clear();
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)).toBeUndefined();
  });
});
