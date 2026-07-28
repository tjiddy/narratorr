import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, companionEbooks } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import type { SettingsService } from './settings.service.js';
import { CompanionEbookReconciler, RECONCILE_CONCURRENCY } from './companion-ebook-reconciler.js';
import { CAN_SYMLINK, removeDirTolerant } from '../__tests__/windows-fs.js';
import {
  observeCompanionEbook,
  revalidateCompanionFile,
  statRegularFile,
} from './companion-ebook-observe.js';
import { findCompanionEbookCandidates } from './companion-ebook-discovery.js';
import { resolveCompanionEbookPath } from './companion-ebook-open.js';
import { findCompanionEbook, upsertCompanionEbook } from './companion-ebook.repository.js';
import { withBookAdmissionLock } from './book-admission.js';
import type { CompanionObserveResult, CompanionRevalidateResult } from './companion-ebook-observe.js';
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

/**
 * All THREE runtime exports, not just the one the sweep uses. The factory REPLACES the module
 * rather than spreading it, so a missing entry fails every case in this file at module load
 * with *"No export is defined on the mock"* — and #1976's selector imports `statRegularFile`
 * (step 7) and `revalidateCompanionFile` (step 8) from here. `Fingerprint` and
 * `CompanionRevalidateInput` are types; `verbatimModuleSyntax` erases them, so they need no
 * entry (F19).
 */
vi.mock('./companion-ebook-observe.js', () => ({
  observeCompanionEbook: vi.fn(),
  statRegularFile: vi.fn(),
  revalidateCompanionFile: vi.fn(),
}));

/**
 * Discovery and the path resolver are the selector's other two collaborators. Both are
 * DELEGATING spies over the real implementations: the selection cases below run against real
 * temp directories, so `gone`/`undetermined`/`out_of_range` stay drivable by arranging the
 * filesystem, while the `unresolvable` TOCTOU case can swap a file mid-call and still let the
 * REAL resolver produce the outcome.
 */
vi.mock('./companion-ebook-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./companion-ebook-discovery.js')>();
  return { ...actual, findCompanionEbookCandidates: vi.fn(actual.findCompanionEbookCandidates) };
});

vi.mock('./companion-ebook-open.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./companion-ebook-open.js')>();
  return { ...actual, resolveCompanionEbookPath: vi.fn(actual.resolveCompanionEbookPath) };
});

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
const statRegularFileMock = vi.mocked(statRegularFile);
const revalidateCompanionFileMock = vi.mocked(revalidateCompanionFile);
const findCompanionEbookCandidatesMock = vi.mocked(findCompanionEbookCandidates);
const resolveCompanionEbookPathMock = vi.mocked(resolveCompanionEbookPath);
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

/**
 * Poll until the system has reached a named state.
 *
 * Every "arrange" step in this suite drives real async work — libSQL round-trips and real
 * `setTimeout` ticks — so a fixed number of `flush()` rounds is a bet on machine speed that
 * loses under a loaded full-suite run. `waitUntil` is used to REACH a state; `flush()` is kept
 * only for the quiet period that follows, where the assertion is that nothing further happened.
 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 3_000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** How many per-book passes have entered `observeCompanionEbook` so far. */
function observedCount(): number {
  return hoisted.events.filter((event) => event.startsWith('observe:')).length;
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

/**
 * Assert a logged `error` value is the output of `serializeError`, not the caught `Error`.
 *
 * The own-ENUMERABLE key set is what makes this discriminating: on a real `Error`, `message`
 * and `stack` are non-enumerable, so a `toMatchObject`/`objectContaining({ message })` matcher
 * reads through to them and passes on a raw `Error` too. Mirrors `companion-ebook-open.test.ts`.
 */
function expectSerializedError(logged: unknown, original: Error, expected: { code?: string }): void {
  expect(logged).not.toBe(original);
  expect(logged).not.toBeInstanceOf(Error);
  expect(Object.keys(logged as object).sort()).toEqual(
    expected.code === undefined ? ['message', 'stack', 'type'] : ['code', 'message', 'stack', 'type'],
  );
  expect(logged).toEqual({
    message: original.message,
    stack: expect.stringContaining(original.message),
    type: 'Error',
    ...(expected.code !== undefined && { code: expected.code }),
  });
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
    // Tolerant on Windows: the libSQL handle keeps the dir undeletable (EPERM).
    removeDirTolerant(dir);
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

    // The two new observe-module exports default to the REAL implementations, so a selection
    // case that does not care about them runs against the real filesystem and the real
    // validator. `vi.fn()` in the factory carries no implementation, unlike the delegating
    // spies elsewhere in this file, so they must be installed here every time.
    const actualObserve = await vi.importActual<typeof import('./companion-ebook-observe.js')>(
      './companion-ebook-observe.js',
    );
    statRegularFileMock.mockImplementation(actualObserve.statRegularFile);
    revalidateCompanionFileMock.mockImplementation(actualObserve.revalidateCompanionFile);

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
      await waitUntil(() => observedCount() === 1, 'A to park inside its observe pass');
      const b = reconciler.reconcileBook(bookId);
      await waitUntil(() => hoisted.events.includes(`lock.acquire:${bookId}`) && priors.length === 1, 'B to queue on the lock');

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
      await waitUntil(() => observedCount() === RECONCILE_CONCURRENCY, 'the sweep to saturate its slots');
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
    ])('aborts the write when $name', async ({ seed, mutate }) => {
      const bookId = await insertBook();
      if (seed) await seedRow(bookId);
      const beforeRow = await readRow(bookId);
      outcomes.set(bookId, async () => { await mutate(db, bookId); return OBSERVED; });

      await reconciler.reconcileBook(bookId);

      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      expect(abortReasons()).toEqual(['observation-changed']);
      expect(await readRow(bookId)).not.toEqual(beforeRow);
    });

    /**
     * One row per material column of the AC19 observation guard, so deleting ANY single
     * comparison in `sameObservationRow` fails a named case (cases 27/31, F7). Every patch is a
     * legal single-column move under the eight CHECK constraints: `candidateCount` is bumped
     * from an already-selected multi-candidate seed (`ck_companion_ebooks_multi_candidate_selection`),
     * and `validationCode` moves within an `invalid` seed (`ck_companion_ebooks_validation_code`).
     */
    it.each([
      { column: 'status', seedValues: {}, patch: { status: 'drm_protected' as const } },
      { column: 'filename', seedValues: {}, patch: { filename: 'a-different.epub' } },
      { column: 'sizeBytes', seedValues: {}, patch: { sizeBytes: 8_192 } },
      { column: 'mtimeMs', seedValues: {}, patch: { mtimeMs: 999 } },
      { column: 'ctimeMs', seedValues: {}, patch: { ctimeMs: 999 } },
      {
        column: 'validationCode',
        seedValues: { status: 'invalid' as const, validationCode: 'empty_spine' },
        patch: { validationCode: 'truncated' },
      },
      {
        column: 'candidateCount',
        seedValues: { candidateCount: 2, selectedFilename: 'book.epub' },
        patch: { candidateCount: 3 },
      },
      { column: 'selectedFilename', seedValues: {}, patch: { selectedFilename: 'book.epub' } },
    ])('aborts the write when a concurrent writer moved only $column (case 27/31, F7)', async ({ seedValues, patch }) => {
      const bookId = await insertBook();
      await seedRow(bookId, seedValues);
      const beforeRow = await readRow(bookId);
      outcomes.set(bookId, async () => {
        await db.update(companionEbooks).set(patch).where(eq(companionEbooks.bookId, bookId));
        return OBSERVED;
      });

      await reconciler.reconcileBook(bookId);

      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      expect(abortReasons()).toEqual(['observation-changed']);
      // The concurrent writer's value survived intact — the pass wrote nothing over it.
      const afterRow = await readRow(bookId);
      expect(afterRow).not.toEqual(beforeRow);
      expect(afterRow).toMatchObject(patch);
    });

    it('queues the guarded write behind an unrelated transaction on the same connection (F8/F12)', async () => {
      const bookId = await insertBook();
      const gate = deferred();
      const events: string[] = [];

      // A plain `db.transaction` — the shape every other service in the codebase uses, and one
      // that knows nothing about the reconciler or about any serialization helper. That is the
      // point: the exclusion must hold for callers that never opted in.
      const otherService = db.transaction(async () => {
        events.push('other:start');
        await gate.promise;
        events.push('other:end');
      });
      upsertCompanionEbookMock.mockImplementation(async (x, id, observation) => {
        events.push('companion:write');
        const actual = await vi.importActual<typeof import('./companion-ebook.repository.js')>('./companion-ebook.repository.js');
        return actual.upsertCompanionEbook(x, id, observation);
      });

      const reconcile = reconciler.reconcileBook(bookId);
      await flush();
      // Without connection-level serialization the companion transaction opens right here,
      // overlapping the other one, and loses to SQLITE_BUSY.
      expect(events).toEqual(['other:start']);

      gate.resolve();
      await Promise.all([otherService, reconcile]);
      expect(events).toEqual(['other:start', 'other:end', 'companion:write']);
      expect(await readRow(bookId)).toMatchObject({ status: 'available' });
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
      await waitUntil(() => inFlight === RECONCILE_CONCURRENCY, 'the sweep to saturate its slots');
      // Then a quiet period: a fifth pass would push `peak` past the bound.
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
      await waitUntil(() => observedCount() === RECONCILE_CONCURRENCY, 'the sweep to saturate its slots');
      expect(hoisted.events.filter((e) => e === 'semaphore.acquired')).toHaveLength(RECONCILE_CONCURRENCY);

      // Inserted AFTER the prefilter returned, so this book belongs to no sweep and the slot
      // accounting below is only ever about the direct call.
      const direct = await insertBook();
      // Every slot is held by a parked sweep book; the direct call must not queue behind them.
      const directRun = reconciler.reconcileBook(direct);
      await waitUntil(() => hoisted.events.includes(`lock.held:${direct}`), 'the direct call to reach its lock');
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
      await waitUntil(() => observeMock.mock.calls.length >= 1, 'the first run to reach its sweep phase');
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
      await waitUntil(() => observeMock.mock.calls.length >= 1, 'the first run to reach its sweep phase');
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
      await waitUntil(() => observeMock.mock.calls.length >= 1, 'the first run to reach its sweep phase');
      const joined = reconciler.reconcileAll();
      const joinedState = track(joined);

      firstGate.resolve();
      await waitUntil(() => summaries(spies).length === 1, "the first sweep's summary");
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
      await waitUntil(() => observeMock.mock.calls.length >= 1, 'the first run to reach its sweep phase');
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
      await waitUntil(() => selectSpy.mock.calls.length >= 1, 'the first run to issue its prefilter');
      const joined = [1, 2, 3].map(() => reconciler.reconcileAll());
      const joinedStates = joined.map(track);
      await flush(3);

      // No book run has started yet, so every `db.select` issued so far IS a prefilter: exactly
      // one setup ran, and the three later calls joined instead of issuing their own query.
      // That is what makes two simultaneous sweeps unreachable.
      expect(selectSpy).toHaveBeenCalledTimes(1);

      prefilterGate.resolve();
      await waitUntil(() => summaries(spies).length === 1, "the first sweep's summary");
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
      await waitUntil(
        () => settingsGet.mock.calls.some((call) => call[0] === 'library'),
        "the first run to park on settings.get('library')",
      );
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

    /**
     * `reconcileBook()`'s setup catch is a SEPARATE catch from the sweep's, and the table above
     * arms both settings sites only for `reconcileAll()` (F11). Deleting the direct catch makes
     * the fire-and-forget entry point reject during either settings read — an unhandled
     * rejection behind an already-returned response — while every other case here stays green.
     *
     * Both sites are armed here, and the assertions cover the whole AC15 contract for the direct
     * path: the promise resolves, exactly one `warn` carries `bookId` plus `serializeError`, and
     * the failure happens early enough that no lock, no DB read, and no filesystem pass occurs.
     */
    it.each([
      { site: "settings.get('companionEpub')", failing: 'companionEpub' },
      { site: "settings.get('library')", failing: 'library' },
    ])('resolves and warns once when a direct reconcileBook hits a rejecting $site (F11)', async ({ failing }) => {
      const bookId = await insertBook();
      const error = Object.assign(new Error(`${failing} read failed`), { code: 'SQLITE_IOERR' });
      settingsGet.mockImplementation(async (key: string) => {
        if (key === failing) throw error;
        if (key === 'companionEpub') return { enabled: true };
        return { path: libraryRoot };
      });
      const selectSpy = vi.spyOn(db, 'select');

      await expect(reconciler.reconcileBook(bookId)).resolves.toBeUndefined();

      expect(spies.warn).toHaveBeenCalledTimes(1);
      const record = spies.warn.mock.calls[0]![0] as Record<string, unknown>;
      expect(record).toMatchObject({ bookId });
      expectSerializedError(record.error, error, { code: 'SQLITE_IOERR' });

      // Setup precedes every other step, so none of them may have run.
      expect(withBookAdmissionLockMock).not.toHaveBeenCalled();
      expect(selectSpy).not.toHaveBeenCalled();
      expect(findCompanionEbookMock).not.toHaveBeenCalled();
      expect(observeMock).not.toHaveBeenCalled();
      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      // A direct call is not a sweep and never emits one.
      expect(summaries(spies)).toEqual([]);
      selectSpy.mockRestore();
    });

    /**
     * The three per-book rejection sites, each asserted on the RECORD the failure leaves behind
     * and not merely on the promise resolving (F1). The `debug` level, the `bookId`, the
     * exactly-once count, and the `serializeError` shape are the whole diagnostic contract for a
     * per-book failure — it is the only trace of it besides the summary's `failed` counter, so
     * losing, duplicating, or raw-logging it has to fail here.
     */
    it.each([
      {
        site: 'the pre-scan prior read',
        arm: (error: Error) => { findCompanionEbookMock.mockRejectedValueOnce(error); },
      },
      {
        site: 'the observe pass',
        arm: (error: Error) => { observeMock.mockRejectedValueOnce(error); },
      },
      {
        site: 'the guarded upsert inside the transaction',
        arm: (error: Error) => { upsertCompanionEbookMock.mockRejectedValueOnce(error); },
      },
    ])('resolves and logs exactly one canonical debug record when $site rejects (F1)', async ({ site, arm }) => {
      const bookId = await insertBook();
      const error = Object.assign(new Error(`${site} failed`), { code: 'EIO' });
      arm(error);

      await expect(reconciler.reconcileBook(bookId)).resolves.toBeUndefined();

      const failureRecords = debugRecords(spies).filter((record) => 'error' in record);
      expect(failureRecords).toHaveLength(1);
      expect(failureRecords[0]).toMatchObject({ bookId });
      expectSerializedError(failureRecords[0]!.error, error, { code: 'EIO' });
      // `debug`, never `warn`: a per-book failure is already info-visible through the summary.
      expect(spies.warn).not.toHaveBeenCalled();
    });

    it('counts a per-book failure once in the sweep summary while still resolving (F1)', async () => {
      const bookId = await insertBook();
      const error = new Error('observe failed');
      outcomes.set(bookId, async () => { throw error; });

      await expect(reconciler.reconcileAll()).resolves.toBeUndefined();

      const failureRecords = debugRecords(spies).filter((record) => 'error' in record);
      expect(failureRecords).toHaveLength(1);
      expect(failureRecords[0]).toMatchObject({ bookId });
      expectSerializedError(failureRecords[0]!.error, error, {});
      expect(summaries(spies)[0]).toMatchObject({ books: 1, failed: 1 });
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

    /**
     * `durationMs` must be the SWEEP PHASE's elapsed wall time, and a `typeof === 'number'`
     * assertion proves none of that (F2). The clock below is driven by hand and advanced by two
     * different amounts on the two sides of the sweep-start instant, so exactly one value is
     * correct and each way of getting it wrong produces a different, named wrong answer:
     *
     * - hard-coded `0`  → 0, not 7_000
     * - setup included  → 100_000 + 7_000
     * - reversed delta  → -7_000
     * - measured across the whole run rather than the sweep → 107_000
     */
    it('reports the sweep-phase elapsed time, excluding setup (case 41/F2)', async () => {
      const SETUP_MS = 100_000;
      const SWEEP_MS = 7_000;
      let now = 1_600_000_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

      const bookId = await insertBook();
      // Setup burns wall-clock time BEFORE the sweep-start instant.
      settingsGet.mockImplementation(async (key: string) => {
        if (key === 'companionEpub') return { enabled: true };
        now += SETUP_MS;
        return { path: libraryRoot };
      });
      outcomes.set(bookId, async () => { now += SWEEP_MS; return OBSERVED; });

      await reconciler.reconcileAll();

      expect(summaries(spies)[0]).toMatchObject({ books: 1, observed: 1, durationMs: SWEEP_MS });
      nowSpy.mockRestore();
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
      await waitUntil(() => observedCount() === RECONCILE_CONCURRENCY, 'the sweep to saturate its slots');
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
      await waitUntil(() => observedCount() === RECONCILE_CONCURRENCY, 'the sweep to saturate its slots');
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
      await waitUntil(() => observedCount() === RECONCILE_CONCURRENCY, 'the sweep to saturate its slots');
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
      await waitUntil(() => observedCount() === 1, 'the direct run to park inside its observe pass');
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
      const late = await insertBook();

      // Hold the book's lock from OUTSIDE the reconciler so its run is parked in the lock queue
      // — accepted at check 1, but not yet at check 3 — when the drain begins.
      const lockGate = deferred();
      const actual = await vi.importActual<typeof import('./book-admission.js')>('./book-admission.js');
      const holding = actual.withBookAdmissionLock(late, async () => { await lockGate.promise; });

      const direct = reconciler.reconcileBook(late);
      await waitUntil(() => hoisted.events.includes(`lock.acquire:${late}`), 'the direct run to queue on the held lock');

      const stopping = reconciler.stop();
      lockGate.resolve();
      await Promise.all([holding, direct, stopping]);

      // Zero filesystem and zero DB work after the lock was finally granted.
      expect(hoisted.events).toContain(`lock.held:${late}`);
      expect(observeMock).not.toHaveBeenCalled();
      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
    });

    it('discards a queued follow-up rather than running it (case 40g)', async () => {
      await insertBook();
      const gate = deferred();
      observeMock.mockImplementation(async () => { await gate.promise; return OBSERVED; });
      const selectSpy = vi.spyOn(db, 'select');

      const first = reconciler.reconcileAll();
      await waitUntil(() => observeMock.mock.calls.length >= 1, 'the first run to reach its sweep phase');
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
      await waitUntil(
        () => (site === 'a settings read'
          ? settingsGet.mock.calls.some((call) => call[0] === 'library')
          : (selectSpy?.mock.calls.length ?? 0) >= 1),
        `the run to park on ${site}`,
      );
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
      await waitUntil(
        () => settingsGet.mock.calls.some((call) => call[0] === 'library'),
        "the run to park on settings.get('library')",
      );
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

  // =========================================================================
  // H. selectCompanionEbook — the owner's `ambiguous` pick (#1976 AC24-AC30)
  // =========================================================================

  describe('selectCompanionEbook (#1976)', () => {
    /** A book with a real directory, plus the candidate files it should enumerate. */
    async function seedCandidates(
      names: string[],
      overrides: Parameters<typeof insertBook>[0] = {},
    ): Promise<{ bookId: number; bookPath: string }> {
      const bookId = await insertBook(overrides);
      const rows = await db.select({ path: books.path }).from(books).where(eq(books.id, bookId));
      const bookPath = rows[0]!.path!;
      for (const name of names) await writeFile(join(bookPath, name), `PK ${name}`);
      return { bookId, bookPath };
    }

    /** The canonical `observed` revalidation for `filename`, as the owner's recorded pick. */
    function selectedObservation(
      filename: string,
      candidateCount: number,
      selected = true,
    ): CompanionRevalidateResult {
      return {
        outcome: 'observed',
        observation: {
          status: 'available',
          filename,
          sizeBytes: 4096,
          mtimeMs: 1_700_000_000_000,
          ctimeMs: 1_700_000_000_500,
          candidateCount,
          selected,
        },
      };
    }

    /**
     * Make revalidation succeed for whatever file step 8 hands it, so the ladder can be driven
     * without planting a real EPUB. It echoes back the `filename`, `candidateCount`, and
     * `selected` it was given — a selector that passed the wrong ones would still "succeed"
     * here, and the assertions on the persisted row are what catch that.
     */
    function stubRevalidation(): void {
      revalidateCompanionFileMock.mockImplementation(async ({ filename, selected, candidateCount }) =>
        selectedObservation(filename, candidateCount, selected),
      );
    }

    function lockAcquisitions(bookId: number): string[] {
      return hoisted.events.filter((event) => event === `lock.acquire:${bookId}`);
    }

    function semaphoreEvents(): string[] {
      return hoisted.events.filter((event) => event.startsWith('semaphore.'));
    }

    // -----------------------------------------------------------------------
    // The happy path and the row-bearing commit (AC29/AC30)
    // -----------------------------------------------------------------------

    it('persists the chosen candidate as selected and returns the row the commit wrote', async () => {
      const { bookId } = await seedCandidates(['a.epub', 'b.epub']);
      await seedRow(bookId, { status: 'ambiguous', filename: null, sizeBytes: null, mtimeMs: null, ctimeMs: null, candidateCount: 2 });
      stubRevalidation();

      const result = await reconciler.selectCompanionEbook(bookId, 1);

      expect(result.outcome).toBe('selected');
      if (result.outcome !== 'selected') return;
      // `upsertCompanionEbook` derives `selected_filename = filename` structurally, so this
      // is the pair `ck_companion_ebooks_selection` polices (AC30).
      expect(result.row).toMatchObject({
        status: 'available',
        filename: 'b.epub',
        selectedFilename: 'b.epub',
        candidateCount: 2,
      });
      expect(await readRow(bookId)).toEqual(result.row);
    });

    it('returns the object upsertCompanionEbook resolved with, and re-reads nothing after the commit (AC29)', async () => {
      const { bookId } = await seedCandidates(['a.epub']);
      stubRevalidation();

      const result = await reconciler.selectCompanionEbook(bookId, 0);

      expect(result.outcome).toBe('selected');
      if (result.outcome !== 'selected') return;
      // Identity, not equality: a post-commit `findCompanionEbook` would produce an equal-looking
      // row read OUTSIDE the transaction, which is exactly what AC29 forbids.
      expect(result.row).toBe(await upsertCompanionEbookMock.mock.results[0]!.value);
      // Exactly two reads: step 2's prior, and the in-transaction precondition re-read. A third
      // would be the post-commit re-read.
      expect(findCompanionEbookMock).toHaveBeenCalledTimes(2);
    });

    it('revalidates with selected: true, the live candidate count, and the resolved path', async () => {
      const { bookId, bookPath } = await seedCandidates(['a.epub', 'b.epub', 'c.epub']);
      stubRevalidation();

      await reconciler.selectCompanionEbook(bookId, 2);

      expect(revalidateCompanionFileMock).toHaveBeenCalledTimes(1);
      expect(revalidateCompanionFileMock.mock.calls[0]![0]).toMatchObject({
        bookId,
        filename: 'c.epub',
        selected: true,
        candidateCount: 3,
        before: expect.objectContaining({ sizeBytes: expect.any(Number) }),
      });
      const passedPath = revalidateCompanionFileMock.mock.calls[0]![0].path.split('\\').join('/');
      expect(passedPath).toBe(join(bookPath, 'c.epub').split('\\').join('/'));
    });

    // AC26/AC27 — the selector runs its OWN pass. `observeCompanionEbook` is never called, so
    // its `unchanged` short-circuit is structurally unreachable from here.
    it('never calls observeCompanionEbook, and re-runs the whole pass on a repeated identical pick', async () => {
      const { bookId } = await seedCandidates(['a.epub', 'b.epub']);
      stubRevalidation();

      const first = await reconciler.selectCompanionEbook(bookId, 0);
      const second = await reconciler.selectCompanionEbook(bookId, 0);

      expect(first.outcome).toBe('selected');
      expect(second.outcome).toBe('selected');
      expect(observeMock).not.toHaveBeenCalled();
      // The work ran twice — the observable invariant, not a moved timestamp (AC27).
      expect(findCompanionEbookCandidatesMock).toHaveBeenCalledTimes(2);
      expect(revalidateCompanionFileMock).toHaveBeenCalledTimes(2);
      expect(upsertCompanionEbookMock).toHaveBeenCalledTimes(2);
    });

    // -----------------------------------------------------------------------
    // The info-level mutation audit record (PR #2010 F1)
    // -----------------------------------------------------------------------

    /**
     * Every `info` record this selection emitted. The sweep summary is excluded by shape — it
     * is the only other `info` record this service produces and it carries a `books`
     * denominator, which a per-selection record never does.
     */
    function selectionInfoRecords(): Array<Record<string, unknown>> {
      return spies.info.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((record) => record !== null && typeof record === 'object' && !('books' in record));
    }

    describe('the persisted-selection audit record', () => {
      // CONTRIBUTING.md: every create/update/delete logs at `info`. A single owner-triggered
      // selection produces no sweep summary, so without this record the default-level log
      // cannot establish that the row changed at all.
      it('emits exactly one info record with the safe fields on a successful persist', async () => {
        const { bookId } = await seedCandidates(['a.epub', 'b.epub', 'c.epub']);
        stubRevalidation();

        await expect(reconciler.selectCompanionEbook(bookId, 2)).resolves.toMatchObject({ outcome: 'selected' });

        const records = selectionInfoRecords();
        expect(records).toHaveLength(1);
        // The EXACT key set — a widened record that started carrying the resolved path or the
        // library root fails here rather than in a leak review.
        expect(Object.keys(records[0]!).sort()).toEqual(['bookId', 'candidateCount', 'filename', 'status']);
        expect(records[0]).toEqual({
          bookId,
          filename: 'c.epub',
          status: 'available',
          candidateCount: 3,
        });
      });

      it('carries the live candidate count and the persisted status, not the stored ones', async () => {
        const { bookId } = await seedCandidates(['a.epub', 'b.epub']);
        await seedRow(bookId, {
          status: 'ambiguous', filename: null, sizeBytes: null, mtimeMs: null, ctimeMs: null, candidateCount: 7,
        });
        revalidateCompanionFileMock.mockImplementation(async ({ filename, candidateCount }) => ({
          outcome: 'observed',
          observation: {
            status: 'invalid',
            filename,
            sizeBytes: 4096,
            mtimeMs: 1_700_000_000_000,
            ctimeMs: 1_700_000_000_500,
            candidateCount,
            selected: true,
            validationCode: 'empty_spine',
          },
        }));

        await reconciler.selectCompanionEbook(bookId, 0);

        expect(selectionInfoRecords()[0]).toEqual({
          bookId,
          filename: 'a.epub',
          status: 'invalid',   // the persisted verdict, not the stored `ambiguous`
          candidateCount: 2,   // the LIVE count, not the stored 7
        });
      });

      it('never leaks the resolved path or the library root', async () => {
        const { bookId, bookPath } = await seedCandidates(['a.epub']);
        stubRevalidation();

        await reconciler.selectCompanionEbook(bookId, 0);

        const leaves = JSON.stringify(selectionInfoRecords());
        expect(leaves).not.toContain(bookPath);
        expect(leaves).not.toContain(libraryRoot);
      });

      // A mutation record is only meaningful if it is absent when nothing was written.
      it.each<[string, () => Promise<number>]>([
        ['out_of_range', async () => (await seedCandidates(['a.epub'])).bookId],
        ['gone', async () => {
          const { bookId } = await seedCandidates(['a.epub']);
          findCompanionEbookCandidatesMock.mockResolvedValueOnce({ outcome: 'gone' });
          return bookId;
        }],
        ['retained', async () => {
          const { bookId } = await seedCandidates(['a.epub']);
          revalidateCompanionFileMock.mockResolvedValueOnce({ outcome: 'retain' });
          return bookId;
        }],
      ])('emits no info record when the outcome is %s', async (_label, arrange) => {
        const bookId = await arrange();
        spies.info.mockClear();

        await reconciler.selectCompanionEbook(bookId, _label === 'out_of_range' ? 5 : 0);

        expect(selectionInfoRecords()).toEqual([]);
      });

      it('emits no info record when the guarded commit conflicts', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        revalidateCompanionFileMock.mockImplementationOnce(async ({ filename, candidateCount }) => {
          await db.update(books).set({ path: join(libraryRoot, 'moved-elsewhere') }).where(eq(books.id, bookId));
          return selectedObservation(filename, candidateCount);
        });
        spies.info.mockClear();

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'conflicted' });

        expect(selectionInfoRecords()).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------
    // Settings setup, above the lock (AC24 steps -2/-1)
    // -----------------------------------------------------------------------

    describe('settings setup', () => {
      it('returns disabled without acquiring the lock or reading books', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        enabled = false;

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'disabled' });

        expect(withBookAdmissionLockMock).not.toHaveBeenCalled();
        expect(findCompanionEbookMock).not.toHaveBeenCalled();
        expect(findCompanionEbookCandidatesMock).not.toHaveBeenCalled();
        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      });

      it.each(['companionEpub', 'library'])(
        'returns failed with one warn record when settings.get(%j) rejects',
        async (failing) => {
          const { bookId } = await seedCandidates(['a.epub']);
          const boom = new Error(`settings ${failing} unavailable`);
          settingsGet.mockImplementation(async (key: string) => {
            if (key === failing) throw boom;
            if (key === 'companionEpub') return { enabled: true };
            return { path: libraryRoot };
          });

          await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'failed' });

          expect(withBookAdmissionLockMock).not.toHaveBeenCalled();
          expect(spies.warn).toHaveBeenCalledTimes(1);
          const record = spies.warn.mock.calls[0]![0] as Record<string, unknown>;
          expect(Object.keys(record).sort()).toEqual(['bookId', 'error']);
          expect(record.bookId).toBe(bookId);
          expectSerializedError(record.error, boom, {});
        },
      );
    });

    // -----------------------------------------------------------------------
    // The locked ladder, step by step (AC24)
    // -----------------------------------------------------------------------

    describe('book_missing (step 1)', () => {
      it('returns book_missing with no discovery, no resolver, and no write', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        await db.delete(books).where(eq(books.id, bookId));

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'book_missing' });

        expect(findCompanionEbookCandidatesMock).not.toHaveBeenCalled();
        expect(resolveCompanionEbookPathMock).not.toHaveBeenCalled();
        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      });

      // The GENUINE race: deleted between the route's `getById` and the locked snapshot. The
      // suite already wraps the lock in a delegating spy, so the deletion lands after
      // acquisition and before the callback — no new seam needed (F6).
      it('returns book_missing when the row is deleted after lock acquisition, before the callback', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        stubRevalidation();
        const actual = await vi.importActual<typeof import('./book-admission.js')>('./book-admission.js');
        withBookAdmissionLockMock.mockImplementationOnce(async (id: number, fn: () => Promise<unknown>) =>
          actual.withBookAdmissionLock(id, async () => {
            await db.delete(books).where(eq(books.id, id));
            return fn();
          }),
        );

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'book_missing' });
        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      });
    });

    describe('ineligible (step 3)', () => {
      it.each<[string, Parameters<typeof insertBook>[0]]>([
        ['a non-imported status', { status: 'missing' }],
        ['a blank path', { path: '   ' }],
      ])('returns ineligible for %s, with no discovery and no write', async (_label, overrides) => {
        const { bookId } = await seedCandidates([], overrides);

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'ineligible' });

        expect(findCompanionEbookCandidatesMock).not.toHaveBeenCalled();
        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      });
    });

    describe('discovery (step 4)', () => {
      it.each(['gone', 'undetermined'] as const)('maps a %s listing to the same outcome, with no write', async (arm) => {
        const { bookId } = await seedCandidates(['a.epub']);
        findCompanionEbookCandidatesMock.mockResolvedValueOnce({ outcome: arm });

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: arm });

        expect(resolveCompanionEbookPathMock).not.toHaveBeenCalled();
        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      });
    });

    /**
     * AC24 step 5 — the range check is against the LIVE list, never the stored
     * `candidate_count`. Both directions are pinned: a selector that read the stored column
     * would accept the first case and reject the second (F8).
     */
    describe('out_of_range (step 5)', () => {
      it('rejects an index the live list cannot address even though the stored count admits it', async () => {
        const { bookId } = await seedCandidates(['a.epub', 'b.epub']);
        await seedRow(bookId, {
          status: 'ambiguous', filename: null, sizeBytes: null, mtimeMs: null, ctimeMs: null, candidateCount: 5,
        });
        const before = await readRow(bookId);

        await expect(reconciler.selectCompanionEbook(bookId, 3)).resolves.toEqual({ outcome: 'out_of_range' });

        expect(resolveCompanionEbookPathMock).not.toHaveBeenCalled();
        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
        // Byte-for-byte, `updated_at` included.
        expect(await readRow(bookId)).toEqual(before);
      });

      it('accepts an index only the live list admits, when the stored count is smaller', async () => {
        const { bookId } = await seedCandidates(['a.epub', 'b.epub', 'c.epub', 'd.epub']);
        await seedRow(bookId, {
          status: 'ambiguous', filename: null, sizeBytes: null, mtimeMs: null, ctimeMs: null, candidateCount: 2,
        });
        stubRevalidation();

        const result = await reconciler.selectCompanionEbook(bookId, 3);

        expect(result.outcome).toBe('selected');
        if (result.outcome !== 'selected') return;
        expect(result.row).toMatchObject({ filename: 'd.epub', selectedFilename: 'd.epub', candidateCount: 4 });
      });

      it('rejects an index past the end of the live list', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        await expect(reconciler.selectCompanionEbook(bookId, 1)).resolves.toEqual({ outcome: 'out_of_range' });
      });
    });

    describe('unresolvable (steps 6 and 7)', () => {
      it.each(['invalid_filename', 'not_regular_file', 'outside_library', 'missing', 'unreadable'] as const)(
        'maps the resolver negative %s to unresolvable, with no validation and no write',
        async (outcome) => {
          const { bookId } = await seedCandidates(['a.epub']);
          resolveCompanionEbookPathMock.mockResolvedValueOnce({ outcome });

          await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'unresolvable' });

          expect(revalidateCompanionFileMock).not.toHaveBeenCalled();
          expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
        },
      );

      it('maps a failed step-7 fingerprint stat to unresolvable, not retained', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        statRegularFileMock.mockResolvedValueOnce(null);

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'unresolvable' });
        expect(revalidateCompanionFileMock).not.toHaveBeenCalled();
      });

      /**
       * The arm is a genuine TOCTOU window, not dead code. A symlink planted BEFORE the call
       * is never a candidate — `findCompanionEbookCandidates` already requires `stats.isFile()`
       * — so the swap has to happen between discovery and the resolver, and the outcome has to
       * be produced by the REAL resolver rather than by a stub.
       */
      it.skipIf(!CAN_SYMLINK)('is reachable: discovery saw a regular file, the real resolver sees a symlink out of the root', async () => {
        const outside = mkdtempSync(join(tmpdir(), 'companion-select-outside-'));
        try {
          await writeFile(join(outside, 'secret.epub'), 'secret');
          const { bookId, bookPath } = await seedCandidates(['a.epub']);
          const actualOpen = await vi.importActual<typeof import('./companion-ebook-open.js')>(
            './companion-ebook-open.js',
          );
          resolveCompanionEbookPathMock.mockImplementationOnce(async (input, log) => {
            await rm(join(bookPath, 'a.epub'));
            await symlink(join(outside, 'secret.epub'), join(bookPath, 'a.epub'));
            return actualOpen.resolveCompanionEbookPath(input, log);
          });

          await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'unresolvable' });
          expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
        } finally {
          rmSync(outside, { recursive: true, force: true });
        }
      });
    });

    describe('retained (step 8)', () => {
      it('writes nothing when revalidation declines to derive a verdict', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        await seedRow(bookId);
        const before = await readRow(bookId);
        revalidateCompanionFileMock.mockResolvedValueOnce({ outcome: 'retain' });

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'retained' });

        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
        expect(await readRow(bookId)).toEqual(before);
      });
    });

    describe('conflicted (step 9)', () => {
      it('aborts when a concurrent writer changed the observation row between the pass and the commit', async () => {
        const { bookId } = await seedCandidates(['a.epub', 'b.epub']);
        await seedRow(bookId, {
          status: 'ambiguous', filename: null, sizeBytes: null, mtimeMs: null, ctimeMs: null, candidateCount: 2,
        });
        // The mutation lands BETWEEN step 8 and step 9, which is the window the precondition
        // exists to close.
        revalidateCompanionFileMock.mockImplementationOnce(async ({ filename, candidateCount }) => {
          await db.update(companionEbooks)
            .set({ status: 'invalid', filename: 'winner.epub', sizeBytes: 1, mtimeMs: 1, ctimeMs: 1, validationCode: 'not_a_zip', candidateCount: 1 })
            .where(eq(companionEbooks.bookId, bookId));
          return selectedObservation(filename, candidateCount);
        });

        await expect(reconciler.selectCompanionEbook(bookId, 1)).resolves.toEqual({ outcome: 'conflicted' });

        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
        expect(abortReasons()).toContain('observation-changed');
        expect(await readRow(bookId)).toMatchObject({ status: 'invalid', filename: 'winner.epub' });
      });

      it('aborts when books.path moved between the pass and the commit', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        revalidateCompanionFileMock.mockImplementationOnce(async ({ filename, candidateCount }) => {
          await db.update(books).set({ path: join(libraryRoot, 'moved-elsewhere') }).where(eq(books.id, bookId));
          return selectedObservation(filename, candidateCount);
        });

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'conflicted' });

        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
        expect(abortReasons()).toContain('book-changed');
      });
    });

    /**
     * F7 — the never-rejects contract, proven at the SERVICE level. A route-level stub of the
     * `failed` arm cannot show that a throw out of the locked callback is absorbed here.
     */
    describe('failed (the never-rejects contract)', () => {
      it('resolves to failed when the commit transaction throws, and logs the serialized record at debug', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        stubRevalidation();
        const boom = new Error('libSQL write exploded');
        upsertCompanionEbookMock.mockRejectedValueOnce(boom);

        const promise = reconciler.selectCompanionEbook(bookId, 0);
        await expect(promise).resolves.toEqual({ outcome: 'failed' });

        const records = debugRecords(spies).filter((record) => 'error' in record);
        expect(records).toHaveLength(1);
        expect(Object.keys(records[0]!).sort()).toEqual(['bookId', 'error']);
        expect(records[0]!.bookId).toBe(bookId);
        expectSerializedError(records[0]!.error, boom, {});
        // A setup rejection warns; a locked-callback throw does not (AC25).
        expect(spies.warn).not.toHaveBeenCalled();
      });

      it('resolves to failed when a collaborator inside the lock throws', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        findCompanionEbookCandidatesMock.mockRejectedValueOnce(new Error('discovery exploded'));

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'failed' });
        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // Lifecycle: one lock, no semaphore slot, and drain membership (AC24)
    // -----------------------------------------------------------------------

    describe('lock and semaphore discipline', () => {
      it('acquires the admission lock exactly once and takes no sweep semaphore slot', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        stubRevalidation();

        await reconciler.selectCompanionEbook(bookId, 0);

        expect(lockAcquisitions(bookId)).toHaveLength(1);
        // User-triggered work must not queue behind a background sweep — the same reason
        // `reconcileBook` takes no slot.
        expect(semaphoreEvents()).toEqual([]);
      });

      it('serializes two concurrent selections for the same book through the lock', async () => {
        const { bookId } = await seedCandidates(['a.epub', 'b.epub']);
        stubRevalidation();

        const [first, second] = await Promise.all([
          reconciler.selectCompanionEbook(bookId, 0),
          reconciler.selectCompanionEbook(bookId, 1),
        ]);

        // Neither deadlocks, and the second observes the first's row as its prior — so both
        // reach a terminal outcome rather than one aborting on a stale precondition.
        expect([first.outcome, second.outcome].sort()).toEqual(['selected', 'selected']);
        expect(lockAcquisitions(bookId)).toHaveLength(2);
      });
    });

    describe('shutdown drain membership', () => {
      it('returns stopped with zero filesystem and zero DB work when stop() ran first', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        await reconciler.stop();
        findCompanionEbookCandidatesMock.mockClear();
        findCompanionEbookMock.mockClear();

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'stopped' });

        expect(withBookAdmissionLockMock).not.toHaveBeenCalled();
        expect(findCompanionEbookCandidatesMock).not.toHaveBeenCalled();
        expect(findCompanionEbookMock).not.toHaveBeenCalled();
      });

      /**
       * Same-turn registration. `stop()` is called in the SAME tick, with no `await` between.
       *
       * The gate is on the SETTINGS read, not on revalidation, and that is the whole point: a
       * same-turn `stop()` latches `stopping` before the locked callback runs, so step 0
       * correctly short-circuits and revalidation is never reached — a gate placed there never
       * fires, and the case would pass without proving anything.
       *
       * Parked on its first `await` inside setup, the selection is observable only through the
       * `activeBookRuns` registration. A run registered AFTER that first `await` would already
       * have been missed by the drain's snapshot and `stop()` would resolve immediately, so
       * this is exactly the discriminator for synchronous registration.
       */
      it('keeps stop() pending until a selection accepted in the same turn resolves', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        const gate = deferred<{ enabled: boolean }>();
        settingsGet.mockImplementation(async (key: string) => {
          if (key === 'companionEpub') return gate.promise;
          return { path: libraryRoot };
        });

        const selection = reconciler.selectCompanionEbook(bookId, 0);
        const stopping = reconciler.stop();
        const stopState = track(stopping);

        await flush();
        expect(stopState.settled).toBe(false);

        gate.resolve({ enabled: true });
        // `stopped`, from step 0 — the drain latched before this selection began its work.
        await expect(selection).resolves.toEqual({ outcome: 'stopped' });
        await stopping;
        expect(stopState.settled).toBe(true);
        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      });

      it('keeps stop() pending for a selection already parked mid-pass, then completes the write', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        const gate = deferred<CompanionRevalidateResult>();
        revalidateCompanionFileMock.mockImplementationOnce(() => gate.promise);

        const selection = reconciler.selectCompanionEbook(bookId, 0);
        await waitUntil(() => revalidateCompanionFileMock.mock.calls.length > 0, 'the selection to reach revalidation');

        const stopping = reconciler.stop();
        const stopState = track(stopping);
        await flush();
        expect(stopState.settled).toBe(false);

        gate.resolve(selectedObservation('a.epub', 1));
        await expect(selection).resolves.toMatchObject({ outcome: 'selected' });
        await stopping;

        expect(stopState.settled).toBe(true);
        // `shutdown.ts` runs `stop()` immediately before `app.close()`, so the write must be
        // done — not merely started — by the time the drain resolves.
        expect(await readRow(bookId)).toMatchObject({ filename: 'a.epub', selectedFilename: 'a.epub' });
      });
    });
  });

});
