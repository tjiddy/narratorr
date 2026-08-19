import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, settings as settingsTable } from '@db/schema.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { generatePublicId } from '../utils/public-id.js';

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

// Re-armed per case so a rename can be parked mid-move, inside the registration it holds.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  rename: vi.fn(),
}));

import { rename } from 'node:fs/promises';
import { SettingsService } from './settings.service.js';
import { BookService } from './book.service.js';
import { RenameService } from './rename.service.js';
import { LibraryRootBusyError, beginRootCommit, rootGateState } from './library-root-gate.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const norm = (value: string | null) => value?.split('\\').join('/') ?? null;

/**
 * #2369 AC15 / F5 / F9. `library-root-gate.test.ts` proves the primitive; these cases prove the
 * WIRING, which the primitive suite cannot see: they drive the real `SettingsService.update` and a
 * real root-dependent commit, so deleting the wrapper in the service — or a caller's registration,
 * or its use of the root the registration returns — fails here rather than passing a green suite.
 */
describe('root-scope gate wiring through its real participants (#2369 AC15)', () => {
  let dir: string;
  let rootA: string;
  let rootB: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let settingsService: SettingsService;
  let bookService: BookService;
  let renameService: RenameService;

  beforeEach(async () => {
    vi.clearAllMocks();
    (rename as Mock).mockImplementation(actualFs.rename as never);

    dir = mkdtempSync(join(tmpdir(), 'root-gate-wiring-'));
    rootA = join(dir, 'library-a');
    rootB = join(dir, 'library-b');
    await actualFs.mkdir(rootA, { recursive: true });
    await actualFs.mkdir(rootB, { recursive: true });

    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    const logger = inject<FastifyBaseLogger>(log);

    settingsService = new SettingsService(db, logger);
    await settingsService.update({ library: { path: rootA, folderFormat: '{author}/{title}', fileFormat: '{title}' } });

    bookService = new BookService(db, logger);
    renameService = new RenameService(db, bookService, settingsService, logger);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps libSQL handles open; see windows-hostile-test-primitives.
    }
  });

  const seedBook = async (title: string, folder: string): Promise<number> => {
    const path = join(folder);
    await actualFs.mkdir(path, { recursive: true });
    await actualFs.writeFile(join(path, `${title}.m4b`), title);
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title, path, status: 'imported' })
      .returning();
    return row!.id;
  };

  const storedCategory = async (key: string): Promise<Record<string, unknown> | undefined> => {
    const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key)).limit(1);
    return row?.value as Record<string, unknown> | undefined;
  };

  /** Park the next `fs.rename` so the rename sits inside its admission section AND registration. */
  const gateNextRename = () => {
    const gate = deferred();
    const entered = deferred();
    (rename as Mock).mockImplementationOnce(async (from: string, to: string) => {
      entered.resolve();
      await gate.promise;
      return actualFs.rename(from, to);
    });
    return { gate, entered };
  };

  describe('SettingsService.update routes library writes through the gate (F5)', () => {
    /**
     * The multi-category arm is the one that matters: the loop is not transactional, so the refusal
     * has to be decided before ANY category is written. A refusal decided per-category — or a
     * service that never entered the gate at all — leaves `metadata` committed here.
     */
    it('refuses a multi-category request naming library while a commit is registered, writing no category', async () => {
      const commit = await beginRootCommit(settingsService);

      await expect(settingsService.update({
        library: { path: rootB, folderFormat: '{author}/{title}', fileFormat: '{title}' },
        search: { intervalMinutes: 15 },
      })).rejects.toBeInstanceOf(LibraryRootBusyError);

      // Every category in the request is untouched, in the durable row, not just in the return value.
      expect(norm(String((await storedCategory('library'))?.path))).toBe(norm(rootA));
      expect((await storedCategory('search'))?.intervalMinutes).not.toBe(15);
      expect((await settingsService.get('library')).path).toBe(rootA);

      commit.release();
    });

    it('allows the same library write once the registration releases', async () => {
      const commit = await beginRootCommit(settingsService);
      await expect(settingsService.update({ library: { path: rootB, folderFormat: '{author}/{title}', fileFormat: '{title}' } }))
        .rejects.toBeInstanceOf(LibraryRootBusyError);

      commit.release();

      await settingsService.update({ library: { path: rootB, folderFormat: '{author}/{title}', fileFormat: '{title}' } });
      expect((await settingsService.get('library')).path).toBe(rootB);
    });

    // The asymmetry is deliberate: only `library` repoints the root every target derives from.
    it('lets a non-library category through untouched while a commit is registered', async () => {
      const commit = await beginRootCommit(settingsService);

      const updated = await settingsService.update({ search: { intervalMinutes: 45 } });

      expect(updated.search.intervalMinutes).toBe(45);
      expect((await storedCategory('search'))?.intervalMinutes).toBe(45);
      commit.release();
    });

    it('leaves no registration or writer flag behind when the write is refused', async () => {
      const commit = await beginRootCommit(settingsService);
      await expect(settingsService.update({ library: { path: rootB, folderFormat: '{author}/{title}', fileFormat: '{title}' } }))
        .rejects.toBeInstanceOf(LibraryRootBusyError);
      commit.release();

      expect(rootGateState()).toEqual({ commitsInFlight: 0, settingsWriteInFlight: false });
    });
  });

  describe('a real root-dependent commit registers and consumes the returned root (F9)', () => {
    /**
     * Case 21 through a real caller. The settings write is parked after the gate admitted it and
     * before its first `set`, then a rename is issued: it must WAIT (never refuse), and the folder
     * it produces must sit under the POST-write root. A rename that read `library` for itself —
     * or that registered after deriving its target — lands the folder under `/library-a`.
     */
    it('makes a rename wait for an in-flight library write and derive its target from the post-write snapshot', async () => {
      const bookId = await seedBook('Wanderer', join(rootA, 'Wrong', 'Old'));

      const parked = deferred();
      const entered = deferred();
      const realSet = settingsService.set.bind(settingsService);
      vi.spyOn(settingsService, 'set').mockImplementationOnce(async (key, value) => {
        entered.resolve();
        await parked.promise;
        return realSet(key, value);
      });

      // `folderFormat` is part of the same controlling snapshot as `path` — re-templating the
      // library moves every future target just as repointing the root does, and unlike a root move
      // it leaves the already-imported book inside the root, so the case exercises the wait itself.
      const write = settingsService.update({ library: { path: rootA, folderFormat: '{title}', fileFormat: '{title}' } });
      await entered.promise;

      const renameRun = renameService.renameBook(bookId);
      await settle();

      // Waiting, not refused, and it has derived nothing yet: the old folder is still in place.
      expect(await actualFs.lstat(join(rootA, 'Wrong', 'Old')).then(() => true, () => false)).toBe(true);

      parked.resolve();
      await write;
      const result = await renameRun;

      // Post-write template: `{title}`. The pre-write one would have produced `Unknown Author/Wanderer`.
      expect(norm(result.newPath)).toBe(norm(join(rootA, 'Wanderer')));
      expect(await actualFs.lstat(join(rootA, 'Wanderer', 'Wanderer.m4b')).then(() => true, () => false)).toBe(true);
      expect(await actualFs.lstat(join(rootA, 'Unknown Author')).then(() => true, () => false)).toBe(false);
      expect(norm((await db.select({ path: books.path }).from(books).where(eq(books.id, bookId)))[0]!.path))
        .toBe(norm(join(rootA, 'Wanderer')));
    });

    /**
     * Case 20 through a real caller: with a rename mid-commit, the operator's library write is
     * refused rather than repointing the root under it. This is what proves the caller registered —
     * a rename that never called `beginRootCommit` lets the write through.
     */
    it('refuses a library write issued while a real rename is mid-commit', async () => {
      const bookId = await seedBook('Wanderer', join(rootA, 'Wrong', 'Old'));

      const { gate, entered } = gateNextRename();
      const renameRun = renameService.renameBook(bookId);
      await entered.promise;

      expect(rootGateState().commitsInFlight).toBe(1);
      await expect(settingsService.update({ library: { path: rootB, folderFormat: '{author}/{title}', fileFormat: '{title}' } }))
        .rejects.toBeInstanceOf(LibraryRootBusyError);
      expect(norm(String((await storedCategory('library'))?.path))).toBe(norm(rootA));

      gate.resolve();
      await renameRun;

      // And the registration is released in a finally, so the retry the operator makes succeeds.
      expect(rootGateState().commitsInFlight).toBe(0);
      await settingsService.update({ library: { path: rootB, folderFormat: '{author}/{title}', fileFormat: '{title}' } });
      expect((await settingsService.get('library')).path).toBe(rootB);
    });

    // Case 33 through a real caller: a throwing commit must not refuse library writes forever.
    it('releases the registration when the commit fails', async () => {
      const bookId = await seedBook('Wanderer', join(rootA, 'Wrong', 'Old'));
      (rename as Mock).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })));

      await expect(renameService.renameBook(bookId)).rejects.toBeTruthy();

      expect(rootGateState().commitsInFlight).toBe(0);
      await settingsService.update({ library: { path: rootB, folderFormat: '{author}/{title}', fileFormat: '{title}' } });
      expect((await settingsService.get('library')).path).toBe(rootB);
    });
  });
});
