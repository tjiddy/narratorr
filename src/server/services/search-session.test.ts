import { describe, it, expect } from 'vitest';
import { SearchSessionManager } from './search-session.js';

describe('SearchSessionManager', () => {
  const indexers = [
    { id: 1, name: 'AudioBookBay' },
    { id: 2, name: 'MAM' },
    { id: 3, name: 'DrunkenSlug' },
  ];

  describe('create', () => {
    it('creates a session with unique ID and per-indexer AbortControllers', () => {
      const manager = new SearchSessionManager();
      const session = manager.create(indexers);

      expect(session.sessionId).toBeDefined();
      expect(typeof session.sessionId).toBe('string');
      expect(session.sessionId.length).toBeGreaterThan(0);
      expect(session.controllers.size).toBe(3);
      expect(session.controllers.get(1)).toBeInstanceOf(AbortController);
      expect(session.controllers.get(2)).toBeInstanceOf(AbortController);
      expect(session.controllers.get(3)).toBeInstanceOf(AbortController);
    });

    it('returns session ID and indexer list', () => {
      const manager = new SearchSessionManager();
      const session = manager.create(indexers);

      expect(session.indexers).toEqual(indexers);
      expect(session.sessionId).toMatch(/^[0-9a-f-]+$/); // UUID format
    });
  });

  describe('cancel', () => {
    it('aborts the specific indexer AbortController by session + indexer ID', () => {
      const manager = new SearchSessionManager();
      const session = manager.create(indexers);

      const result = manager.cancel(session.sessionId, 2);
      expect(result).toBe(true);
      expect(session.controllers.get(2)!.signal.aborted).toBe(true);
      // Other controllers not aborted
      expect(session.controllers.get(1)!.signal.aborted).toBe(false);
      expect(session.controllers.get(3)!.signal.aborted).toBe(false);
    });

    it('cancel for already-aborted indexer is a no-op (returns true)', () => {
      const manager = new SearchSessionManager();
      const session = manager.create(indexers);

      manager.cancel(session.sessionId, 2);
      const result = manager.cancel(session.sessionId, 2);
      expect(result).toBe(true);
      expect(session.controllers.get(2)!.signal.aborted).toBe(true);
    });

    it('returns false for invalid session ID', () => {
      const manager = new SearchSessionManager();
      const result = manager.cancel('nonexistent', 1);
      expect(result).toBe(false);
    });

    it('returns false for invalid indexer ID within valid session', () => {
      const manager = new SearchSessionManager();
      const session = manager.create(indexers);
      const result = manager.cancel(session.sessionId, 999);
      expect(result).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('removes session and aborts all pending controllers on cleanup', () => {
      const manager = new SearchSessionManager();
      const session = manager.create(indexers);

      manager.cleanup(session.sessionId);

      expect(manager.get(session.sessionId)).toBeUndefined();
      // All controllers aborted
      expect(session.controllers.get(1)!.signal.aborted).toBe(true);
      expect(session.controllers.get(2)!.signal.aborted).toBe(true);
      expect(session.controllers.get(3)!.signal.aborted).toBe(true);
    });

    it('concurrent sessions are independent — cleanup of one does not affect the other', () => {
      const manager = new SearchSessionManager();
      const session1 = manager.create(indexers);
      const session2 = manager.create(indexers);

      manager.cleanup(session1.sessionId);

      expect(manager.get(session1.sessionId)).toBeUndefined();
      expect(manager.get(session2.sessionId)).toBeDefined();
      expect(session2.controllers.get(1)!.signal.aborted).toBe(false);
    });
  });

  describe('get', () => {
    it('returns session by ID', () => {
      const manager = new SearchSessionManager();
      const session = manager.create(indexers);
      expect(manager.get(session.sessionId)).toBe(session);
    });

    it('returns undefined for unknown session ID', () => {
      const manager = new SearchSessionManager();
      expect(manager.get('nonexistent')).toBeUndefined();
    });
  });
});
