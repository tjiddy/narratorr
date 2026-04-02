import { describe, it } from 'vitest';

describe('useSearchStream', () => {
  describe('connection lifecycle', () => {
    it.todo('opens EventSource to /api/search/stream with query params and apikey');
    it.todo('parses search-start event and returns indexer list with pending status');
    it.todo('updates indexer status to complete on indexer-complete event');
    it.todo('updates indexer status to error on indexer-error event with message');
    it.todo('updates indexer status to cancelled on indexer-cancelled event');
    it.todo('returns search results on search-complete event');
    it.todo('sets phase to results when search-complete received');
  });

  describe('cancel', () => {
    it.todo('sends POST to cancel endpoint with correct sessionId and indexerId');
    it.todo('does not send duplicate cancel for same indexer');
  });

  describe('show results early', () => {
    it.todo('cancels all pending indexers and transitions to results phase');
  });

  describe('error handling', () => {
    it.todo('sets error state on EventSource connection failure');
    it.todo('cleans up EventSource on unmount');
  });

  describe('hasResults', () => {
    it.todo('returns true when any indexer has resultCount > 0');
    it.todo('returns false when all indexers have resultCount 0 or are pending');
  });
});
