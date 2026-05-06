import { describe, it, expect, vi } from 'vitest';
import { searchWithSwapRetryTrace } from './search-helpers.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { FastifyBaseLogger } from 'fastify';

function createMockLog(): FastifyBaseLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
}

const foundResult: BookMetadata[] = [{ title: 'Found' } as BookMetadata];

describe('searchWithSwapRetryTrace', () => {
  it('returns initialQuery, initialResultCount, and all results on first-search hit', async () => {
    const searchFn = vi.fn().mockResolvedValue(foundResult);
    const log = createMockLog();

    const trace = await searchWithSwapRetryTrace({
      searchFn, title: 'Title', author: 'Author', log,
    });

    expect(trace.initialQuery).toBe('Title Author');
    expect(trace.initialResultCount).toBe(1);
    expect(trace.results).toEqual(foundResult);
  });

  it('returns swapRetry: true and swapQuery when initial search returns zero and author present', async () => {
    const searchFn = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(foundResult);
    const log = createMockLog();

    const trace = await searchWithSwapRetryTrace({
      searchFn, title: 'Title', author: 'Author', log,
    });

    expect(trace.swapRetry).toBe(true);
    expect(trace.swapQuery).toBe('Author Title');
    expect(trace.initialResultCount).toBe(0);
    expect(trace.results).toEqual(foundResult);
  });

  it('returns swapRetry: false and swapQuery: null when initial search has results', async () => {
    const searchFn = vi.fn().mockResolvedValue(foundResult);
    const log = createMockLog();

    const trace = await searchWithSwapRetryTrace({
      searchFn, title: 'Title', author: 'Author', log,
    });

    expect(trace.swapRetry).toBe(false);
    expect(trace.swapQuery).toBeNull();
  });

  it('returns swapRetry: false when no author (no swap attempted)', async () => {
    const searchFn = vi.fn().mockResolvedValue([]);
    const log = createMockLog();

    const trace = await searchWithSwapRetryTrace({
      searchFn, title: 'Title', author: undefined, log,
    });

    expect(trace.swapRetry).toBe(false);
    expect(trace.swapQuery).toBeNull();
    expect(trace.initialQuery).toBe('Title');
    expect(searchFn).toHaveBeenCalledTimes(1);
  });

  it('returns all results from the successful search (initial or swap)', async () => {
    const multipleResults: BookMetadata[] = [
      { title: 'Result 1' } as BookMetadata,
      { title: 'Result 2' } as BookMetadata,
    ];
    const searchFn = vi.fn().mockResolvedValue(multipleResults);
    const log = createMockLog();

    const trace = await searchWithSwapRetryTrace({
      searchFn, title: 'Title', author: 'Author', log,
    });

    expect(trace.results).toEqual(multipleResults);
    expect(trace.results).toHaveLength(2);
  });

  it('returns empty results array when both searches return zero', async () => {
    const searchFn = vi.fn().mockResolvedValue([]);
    const log = createMockLog();

    const trace = await searchWithSwapRetryTrace({
      searchFn, title: 'Title', author: 'Author', log,
    });

    expect(trace.results).toEqual([]);
    expect(trace.swapRetry).toBe(true);
    expect(trace.initialResultCount).toBe(0);
    expect(searchFn).toHaveBeenCalledTimes(2);
  });

  it('propagates search function errors without catching', async () => {
    const searchFn = vi.fn().mockRejectedValue(new Error('API down'));
    const log = createMockLog();

    await expect(
      searchWithSwapRetryTrace({ searchFn, title: 'Title', author: 'Author', log }),
    ).rejects.toThrow('API down');

    expect(searchFn).toHaveBeenCalledTimes(1);
  });
});
