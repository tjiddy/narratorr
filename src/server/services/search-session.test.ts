import { describe, it } from 'vitest';

describe('SearchSessionManager', () => {
  describe('create', () => {
    it.todo('creates a session with unique ID and per-indexer AbortControllers');
    it.todo('returns session ID and indexer list');
  });

  describe('cancel', () => {
    it.todo('aborts the specific indexer AbortController by session + indexer ID');
    it.todo('cancel for already-completed indexer is a no-op');
    it.todo('returns false for invalid session ID');
    it.todo('returns false for invalid indexer ID within valid session');
  });

  describe('cleanup', () => {
    it.todo('removes session and aborts all pending controllers on cleanup');
    it.todo('concurrent sessions are independent — cleanup of one does not affect the other');
  });

  describe('get', () => {
    it.todo('returns session by ID');
    it.todo('returns undefined for unknown session ID');
  });
});
