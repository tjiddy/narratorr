import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { BookService } from './book.service.js';
import { CLEARABLE_BOOK_FIELDS } from '@shared/schemas/book.js';
import { unmatchedGenres } from '@db/schema.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '@db/index.js';

const mockAuthor = createMockDbAuthor();
const mockBook = createMockDbBook();

/** Queue the three getById selects onto whichever handle hydration runs on. */
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

  /** The `.set(...)` payload the book UPDATE was actually issued with. */
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
      // No precondition re-read either — the recompute never ran.
      expect(db.select).toHaveBeenCalledTimes(3); // getById only
    });

    it('the userAsserted opt-in recomputes and writes the canonical set', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ userClearedFields: null }]));
      queueGetById(db);

      await service.update(1, { seriesName: null, publisher: '  ' }, { userAsserted: true });

      const set = issuedSet();
      expect(set.userClearedFields).toBe('["publisher","seriesName"]');
      // AC7: the stored values are normalized so they cannot contradict the tombstone.
      expect(set.seriesName).toBeNull();
      expect(set.publisher).toBeNull();
    });
  });

  describe('AC8 / F24 — the set is re-read INSIDE the write transaction', () => {
    it('merges a clear that commits between the caller entering update() and the transaction opening', async () => {
      // The stored set is empty in the pre-transaction world; a concurrent operator
      // edit commits `["subtitle"]` exactly as this transaction opens. An
      // implementation that reads the set BEFORE `db.transaction` computes
      // `["publisher"]` and silently erases that clear.
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
      // F20: the hydration read stays ON the handle, so it observes the write just
      // made — a `this.db` read could not see the caller's uncommitted transaction.
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
