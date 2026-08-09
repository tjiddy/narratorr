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
 * Real migrated libSQL pins the guarded read and returning upsert in one transaction and makes
 * AC18/AC19 races genuine. External I/O is doubled; semaphore/admission lock are wrapped so real
 * exclusion remains while acquisition order is observable.
 */
const hoisted = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, stat: vi.fn(actual.stat) };
});

/** Full replacement must declare all three runtime exports; type-only exports are erased (F19). */
vi.mock('./companion-ebook-observe.js', () => ({
  observeCompanionEbook: vi.fn(),
  statRegularFile: vi.fn(),
  revalidateCompanionFile: vi.fn(),
}));

/** Delegating spies preserve real filesystem outcomes while allowing selector TOCTOU injection. */
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
    // acquire() returns a single-use release token, so wrap it to record release (#1984).
    override async acquire(): Promise<() => void> {
      hoisted.events.push('semaphore.wait');
      const release = await super.acquire();
      hoisted.events.push('semaphore.acquired');
      return () => {
        hoisted.events.push('semaphore.release');
        release();
      };
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** Register every gate so a failed assertion cannot leave stop() hanging on parked work. */
const openGates: Array<() => void> = [];

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  openGates.push(() => resolve(undefined as T));
  return { promise, resolve, reject };
}

/** Lets tests assert a promise is still pending without racing it. */
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

/** Poll real async work to reach a state; fixed flush counts are reserved for proving later quiet periods. */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 3_000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

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

/** Enumerable keys distinguish serializeError output from raw Error; ordinary matchers read non-enumerable message/stack too. */
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
    // libSQL may keep the directory handle open on Windows.
    removeDirTolerant(dir);
  });

  beforeEach(async () => {
    // clearAllMocks leaves queued *Once responses intact; reset them between cases.
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

    // Full-module vi.fn mocks have no implementation; selectors default to real filesystem/validator behavior.
    const actualObserve = await vi.importActual<typeof import('./companion-ebook-observe.js')>(
      './companion-ebook-observe.js',
    );
    statRegularFileMock.mockImplementation(actualObserve.statRegularFile);
    revalidateCompanionFileMock.mockImplementation(actualObserve.revalidateCompanionFile);

    reconciler = new CompanionEbookReconciler(db, settings, log);
  });

  afterEach(async () => {
    // Release parked work before draining the file-global semaphore.
    for (const release of openGates.splice(0)) release();
    await reconciler.stop();
  });

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

  describe('the feature gate (AC16)', () => {
    it('issues no prefilter, no per-book read, no observe, no write, and no summary when disabled (case 21)', async () => {
      enabled = false;
      const bookId = await insertBook();
      await seedRow(bookId);
      const selectSpy = vi.spyOn(db, 'select');

      await reconciler.reconcileAll();
      await reconciler.reconcileBook(bookId);

      // Every database read uses db.select; settings use a separate double (F17).
      expect(selectSpy).not.toHaveBeenCalled();
      expect(findCompanionEbookMock).not.toHaveBeenCalled();
      expect(observeMock).not.toHaveBeenCalled();
      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      // Disabled reconcileAll never reaches the sweep-start instant (F18).
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

  describe('per-book serialization (AC18)', () => {
    it('acquires the lock exactly once and does every read and the write inside it (case 23)', async () => {
      const bookId = await insertBook();
      // Wrap both repository seams to place reads/writes in the lock event log.
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
        // Record only the pre-scan read outside a transaction.
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

      // If hoisted outside the lock, B would see A's stale null instead of its committed row.
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
      // This row queues behind saturated slots before its locked snapshot read.
      const target = await insertBook();

      const sweep = reconciler.reconcileAll();
      await waitUntil(() => observedCount() === RECONCILE_CONCURRENCY, 'the sweep to saturate its slots');
      // Mutate after AC21 prefilter but before the authoritative locked read.
      await db.update(books).set({ status: 'wanted' }).where(eq(books.id, target));
      gate.resolve();
      await sweep;

      // A stale prefilter row would observe and write this now-ineligible book.
      expect(observeMock.mock.calls.map((call) => call[0].bookId)).not.toContain(target);
      expect(upsertCompanionEbookMock.mock.calls.map((call) => call[1])).not.toContain(target);
      expect(summaries(spies)[0]).toMatchObject({
        books: RECONCILE_CONCURRENCY + 1,
        observed: RECONCILE_CONCURRENCY,
        skipped: 1,
      });
    });
  });

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
     * Cover every material AC19 guard column with schema-valid single-column moves; candidateCount
     * starts selected and validationCode starts invalid to satisfy their CHECK constraints (F7).
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
      const afterRow = await readRow(bookId);
      expect(afterRow).not.toEqual(beforeRow);
      expect(afterRow).toMatchObject(patch);
    });

    it('queues the guarded write behind an unrelated transaction on the same connection (F8/F12)', async () => {
      const bookId = await insertBook();
      const gate = deferred();
      const events: string[] = [];

      // Connection serialization must exclude ordinary db.transaction callers that never opt in.
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
      // An overlapping companion transaction would lose to SQLITE_BUSY here.
      expect(events).toEqual(['other:start']);

      gate.resolve();
      await Promise.all([otherService, reconcile]);
      expect(events).toEqual(['other:start', 'other:end', 'companion:write']);
      expect(await readRow(bookId)).toMatchObject({ status: 'available' });
    });
  });

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

    /**
     * This suite pins slot count only. core/epub separately rejects oversized archives before
     * Open.custom; heap/RSS assertions would be nondeterministic because retention is external
     * and the Vitest worker is not isolated (#2025).
     */
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
      // Quiet period proves no fifth pass starts while all slots are held.
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

      // Insert after prefilter so this book belongs only to the direct call.
      const direct = await insertBook();
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
      // Joined caller must remain pending after the first summary until its follow-up settles.
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

      // Before book work starts, one db.select proves later calls joined the first setup.
      expect(selectSpy).toHaveBeenCalledTimes(1);

      prefilterGate.resolve();
      await waitUntil(() => summaries(spies).length === 1, "the first sweep's summary");
      await flush();
      // Three joined callers remain on their single coalesced follow-up.
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

      // While settings is pending, that read—not a zero prefilter count—pins setup once.
      expect(settingsGet.mock.calls.filter((call) => call[0] === 'library')).toHaveLength(1);

      gate.resolve();
      await Promise.all([first, ...joined]);
      expect(summaries(spies)).toHaveLength(2);
    });
  });

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
      // No books:0 summary: setup failed before AC25's sweep-start denominator existed.
      expect(summaries(spies)).toEqual([]);
      expect(observeMock).not.toHaveBeenCalled();
      selectSpy?.mockRestore();
    });

    /**
     * Direct reconcile has a separate setup catch; without it, fire-and-forget settings failures
     * reject after the response. Both sites must resolve, warn once, and run no later work (F11).
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

      // Setup precedes every other step, so none may have run.
      expect(withBookAdmissionLockMock).not.toHaveBeenCalled();
      expect(selectSpy).not.toHaveBeenCalled();
      expect(findCompanionEbookMock).not.toHaveBeenCalled();
      expect(observeMock).not.toHaveBeenCalled();
      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      expect(summaries(spies)).toEqual([]);
      selectSpy.mockRestore();
    });

    /** Per-book failures must leave exactly one debug record with bookId and serialized error; summary count is the only other trace (F1). */
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

      findCompanionEbookMock.mockRejectedValueOnce(new Error('prior read failed'));
      await expect(reconciler.reconcileBook(bookId)).resolves.toBeUndefined();

      outcomes.set(bookId, async () => { throw new Error('observe failed'); });
      await expect(reconciler.reconcileBook(bookId)).resolves.toBeUndefined();
      await expect(reconciler.reconcileAll()).resolves.toBeUndefined();

      outcomes.delete(bookId);
      upsertCompanionEbookMock.mockRejectedValueOnce(new Error('upsert failed'));
      await expect(reconciler.reconcileBook(bookId)).resolves.toBeUndefined();

      const selectSpy = vi.spyOn(db, 'select').mockImplementationOnce((() => { throw new Error('query failed'); }) as never);
      await expect(reconciler.reconcileAll()).resolves.toBeUndefined();
      selectSpy.mockRestore();

      expect(summaries(spies).some((summary) => summary.failed === 1)).toBe(true);
    });
  });

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
     * Drive setup and sweep time independently so durationMs cannot pass as a number, hard-coded
     * zero, reversed delta, or whole-run duration; only sweep-phase 7_000 is valid (F2).
     */
    it('reports the sweep-phase elapsed time, excluding setup (case 41/F2)', async () => {
      const SETUP_MS = 100_000;
      const SWEEP_MS = 7_000;
      let now = 1_600_000_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

      const bookId = await insertBook();
      // Advance setup time before the sweep-start instant.
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
      // Passes AC21 prefilter but fails the later directory eligibility probe.
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
      // Queue deletion target behind saturated slots before its locked snapshot read.
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

      // Assert before awaiting: async stop() would allocate distinct outer promises.
      expect(a).toBe(b);
    });

    it('returns `stopped` from a book run that reaches the lock after stopping (case 40f)', async () => {
      const late = await insertBook();

      // External lock parks the accepted run before its post-lock stopping check.
      const lockGate = deferred();
      const actual = await vi.importActual<typeof import('./book-admission.js')>('./book-admission.js');
      const holding = actual.withBookAdmissionLock(late, async () => { await lockGate.promise; });

      const direct = reconciler.reconcileBook(late);
      await waitUntil(() => hoisted.events.includes(`lock.acquire:${late}`), 'the direct run to queue on the held lock');

      const stopping = reconciler.stop();
      lockGate.resolve();
      await Promise.all([holding, direct, stopping]);

      // Post-lock stop check must prevent filesystem and database work.
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

      // Discarded follow-up issues no prefilter/summary and still resolves its joiner.
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

      // Rows return after stop(); the run must still refuse them.
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

  describe('forced revalidation (#2034)', () => {
    function forceFlags(): boolean[] {
      return observeMock.mock.calls.map((call) => call[0].force);
    }

    it('threads force: true from reconcileBook(id, true) into observeCompanionEbook (AC1)', async () => {
      const bookId = await insertBook();

      await reconciler.reconcileBook(bookId, true);

      expect(observeMock).toHaveBeenCalledTimes(1);
      expect(observeMock.mock.calls[0]![0]).toMatchObject({ bookId, force: true });
    });

    /** Omitted force must remain false for untouched one-argument trigger sites. */
    it.each([
      { label: 'omitted entirely — the seven untouched call sites', call: (id: number) => reconciler.reconcileBook(id) },
      { label: 'passed explicitly as false', call: (id: number) => reconciler.reconcileBook(id, false) },
    ])('threads force: false when the argument is $label (AC1)', async ({ call }) => {
      const bookId = await insertBook();

      await call(bookId);

      expect(observeMock).toHaveBeenCalledTimes(1);
      expect(observeMock.mock.calls[0]![0]).toMatchObject({ bookId, force: false });
    });

    it('reaches observe with force: false for every book in a sweep (AC5)', async () => {
      const ids = [await insertBook(), await insertBook(), await insertBook()];
      for (const id of ids) await seedRow(id);
      for (const id of ids) outcomes.set(id, { outcome: 'unchanged' });

      await reconciler.reconcileAll();

      expect(observeMock).toHaveBeenCalledTimes(ids.length);
      expect(forceFlags()).toEqual([false, false, false]);
      expect(summaries(spies)[0]).toMatchObject({ books: 3, unchanged: 3, observed: 0 });
    });

    /**
     * Force must be call-scoped. The observer simulates matching fingerprints: only forced calls
     * write. Parking one forced pass while a sweep runs exposes leaked instance state as extra
     * true flags and overwritten sweep rows (AC4).
     */
    it('never lets a concurrent sweep observe a direct call’s force (AC4)', async () => {
      const forcedId = await insertBook();
      const sweepOnly = [await insertBook(), await insertBook()];
      for (const id of [forcedId, ...sweepOnly]) await seedRow(id);
      const before = new Map(await Promise.all(
        sweepOnly.map(async (id) => [id, await readRow(id)] as const),
      ));

      const gate = deferred();
      observeMock.mockImplementation(async (input) => {
        hoisted.events.push(`observe:${input.bookId}`);
        if (input.force) await gate.promise;
        return input.force ? OBSERVED : { outcome: 'unchanged' };
      });

      const direct = reconciler.reconcileBook(forcedId, true);
      await waitUntil(() => observedCount() === 1, 'the forced direct pass to park inside observe');

      const sweep = reconciler.reconcileAll();
      await waitUntil(
        () => sweepOnly.every((id) => hoisted.events.includes(`observe:${id}`)),
        'the sweep to observe both sweep-only books',
      );

      gate.resolve();
      await Promise.all([direct, sweep]);

      expect(forceFlags().filter(Boolean)).toHaveLength(1);
      expect(observeMock.mock.calls.find((call) => call[0].force)![0].bookId).toBe(forcedId);
      for (const id of sweepOnly) expect(await readRow(id)).toEqual(before.get(id));
      // Forced-book write keeps sweep-only byte identity from passing vacuously.
      expect(await readRow(forcedId)).toMatchObject({ status: 'available', filename: 'book.epub' });
    });

    it('leaves the sweep’s pass over the SAME book non-forcing while a forced run holds its lock (AC4/AC5)', async () => {
      const bookId = await insertBook();
      await seedRow(bookId);

      const gate = deferred();
      observeMock.mockImplementation(async (input) => {
        hoisted.events.push(`observe:${input.bookId}`);
        if (input.force) await gate.promise;
        return input.force ? OBSERVED : { outcome: 'unchanged' };
      });

      const direct = reconciler.reconcileBook(bookId, true);
      await waitUntil(() => observedCount() === 1, 'the forced direct pass to park inside observe');
      const sweep = reconciler.reconcileAll();

      gate.resolve();
      await Promise.all([direct, sweep]);

      expect(forceFlags()).toEqual([true, false]);
    });

    /**
     * Park on pre-lock settings so same-turn stop() observes synchronous active-run registration.
     * An inside-lock gate is vacuous because the stopping recheck prevents reaching it (AC6).
     */
    it('registers a forced run synchronously, so a same-turn stop() still drains it (AC6)', async () => {
      const bookId = await insertBook();
      const settingsGate = deferred();
      settingsGet.mockImplementation(async (key: string) => {
        if (key === 'companionEpub') { await settingsGate.promise; return { enabled: true }; }
        return { path: libraryRoot };
      });

      const direct = reconciler.reconcileBook(bookId, true);
      const stopping = reconciler.stop();
      const stopState = track(stopping);
      await flush();
      expect(stopState.settled).toBe(false);

      settingsGate.resolve();
      await Promise.all([direct, stopping]);
      expect(stopState.settled).toBe(true);
    });

    it('refuses a forced run once the drain has resolved (AC6)', async () => {
      const bookId = await insertBook();
      await reconciler.stop();

      await expect(reconciler.reconcileBook(bookId, true)).resolves.toBeUndefined();
      expect(settingsGet).not.toHaveBeenCalled();
      expect(observeMock).not.toHaveBeenCalled();
    });

    it('returns `stopped` from a forced run that reaches the lock after stopping (AC6)', async () => {
      const bookId = await insertBook();
      const lockGate = deferred();
      const actual = await vi.importActual<typeof import('./book-admission.js')>('./book-admission.js');
      const holding = actual.withBookAdmissionLock(bookId, async () => { await lockGate.promise; });

      const direct = reconciler.reconcileBook(bookId, true);
      await waitUntil(
        () => hoisted.events.includes(`lock.acquire:${bookId}`),
        'the forced run to queue on the held lock',
      );

      const stopping = reconciler.stop();
      lockGate.resolve();
      await Promise.all([holding, direct, stopping]);

      expect(hoisted.events).toContain(`lock.held:${bookId}`);
      expect(observeMock).not.toHaveBeenCalled();
      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: 'the book-changed term',
        reason: 'book-changed',
        mutate: async (bookId: number) => {
          await db.update(books).set({ path: join(libraryRoot, 'moved') }).where(eq(books.id, bookId));
        },
      },
      {
        name: 'the observation-changed term',
        reason: 'observation-changed',
        mutate: async (bookId: number) => {
          await db.update(companionEbooks).set({ status: 'drm_protected' }).where(eq(companionEbooks.bookId, bookId));
        },
      },
    ])('still aborts to `conflicted` on $name under force (AC6)', async ({ reason, mutate }) => {
      const bookId = await insertBook();
      await seedRow(bookId);
      outcomes.set(bookId, async () => { await mutate(bookId); return OBSERVED; });

      await reconciler.reconcileBook(bookId, true);

      expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      expect(abortReasons()).toEqual([reason]);
    });

    it('acquires the admission lock exactly once and takes no sweep semaphore slot (AC6)', async () => {
      const bookId = await insertBook();

      await reconciler.reconcileBook(bookId, true);

      expect(hoisted.events.filter((event) => event === `lock.acquire:${bookId}`)).toHaveLength(1);
      expect(hoisted.events.filter((event) => event === `lock.held:${bookId}`)).toHaveLength(1);
      // User-triggered forced refresh must not queue behind the sweep semaphore.
      expect(hoisted.events).not.toContain('semaphore.wait');
    });

    it('still honours the feature gate and the eligibility gate under force (AC6)', async () => {
      enabled = false;
      const disabledId = await insertBook();
      await reconciler.reconcileBook(disabledId, true);
      expect(observeMock).not.toHaveBeenCalled();

      enabled = true;
      const ineligibleId = await insertBook({ status: 'missing' });
      await seedRow(ineligibleId);
      const before = await readRow(ineligibleId);

      await reconciler.reconcileBook(ineligibleId, true);

      expect(observeMock).not.toHaveBeenCalled();
      expect(await readRow(ineligibleId)).toEqual(before);
    });
  });

  describe('selectCompanionEbook (#1976)', () => {
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

    /** Echo revalidation inputs so ladder tests need no real EPUB; persisted-row assertions catch wrong arguments. */
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

    it('persists the chosen candidate as selected and returns the row the commit wrote', async () => {
      const { bookId } = await seedCandidates(['a.epub', 'b.epub']);
      await seedRow(bookId, { status: 'ambiguous', filename: null, sizeBytes: null, mtimeMs: null, ctimeMs: null, candidateCount: 2 });
      stubRevalidation();

      const result = await reconciler.selectCompanionEbook(bookId, 1);

      expect(result.outcome).toBe('selected');
      if (result.outcome !== 'selected') return;
      // selected_filename derives from filename and must satisfy their paired CHECK (AC30).
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
      // Identity catches an equal-looking post-commit reread outside the transaction (AC29).
      expect(result.row).toBe(await upsertCompanionEbookMock.mock.results[0]!.value);
      // Third read would be a forbidden post-commit reread.
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

    // Selector owns the pass; observeCompanionEbook's unchanged short-circuit is unreachable (AC26/AC27).
    it('never calls observeCompanionEbook, and re-runs the whole pass on a repeated identical pick', async () => {
      const { bookId } = await seedCandidates(['a.epub', 'b.epub']);
      stubRevalidation();

      const first = await reconciler.selectCompanionEbook(bookId, 0);
      const second = await reconciler.selectCompanionEbook(bookId, 0);

      expect(first.outcome).toBe('selected');
      expect(second.outcome).toBe('selected');
      expect(observeMock).not.toHaveBeenCalled();
      expect(findCompanionEbookCandidatesMock).toHaveBeenCalledTimes(2);
      expect(revalidateCompanionFileMock).toHaveBeenCalledTimes(2);
      expect(upsertCompanionEbookMock).toHaveBeenCalledTimes(2);
    });

    /** Selection info records exclude sweep summaries by their books denominator. */
    function selectionInfoRecords(): Array<Record<string, unknown>> {
      return spies.info.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((record) => record !== null && typeof record === 'object' && !('books' in record));
    }

    describe('the persisted-selection audit record', () => {
      // Owner-triggered mutations need their own default-level audit record; no sweep summary exists.
      it('emits exactly one info record with the safe fields on a successful persist', async () => {
        const { bookId } = await seedCandidates(['a.epub', 'b.epub', 'c.epub']);
        stubRevalidation();

        await expect(reconciler.selectCompanionEbook(bookId, 2)).resolves.toMatchObject({ outcome: 'selected' });

        const records = selectionInfoRecords();
        expect(records).toHaveLength(1);
        // Exact keys prevent future path/library-root leakage.
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
          status: 'invalid',
          candidateCount: 2,
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

    describe('book_missing (step 1)', () => {
      it('returns book_missing with no discovery, no resolver, and no write', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        await db.delete(books).where(eq(books.id, bookId));

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'book_missing' });

        expect(findCompanionEbookCandidatesMock).not.toHaveBeenCalled();
        expect(resolveCompanionEbookPathMock).not.toHaveBeenCalled();
        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      });

      // Delete after real lock acquisition but before the callback to reproduce the route/snapshot race (F6).
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

    /** Pin both directions: range checks use the live list, never stored candidate_count (F8). */
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
        // Equality includes updated_at.
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
       * Symlinks planted before discovery are excluded by isFile(), so swap a regular file after
       * discovery and let the real resolver expose the TOCTOU escape.
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
        // The mutation lands between step 8 and step 9, the guarded-commit window.
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

    /** Service-level throw proves the locked callback is absorbed; a route stub cannot (F7). */
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
        // Setup rejections warn; locked-callback failures stay at debug (AC25).
        expect(spies.warn).not.toHaveBeenCalled();
      });

      it('resolves to failed when a collaborator inside the lock throws', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        findCompanionEbookCandidatesMock.mockRejectedValueOnce(new Error('discovery exploded'));

        await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toEqual({ outcome: 'failed' });
        expect(upsertCompanionEbookMock).not.toHaveBeenCalled();
      });
    });

    describe('lock and semaphore discipline', () => {
      it('acquires the admission lock exactly once and takes no sweep semaphore slot', async () => {
        const { bookId } = await seedCandidates(['a.epub']);
        stubRevalidation();

        await reconciler.selectCompanionEbook(bookId, 0);

        expect(lockAcquisitions(bookId)).toHaveLength(1);
        // User-triggered selection must not queue behind the sweep semaphore.
        expect(semaphoreEvents()).toEqual([]);
      });

      it('serializes two concurrent selections for the same book through the lock', async () => {
        const { bookId } = await seedCandidates(['a.epub', 'b.epub']);
        stubRevalidation();

        const [first, second] = await Promise.all([
          reconciler.selectCompanionEbook(bookId, 0),
          reconciler.selectCompanionEbook(bookId, 1),
        ]);

        // Both selected outcomes prove the queued call reread the first commit instead of using stale prior state.
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
       * Gate the first settings await: same-turn stop latches before the lock, making a revalidation
       * gate unreachable. Only synchronous activeBookRuns registration can keep the drain pending.
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
        // Step 0 sees the drain latched before locked work begins.
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
        // shutdown calls stop() before app.close(), so the write must finish before drain resolution.
        expect(await readRow(bookId)).toMatchObject({ filename: 'a.epub', selectedFilename: 'a.epub' });
      });
    });
  });

});
