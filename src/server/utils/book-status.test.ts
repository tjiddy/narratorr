import { describe, it, expect } from 'vitest';
import type { Mock } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { revertBookStatus, transitionBookStatus, REVERT_FALLBACK_STATUS } from './book-status.js';
import { createMockDb, mockDbChain } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import { books } from '../../db/schema.js';

describe('transitionBookStatus', () => {
  it('sets only the provided fields (plus updatedAt) and targets the correct row', async () => {
    const db = createMockDb();
    const chain = mockDbChain([{ id: 7 }]);
    db.update.mockReturnValue(chain);

    const landed = await transitionBookStatus(db as unknown as Db, 7, { status: 'downloading' });

    expect(landed).toBe(true);
    const setFn = (chain as Record<string, Mock>).set!;
    const setArg = setFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).toHaveProperty('status', 'downloading');
    expect(setArg).toHaveProperty('updatedAt');
    // Omitted fields are never written — they can't clobber a concurrent writer.
    expect(setArg).not.toHaveProperty('path');
    expect(setArg).not.toHaveProperty('size');
    const whereFn = (chain as Record<string, Mock>).where;
    expect(whereFn).toHaveBeenCalledWith(eq(books.id, 7));
  });

  it('writes co-transitioned side fields atomically (path/size/lastGrab*)', async () => {
    const db = createMockDb();
    const chain = mockDbChain([{ id: 1 }]);
    db.update.mockReturnValue(chain);

    await transitionBookStatus(db as unknown as Db, 1, {
      status: 'imported', path: '/lib/book', size: 1234, lastGrabGuid: 'g', lastGrabInfoHash: 'h',
    });

    const setArg = (chain as Record<string, Mock>).set!.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ status: 'imported', path: '/lib/book', size: 1234, lastGrabGuid: 'g', lastGrabInfoHash: 'h' });
  });

  it('compiles an expected guard into the WHERE predicate', async () => {
    const db = createMockDb();
    const chain = mockDbChain([{ id: 3 }]);
    db.update.mockReturnValue(chain);

    await transitionBookStatus(db as unknown as Db, 3, { status: 'missing', expected: { status: 'imported' } });

    const whereFn = (chain as Record<string, Mock>).where;
    expect(whereFn).toHaveBeenCalledWith(and(eq(books.id, 3), eq(books.status, 'imported')));
  });

  it('returns false when the expected guard does not match (no rows updated)', async () => {
    const db = createMockDb();
    db.update.mockReturnValue(mockDbChain([])); // returning() resolves empty → precondition missed

    const landed = await transitionBookStatus(db as unknown as Db, 9, { status: 'missing', expected: { status: 'imported' } });

    expect(landed).toBe(false);
  });
});

describe('revertBookStatus', () => {
  it('restores the explicit prior lifecycle, not a path-inferred value (failed)', async () => {
    const db = createMockDb();
    const chain = mockDbChain([{ id: 42 }]);
    db.update.mockReturnValue(chain);

    const result = await revertBookStatus(db as unknown as Db, { id: 42 }, 'failed');

    expect(result).toBe('failed');
    const setFn = (chain as Record<string, Mock>).set;
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    const whereFn = (chain as Record<string, Mock>).where;
    expect(whereFn).toHaveBeenCalledWith(eq(books.id, 42));
  });

  it('restores missing prior state', async () => {
    const db = createMockDb();
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
    expect(await revertBookStatus(db as unknown as Db, { id: 1 }, 'missing')).toBe('missing');
  });

  it('restores the common wanted prior state (clean-grab regression guard)', async () => {
    const db = createMockDb();
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
    expect(await revertBookStatus(db as unknown as Db, { id: 1 }, 'wanted')).toBe('wanted');
  });

  it('falls back to the conservative REVERT_FALLBACK_STATUS when prior state is null (legacy rows)', async () => {
    const db = createMockDb();
    const chain = mockDbChain([{ id: 7 }]);
    db.update.mockReturnValue(chain);

    const result = await revertBookStatus(db as unknown as Db, { id: 7 }, null);

    expect(REVERT_FALLBACK_STATUS).toBe('imported');
    expect(result).toBe('imported');
    expect((chain as Record<string, Mock>).set).toHaveBeenCalledWith(expect.objectContaining({ status: 'imported' }));
  });
});
