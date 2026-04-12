import { describe, expect, it, vi } from 'vitest';
import { createMockDb, inject, mockDbChain } from '../__tests__/helpers.js';
import type { DbOrTx } from '../../db/index.js';
import { findOrCreateAuthor, findOrCreateNarrator } from './find-or-create-person.js';

describe('findOrCreateAuthor', () => {
  describe('happy path', () => {
    it('inserts new author and returns ID when slug not found', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([])); // not found
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 42 }])); // inserted

      const id = await findOrCreateAuthor(inject<DbOrTx>(db), 'Brandon Sanderson');

      expect(id).toBe(42);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('inserts new author with ASIN when provided', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 43 }]);
      db.insert.mockReturnValueOnce(insertChain);

      const id = await findOrCreateAuthor(inject<DbOrTx>(db), 'Joe Abercrombie', 'B001ASINFAKE');

      expect(id).toBe(43);
      expect(insertChain.values).toHaveBeenCalledWith({
        name: 'Joe Abercrombie',
        slug: 'joe-abercrombie',
        asin: 'B001ASINFAKE',
      });
    });

    it('returns existing author ID when slug already exists', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([{ id: 10, asin: 'B00EXISTING' }]));

      const id = await findOrCreateAuthor(inject<DbOrTx>(db), 'Brandon Sanderson');

      expect(id).toBe(10);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('ASIN backfill', () => {
    it('backfills ASIN on existing author with null ASIN', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([{ id: 10, asin: null }]));
      const updateChain = mockDbChain([]);
      db.update.mockReturnValueOnce(updateChain);

      const id = await findOrCreateAuthor(inject<DbOrTx>(db), 'Brandon Sanderson', 'B00NEWASIN');

      expect(id).toBe(10);
      expect(updateChain.set).toHaveBeenCalledWith({ asin: 'B00NEWASIN' });
    });

    it('does not overwrite existing non-null ASIN', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([{ id: 10, asin: 'B00EXISTING' }]));

      const id = await findOrCreateAuthor(inject<DbOrTx>(db), 'Brandon Sanderson', 'B00DIFFERENT');

      expect(id).toBe(10);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('does not issue update when asin param is undefined', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([{ id: 10, asin: null }]));

      const id = await findOrCreateAuthor(inject<DbOrTx>(db), 'Brandon Sanderson');

      expect(id).toBe(10);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('backfills ASIN on conflict-retry path when existing has null ASIN', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([])); // initial: not found
      db.insert.mockReturnValueOnce(mockDbChain(undefined, { error: new Error('UNIQUE constraint') }));
      db.select.mockReturnValueOnce(mockDbChain([{ id: 10, asin: null }])); // retry: found
      const updateChain = mockDbChain([]);
      db.update.mockReturnValueOnce(updateChain);

      const id = await findOrCreateAuthor(inject<DbOrTx>(db), 'Brandon Sanderson', 'B00RETRY');

      expect(id).toBe(10);
      expect(updateChain.set).toHaveBeenCalledWith({ asin: 'B00RETRY' });
    });
  });

  describe('race condition / conflict retry', () => {
    it('returns existing ID when insert throws and retry select succeeds', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([])); // initial: not found
      db.insert.mockReturnValueOnce(mockDbChain(undefined, { error: new Error('UNIQUE constraint') }));
      db.select.mockReturnValueOnce(mockDbChain([{ id: 99, asin: 'B00EXISTS' }])); // retry: found

      const id = await findOrCreateAuthor(inject<DbOrTx>(db), 'Brandon Sanderson');

      expect(id).toBe(99);
    });

    it('throws error when insert throws and retry select also returns empty', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([])); // initial: not found
      db.insert.mockReturnValueOnce(mockDbChain(undefined, { error: new Error('UNIQUE constraint') }));
      db.select.mockReturnValueOnce(mockDbChain([])); // retry: also not found

      await expect(findOrCreateAuthor(inject<DbOrTx>(db), 'Ghost Author'))
        .rejects.toThrow('Failed to find or create author: Ghost Author');
    });
  });

  describe('DbOrTx context', () => {
    it('uses the provided db/tx handle for all queries — not a different instance', async () => {
      const tx = createMockDb();
      const otherDb = createMockDb();
      tx.select.mockReturnValueOnce(mockDbChain([]));
      tx.insert.mockReturnValueOnce(mockDbChain([{ id: 5 }]));

      await findOrCreateAuthor(inject<DbOrTx>(tx), 'Test Author');

      expect(tx.select).toHaveBeenCalledTimes(1);
      expect(tx.insert).toHaveBeenCalledTimes(1);
      expect(otherDb.select).not.toHaveBeenCalled();
      expect(otherDb.insert).not.toHaveBeenCalled();
    });
  });
});

describe('findOrCreateNarrator', () => {
  describe('happy path', () => {
    it('inserts new narrator and returns ID when slug not found', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 77 }]);
      db.insert.mockReturnValueOnce(insertChain);

      const id = await findOrCreateNarrator(inject<DbOrTx>(db), 'Tim Gerard Reynolds');

      expect(id).toBe(77);
      expect(insertChain.values).toHaveBeenCalledWith({
        name: 'Tim Gerard Reynolds',
        slug: 'tim-gerard-reynolds',
      });
    });

    it('returns existing narrator ID when slug already exists', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([{ id: 33 }]));

      const id = await findOrCreateNarrator(inject<DbOrTx>(db), 'Tim Gerard Reynolds');

      expect(id).toBe(33);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('race condition / conflict retry', () => {
    it('returns existing ID when insert throws and retry select succeeds', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValueOnce(mockDbChain(undefined, { error: new Error('UNIQUE constraint') }));
      db.select.mockReturnValueOnce(mockDbChain([{ id: 88 }]));

      const id = await findOrCreateNarrator(inject<DbOrTx>(db), 'Tim Gerard Reynolds');

      expect(id).toBe(88);
    });

    it('throws error when insert throws and retry select also returns empty', async () => {
      const db = createMockDb();
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValueOnce(mockDbChain(undefined, { error: new Error('UNIQUE constraint') }));
      db.select.mockReturnValueOnce(mockDbChain([]));

      await expect(findOrCreateNarrator(inject<DbOrTx>(db), 'Ghost Narrator'))
        .rejects.toThrow('Failed to find or create narrator: Ghost Narrator');
    });
  });

  describe('DbOrTx context', () => {
    it('uses the provided db/tx handle for all queries — not a different instance', async () => {
      const tx = createMockDb();
      const otherDb = createMockDb();
      tx.select.mockReturnValueOnce(mockDbChain([{ id: 1 }]));

      await findOrCreateNarrator(inject<DbOrTx>(tx), 'Test Narrator');

      expect(tx.select).toHaveBeenCalledTimes(1);
      expect(otherDb.select).not.toHaveBeenCalled();
    });
  });
});
