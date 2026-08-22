import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { BookService } from '../services/book.service.js';

import { runGenreMarkerSweep } from './genre-marker-sweep.js';
import { withBookAdmissionLock } from '../utils/book-admission-lock.js';

vi.mock('../utils/book-admission-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/book-admission-lock.js')>();
  return { ...actual, withBookAdmissionLock: vi.fn(actual.withBookAdmissionLock) };
});

const mockLock = vi.mocked(withBookAdmissionLock);

function createMockLogger() {
  return inject<FastifyBaseLogger>({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  });
}

interface SweepRow {
  id: number;
  title: string;
  subtitle?: string | null;
  seriesName?: string | null;
  genres?: string[] | null;
  userClearedFields?: string | null;
}

function normalize(row: SweepRow) {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle ?? null,
    seriesName: row.seriesName ?? null,
    genres: row.genres ?? null,
    userClearedFields: row.userClearedFields ?? null,
  };
}

/**
 * Two shapes of read, told apart by projection exactly as `cover-backfill.test.ts` does: the
 * discovery scan projects `id` alongside the marker columns, the per-book in-lock revalidation
 * projects the same columns WITHOUT `id`. `state` is one shared mutable store the production write
 * advances, so an idempotence or stale-re-read pre-condition can genuinely fail.
 */
function createMockDb(state: Map<number, SweepRow>) {
  const discovery = vi.fn();
  const revalidation = vi.fn();
  const db = {
    select: vi.fn().mockImplementation((columns: Record<string, unknown>) => {
      const isDiscovery = 'id' in columns;
      (isDiscovery ? discovery : revalidation)(Object.keys(columns).sort());
      return {
        from: vi.fn().mockImplementation(() => {
          if (isDiscovery) return Promise.resolve([...state.values()].map(normalize));
          return {
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockImplementation(() => {
                // Drizzle binds the predicate at build time; the mock reads it off the pending id.
                const row = state.get(revalidationTarget);
                return Promise.resolve(row ? [normalize(row)] : []);
              }),
            }),
          };
        }),
      };
    }),
  };
  let revalidationTarget = -1;
  return { db: db as unknown as Db, discovery, revalidation, setTarget: (id: number) => { revalidationTarget = id; } };
}

/**
 * The lock is the only place the sweep names a book id, so pinning the revalidation target there
 * keeps the double honest: a read issued outside a section resolves against no row at all.
 */
function trackLockTargets(setTarget: (id: number) => void): number[] {
  const acquired: number[] = [];
  mockLock.mockImplementation(async (bookId, fn) => {
    acquired.push(bookId);
    setTarget(bookId);
    return fn();
  });
  return acquired;
}

function createBookService(state: Map<number, SweepRow>) {
  return {
    update: vi.fn().mockImplementation(async (id: number, data: { genres?: string[] }) => {
      const row = state.get(id);
      if (row && data.genres) row.genres = data.genres;
      return null;
    }),
  } as unknown as BookService & { update: ReturnType<typeof vi.fn> };
}

describe('runGenreMarkerSweep (#2535)', () => {
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    log = createMockLogger();
  });

  const MARKED = { id: 1, title: 'Mage Tank 2: A LitRPG Adventure', genres: ['Humor', 'Fantasy'] };
  const MARKED_SUBTITLE = { id: 2, title: 'The Land: Founding', subtitle: 'A LitRPG Saga', genres: null };
  const UNMARKED = { id: 3, title: 'Dungeon Crawler Carl', genres: ['Humor'] };

  it('updates each marked book once and leaves an unmarked sibling alone', async () => {
    const state = new Map<number, SweepRow>([[1, { ...MARKED }], [2, { ...MARKED_SUBTITLE }], [3, { ...UNMARKED }]]);
    const { db, setTarget } = createMockDb(state);
    const acquired = trackLockTargets(setTarget);
    const bookService = createBookService(state);

    await runGenreMarkerSweep(db, bookService, log);

    expect(bookService.update.mock.calls).toEqual([
      [1, { genres: ['Humor', 'Fantasy', 'LitRPG'] }],
      [2, { genres: ['LitRPG'] }],
    ]);
    expect(acquired).toEqual([1, 2]);
  });

  // AC31: the merge pre-check must drop converged books BEFORE the loop, or a converged library
  // re-locks every marked book on every boot. The lock count is the assertion that reds; the
  // update count alone stays green because the in-lock recompute also declines.
  it('AC31: a second run issues zero updates AND acquires zero locks', async () => {
    const state = new Map<number, SweepRow>([[1, { ...MARKED }], [2, { ...MARKED_SUBTITLE }]]);
    const { db, setTarget } = createMockDb(state);
    trackLockTargets(setTarget);
    const bookService = createBookService(state);

    await runGenreMarkerSweep(db, bookService, log);
    expect(bookService.update).toHaveBeenCalledTimes(2);

    bookService.update.mockClear();
    mockLock.mockClear();

    await runGenreMarkerSweep(db, bookService, log);

    expect(bookService.update).not.toHaveBeenCalled();
    expect(mockLock).not.toHaveBeenCalled();
  });

  // AC25: bounded by READ SHAPE, never by a global db.select count — the in-lock re-read is
  // mandatory, and bookService.update hydrates through getById with three more selects per book.
  it('AC25: discovery is one six-column query for the whole batch, revalidation one per locked book', async () => {
    const state = new Map<number, SweepRow>([[1, { ...MARKED }], [2, { ...MARKED_SUBTITLE }], [3, { ...UNMARKED }]]);
    const { db, discovery, revalidation, setTarget } = createMockDb(state);
    trackLockTargets(setTarget);

    await runGenreMarkerSweep(db, createBookService(state), log);

    expect(discovery).toHaveBeenCalledTimes(1);
    expect(discovery).toHaveBeenCalledWith(['genres', 'id', 'seriesName', 'subtitle', 'title', 'userClearedFields']);
    expect(revalidation).toHaveBeenCalledTimes(2);
    expect(revalidation).toHaveBeenCalledWith(['genres', 'seriesName', 'subtitle', 'title', 'userClearedFields']);
  });

  it('AC26: locks only the marked rows out of a large projection', async () => {
    const state = new Map<number, SweepRow>();
    for (let id = 1; id <= 50; id++) state.set(id, { id, title: `Ordinary Book ${id}`, genres: ['Fantasy'] });
    state.set(17, { id: 17, title: 'A LitRPG Adventure', genres: null });
    state.set(42, { id: 42, title: 'Book', subtitle: 'A GameLit Saga', genres: null });

    const { db, setTarget } = createMockDb(state);
    const acquired = trackLockTargets(setTarget);

    await runGenreMarkerSweep(db, createBookService(state), log);

    expect(acquired).toEqual([17, 42]);
  });

  // The snapshot gates may only ever REDUCE the candidate set; the in-lock recompute decides.
  it('AC27: a row that no longer matches at lock time is not written', async () => {
    const state = new Map<number, SweepRow>([[1, { ...MARKED }]]);
    const { db, setTarget } = createMockDb(state);
    const acquired = trackLockTargets(setTarget);
    const bookService = createBookService(state);
    // The concurrent write lands between the batch query and the lock.
    mockLock.mockImplementation(async (bookId, fn) => {
      acquired.push(bookId);
      setTarget(bookId);
      state.set(1, { id: 1, title: 'Mage Tank 2: A LitRPG Adventure', genres: ['Humor', 'Fantasy', 'LitRPG'] });
      return fn();
    });

    await runGenreMarkerSweep(db, bookService, log);

    expect(acquired).toEqual([1]);
    expect(bookService.update).not.toHaveBeenCalled();
  });

  it('AC27: a title retitled to an unmarked one between snapshot and lock is not written', async () => {
    const state = new Map<number, SweepRow>([[1, { ...MARKED }]]);
    const { db, setTarget } = createMockDb(state);
    const bookService = createBookService(state);
    mockLock.mockImplementation(async (bookId, fn) => {
      setTarget(bookId);
      state.set(1, { id: 1, title: 'Mage Tank 2', genres: ['Humor', 'Fantasy'] });
      return fn();
    });

    await runGenreMarkerSweep(db, bookService, log);

    expect(bookService.update).not.toHaveBeenCalled();
  });

  it('AC28: a genres tombstone in the snapshot skips the book without taking a lock', async () => {
    const state = new Map<number, SweepRow>([[1, { ...MARKED, userClearedFields: '["genres"]' }]]);
    const { db, setTarget } = createMockDb(state);
    trackLockTargets(setTarget);
    const bookService = createBookService(state);

    await runGenreMarkerSweep(db, bookService, log);

    expect(mockLock).not.toHaveBeenCalled();
    expect(bookService.update).not.toHaveBeenCalled();
  });

  // The operator can clear genres between the scan and the lock, so the in-lock read is authoritative.
  it('AC28: a genres tombstone that appears only at lock time still blocks the write', async () => {
    const state = new Map<number, SweepRow>([[1, { ...MARKED }]]);
    const { db, setTarget } = createMockDb(state);
    const acquired = trackLockTargets(setTarget);
    const bookService = createBookService(state);
    mockLock.mockImplementation(async (bookId, fn) => {
      acquired.push(bookId);
      setTarget(bookId);
      state.set(1, { ...MARKED, userClearedFields: '["genres"]' });
      return fn();
    });

    await runGenreMarkerSweep(db, bookService, log);

    expect(acquired).toEqual([1]);
    expect(bookService.update).not.toHaveBeenCalled();
  });

  it('AC29: a failing book is logged and the sweep continues with the rest', async () => {
    const state = new Map<number, SweepRow>([[1, { ...MARKED }], [2, { ...MARKED_SUBTITLE }]]);
    const { db, setTarget } = createMockDb(state);
    trackLockTargets(setTarget);
    const bookService = createBookService(state);
    bookService.update.mockRejectedValueOnce(new Error('write boom'));

    await expect(runGenreMarkerSweep(db, bookService, log)).resolves.toBeUndefined();

    expect(bookService.update.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Genre marker sweep: unexpected error while merging inferred genres',
    );
  });

  it('AC30: an all-unmarked projection takes no lock, issues no write, and logs at debug', async () => {
    const state = new Map<number, SweepRow>([[3, { ...UNMARKED }], [4, { id: 4, title: 'The Dungeon Corridor' }]]);
    const { db, setTarget } = createMockDb(state);
    trackLockTargets(setTarget);
    const bookService = createBookService(state);

    await expect(runGenreMarkerSweep(db, bookService, log)).resolves.toBeUndefined();

    expect(mockLock).not.toHaveBeenCalled();
    expect(bookService.update).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(expect.anything(), 'Genre marker sweep: no books need inferred genres');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('AC30: an empty books table takes the same no-write path', async () => {
    const state = new Map<number, SweepRow>();
    const { db, setTarget } = createMockDb(state);
    trackLockTargets(setTarget);
    const bookService = createBookService(state);

    await expect(runGenreMarkerSweep(db, bookService, log)).resolves.toBeUndefined();

    expect(mockLock).not.toHaveBeenCalled();
    expect(bookService.update).not.toHaveBeenCalled();
  });

  it('AC30: the completion log carries the updated count', async () => {
    const state = new Map<number, SweepRow>([[1, { ...MARKED }], [2, { ...MARKED_SUBTITLE }]]);
    const { db, setTarget } = createMockDb(state);
    trackLockTargets(setTarget);

    await runGenreMarkerSweep(db, createBookService(state), log);

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ updated: 2 }),
      'Genre marker sweep complete',
    );
  });

  // AC26: the update for book N must sit inside book N's own section, not around the batch.
  it('AC26: each write is issued inside that book\'s own admission section', async () => {
    const state = new Map<number, SweepRow>([[1, { ...MARKED }], [2, { ...MARKED_SUBTITLE }]]);
    const { db, setTarget } = createMockDb(state);
    const trace: string[] = [];
    const bookService = createBookService(state);
    bookService.update.mockImplementation(async (id: number, data: { genres?: string[] }) => {
      trace.push(`update:${id}`);
      const row = state.get(id);
      if (row && data.genres) row.genres = data.genres;
      return null;
    });
    mockLock.mockImplementation(async (bookId, fn) => {
      setTarget(bookId);
      trace.push(`enter:${bookId}`);
      const result = await fn();
      trace.push(`exit:${bookId}`);
      return result;
    });

    await runGenreMarkerSweep(db, bookService, log);

    expect(trace).toEqual(['enter:1', 'update:1', 'exit:1', 'enter:2', 'update:2', 'exit:2']);
  });

  // The sweep is not an operator edit: `userAsserted` would recompute tombstones from its own write.
  it('never passes userAsserted to the update', async () => {
    const state = new Map<number, SweepRow>([[1, { ...MARKED }]]);
    const { db, setTarget } = createMockDb(state);
    trackLockTargets(setTarget);
    const bookService = createBookService(state);

    await runGenreMarkerSweep(db, bookService, log);

    expect(bookService.update).toHaveBeenCalledWith(1, { genres: ['Humor', 'Fantasy', 'LitRPG'] });
  });
});
