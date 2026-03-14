import { describe, it, expect } from 'vitest';
import type { Mock } from 'vitest';
import { eq } from 'drizzle-orm';
import { revertBookStatus } from './book-status.js';
import { createMockDb, mockDbChain } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import { books } from '../../db/schema.js';

describe('revertBookStatus', () => {
  it('reverts book with path to imported status and persists to correct row', async () => {
    const db = createMockDb();
    const chain = mockDbChain([]);
    db.update.mockReturnValue(chain);
    const book = { id: 42, path: '/library/Test Book' };

    const result = await revertBookStatus(db as unknown as Db, book);

    expect(result).toBe('imported');
    const setFn = (chain as Record<string, Mock>).set;
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'imported' }));
    const whereFn = (chain as Record<string, Mock>).where;
    expect(whereFn).toHaveBeenCalledWith(eq(books.id, 42));
  });

  it('reverts book without path to wanted status and persists to correct row', async () => {
    const db = createMockDb();
    const chain = mockDbChain([]);
    db.update.mockReturnValue(chain);
    const book = { id: 7, path: null };

    const result = await revertBookStatus(db as unknown as Db, book);

    expect(result).toBe('wanted');
    const setFn = (chain as Record<string, Mock>).set;
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'wanted' }));
    const whereFn = (chain as Record<string, Mock>).where;
    expect(whereFn).toHaveBeenCalledWith(eq(books.id, 7));
  });

  it('reverts book with empty string path to wanted status', async () => {
    const db = createMockDb();
    const chain = mockDbChain([]);
    db.update.mockReturnValue(chain);
    const book = { id: 1, path: '' };

    const result = await revertBookStatus(db as unknown as Db, book);

    expect(result).toBe('wanted');
    const setFn = (chain as Record<string, Mock>).set;
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'wanted' }));
  });

  it('returns the computed revert status for caller use', async () => {
    const db = createMockDb();
    db.update.mockReturnValue(mockDbChain([]));

    const imported = await revertBookStatus(db as unknown as Db, { id: 1, path: '/lib/book' });
    const wanted = await revertBookStatus(db as unknown as Db, { id: 2, path: null });

    expect(imported).toBe('imported');
    expect(wanted).toBe('wanted');
  });
});
