import { describe, it, expect, beforeEach } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { BookService } from './book.service.js';
import { CLEARABLE_BOOK_FIELDS } from '@shared/schemas/book.js';
import { unmatchedGenres } from '@db/schema.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '@db/index.js';

const mockAuthor = createMockDbAuthor();
const mockBook = createMockDbBook();

function queueGetById(handle: ReturnType<typeof createMockDb>) {
  handle.select
    .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
    .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
    .mockReturnValueOnce(mockDbChain([]));
}

describe('BookService — user-cleared fields (#2069)', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let service: BookService;
  let updateChain: ReturnType<typeof mockDbChain>;

  beforeEach(() => {
    db = createMockDb();
    log = createMockLogger();
    service = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(log));
    updateChain = mockDbChain([{ id: 1 }]);
    db.update.mockReturnValue(updateChain);
  });

  function issuedSet(chain = updateChain): Record<string, unknown> {
    return chain.set.mock.calls[0]![0] as Record<string, unknown>;
  }

  describe('AC2 — the write boundary rejects an unknown field name', () => {
    it('throws BEFORE the transaction opens, issuing no write', async () => {
      await expect(
        service.update(1, { userClearedFields: '["genres","futureField"]' }),
      ).rejects.toThrow();

      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(updateChain.set).not.toHaveBeenCalled();
    });

    it('throws on an unparseable supplied column value, issuing no write', async () => {
      await expect(service.update(1, { userClearedFields: '{oops' })).rejects.toThrow();

      expect(db.transaction).not.toHaveBeenCalled();
      expect(updateChain.set).not.toHaveBeenCalled();
    });

    it('accepts every canonical clearable name (guards against a typo’d enum)', async () => {
      db.select.mockReturnValue(mockDbChain([{ userClearedFields: null }]));
      queueGetById(db);

      await service.update(1, { userClearedFields: JSON.stringify([...CLEARABLE_BOOK_FIELDS]) });

      expect(issuedSet().userClearedFields).toBe(JSON.stringify([...CLEARABLE_BOOK_FIELDS].sort()));
    });
  });

  describe('AC5 — only the userAsserted opt-in touches the column', () => {
    it('an internal caller passing nulls writes no userClearedFields key at all', async () => {
      queueGetById(db);

      await service.update(1, { seriesName: null, seriesPosition: null, publisher: null });

      expect(issuedSet()).not.toHaveProperty('userClearedFields');
      // No precondition re-read ran; only getById hydration reads.
      expect(db.select).toHaveBeenCalledTimes(3);
    });

    it('the userAsserted opt-in recomputes and writes the canonical set', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ userClearedFields: null }]));
      queueGetById(db);

      await service.update(1, { seriesName: null, publisher: '  ' }, { userAsserted: true });

      const set = issuedSet();
      expect(set.userClearedFields).toBe('["publisher","seriesName"]');
      // Tombstoned fields cannot retain contradictory stored values.
      expect(set.seriesName).toBeNull();
      expect(set.publisher).toBeNull();
    });
  });

  describe('#2152 — the series matrix reaches the issued UPDATE verbatim', () => {
    async function issuedFor(stored: string | null, body: Record<string, unknown>): Promise<Record<string, unknown>> {
      db.select.mockReturnValueOnce(mockDbChain([{ userClearedFields: stored }]));
      queueGetById(db);
      await service.update(1, body, { userAsserted: true });
      return issuedSet();
    }

    it('row 3: a position-only clear writes the tombstone and NULLs only that column', async () => {
      const set = await issuedFor(null, { seriesPosition: null });

      expect(set.userClearedFields).toBe('["seriesPosition"]');
      expect(set.seriesPosition).toBeNull();
      expect(set).not.toHaveProperty('seriesName');
    });

    it('row 2a: 0 reaches the UPDATE as 0 and lifts the tombstone', async () => {
      const set = await issuedFor('["seriesPosition"]', { seriesPosition: 0 });

      expect(set.seriesPosition).toBe(0);
      expect(set.userClearedFields).toBeNull();
    });

    it('rule b: a name clear NULLs the position column even though the body never named it', async () => {
      const set = await issuedFor(null, { seriesName: null });

      expect(set.userClearedFields).toBe('["seriesName"]');
      expect(set.seriesName).toBeNull();
      expect(set.seriesPosition).toBeNull();
    });

    it('row 2b: rule b discards a supplied number on an already-name-tombstoned book', async () => {
      const set = await issuedFor('["seriesName"]', { seriesPosition: 7 });

      expect(set.seriesPosition).toBeNull();
      expect(set.userClearedFields).toBe('["seriesName"]');
    });

    it('row 1 exemption: an unrelated update issues no series keys at all', async () => {
      const set = await issuedFor('["seriesName"]', { subtitle: 'x' });

      expect(set).not.toHaveProperty('seriesName');
      expect(set).not.toHaveProperty('seriesPosition');
      expect(set.userClearedFields).toBe('["seriesName"]');
    });
  });

  describe('AC8 / F24 — the set is re-read INSIDE the write transaction', () => {
    it('merges a clear that commits between the caller entering update() and the transaction opening', async () => {
      // Simulate a concurrent subtitle clear committed as the transaction opens; an earlier read
      // would overwrite it.
      let stored: string | null = null;
      let selectCall = 0;
      db.select.mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return mockDbChain([{ userClearedFields: stored }]);
        if (selectCall === 2) return mockDbChain([{ book: mockBook, importListName: null }]);
        return mockDbChain([]);
      });
      db.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        stored = '["subtitle"]';
        return cb(db);
      });

      await service.update(1, { publisher: null }, { userAsserted: true });

      expect(issuedSet().userClearedFields).toBe('["publisher","subtitle"]');
    });

    it('returns null without writing when the row disappeared before the transaction read it', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));

      const result = await service.update(999, { publisher: null }, { userAsserted: true });

      expect(result).toBeNull();
      expect(updateChain.set).not.toHaveBeenCalled();
    });
  });

  describe('AC11 / F20 / F21 — the caller-owned transaction arm', () => {
    it('runs every write on the caller handle, opens no transaction, and issues no off-handle query', async () => {
      const tx = createMockDb();
      const txUpdateChain = mockDbChain([{ id: 1 }]);
      tx.update.mockReturnValue(txUpdateChain);
      queueGetById(tx);

      const result = await service.update(1, { genres: ['Fantasy'] }, { tx: inject<DbOrTx>(tx) });

      expect(result).not.toBeNull();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(tx.transaction).not.toHaveBeenCalled();
      expect(tx.update).toHaveBeenCalledTimes(1);
      // Hydration must use the caller's handle to see its uncommitted write.
      expect(db.update).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });

    it('runs no success log and no genre telemetry before the owner commits (F21)', async () => {
      const tx = createMockDb();
      tx.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      queueGetById(tx);

      await service.update(1, { genres: ['Zzzz Unmatched Genre'] }, { tx: inject<DbOrTx>(tx) });
      await Promise.resolve();

      expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Book updated');
      expect(db.insert).not.toHaveBeenCalled();
      expect(tx.insert).not.toHaveBeenCalled();
    });

    it('the self-managed arm still logs and still tracks unmatched genres', async () => {
      queueGetById(db);
      db.insert.mockReturnValue(mockDbChain([]));

      await service.update(1, { genres: ['Zzzz Unmatched Genre'] });
      await Promise.resolve();

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'Book updated');
      expect(db.insert).toHaveBeenCalledWith(unmatchedGenres);
    });

    it('returns null on the tx arm when no row matched, without hydrating', async () => {
      const tx = createMockDb();
      tx.update.mockReturnValue(mockDbChain([]));

      const result = await service.update(1, { title: 'Nope' }, { tx: inject<DbOrTx>(tx) });

      expect(result).toBeNull();
      expect(tx.select).not.toHaveBeenCalled();
    });
  });

  describe('AC13 — Fix Match resets the whole set', () => {
    it('writes userClearedFields: null in the same transaction as the scalar replacement', async () => {
      db.delete.mockReturnValue(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValueOnce(mockDbChain([mockAuthor])); // syncAuthors → findOrCreateAuthor
      queueGetById(db);

      await service.fixMatch(1, { title: 'New Identity', authors: [{ name: 'Someone' }] });

      const set = issuedSet();
      expect(set.userClearedFields).toBeNull();
      expect(set.enrichmentStatus).toBe('pending');
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC16 — getById hydrates the parsed set', () => {
    it('overrides the raw column with the parsed array', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, userClearedFields: '["genres","seriesName"]' }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const book = await service.getById(1);

      expect(book!.userClearedFields).toEqual(['genres', 'seriesName']);
    });

    it('degrades a corrupt column to [] and warns once, without failing the request', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, userClearedFields: '{oops' }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const book = await service.getById(7);

      expect(book).not.toBeNull();
      expect(book!.userClearedFields).toEqual([]);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 7 }),
        expect.stringContaining('Unparseable userClearedFields'),
      );
    });
  });
});
