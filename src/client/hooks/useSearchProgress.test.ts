import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  handleSearchEvent,
  useSearchProgress,
  _resetForTesting,
} from './useSearchProgress';

beforeEach(() => {
  _resetForTesting();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSearchProgress store', () => {
  describe('module-level Map state', () => {
    it('adds entry on search_started event with all indexers in pending state', () => {
      const { result } = renderHook(() => useSearchProgress());
      act(() => {
        handleSearchEvent('search_started', {
          book_id: 1, book_title: 'Test Book',
          indexers: [{ id: 10, name: 'MAM' }, { id: 20, name: 'ABB' }],
        });
      });
      expect(result.current).toHaveLength(1);
      expect(result.current[0]!.bookId).toBe(1);
      expect(result.current[0]!.bookTitle).toBe('Test Book');
      expect(result.current[0]!.indexers.get(10)).toEqual({ name: 'MAM', status: 'pending' });
      expect(result.current[0]!.indexers.get(20)).toEqual({ name: 'ABB', status: 'pending' });
    });

    it('updates individual indexer to complete state on search_indexer_complete', () => {
      const { result } = renderHook(() => useSearchProgress());
      act(() => {
        handleSearchEvent('search_started', {
          book_id: 1, book_title: 'Test', indexers: [{ id: 10, name: 'MAM' }],
        });
      });
      act(() => {
        handleSearchEvent('search_indexer_complete', {
          book_id: 1, indexer_id: 10, indexer_name: 'MAM', results_found: 3, elapsed_ms: 1200,
        });
      });
      expect(result.current[0]!.indexers.get(10)).toEqual({
        name: 'MAM', status: 'complete', resultsFound: 3, elapsedMs: 1200,
      });
    });

    it('updates individual indexer to error state on search_indexer_error', () => {
      const { result } = renderHook(() => useSearchProgress());
      act(() => {
        handleSearchEvent('search_started', {
          book_id: 1, book_title: 'Test', indexers: [{ id: 10, name: 'MAM' }],
        });
        handleSearchEvent('search_indexer_error', {
          book_id: 1, indexer_id: 10, indexer_name: 'MAM', error: 'timeout', elapsed_ms: 30000,
        });
      });
      expect(result.current[0]!.indexers.get(10)).toEqual({
        name: 'MAM', status: 'error', error: 'timeout', elapsedMs: 30000,
      });
    });

    it('marks outcome as grabbed on search_grabbed', () => {
      const { result } = renderHook(() => useSearchProgress());
      act(() => {
        handleSearchEvent('search_started', {
          book_id: 1, book_title: 'Test', indexers: [{ id: 10, name: 'MAM' }],
        });
        handleSearchEvent('search_grabbed', {
          book_id: 1, release_title: 'Best Result', indexer_name: 'MAM',
        });
      });
      expect(result.current[0]!.outcome).toBe('grabbed');
      expect(result.current[0]!.grabbedFrom).toBe('MAM');
    });

    it('marks outcome as no_results on search_complete with no_results', () => {
      const { result } = renderHook(() => useSearchProgress());
      act(() => {
        handleSearchEvent('search_started', {
          book_id: 1, book_title: 'Test', indexers: [{ id: 10, name: 'MAM' }],
        });
        handleSearchEvent('search_complete', {
          book_id: 1, total_results: 0, outcome: 'no_results',
        });
      });
      expect(result.current[0]!.outcome).toBe('no_results');
    });

    it('replaces previous entry on duplicate search_started for same book_id', () => {
      const { result } = renderHook(() => useSearchProgress());
      act(() => {
        handleSearchEvent('search_started', {
          book_id: 1, book_title: 'First', indexers: [{ id: 10, name: 'MAM' }],
        });
        handleSearchEvent('search_started', {
          book_id: 1, book_title: 'Second', indexers: [{ id: 20, name: 'ABB' }],
        });
      });
      expect(result.current).toHaveLength(1);
      expect(result.current[0]!.bookTitle).toBe('Second');
    });

    it('handles search_indexer_complete for unknown book_id gracefully', () => {
      const { result } = renderHook(() => useSearchProgress());
      act(() => {
        handleSearchEvent('search_indexer_complete', {
          book_id: 999, indexer_id: 10, indexer_name: 'MAM', results_found: 1, elapsed_ms: 100,
        });
      });
      expect(result.current).toHaveLength(0);
    });
  });

  describe('auto-dismiss', () => {
    it('removes entry after 3s timeout following search_complete outcome', () => {
      const { result } = renderHook(() => useSearchProgress());
      act(() => {
        handleSearchEvent('search_started', {
          book_id: 1, book_title: 'Test', indexers: [{ id: 10, name: 'MAM' }],
        });
        handleSearchEvent('search_complete', {
          book_id: 1, total_results: 0, outcome: 'no_results',
        });
      });
      expect(result.current).toHaveLength(1);
      act(() => { vi.advanceTimersByTime(3000); });
      expect(result.current).toHaveLength(0);
    });

    it('removes entry after 3s timeout following search_grabbed outcome', () => {
      const { result } = renderHook(() => useSearchProgress());
      act(() => {
        handleSearchEvent('search_started', {
          book_id: 1, book_title: 'Test', indexers: [{ id: 10, name: 'MAM' }],
        });
        handleSearchEvent('search_grabbed', {
          book_id: 1, release_title: 'Grabbed', indexer_name: 'MAM',
        });
      });
      expect(result.current).toHaveLength(1);
      act(() => { vi.advanceTimersByTime(3000); });
      expect(result.current).toHaveLength(0);
    });
  });

  describe('useSearchProgress hook', () => {
    it('returns empty array when no active searches', () => {
      const { result } = renderHook(() => useSearchProgress());
      expect(result.current).toEqual([]);
    });

    it('returns all active SearchCardState entries', () => {
      const { result } = renderHook(() => useSearchProgress());
      act(() => {
        handleSearchEvent('search_started', {
          book_id: 1, book_title: 'Book A', indexers: [{ id: 10, name: 'MAM' }],
        });
        handleSearchEvent('search_started', {
          book_id: 2, book_title: 'Book B', indexers: [{ id: 20, name: 'ABB' }],
        });
      });
      expect(result.current).toHaveLength(2);
    });
  });
});
