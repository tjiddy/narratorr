import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { BookService } from './book.service.js';
import { BookDeletionService } from './book-deletion.service.js';
import { BookRejectionService } from './book-rejection.service.js';
import { RenameService, RenameError, type RenameResult } from './rename.service.js';
import { cleanupOldBookPath } from '../utils/import-steps.js';
import { claimLockKey } from '../utils/claim-lock.js';
import { hasPendingPathWrite, withPathWriteLock } from '../utils/path-write-lock.js';
import { generatePublicId } from '../utils/public-id.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import type { DownloadService } from './download.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { SettingsService } from './settings.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { EventHistoryService } from './event-history.service.js';

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

// Real link/directory/delete semantics run; only `rename` and `rm` are re-armed per test so a
// gated operation can be parked mid-flight, INSIDE the claim it holds.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  rename: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('../utils/cover-cache.js', () => ({
  preserveBookCover: vi.fn().mockResolvedValue(undefined),
  cleanCoverCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./rejection-helpers.js', () => ({
  blacklistAndRetrySearch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', () => ({ config: { configPath: '/test-config' } }));

// The two ends of rename's claim span. Both keep their real implementations (re-armed in
// `beforeEach`) and are only parked per-test, so a contender can be observed against a rename that
// is genuinely inside recovery / inside parent cleanup rather than merely before or after them.
const actualRecovery = await vi.importActual<typeof import('../utils/recover-interrupted-commit.js')>('../utils/recover-interrupted-commit.js');
vi.mock('../utils/recover-interrupted-commit.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  recoverInterruptedCommit: vi.fn(),
}));

const actualPaths = await vi.importActual<typeof import('../utils/paths.js')>('../utils/paths.js');
vi.mock('../utils/paths.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  cleanEmptyParents: vi.fn(),
}));

import { rename, rm } from 'node:fs/promises';
import { blacklistAndRetrySearch } from './rejection-helpers.js';
import { recoverInterruptedCommit } from '../utils/recover-interrupted-commit.js';
import { cleanEmptyParents } from '../utils/paths.js';
import { sidecarLockKey } from '../utils/opf-writer.js';

// A backslash is an ordinary filename character on POSIX and illegal on Windows; the aliased-key
// fixture needs a REAL directory whose name carries one, so probe rather than test the platform.
const CAN_NAME_WITH_BACKSLASH = await (async () => {
  const probe = await actualFs.mkdtemp(join(tmpdir(), 'backslash-probe-'));
  try {
    await actualFs.mkdir(join(probe, 'a\\b'));
    return true;
  } catch {
    return false;
  } finally {
    await actualFs.rm(probe, { recursive: true, force: true });
  }
})();

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const norm = (value: string | null) => value?.split('\\').join('/') ?? null;

describe('claim-key protocol — rename and the three destroyers serialize (#2301)', () => {
  let dir: string;
  let root: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;
  let renameService: RenameService;
  let deletionService: BookDeletionService;
  let rejectionService: BookRejectionService;

  const settings = () => inject<SettingsService>({
    get: vi.fn().mockResolvedValue({ path: root, folderFormat: '{author}/{title}', fileFormat: '' }),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    (rename as Mock).mockImplementation(actualFs.rename as never);
    (rm as Mock).mockImplementation(actualFs.rm as never);
    (recoverInterruptedCommit as Mock).mockImplementation(actualRecovery.recoverInterruptedCommit as never);
    (cleanEmptyParents as Mock).mockImplementation(actualPaths.cleanEmptyParents as never);
    (blacklistAndRetrySearch as Mock).mockResolvedValue(undefined);

    dir = mkdtempSync(join(tmpdir(), 'claim-lock-'));
    root = join(dir, 'library');
    await actualFs.mkdir(root, { recursive: true });
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    const logger = inject<FastifyBaseLogger>(log);

    bookService = new BookService(db, logger);
    renameService = new RenameService(db, bookService, settings(), logger);
    deletionService = new BookDeletionService(
      db,
      bookService,
      inject<DownloadService>({ getActiveByBookId: vi.fn().mockResolvedValue([]) }),
      inject<DownloadOrchestrator>({ cancel: vi.fn() }),
      settings(),
      logger,
    );
    rejectionService = new BookRejectionService(
      db,
      logger,
      bookService,
      inject<BlacklistService>({}),
      settings(),
      inject<EventHistoryService>({ create: vi.fn().mockResolvedValue(null) }),
    );
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps libSQL handles open; see windows-hostile-test-primitives.
    }
  });

  /** A book folder holding one audio file, plus its row. */
  const seedBook = async (
    title: string,
    folder: string,
    extra: Partial<typeof books.$inferInsert> = {},
  ): Promise<number> => {
    const path = join(root, folder);
    await actualFs.mkdir(path, { recursive: true });
    await actualFs.writeFile(join(path, `${title}.m4b`), title);
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title, path, status: 'imported', ...extra })
      .returning();
    return row!.id;
  };

  const seedRow = async (title: string, path: string | null, extra: Partial<typeof books.$inferInsert> = {}): Promise<number> => {
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title, path, status: 'imported', ...extra })
      .returning();
    return row!.id;
  };

  const pathOf = async (id: number): Promise<string | null> => {
    const [row] = await db.select({ path: books.path }).from(books).where(eq(books.id, id));
    return row?.path ?? null;
  };

  const exists = async (p: string): Promise<boolean> => actualFs.lstat(p).then(() => true, () => false);

  /** Park the next `fs.rename` on a gate so the rename sits inside its claim span. */
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

  /** Park the next recovery — the FIRST destructive step, and the span's opening boundary. */
  const gateNextRecovery = () => {
    const gate = deferred();
    const entered = deferred();
    (recoverInterruptedCommit as Mock).mockImplementationOnce(async (...args: Parameters<typeof actualRecovery.recoverInterruptedCommit>) => {
      entered.resolve();
      await gate.promise;
      return actualRecovery.recoverInterruptedCommit(...args);
    });
    return { gate, entered };
  };

  /** Park the next parent cleanup — the span's closing boundary. */
  const gateNextParentCleanup = () => {
    const gate = deferred();
    const entered = deferred();
    (cleanEmptyParents as Mock).mockImplementationOnce(async (...args: Parameters<typeof actualPaths.cleanEmptyParents>) => {
      entered.resolve();
      await gate.promise;
      return actualPaths.cleanEmptyParents(...args);
    });
    return { gate, entered };
  };

  /** A contender on one claim key, reported by whether it has ENTERED rather than by settling. */
  const queueClaimContender = (key: string) => {
    const marker = { entered: false };
    // Every enrolled participant reaches a claim key through exactly this primitive
    // (`withFreshClaimLock` -> `withPathWriteLock(claimLockKey(path))`).
    const run = withPathWriteLock(key, async () => { marker.entered = true; });
    return { marker, run };
  };

  it('serializes two renames onto one target: the second sees the committed owner and refuses', async () => {
    // Both books resolve to <root>/Author/Shared Title.
    const first = await seedBook('Shared Title', join('Wrong A', 'Old A'), {});
    const second = await seedBook('Shared Title', join('Wrong B', 'Old B'), {});
    await db.update(books).set({ title: 'Shared Title' }).where(eq(books.id, first));

    const { gate, entered } = gateNextRename();
    const firstRun = renameService.renameBook(first);
    await entered.promise;

    const secondRun = renameService.renameBook(second).catch((e: unknown) => e);
    await settle();
    // The second is parked on the shared target key, not interleaved into the move.
    expect((rename as Mock).mock.calls).toHaveLength(1);

    gate.resolve();
    await firstRun;
    const error = await secondRun;

    expect(error).toBeInstanceOf(RenameError);
    expect((error as RenameError).code).toBe('CONFLICT');
    const target = join(root, 'Unknown Author', 'Shared Title');
    expect(norm(await pathOf(first))).toBe(norm(target));
    expect(norm(await pathOf(second))).toBe(norm(join(root, 'Wrong B', 'Old B')));
  });

  it('lets a rename proceed onto a target the queued deletion has already swept and released', async () => {
    const owner = await seedBook('Target Owner', join('Unknown Author', 'Mover'));
    const mover = await seedBook('Mover', join('Wrong', 'Old'));
    // Point the owner at the folder the mover will compute as its target.
    const target = join(root, 'Unknown Author', 'Mover');
    await db.update(books).set({ path: target }).where(eq(books.id, owner));

    await deletionService.deleteBook(owner, { deleteFiles: true });
    const result = await renameService.renameBook(mover);

    expect(norm(result.newPath)).toBe(norm(target));
    expect(norm(await pathOf(mover))).toBe(norm(target));
  });

  it('refuses a rename whose target another row still owns, and lets the deletion sweep afterwards', async () => {
    const owner = await seedBook('Mover', join('Unknown Author', 'Mover'));
    const mover = await seedBook('Mover', join('Wrong', 'Old'));

    const error = await renameService.renameBook(mover).catch((e: unknown) => e);
    expect((error as RenameError).code).toBe('CONFLICT');
    expect(norm(await pathOf(mover))).toBe(norm(join(root, 'Wrong', 'Old')));

    const deleted = await deletionService.deleteBook(owner, { deleteFiles: true });
    expect(deleted.outcome).toBe('deleted');
    expect(await exists(join(root, 'Unknown Author', 'Mover', 'Mover.m4b'))).toBe(false);
  });

  it('makes a queued deletion sweep the folder its row names NOW, not the one it read first', async () => {
    const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
    const target = join(root, 'Unknown Author', 'Wanderer');

    const { gate, entered } = gateNextRename();
    const renameRun = renameService.renameBook(bookId);
    await entered.promise;

    // The deletion hydrates its row while the rename still holds the old path.
    const deletionRun = deletionService.deleteBook(bookId, { deleteFiles: true });
    await settle();

    gate.resolve();
    await renameRun;
    const result = await deletionRun;

    expect(result.outcome).toBe('deleted');
    // An implementation keeping the pre-lock path deletes the row while the new folder survives.
    expect(await exists(join(target, 'Wanderer.m4b'))).toBe(false);
    expect(await pathOf(bookId)).toBeNull();
  });

  it('makes a wrong-release rejection sweep the current folder after a same-book rename', async () => {
    const bookId = await seedBook('Wanderer', join('Wrong', 'Old'), { lastGrabGuid: 'guid-a' });
    const oldPath = join(root, 'Wrong', 'Old');
    const target = join(root, 'Unknown Author', 'Wanderer');

    // The folder moves during blacklistAndRetrySearch, before rejection picks its key. Landed
    // directly rather than through `renameService`: after #2369 the rejection holds the book's
    // admission lock across this await, so a real same-book rename would (correctly) queue behind
    // it rather than interleave — the concurrent-rename arm is the case below. What is under test
    // here is unchanged: the claim key comes from a read taken AFTER the await, not before it.
    (blacklistAndRetrySearch as Mock).mockImplementationOnce(async () => {
      await actualFs.mkdir(target, { recursive: true });
      await actualFs.rename(join(oldPath, 'Wanderer.m4b'), join(target, 'Wanderer.m4b'));
      await actualFs.rm(oldPath, { recursive: true, force: true });
      await db.update(books).set({ path: target }).where(eq(books.id, bookId));
    });

    await rejectionService.rejectAsWrongRelease(bookId);

    expect(await exists(join(target, 'Wanderer.m4b'))).toBe(false);
    expect(await exists(oldPath)).toBe(false);
    const [row] = await db.select().from(books).where(eq(books.id, bookId));
    expect(row?.status).toBe('wanted');
    expect(row?.path).toBeNull();
  });

  it('defers a concurrent same-book rename until the rejection has finished (#2369)', async () => {
    const bookId = await seedBook('Wanderer', join('Wrong', 'Old'), { lastGrabGuid: 'guid-a' });
    const order: string[] = [];
    let releaseBlacklist!: () => void;
    const blacklistGate = new Promise<void>((resolve) => { releaseBlacklist = resolve; });

    (blacklistAndRetrySearch as Mock).mockImplementationOnce(async () => {
      order.push('rejection:inside');
      await blacklistGate;
    });

    const rejection = rejectionService.rejectAsWrongRelease(bookId).then(() => { order.push('rejection:done'); });
    await settle();

    // Issued while the rejection is parked mid-flight, inside the section it holds.
    const renameRun = renameService.renameBook(bookId)
      .then(() => { order.push('rename:done'); }, () => { order.push('rename:done'); });
    await settle();

    // Before #2369 the rename would have run straight through: it takes claim keys, and the
    // rejection had not chosen one yet.
    expect(order).toEqual(['rejection:inside']);

    releaseBlacklist();
    await rejection;
    await renameRun;

    expect(order).toEqual(['rejection:inside', 'rejection:done', 'rename:done']);
    // The rejection won, so the rename woke to a pathless row and took its NO_PATH arm.
    expect(await pathOf(bookId)).toBeNull();
  });

  it('abandons the destructive half when a replacement release imported during the blacklist await', async () => {
    const bookId = await seedBook('Wanderer', join('Wrong', 'Old'), { lastGrabGuid: 'guid-a', lastGrabInfoHash: 'hash-a' });
    const replacement = join(root, 'Unknown Author', 'Replacement');
    await actualFs.mkdir(replacement, { recursive: true });
    await actualFs.writeFile(join(replacement, 'Replacement.m4b'), 'B');

    (blacklistAndRetrySearch as Mock).mockImplementationOnce(async () => {
      await db.update(books).set({ path: replacement, lastGrabGuid: 'guid-b', lastGrabInfoHash: 'hash-b' }).where(eq(books.id, bookId));
    });

    await rejectionService.rejectAsWrongRelease(bookId);

    // Release B is untouched: no reset, no sweep.
    expect(await exists(join(replacement, 'Replacement.m4b'))).toBe(true);
    const [row] = await db.select().from(books).where(eq(books.id, bookId));
    expect(row?.status).toBe('imported');
    expect(row?.lastGrabGuid).toBe('guid-b');
    expect(norm(row?.path ?? null)).toBe(norm(replacement));
    // The half the operator did ask for still happened.
    expect(blacklistAndRetrySearch).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ rejected: { guid: 'guid-a', infoHash: 'hash-a' } }),
      expect.stringMatching(/no longer on this book/i),
    );
  });

  it('abandons the destructive half when the book is no longer imported, identifiers unchanged', async () => {
    const bookId = await seedBook('Wanderer', join('Wrong', 'Old'), { lastGrabGuid: 'guid-a' });
    (blacklistAndRetrySearch as Mock).mockImplementationOnce(async () => {
      await db.update(books).set({ status: 'missing' }).where(eq(books.id, bookId));
    });

    await rejectionService.rejectAsWrongRelease(bookId);

    expect(await exists(join(root, 'Wrong', 'Old', 'Wanderer.m4b'))).toBe(true);
    const [row] = await db.select().from(books).where(eq(books.id, bookId));
    expect(row?.status).toBe('missing');
  });

  it.skipIf(!CAN_NAME_WITH_BACKSLASH)('serializes participants whose paths are spelled differently but name one folder', async () => {
    const mover = await seedBook('Wanderer', join('Wrong', 'Old'));
    // A destroyer whose stored path carries a parent segment behind backslashes. `resolve` treats
    // `\` as an ordinary character on POSIX, so a plain-`resolve` key would not collide with the
    // rename's key and both spans would interleave. The directory is real, and lexically inside
    // the root, so the sweep is genuinely reachable once the claim is granted.
    const aliasedPath = join(root, 'Wrong\\X\\..\\Old');
    await actualFs.mkdir(aliasedPath, { recursive: true });
    await actualFs.writeFile(join(aliasedPath, 'aliased.m4b'), 'x');
    const aliasedId = await seedRow('Aliased', aliasedPath);

    const { gate, entered } = gateNextRename();
    const renameRun = renameService.renameBook(mover);
    await entered.promise;

    const deletionRun = deletionService.deleteBook(aliasedId, { deleteFiles: true });
    await settle();
    // The row delete is the observable that survives a key mismatch: under a plain-`resolve` key
    // the destroyer never contends, runs straight through, and its row is already gone here.
    const [parked] = await db.select({ id: books.id }).from(books).where(eq(books.id, aliasedId));
    expect(parked).toBeDefined();

    gate.resolve();
    await renameRun;
    await deletionRun;
    await settle();
    const [afterRelease] = await db.select({ id: books.id }).from(books).where(eq(books.id, aliasedId));
    expect(afterRelease).toBeUndefined();
    expect(hasPendingPathWrite(claimLockKey(join(root, 'Wrong', 'Old')))).toBe(false);
  });

  it('skips the sweep — and still deletes the book — for a pre-existing duplicate-path pair', async () => {
    const folder = join('Author', 'Shared Folder');
    const first = await seedBook('First Claim', folder);
    const second = await seedRow('Second Claim', join(root, folder));

    const result = await deletionService.deleteBook(second, { deleteFiles: true });

    expect(result.outcome).toBe('deleted');
    expect(result).toMatchObject({ fileSummary: { deletedManaged: 0, preservedForeign: [] } });
    expect(await exists(join(root, folder, 'First Claim.m4b'))).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ownerBookId: first }),
      expect.stringMatching(/another book owns this folder/i),
    );
  });

  it('refuses the old-path cleanup when a rename has claimed that folder for another row', async () => {
    const oldFolder = join(root, 'Author', 'Old Folder');
    await actualFs.mkdir(oldFolder, { recursive: true });
    await actualFs.writeFile(join(oldFolder, 'left.m4b'), 'x');
    await seedRow('New Owner', oldFolder);

    await cleanupOldBookPath({
      bookPath: oldFolder,
      targetPath: join(root, 'Author', 'New Folder'),
      libraryRoot: root,
      log: inject<FastifyBaseLogger>(log),
      db,
    });

    expect(await exists(join(oldFolder, 'left.m4b'))).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ownerBookId: expect.any(Number) }),
      expect.stringMatching(/another book owns this folder/i),
    );
  });

  it('holds the pointer file as its claim key, so a raw file-key writer blocks until the rename releases', async () => {
    const pointer = join(root, 'Unknown Author', 'Pointer Book.m4b');
    await actualFs.mkdir(join(root, 'Unknown Author'), { recursive: true });
    await actualFs.writeFile(pointer, 'audio');
    const bookId = await seedRow('Pointer Book', pointer);

    const { gate, entered } = gateNextRename();
    const renameRun = renameService.renameBook(bookId).catch((e: unknown) => e);
    await entered.promise;

    // `tagging.service.ts:118` locks on the RAW stored audio path. Read that string back off the
    // row rather than recomputing it: deriving both sides from `claimLockKey` would move the
    // expected key in lockstep with any change to it, and prove nothing about the coincidence.
    const rawFileKey = (await pathOf(bookId))!;
    const tagWrite = queueClaimContender(rawFileKey);

    await settle();
    expect(tagWrite.marker.entered).toBe(false);

    gate.resolve();
    await renameRun;
    await tagWrite.run;
    expect(tagWrite.marker.entered).toBe(true);

    // `sidecarLockKey` appends metadata.opf, so the EXDEV fallback's nested file key can never
    // equal the claim key it nests inside — including for a pointer path.
    expect(sidecarLockKey(pointer)).not.toBe(rawFileKey);
    await settle();
    expect(hasPendingPathWrite(rawFileKey)).toBe(false);
  });

  it('holds the source claim across recoverInterruptedCommit, so a second same-book rename cannot recover concurrently', async () => {
    const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));

    const { gate, entered } = gateNextRecovery();
    const first = renameService.renameBook(bookId);
    await entered.promise;

    let secondSettled = false;
    const second = renameService.renameBook(bookId)
      .then((v) => { secondSettled = true; return v as unknown; }, (e: unknown) => { secondSettled = true; return e; });
    await settle();

    // Recovery is not a read: with no marker present it recursively deletes the target's staging
    // and backup siblings. A second entry here while the first is mid-recovery is exactly the
    // destructive concurrency the span's opening boundary exists to prevent.
    expect(recoverInterruptedCommit).toHaveBeenCalledTimes(1);
    expect(secondSettled).toBe(false);

    gate.resolve();
    await first;
    const outcome = await second;

    // #2369 changed what the queued rename wakes up holding. It used to carry a plan built from a
    // pre-lock read and be refused by `assertPlanStillFresh` with STALE_PATH; the plan is now built
    // INSIDE the admission section, so it wakes, re-reads, and finds the book already at its target.
    // The property this case exists for is unchanged and stronger: it never entered recovery while
    // the first rename was inside it.
    expect((outcome as RenameError).code).toBeUndefined();
    expect((outcome as RenameResult).message).toBe('Already organized');
    expect(norm(await pathOf(bookId))).toBe(norm(join(root, 'Unknown Author', 'Wanderer')));
  });

  it('lets a queued rename of a second row at the same folder enter recovery only once the claim releases', async () => {
    // The duplicate-path pair this issue's own absence produces — and the arm where the queued
    // participant does reach recovery, which the same-book case cannot show.
    const first = await seedBook('Wanderer', join('Wrong', 'Old'));
    const second = await seedRow('Second Claim', join(root, 'Wrong', 'Old'));

    const { gate, entered } = gateNextRecovery();
    const firstRun = renameService.renameBook(first);
    await entered.promise;

    const secondRun = renameService.renameBook(second).catch((e: unknown) => e);
    await settle();
    expect(recoverInterruptedCommit).toHaveBeenCalledTimes(1);

    gate.resolve();
    await firstRun;
    await secondRun;

    expect(recoverInterruptedCommit).toHaveBeenCalledTimes(2);
    const secondCall = (recoverInterruptedCommit as Mock).mock.calls[1]!;
    expect(norm(secondCall[0] as string)).toBe(norm(join(root, 'Wrong', 'Old')));
  });

  it('holds the source claim through cleanEmptyParents, so a contender cannot enter the vacated path first', async () => {
    const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
    const source = claimLockKey(join(root, 'Wrong', 'Old'));

    const { gate, entered } = gateNextParentCleanup();
    const renameRun = renameService.renameBook(bookId);
    await entered.promise;

    const contender = queueClaimContender(source);
    await settle();
    // Cleanup is removing the vacated folder's parents; a participant that entered here would be
    // mutating a path underneath it.
    expect(contender.marker.entered).toBe(false);

    gate.resolve();
    await renameRun;
    await contender.run;
    expect(contender.marker.entered).toBe(true);
    await settle();
    expect(hasPendingPathWrite(source)).toBe(false);
  });

  it('takes no lock at all in planRename, and releases every key after a rename fails', async () => {
    const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
    const source = claimLockKey(join(root, 'Wrong', 'Old'));
    const target = claimLockKey(join(root, 'Unknown Author', 'Wanderer'));

    const plan = renameService.planRename(bookId);
    expect(hasPendingPathWrite(source)).toBe(false);
    expect(hasPendingPathWrite(target)).toBe(false);
    await plan;
    expect(hasPendingPathWrite(source)).toBe(false);

    (rename as Mock).mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
    await expect(renameService.renameBook(bookId)).rejects.toThrow('EIO');
    await settle();
    expect(hasPendingPathWrite(source)).toBe(false);
    expect(hasPendingPathWrite(target)).toBe(false);
  });
});
