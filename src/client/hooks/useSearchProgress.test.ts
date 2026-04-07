import { describe, it, vi, beforeEach, afterEach } from 'vitest';

describe('useSearchProgress store', () => {
  describe('module-level Map state', () => {
    it.todo('adds entry on search_started event with all indexers in pending state');
    it.todo('updates individual indexer to complete state on search_indexer_complete');
    it.todo('updates individual indexer to error state on search_indexer_error');
    it.todo('marks outcome as grabbed on search_grabbed');
    it.todo('marks outcome as no_results on search_complete with no_results');
    it.todo('replaces previous entry on duplicate search_started for same book_id');
    it.todo('handles search_indexer_complete for unknown book_id gracefully');
  });

  describe('auto-dismiss', () => {
    it.todo('removes entry after 3s timeout following search_complete outcome');
    it.todo('removes entry after 3s timeout following search_grabbed outcome');
    it.todo('clears existing timer when new search_started arrives for same book_id');
  });

  describe('useSyncExternalStore integration', () => {
    it.todo('notifies subscribers when entry added');
    it.todo('notifies subscribers when entry updated');
    it.todo('notifies subscribers when entry removed by auto-dismiss');
    it.todo('survives component unmount/remount — state persists at module level');
  });

  describe('useSearchProgress hook', () => {
    it.todo('returns empty array when no active searches');
    it.todo('returns all active SearchCardState entries');
    it.todo('returns updated state after indexer event');
  });
});
