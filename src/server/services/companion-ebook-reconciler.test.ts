import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, companionEbooks } from '../../db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import type { SettingsService } from './settings.service.js';
import { CompanionEbookReconciler, RECONCILE_CONCURRENCY } from './companion-ebook-reconciler.js';
import { observeCompanionEbook } from './companion-ebook-observe.js';
import { findCompanionEbook, upsertCompanionEbook } from './companion-ebook.repository.js';
import { withBookAdmissionLock } from './book-admission.js';
import type { CompanionObserveResult } from './companion-ebook-observe.js';
import type { CompanionEbookObservation } from './companion-ebook-observation.js';

/**
 * Driven against a REAL migrated libSQL database rather than Drizzle chain doubles.
 *
 * The learning that motivates the doubles guidance
 * (guarded-transition-needs-returning-in-tx-mocks) is about a guarded read plus a
 * `.returning()` upsert in ONE transaction — precisely this service's write shape. A real
 * transaction satisfies both halves by construction and cannot drift from the SQL the
 * repository actually emits, which a hand-rolled `where`-terminus double repeatedly has. It
 * also makes the AC18 / AC19 races expressible as what they are: a second writer committing
 * between the pre-scan read and the guarded write.
 *
 * What IS doubled is everything outside the DB: the filesystem pass (`observeCompanionEbook`,
 * so a disposition can be dictated per book), `node:fs/promises.stat` (the eligibility guard's
 * only syscall), and the two shared concurrency primitives — wrapped, never replaced, so the
 * real `Semaphore` and the real `withBookAdmissionLock` still do the work while their
 * acquisition ORDER becomes observable (AC22).
 */
const hoisted = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, stat: vi.fn(actual.stat) };
});

vi.mock('./companion-ebook-observe.js', () => ({ observeCompanionEbook: vi.fn() }));

vi.mock('./companion-ebook.repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./companion-ebook.repository.js')>();
  return {
    ...actual,
    findCompanionEbook: vi.fn(actual.findCompanionEbook),
    upsertCompanionEbook: vi.fn(actual.upsertCompanionEbook),
  };
});

vi.mock('./book-admission.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./book-admission.js')>();
  return {
    ...actual,
    withBookAdmissionLock: vi.fn(async (bookId: number, fn: () => Promise<unknown>) => {
      hoisted.events.push(`lock.acquire:${bookId}`);
      return actual.withBookAdmissionLock(bookId, async () => {
        hoisted.events.push(`lock.held:${bookId}`);
        try {
          return await fn();
        } finally {
          hoisted.events.push(`lock.release:${bookId}`);
        }
      });
    }),
  };
});

vi.mock('../utils/semaphore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/semaphore.js')>();
  class RecordingSemaphore extends actual.Semaphore {
    override async acquire(): Promise<void> {
      hoisted.events.push('semaphore.wait');
      await super.acquire();
      hoisted.events.push('semaphore.acquired');
    }
    override release(): void {
      hoisted.events.push('semaphore.release');
      super.release();
    }
  }
  return { ...actual, Semaphore: RecordingSemaphore };
});

const observeMock = vi.mocked(observeCompanionEbook);
const findCompanionEbookMock = vi.mocked(findCompanionEbook);
const upsertCompanionEbookMock = vi.mocked(upsertCompanionEbook);
const withBookAdmissionLockMock = vi.mocked(withBookAdmissionLock);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * Every gate is registered so `afterEach` can release it. Without that, a failing assertion
 * leaves the sweep books it parked hanging forever and `stop()` — correctly unbounded — turns
 * one real failure into a 30-second hook timeout and a cascade of unrelated ones.
 */
const openGates: Array<() => void> = [];

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  openGates.push(() => resolve(undefined as T));
  return { promise, resolve, reject };
}

/** Settle-tracker: lets a test assert a promise is still PENDING without racing on it. */
function track<T>(promise: Promise<T>): { settled: boolean; rejected: boolean } {
  const state = { settled: false, rejected: false };
  void promise.then(
    () => { state.settled = true; },
    () => { state.settled = true; state.rejected = true; },
  );
  return state;
}

/** Drain the macrotask queue enough times that any real libSQL round-trip has landed. */
async function flush(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

function createMockLogger() {
  const log = {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'debug', silent: vi.fn(),
  };
  return { log: log as unknown as FastifyBaseLogger, spies: log };
}

/** Every `info` record that is a sweep summary — identified by its `books` denominator. */
function summaries(spies: { info: ReturnType<typeof vi.fn> }): Array<Record<string, unknown>> {
  return spies.info.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((record) => record !== null && typeof record === 'object' && 'books' in record);
}

function debugRecords(spies: { debug: ReturnType<typeof vi.fn> }): Array<Record<string, unknown>> {
  return spies.debug.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((record): record is Record<string, unknown> => record !== null && typeof record === 'object');
}

const OBSERVATION: CompanionEbookObservation = {
  status: 'available',
  filename: 'book.epub',
  sizeBytes: 4096,
  mtimeMs: 1_700_000_000_000,
  ctimeMs: 1_700_000_000_500,
  candidateCount: 1,
  selected: false,
};

const OBSERVED: CompanionObserveResult = { outcome: 'observed', observation: OBSERVATION };

describe('CompanionEbookReconciler (#1959)', () => {
  let dir: string;
  let libraryRoot: string;
  let db: Db;
  let log: FastifyBaseLogger;
  let spies: ReturnType<typeof createMockLogger>['spies'];
  let settings: SettingsService;
  let settingsGet: ReturnType<typeof vi.fn>;
  let reconciler: CompanionEbookReconciler;
  let enabled: boolean;
  /** Per-book observe outcome; anything unlisted observes the canonical `available` row. */
  let outcomes: Map<number, CompanionObserveResult | (() => Promise<CompanionObserveResult>)>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'companion-reconciler-'));
    libraryRoot = join(dir, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // resetAllMocks, never clearAllMocks: several cases queue `*Once()` responses and
    // clearAllMocks does not drain those queues (vitest-clearallmocks-once-queue).
    vi.resetAllMocks();
    hoisted.events.length = 0;
    outcomes = new Map();
    enabled = true;

    await db.delete(companionEbooks);
    await db.delete(books);

    const logger = createMockLogger();
    log = logger.log;
    spies = logger.spies;

    settingsGet = vi.fn(async (key: string) => {
      // Fresh objects per call — a fixture built off a shared default must never be handed
      // out by reference (mock-settings-deep-clone).
      if (key === 'companionEpub') return { enabled };
      if (key === 'library') return { path: libraryRoot };
      return {};
    });
    settings = { get: settingsGet } as unknown as SettingsService;

    findCompanionEbookMock.mockImplementation(
      (await vi.importActual<typeof import('./companion-ebook.repository.js')>('./companion-ebook.repository.js'))
        .findCompanionEbook,
    );
    upsertCompanionEbookMock.mockImplementation(
      (await vi.importActual<typeof import('./companion-ebook.repository.js')>('./companion-ebook.repository.js'))
        .upsertCompanionEbook,
    );
    withBookAdmissionLockMock.mockImplementation(async (bookId: number, fn: () => Promise<unknown>) => {
      const actual = await vi.importActual<typeof import('./book-admission.js')>('./book-admission.js');
      hoisted.events.push(`lock.acquire:${bookId}`);
      return actual.withBookAdmissionLock(bookId, async () => {
        hoisted.events.push(`lock.held:${bookId}`);
        try {
          return await fn();
        } finally {
          hoisted.events.push(`lock.release:${bookId}`);
        }
      });
    });

    observeMock.mockImplementation(async ({ bookId }) => {
      hoisted.events.push(`observe:${bookId}`);
      const configured = outcomes.get(bookId);
      if (typeof configured === 'function') return configured();
      return configured ?? OBSERVED;
    });

    reconciler = new CompanionEbookReconciler(db, settings, log);
  });

  afterEach(async () => {
    // Release anything a failed assertion left parked, THEN drain — the module-level semaphore
    // is shared by the whole file and must come back empty.
    for (const release of openGates.splice(0)) release();
    await reconciler.stop();
  });

  // -------------------------------------------------------------------------
  // Fixture helpers
  // -------------------------------------------------------------------------

  let bookSeq = 0;

  async function insertBook(
    overrides: {
      status?: 'imported' | 'wanted' | 'missing';
      path?: string | null;
      folder?: string;
      createDir?: boolean;
    } = {},
  ): Promise<number> {
    const folder = overrides.folder ?? `book-${++bookSeq}`;
    const bookPath = overrides.path === undefined ? join(libraryRoot, folder) : overrides.path;
    if (overrides.createDir !== false && bookPath !== null && bookPath.startsWith(libraryRoot)) {
      await mkdir(bookPath, { recursive: true });
    }
    const [row] = await db
      .insert(books)
      .values({
        publicId: generatePublicId('bk'),
        title: folder,
        status: overrides.status ?? 'imported',
        path: bookPath,
      })
      .returning({ id: books.id });
    return row!.id;
  }

  async function seedRow(bookId: number, values: Record<string, unknown> = {}): Promise<void> {
    await db.insert(companionEbooks).values({
      bookId,
      status: 'available',
      filename: 'book.epub',
      sizeBytes: 4096,
      mtimeMs: 1_700_000_000_000,
      ctimeMs: 1_700_000_000_500,
      candidateCount: 1,
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
      ...values,
    } as never);
  }

  async function readRow(bookId: number) {
    const rows = await db.select().from(companionEbooks).where(eq(companionEbooks.bookId, bookId));
    return rows[0] ?? null;
  }

  function abortReasons(): string[] {
    return debugRecords(spies)
      .filter((record) => typeof record.reason === 'string')
      .map((record) => record.reason as string);
  }

  // =========================================================================
  // A. The feature gate and the eligibility gate
  // =========================================================================

  describe('the feature gate (AC16)', () => {
    it('issues no prefilter, no per-book read, no observe, no write, and no summary when disabled (case 21)', async () => {
      enabled = false;
      const bookId = await insertBook();
      await seedRow(bookId);
      const selectSpy = vi.spyOn(db, 'select');

      await reconciler.reconcileAll();
      await reconciler.reconcileBook(bookId);

      // The books prefilter, the per-book snapshot, and the prior read are all `db.select`
      // calls; the settings reads go through the settings double, so this separates them
      // cleanly (F17).
      expect(selectSpy).not.toHaveBeenCalled();
      expect(findCompanionEbookMock).not.toHaveBeenCalled();
      expect(observeMock).not.toHaveBeenCalled();
      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      // A disabled reconcileAll never reaches the sweep-start instant, so it is not a sweep
      // and emits no summary (F18).
      expect(summaries(spies)).toEqual([]);
      selectSpy.mockRestore();
    });
  });

  describe('the eligibility gate (AC17)', () => {
    it.each([
      { name: 'a missing book', make: () => insertBook({ status: 'missing' }) },
      { name: 'a null path', make: () => insertBook({ path: null }) },
      { name: 'a path outside the library root', make: () => insertBook({ path: join(dir, 'elsewhere') }) },
      { name: 'a path that is a file, not a directory', make: async () => {
        const filePath = join(libraryRoot, 'not-a-folder.txt');
        await writeFile(filePath, 'x');
        return insertBook({ path: filePath, createDir: false });
      } },
    ])('leaves the existing row byte-identical for $name (case 22)', async ({ make }) => {
      const bookId = await make();
      await seedRow(bookId);
      const before = await readRow(bookId);

      await reconciler.reconcileBook(bookId);

      expect(observeMock).not.toHaveBeenCalled();
      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      expect(await readRow(bookId)).toEqual(before);
    });
  });

  // =========================================================================
  // B. The lock boundary (AC18)
  // =========================================================================

  describe('per-book serialization (AC18)', () => {
    it('acquires the lock exactly once and does every read and the write inside it (case 23)', async () => {
      const bookId = await insertBook();
      // Order the DB reads into the event log by wrapping the two read seams.
      findCompanionEbookMock.mockImplementation(async (x, id) => {
        hoisted.events.push(`prior:${id}`);
        const actual = await vi.importActual<typeof import('./companion-ebook.repository.js')>('./companion-ebook.repository.js');
        return actual.findCompanionEbook(x, id);
      });
      upsertCompanionEbookMock.mockImplementation(async (x, id, observation) => {
        hoisted.events.push(`write:${id}`);
        const actual = await vi.importActual<typeof import('./companion-ebook.repository.js')>('./companion-ebook.repository.js');
        return actual.upsertCompanionEbook(x, id, observation);
      });

      await reconciler.reconcileBook(bookId);

      expect(withBookAdmissionLockMock).toHaveBeenCalledTimes(1);
      expect(withBookAdmissionLockMock.mock.calls[0]![0]).toBe(bookId);

      const held = hoisted.events.indexOf(`lock.held:${bookId}`);
      const released = hoisted.events.indexOf(`lock.release:${bookId}`);
      expect(held).toBeGreaterThanOrEqual(0);
      for (const event of [`prior:${bookId}`, `observe:${bookId}`, `write:${bookId}`]) {
        const at = hoisted.events.indexOf(event);
        expect(at).toBeGreaterThan(held);
        expect(at).toBeLessThan(released);
      }
    });

    it('re-reads the snapshot INSIDE the lock, so a queued call observes the committed row (case 24)', async () => {
      const bookId = await insertBook();
      const gate = deferred();
      const priors: Array<unknown> = [];
      findCompanionEbookMock.mockImplementation(async (x, id) => {
        const actual = await vi.importActual<typeof import('./companion-ebook.repository.js')>('./companion-ebook.repository.js');
        const row = await actual.findCompanionEbook(x, id);
        // Only record the pre-scan read (the one taken outside a transaction).
        if (x === db) priors.push(row);
        return row;
      });

      let first = true;
      outcomes.set(bookId, async () => {
        if (first) { first = false; await gate.promise; }
        return OBSERVED;
      });

      const a = reconciler.reconcileBook(bookId);
      await flush(3);
      const b = reconciler.reconcileBook(bookId);
      await flush(3);

      gate.resolve();
      await Promise.all([a, b]);

      // A read hoisted out of the lock would have handed B the same `null` A saw; inside the
      // lock B sees A's committed row and therefore does NOT abort on a stale precondition.
      expect(priors).toHaveLength(2);
      expect(priors[0]).toBeNull();
      expect(priors[1]).toMatchObject({ bookId, status: 'available' });
      expect(abortReasons()).toEqual([]);
      expect(upsertCompanionEbookMock).toHaveBeenCalledTimes(2);
    });

    it('re-reads path and status inside the lock on the SWEEP path too (F21)', async () => {
      const gate = deferred();
      for (let i = 0; i < RECONCILE_CONCURRENCY; i++) {
        const bookId = await insertBook();
        outcomes.set(bookId, async () => { await gate.promise; return OBSERVED; });
      }
      // Queued behind the four saturated slots, so its locked snapshot read has not run yet.
      const target = await insertBook();

      const sweep = reconciler.reconcileAll();
      await flush();
      // The AC21 prefilter has already returned this id; the authoritative row moves afterwards.
      await db.update(books).set({ status: 'wanted' }).where(eq(books.id, target));
      gate.resolve();
      await sweep;

      // The per-book pass re-read `status` under the lock, found it no longer `imported`, and
      // skipped — an implementation that carried the prefilter's stale row down would have
      // observed and written instead.
      expect(observeMock.mock.calls.map((call) => call[0].bookId)).not.toContain(target);
      expect(upsertCompanionEbookMock.mock.calls.map((call) => call[1])).not.toContain(target);
      expect(summaries(spies)[0]).toMatchObject({
        books: RECONCILE_CONCURRENCY + 1,
        observed: RECONCILE_CONCURRENCY,
        skipped: 1,
      });
    });
  });

  // =========================================================================
  // C. The conditional write (AC19)
  // =========================================================================

  describe('the conditional write (AC19)', () => {
    it('commits through the transaction handle, never the db (case 32)', async () => {
      const bookId = await insertBook();

      await reconciler.reconcileBook(bookId);

      expect(upsertCompanionEbookMock).toHaveBeenCalledTimes(1);
      const executor = upsertCompanionEbookMock.mock.calls[0]![0];
      expect(executor).not.toBe(db);
      expect(await readRow(bookId)).toMatchObject({ status: 'available', filename: 'book.epub' });
    });

    it('opens no transaction for `unchanged` or `retain` (case 33/AC20)', async () => {
      const unchangedId = await insertBook();
      const retainId = await insertBook();
      await seedRow(unchangedId);
      await seedRow(retainId);
      outcomes.set(unchangedId, { outcome: 'unchanged' });
      outcomes.set(retainId, { outcome: 'retain' });
      const before = await readRow(unchangedId);
      const transactionSpy = vi.spyOn(db, 'transaction');

      await reconciler.reconcileBook(unchangedId);
      await reconciler.reconcileBook(retainId);

      expect(transactionSpy).not.toHaveBeenCalled();
      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      // Not even an `updated_at` touch.
      expect(await readRow(unchangedId)).toEqual(before);
      transactionSpy.mockRestore();
    });

    it.each([
      {
        name: 'books.path changed during observe (case 25)',
        reason: 'book-changed',
        mutate: async (bookId: number) => {
          await db.update(books).set({ path: join(libraryRoot, 'moved') }).where(eq(books.id, bookId));
        },
      },
      {
        name: 'books.status moved imported → wanted during observe (case 26)',
        reason: 'book-changed',
        mutate: async (bookId: number) => {
          await db.update(books).set({ status: 'wanted' }).where(eq(books.id, bookId));
        },
      },
      {
        name: 'the books row is gone at write time (case 29)',
        reason: 'book-changed',
        mutate: async (bookId: number) => {
          await db.delete(books).where(eq(books.id, bookId));
        },
      },
    ])('aborts the write when $name', async ({ reason, mutate }) => {
      const bookId = await insertBook();
      outcomes.set(bookId, async () => { await mutate(bookId); return OBSERVED; });

      await reconciler.reconcileBook(bookId);

      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      expect(abortReasons()).toEqual([reason]);
    });

    it.each([
      {
        name: 'the fingerprint no longer matches the pre-scan prior (case 27)',
        seed: true,
        mutate: async (db_: Db, bookId: number) => {
          await db_.update(companionEbooks).set({ mtimeMs: 999 }).where(eq(companionEbooks.bookId, bookId));
        },
      },
      {
        name: 'the prior was null but a row exists at write time (case 28)',
        seed: false,
        mutate: async (db_: Db, bookId: number) => {
          await db_.insert(companionEbooks).values({ bookId, status: 'none', candidateCount: 0 });
        },
      },
      {
        name: 'the prior was non-null but the row is gone at write time (case 30)',
        seed: true,
        mutate: async (db_: Db, bookId: number) => {
          await db_.delete(companionEbooks).where(eq(companionEbooks.bookId, bookId));
        },
      },
      {
        name: 'ONLY validation_code differs — the eighth column (case 31)',
        seed: true,
        seedValues: { status: 'invalid' as const, validationCode: 'empty_spine' },
        mutate: async (db_: Db, bookId: number) => {
          await db_
            .update(companionEbooks)
            .set({ validationCode: 'truncated' })
            .where(eq(companionEbooks.bookId, bookId));
        },
      },
    ])('aborts the write when $name', async ({ seed, seedValues, mutate }) => {
      const bookId = await insertBook();
      if (seed) await seedRow(bookId, seedValues ?? {});
      const beforeRow = await readRow(bookId);
      outcomes.set(bookId, async () => { await mutate(db, bookId); return OBSERVED; });

      await reconciler.reconcileBook(bookId);

      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      expect(abortReasons()).toEqual(['observation-changed']);
      expect(await readRow(bookId)).not.toEqual(beforeRow);
    });
  });

  // =========================================================================
  // D. The sweep (AC21/AC22/AC24)
  // =========================================================================

  describe('the sweep', () => {
    it('selects its own eligible rows and never visits the rest (case 39)', async () => {
      const good = await insertBook();
      await insertBook({ status: 'wanted' });
      await insertBook({ status: 'missing' });
      await insertBook({ path: null });
      await insertBook({ path: '   ' });

      await reconciler.reconcileAll();

      expect(observeMock).toHaveBeenCalledTimes(1);
      expect(observeMock.mock.calls[0]![0].bookId).toBe(good);
      expect(summaries(spies)[0]).toMatchObject({ books: 1, observed: 1 });
    });

    it(`never runs more than ${RECONCILE_CONCURRENCY} per-book passes at once (case 37)`, async () => {
      const gate = deferred();
      let inFlight = 0;
      let peak = 0;
      for (let i = 0; i < 10; i++) {
        const bookId = await insertBook();
        outcomes.set(bookId, async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await gate.promise;
          inFlight--;
          return OBSERVED;
        });
      }

      const sweep = reconciler.reconcileAll();
      await flush();
      expect(peak).toBe(RECONCILE_CONCURRENCY);

      gate.resolve();
      await sweep;
      expect(peak).toBe(RECONCILE_CONCURRENCY);
      expect(observeMock).toHaveBeenCalledTimes(10);
    });

    it('takes a semaphore slot BEFORE the admission lock, never the reverse (F19)', async () => {
      await insertBook();

      await reconciler.reconcileAll();

      const acquired = hoisted.events.indexOf('semaphore.acquired');
      const locked = hoisted.events.findIndex((event) => event.startsWith('lock.acquire:'));
      expect(acquired).toBeGreaterThanOrEqual(0);
      expect(locked).toBeGreaterThan(acquired);
    });

    it('lets a direct reconcile past a fully saturated sweep semaphore (F20)', async () => {
      const gate = deferred();
      for (let i = 0; i < RECONCILE_CONCURRENCY; i++) {
        const bookId = await insertBook();
        outcomes.set(bookId, async () => { await gate.promise; return OBSERVED; });
      }

      const sweep = reconciler.reconcileAll();
      await flush();
      expect(hoisted.events.filter((e) => e === 'semaphore.acquired')).toHaveLength(RECONCILE_CONCURRENCY);

      // Inserted AFTER the prefilter returned, so this book belongs to no sweep and the slot
      // accounting below is only ever about the direct call.
      const direct = await insertBook();
      // Every slot is held by a parked sweep book; the direct call must not queue behind them.
      const directRun = reconciler.reconcileBook(direct);
      await flush();
      expect(hoisted.events).toContain(`lock.held:${direct}`);
      expect(hoisted.events.filter((e) => e === 'semaphore.wait')).toHaveLength(RECONCILE_CONCURRENCY);

      await directRun;
      expect(upsertCompanionEbookMock.mock.calls.map((call) => call[1])).toContain(direct);

      gate.resolve();
      await sweep;
    });

    it('does not abort the sweep when one book rejects (case 38/AC24)', async () => {
      const failing = await insertBook();
      const others = [await insertBook(), await insertBook()];
      outcomes.set(failing, async () => { throw new Error('observe exploded'); });

      await expect(reconciler.reconcileAll()).resolves.toBeUndefined();

      expect(observeMock).toHaveBeenCalledTimes(3);
      const written = upsertCompanionEbookMock.mock.calls.map((call) => call[1]);
      expect(written.sort()).toEqual([...others].sort());
      expect(summaries(spies)[0]).toMatchObject({ books: 3, observed: 2, failed: 1 });
    });
  });

  // =========================================================================
  // E. Single-flight, coalescing, and the chain (AC23)
  // =========================================================================

  describe('single-flight and coalescing (AC23)', () => {
    it('turns two concurrent calls into exactly two runs (case 34)', async () => {
      await insertBook();
      const gate = deferred();
      observeMock.mockImplementation(async () => { await gate.promise; return OBSERVED; });

      const a = reconciler.reconcileAll();
      await flush(3);
      const b = reconciler.reconcileAll();
      gate.resolve();
      await Promise.all([a, b]);

      expect(summaries(spies)).toHaveLength(2);
    });

    it('turns five calls arriving during one run into exactly two runs (case 35)', async () => {
      await insertBook();
      const gate = deferred();
      observeMock.mockImplementation(async () => { await gate.promise; return OBSERVED; });

      const first = reconciler.reconcileAll();
      await flush(3);
      const joined = [1, 2, 3, 4, 5].map(() => reconciler.reconcileAll());
      gate.resolve();
      await Promise.all([first, ...joined]);

      expect(summaries(spies)).toHaveLength(2);
    });

    it('keeps every joined caller pending until the follow-up it caused settles (case 36)', async () => {
      await insertBook();
      const firstGate = deferred();
      const followUpGate = deferred();
      let call = 0;
      observeMock.mockImplementation(async () => {
        call++;
        await (call === 1 ? firstGate.promise : followUpGate.promise);
        return OBSERVED;
      });

      const first = reconciler.reconcileAll();
      await flush(3);
      const joined = reconciler.reconcileAll();
      const joinedState = track(joined);

      firstGate.resolve();
      await flush();
      // The first sweep has finished and emitted its summary; the joined caller must still be
      // waiting on the follow-up it queued — counting sweeps alone would not catch this.
      expect(summaries(spies)).toHaveLength(1);
      expect(joinedState.settled).toBe(false);

      followUpGate.resolve();
      await Promise.all([first, joined]);
      expect(joinedState.settled).toBe(true);
      expect(summaries(spies)).toHaveLength(2);
    });

    it('emits one summary per started sweep and none for a direct reconcile (case 42)', async () => {
      const bookId = await insertBook();
      const gate = deferred();
      observeMock.mockImplementation(async () => { await gate.promise; return OBSERVED; });

      const first = reconciler.reconcileAll();
      await flush(3);
      const joined = reconciler.reconcileAll();
      gate.resolve();
      await Promise.all([first, joined]);
      expect(summaries(spies)).toHaveLength(2);

      spies.info.mockClear();
      await reconciler.reconcileBook(bookId);
      expect(summaries(spies)).toEqual([]);
    });

    it('coalesces calls that arrive while the FIRST run is still in setup (case 44)', async () => {
      await insertBook();
      const prefilterGate = deferred();
      const followUpGate = deferred();
      let observeCall = 0;
      observeMock.mockImplementation(async () => {
        // One book per sweep, so call 2 is the coalesced follow-up's only pass.
        if (++observeCall > 1) await followUpGate.promise;
        return OBSERVED;
      });
      const realSelect = db.select.bind(db);
      const selectSpy = vi.spyOn(db, 'select');
      selectSpy.mockImplementationOnce(((...args: unknown[]) => {
        const chain = (realSelect as unknown as (...a: unknown[]) => Record<string, unknown>)(...args);
        const from = chain.from as (...a: unknown[]) => Record<string, unknown>;
        chain.from = (...fromArgs: unknown[]) => {
          const next = from.apply(chain, fromArgs);
          const where = next.where as (...a: unknown[]) => Promise<unknown>;
          next.where = async (...whereArgs: unknown[]) => {
            await prefilterGate.promise;
            return where.apply(next, whereArgs);
          };
          return next;
        };
        return chain;
      }) as never);

      const first = reconciler.reconcileAll();
      await flush(3);
      const joined = [1, 2, 3].map(() => reconciler.reconcileAll());
      const joinedStates = joined.map(track);
      await flush(3);

      // No book run has started yet, so every `db.select` issued so far IS a prefilter: exactly
      // one setup ran, and the three later calls joined instead of issuing their own query.
      // That is what makes two simultaneous sweeps unreachable.
      expect(selectSpy).toHaveBeenCalledTimes(1);

      prefilterGate.resolve();
      await flush();
      // The first sweep has finished; the joined callers are still on the ONE follow-up their
      // three calls coalesced into.
      expect(summaries(spies)).toHaveLength(1);
      expect(joinedStates.some((state) => state.settled)).toBe(false);

      followUpGate.resolve();
      await Promise.all([first, ...joined]);
      expect(joinedStates.every((state) => state.settled)).toBe(true);
      expect(summaries(spies)).toHaveLength(2);
      selectSpy.mockRestore();
    });

    it('runs the settings reads once per run, not once per joined call (case 44/F29)', async () => {
      await insertBook();
      const gate = deferred();
      settingsGet.mockImplementation(async (key: string) => {
        if (key === 'companionEpub') return { enabled: true };
        if (key === 'library') { await gate.promise; return { path: libraryRoot }; }
        return {};
      });

      const first = reconciler.reconcileAll();
      await flush(3);
      const joined = [1, 2, 3].map(() => reconciler.reconcileAll());
      await flush(3);

      // Counting prefilters here would prove nothing — it is trivially zero while the settings
      // read is pending. The settings read itself is the assertion that pins "setup once".
      expect(settingsGet.mock.calls.filter((call) => call[0] === 'library')).toHaveLength(1);

      gate.resolve();
      await Promise.all([first, ...joined]);
      expect(summaries(spies)).toHaveLength(2);
    });
  });

  // =========================================================================
  // F. Setup failures (AC15)
  // =========================================================================

  describe('setup failures (AC15)', () => {
    it.each([
      { site: "settings.get('companionEpub')" },
      { site: "settings.get('library')" },
      { site: 'the AC21 prefilter query' },
    ])('resolves, warns once, and emits no summary when $site rejects (case 43)', async ({ site }) => {
      await insertBook();
      const error = new Error(`${site} is down`);
      let selectSpy: ReturnType<typeof vi.spyOn> | undefined;

      if (site === "settings.get('companionEpub')") {
        settingsGet.mockImplementation(async (key: string) => {
          if (key === 'companionEpub') throw error;
          return { path: libraryRoot };
        });
      } else if (site === "settings.get('library')") {
        settingsGet.mockImplementation(async (key: string) => {
          if (key === 'companionEpub') return { enabled: true };
          throw error;
        });
      } else {
        selectSpy = vi.spyOn(db, 'select').mockImplementationOnce((() => { throw error; }) as never);
      }

      await expect(reconciler.reconcileAll()).resolves.toBeUndefined();

      expect(spies.warn).toHaveBeenCalledTimes(1);
      expect(spies.warn.mock.calls[0]![0]).toMatchObject({
        error: expect.objectContaining({ message: error.message, type: 'Error' }),
      });
      // In particular NO `books: 0` summary — that would fabricate a denominator AC25's
      // sweep-start definition says cannot exist.
      expect(summaries(spies)).toEqual([]);
      expect(observeMock).not.toHaveBeenCalled();
      selectSpy?.mockRestore();
    });

    it('never rejects from either public method, whatever fails (F7)', async () => {
      const bookId = await insertBook();

      // (a) before the lock — the prior read.
      findCompanionEbookMock.mockRejectedValueOnce(new Error('prior read failed'));
      await expect(reconciler.reconcileBook(bookId)).resolves.toBeUndefined();

      // (b) inside the per-book pass — observe itself.
      outcomes.set(bookId, async () => { throw new Error('observe failed'); });
      await expect(reconciler.reconcileBook(bookId)).resolves.toBeUndefined();
      await expect(reconciler.reconcileAll()).resolves.toBeUndefined();

      // (c) inside the transaction — the guarded upsert.
      outcomes.delete(bookId);
      upsertCompanionEbookMock.mockRejectedValueOnce(new Error('upsert failed'));
      await expect(reconciler.reconcileBook(bookId)).resolves.toBeUndefined();

      // (d) the sweep query itself.
      const selectSpy = vi.spyOn(db, 'select').mockImplementationOnce((() => { throw new Error('query failed'); }) as never);
      await expect(reconciler.reconcileAll()).resolves.toBeUndefined();
      selectSpy.mockRestore();

      // Per-book failures stay at `debug`; they are already info-visible through the summary.
      expect(summaries(spies).some((summary) => summary.failed === 1)).toBe(true);
    });
  });

  // =========================================================================
  // G. The summary (AC25)
  // =========================================================================

  describe('the sweep summary (AC25)', () => {
    const FIELDS = [
      'books', 'observed', 'unchanged', 'retained', 'conflicted', 'skipped', 'failed', 'stopped', 'durationMs',
    ];

    it('emits exactly one nine-field record for an empty sweep', async () => {
      await reconciler.reconcileAll();

      const records = summaries(spies);
      expect(records).toHaveLength(1);
      expect(Object.keys(records[0]!).sort()).toEqual([...FIELDS].sort());
      expect(records[0]).toMatchObject({ books: 0, observed: 0, unchanged: 0, retained: 0, conflicted: 0, skipped: 0, failed: 0, stopped: 0 });
      expect(typeof records[0]!.durationMs).toBe('number');
    });

    it.each([
      { bucket: 'observed', outcome: OBSERVED, seed: false },
      { bucket: 'unchanged', outcome: { outcome: 'unchanged' } as CompanionObserveResult, seed: true },
      { bucket: 'retained', outcome: { outcome: 'retain' } as CompanionObserveResult, seed: true },
    ])('counts a $bucket book in its own bucket and no other (case 41/F16)', async ({ bucket, outcome, seed }) => {
      const bookId = await insertBook();
      if (seed) await seedRow(bookId);
      outcomes.set(bookId, outcome);

      await reconciler.reconcileAll();

      const record = summaries(spies)[0]!;
      expect(record).toMatchObject({ books: 1, [bucket]: 1 });
      expectTotalInvariant(record);
      for (const other of ['observed', 'unchanged', 'retained', 'conflicted', 'skipped', 'failed', 'stopped']) {
        if (other !== bucket) expect(record[other]).toBe(0);
      }
    });

    it('counts a computed-then-aborted observation as conflicted and NOT observed (case 41)', async () => {
      const bookId = await insertBook();
      outcomes.set(bookId, async () => {
        await db.update(books).set({ status: 'wanted' }).where(eq(books.id, bookId));
        return OBSERVED;
      });

      await reconciler.reconcileAll();

      const record = summaries(spies)[0]!;
      expect(record).toMatchObject({ books: 1, conflicted: 1, observed: 0 });
      expectTotalInvariant(record);
    });

    it('counts an eligibility refusal as skipped (case 41/F16)', async () => {
      // Passes the AC21 prefilter (imported, non-blank path) but its folder does not exist, so
      // `isCompanionEbookEligible` refuses on the directory probe.
      await insertBook({ createDir: false });

      await reconciler.reconcileAll();

      const record = summaries(spies)[0]!;
      expect(record).toMatchObject({ books: 1, skipped: 1, observed: 0 });
      expectTotalInvariant(record);
      expect(observeMock).not.toHaveBeenCalled();
    });

    it('counts a book whose row is gone at snapshot time as skipped (case 41/F16)', async () => {
      const gate = deferred();
      for (let i = 0; i < RECONCILE_CONCURRENCY; i++) {
        const bookId = await insertBook();
        outcomes.set(bookId, async () => { await gate.promise; return OBSERVED; });
      }
      // Queued behind the four saturated slots, so its locked snapshot read has not run yet.
      const vanishing = await insertBook();

      const sweep = reconciler.reconcileAll();
      await flush();
      await db.delete(books).where(eq(books.id, vanishing));
      gate.resolve();
      await sweep;

      const record = summaries(spies)[0]!;
      expect(record).toMatchObject({ books: RECONCILE_CONCURRENCY + 1, observed: RECONCILE_CONCURRENCY, skipped: 1 });
      expectTotalInvariant(record);
    });

    it('counts a failing book run as failed', async () => {
      const bookId = await insertBook();
      outcomes.set(bookId, async () => { throw new Error('boom'); });

      await reconciler.reconcileAll();

      const record = summaries(spies)[0]!;
      expect(record).toMatchObject({ books: 1, failed: 1 });
      expectTotalInvariant(record);
    });

    it('counts books the drain refused as stopped (case 41)', async () => {
      const gate = deferred();
      const first = await insertBook();
      for (let i = 0; i < 6; i++) {
        const bookId = await insertBook();
        if (bookId !== first) outcomes.set(bookId, async () => { await gate.promise; return OBSERVED; });
      }
      outcomes.set(first, async () => { await gate.promise; return OBSERVED; });

      const sweep = reconciler.reconcileAll();
      await flush();
      const stopping = reconciler.stop();
      gate.resolve();
      await Promise.all([sweep, stopping]);

      const record = summaries(spies)[0]!;
      expect(record.stopped).toBeGreaterThan(0);
      expectTotalInvariant(record);
    });

    function expectTotalInvariant(record: Record<string, unknown>): void {
      const sum = ['observed', 'unchanged', 'retained', 'conflicted', 'skipped', 'failed', 'stopped']
        .reduce((total, key) => total + (record[key] as number), 0);
      expect(sum).toBe(record.books);
    }
  });

  // =========================================================================
  // H. The drain (AC26)
  // =========================================================================

  describe('stop() (AC26)', () => {
    it('starts no further sweep books once stopping (case 40a)', async () => {
      const gate = deferred();
      for (let i = 0; i < 8; i++) {
        const bookId = await insertBook();
        outcomes.set(bookId, async () => { await gate.promise; return OBSERVED; });
      }

      const sweep = reconciler.reconcileAll();
      await flush();
      const started = observeMock.mock.calls.length;
      expect(started).toBe(RECONCILE_CONCURRENCY);

      const stopping = reconciler.stop();
      gate.resolve();
      await Promise.all([sweep, stopping]);

      expect(observeMock.mock.calls.length).toBe(started);
    });

    it('awaits a direct in-flight reconcileBook with no sweep active (case 40b)', async () => {
      const bookId = await insertBook();
      const gate = deferred();
      outcomes.set(bookId, async () => { await gate.promise; return OBSERVED; });

      const direct = reconciler.reconcileBook(bookId);
      await flush(4);
      const stopping = reconciler.stop();
      const stopState = track(stopping);
      await flush();
      expect(stopState.settled).toBe(false);

      gate.resolve();
      await Promise.all([direct, stopping]);
      expect(stopState.settled).toBe(true);
      expect(await readRow(bookId)).toMatchObject({ status: 'available' });
    });

    it('makes both public methods no-ops after the drain resolves (cases 40c/40d)', async () => {
      const bookId = await insertBook();
      await reconciler.stop();

      await expect(reconciler.reconcileAll()).resolves.toBeUndefined();
      await expect(reconciler.reconcileBook(bookId)).resolves.toBeUndefined();
      expect(settingsGet).not.toHaveBeenCalled();
      expect(observeMock).not.toHaveBeenCalled();
      expect(summaries(spies)).toEqual([]);
    });

    it('is memoized on literal Promise identity, not merely on the drain (case 40e)', () => {
      const a = reconciler.stop();
      const b = reconciler.stop();

      // Asserted BEFORE awaiting either: an `async stop()` allocates a fresh outer promise per
      // call and fails only this assertion while passing every other one in this suite.
      expect(a).toBe(b);
    });

    it('returns `stopped` from a book run that reaches the lock after stopping (case 40f)', async () => {
      const gate = deferred();
      const blocker = await insertBook();
      const late = await insertBook();
      outcomes.set(blocker, async () => { await gate.promise; return OBSERVED; });

      // Hold the LATE book's lock from outside so its run parks before check 3.
      const lockGate = deferred();
      const actual = await vi.importActual<typeof import('./book-admission.js')>('./book-admission.js');
      const holding = actual.withBookAdmissionLock(late, async () => { await lockGate.promise; });

      const direct = reconciler.reconcileBook(late);
      await flush(3);
      void blocker;

      const stopping = reconciler.stop();
      lockGate.resolve();
      gate.resolve();
      await Promise.all([holding, direct, stopping]);

      expect(observeMock).not.toHaveBeenCalled();
      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
    });

    it('discards a queued follow-up rather than running it (case 40g)', async () => {
      await insertBook();
      const gate = deferred();
      observeMock.mockImplementation(async () => { await gate.promise; return OBSERVED; });
      const selectSpy = vi.spyOn(db, 'select');

      const first = reconciler.reconcileAll();
      await flush(3);
      const prefiltersAfterFirst = selectSpy.mock.calls.length;
      const joined = reconciler.reconcileAll();
      const joinedState = track(joined);

      const stopping = reconciler.stop();
      gate.resolve();
      await Promise.all([first, joined, stopping]);

      // B never ran: no second prefilter, one summary (A's), and the joined caller RESOLVED
      // rather than hanging on a follow-up that will never exist.
      expect(selectSpy.mock.calls.length).toBe(prefiltersAfterFirst);
      expect(summaries(spies)).toHaveLength(1);
      expect(joinedState.settled).toBe(true);
      expect(joinedState.rejected).toBe(false);
      selectSpy.mockRestore();
    });

    it('registers a direct book run synchronously, before its first await (F22)', async () => {
      const bookId = await insertBook();
      const settingsGate = deferred();
      settingsGet.mockImplementation(async (key: string) => {
        if (key === 'companionEpub') { await settingsGate.promise; return { enabled: true }; }
        return { path: libraryRoot };
      });

      // Same synchronous turn, no yield in between.
      const direct = reconciler.reconcileBook(bookId);
      const stopping = reconciler.stop();
      const stopState = track(stopping);
      await flush();
      expect(stopState.settled).toBe(false);

      settingsGate.resolve();
      await Promise.all([direct, stopping]);
      expect(stopState.settled).toBe(true);
    });

    it.each([
      { site: 'the prefilter query' },
      { site: 'a settings read' },
    ])('stays pending through a run parked on $site and lets no sweep begin (case 45)', async ({ site }) => {
      await insertBook();
      const gate = deferred();
      let selectSpy: ReturnType<typeof vi.spyOn> | undefined;

      if (site === 'a settings read') {
        settingsGet.mockImplementation(async (key: string) => {
          if (key === 'companionEpub') return { enabled: true };
          await gate.promise;
          return { path: libraryRoot };
        });
      } else {
        const realSelect = db.select.bind(db);
        selectSpy = vi.spyOn(db, 'select');
        selectSpy.mockImplementationOnce(((...args: unknown[]) => {
          const chain = (realSelect as unknown as (...a: unknown[]) => Record<string, unknown>)(...args);
          const from = chain.from as (...a: unknown[]) => Record<string, unknown>;
          chain.from = (...fromArgs: unknown[]) => {
            const next = from.apply(chain, fromArgs);
            const where = next.where as (...a: unknown[]) => Promise<unknown>;
            next.where = async (...whereArgs: unknown[]) => {
              await gate.promise;
              return where.apply(next, whereArgs);
            };
            return next;
          };
          return chain;
        }) as never);
      }

      const run = reconciler.reconcileAll();
      await flush(3);
      const stopping = reconciler.stop();
      const stopState = track(stopping);
      await flush();
      expect(stopState.settled).toBe(false);

      // The query RETURNS rows after stop() — the run must still refuse to accept them.
      gate.resolve();
      await Promise.all([run, stopping]);

      expect(stopState.settled).toBe(true);
      expect(observeMock).not.toHaveBeenCalled();
      expect(summaries(spies)).toEqual([]);
      selectSpy?.mockRestore();
    });

    it('settles a discarded joiner on the RUN, not on a sweep that never existed (case 46)', async () => {
      await insertBook();
      const gate = deferred();
      settingsGet.mockImplementation(async (key: string) => {
        if (key === 'companionEpub') return { enabled: true };
        await gate.promise;
        return { path: libraryRoot };
      });

      const a = reconciler.reconcileAll();
      await flush(3);
      const b = reconciler.reconcileAll();
      const bState = track(b);
      const stopping = reconciler.stop();

      gate.resolve();
      await Promise.all([a, b, stopping]);

      expect(bState.settled).toBe(true);
      expect(bState.rejected).toBe(false);
      expect(observeMock).not.toHaveBeenCalled();
      expect(summaries(spies)).toEqual([]);
    });
  });
});
