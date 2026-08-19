import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { BookService } from './book.service.js';
import { RenameService } from './rename.service.js';
import { MergeService } from './merge.service.js';
import { generatePublicId } from '../utils/public-id.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import type { SettingsService } from './settings.service.js';

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  rename: vi.fn(),
}));

// Merge derives its recovery target, its staging sibling and its output path from ONE `book.path`
// read. Parking recovery is the earliest point that read is observable.
const actualRecovery = await vi.importActual<typeof import('../utils/recover-interrupted-commit.js')>('../utils/recover-interrupted-commit.js');
vi.mock('../utils/recover-interrupted-commit.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  recoverInterruptedCommit: vi.fn(),
}));

vi.mock('@core/utils/audio-processor.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  resolveFfmpegPath: vi.fn().mockResolvedValue('/usr/bin/ffmpeg'),
  // Fail after recovery so the case never has to run a real encode; everything under test —
  // which path merge derived — has already happened by then.
  processAudioFiles: vi.fn().mockRejectedValue(new Error('encode stopped for the test')),
}));

vi.mock('./enrichment-utils.js', () => ({ enrichBookFromAudioWithinAdmissionLock: vi.fn() }));
vi.mock('../utils/paths.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  cleanEmptyParents: vi.fn().mockResolvedValue(undefined),
}));

import { rename } from 'node:fs/promises';
import { recoverInterruptedCommit } from '../utils/recover-interrupted-commit.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const norm = (value: string | null | undefined) => value?.split('\\').join('/') ?? null;

/**
 * #2369 AC5 / F2 / F13. Merge used to read `book.path` and derive its staging sibling, its recovery
 * target and its output path from that read, then start locking only at `recoverInterruptedCommit`.
 * A merge queued behind a rename therefore woke holding a path the row had vacated.
 *
 * AC5 permits either strategy — move the read inside the section, or revalidate a pre-lock snapshot.
 * This implementation moved the read inside, so the assertion is the successful arm: recovery and
 * staging reference the POST-rename path, and the vacated path receives zero filesystem calls.
 * The invariant is "never touches the vacated path", not "must fail".
 */
describe('merge composes with rename through the admission lock (#2369 AC5)', () => {
  let dir: string;
  let root: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;
  let renameService: RenameService;
  let mergeService: MergeService;

  const settings = () => inject<SettingsService>({
    get: vi.fn().mockImplementation(async (category: string) => {
      if (category === 'library') return { path: root, folderFormat: '{author}/{title}', fileFormat: '' };
      if (category === 'processing') return { outputFormat: 'm4b', bitrate: 64, keepOriginalBitrate: true, maxConcurrentProcessing: 1 };
      return {};
    }),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    (rename as Mock).mockImplementation(actualFs.rename as never);
    (recoverInterruptedCommit as Mock).mockImplementation(actualRecovery.recoverInterruptedCommit as never);

    dir = mkdtempSync(join(tmpdir(), 'merge-admission-'));
    root = join(dir, 'library');
    await actualFs.mkdir(root, { recursive: true });
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    const logger = inject<FastifyBaseLogger>(log);

    bookService = new BookService(db, logger);
    renameService = new RenameService(db, bookService, settings(), logger);
    mergeService = new MergeService(db, bookService, settings(), logger);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps libSQL handles open; see windows-hostile-test-primitives.
    }
  });

  /** Merge needs at least two top-level audio files to be eligible. */
  const seedMergeableBook = async (title: string, folder: string): Promise<number> => {
    const path = join(root, folder);
    await actualFs.mkdir(path, { recursive: true });
    await actualFs.writeFile(join(path, 'part-1.m4b'), 'a');
    await actualFs.writeFile(join(path, 'part-2.m4b'), 'b');
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title, path, status: 'imported' })
      .returning();
    return row!.id;
  };

  it('derives recovery and staging from the post-rename path when queued behind a rename', async () => {
    const bookId = await seedMergeableBook('Wanderer', join('Wrong', 'Old'));
    const oldPath = join(root, 'Wrong', 'Old');
    const target = join(root, 'Unknown Author', 'Wanderer');

    // Park the rename inside its own `fs.rename`, holding admission.
    const gate = deferred();
    const entered = deferred();
    (rename as Mock).mockImplementationOnce(async (from: string, to: string) => {
      entered.resolve();
      await gate.promise;
      return actualFs.rename(from, to);
    });

    const renameRun = renameService.renameBook(bookId);
    await entered.promise;

    // Rename recovers inside its own claim span, before the move — so a call already exists, and
    // it is against the old path. That is the rename's, not the merge's.
    const afterRenameRecovered = vi.mocked(recoverInterruptedCommit).mock.calls.length;
    expect(afterRenameRecovered).toBe(1);
    expect(norm(String(vi.mocked(recoverInterruptedCommit).mock.calls[0]![0]))).toBe(norm(oldPath));

    await mergeService.enqueueMerge(bookId);
    await settle();

    // The merge is queued on admission: it has not read the row, let alone recovered against it.
    expect(vi.mocked(recoverInterruptedCommit).mock.calls).toHaveLength(afterRenameRecovered);

    gate.resolve();
    await renameRun;
    await settle();

    // The merge's own recovery targets the folder the row names NOW.
    const mergeRecoveryTargets = vi.mocked(recoverInterruptedCommit).mock.calls
      .slice(afterRenameRecovered)
      .map((c) => norm(String(c[0])));
    expect(mergeRecoveryTargets).toEqual([norm(target)]);
    expect(mergeRecoveryTargets).not.toContain(norm(oldPath));

    // The vacated path is gone, and nothing recreated it or a staging sibling beside it.
    expect(await actualFs.lstat(oldPath).then(() => true, () => false)).toBe(false);
    const wrongParent = await actualFs.readdir(join(root, 'Wrong')).catch(() => [] as string[]);
    expect(wrongParent).toEqual([]);
  });
});
