import { describe, it } from 'vitest';

describe('GET /api/search/stream', () => {
  describe('SSE streaming', () => {
    it.todo('streams search-start event with session ID and indexer list (id + name)');
    it.todo('streams indexer-complete with indexerId, resultCount, and elapsedMs');
    it.todo('streams indexer-error with indexerId and error message on failure');
    it.todo('streams search-complete with full SearchResponse shape (results, durationUnknown, unsupportedResults)');
    it.todo('search-complete results exclude cancelled indexers');
    it.todo('zero enabled indexers — streams search-start with empty list then search-complete with empty results');
    it.todo('all indexers fail — search-complete emits with empty results array');
    it.todo('sets correct SSE headers and hijacks reply');
  });

  describe('auth', () => {
    it.todo('rejects unauthenticated request (no credentials)');
  });

  describe('client disconnect', () => {
    it.todo('cleans up session and aborts all pending controllers on client disconnect');
  });
});

describe('POST /api/search/stream/:sessionId/cancel/:indexerId', () => {
  it.todo('aborts the specific indexer and returns 200');
  it.todo('returns 200 for already-completed indexer (no-op)');
  it.todo('returns 404 for invalid session ID');
  it.todo('returns 404 for invalid indexer ID');
});
