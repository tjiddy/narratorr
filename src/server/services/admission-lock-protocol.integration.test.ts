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
import { RenameService, RenameError } from './rename.service.js';
import { refreshScanBook, RefreshScanError } from './refresh-scan.service.js';
import { TaggingService, RetagError } from './tagging.service.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import { writeOpfSidecar } from '../utils/opf-writer.js';
import { embedTagsForImport } from '../utils/import-steps.js';
import type { CoverUploadError } from './cover-upload.js';
import { generatePublicId } from '../utils/public-id.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { hasPendingBookAdmission, withBookAdmissionLock } from './book-admission.js';
import { runEnrichment } from '../jobs/enrichment.js';
import type { MetadataService } from './metadata.service.js';
import type { DownloadService } from './download.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { SettingsService } from './settings.service.js';

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

// Real fs semantics run; only `rename` is re-armed per test so a mutator can be parked mid-flight,
// INSIDE the section it holds, and a contender issued against it.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  rename: vi.fn(),
}));

vi.mock('../utils/cover-cache.js', () => ({
  preserveBookCover: vi.fn().mockResolvedValue(undefined),
  cleanCoverCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', () => ({ config: { configPath: '/test-config' } }));

vi.mock('@core/utils/audio-scanner.js', () => ({ scanAudioDirectory: vi.fn() }));

// Parkable so a contender can be issued while the enrichment writeback is mid-narrator-loop —
// the exact interleaving the F4 defect exploited.
vi.mock('../utils/find-or-create-person.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  findOrCreateNarrator: vi.fn(),
}));
vi.mock('@core/utils/audio-processor.js', () => ({ resolveFfmpegPath: vi.fn().mockResolvedValue(undefined) }));

// Retag's own writes are the observable for AC13; the mutagen subprocess is not under test.
vi.mock('@core/utils/mutagen-resolver.js', () => ({ resolveMutagenPython: vi.fn().mockResolvedValue('python3') }));
vi.mock('./mutagen-tag-writer.js', () => ({ writeTagsWithMutagen: vi.fn() }));

import { rename } from 'node:fs/promises';
import { writeTagsWithMutagen } from './mutagen-tag-writer.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { findOrCreateNarrator } from '../utils/find-or-create-person.js';

const actualPerson = await vi.importActual<typeof import('../utils/find-or-create-person.js')>('../utils/find-or-create-person.js');

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const norm = (value: string | null) => value?.split('\\').join('/') ?? null;

/**
 * #2369. The admission lock used to protect only its own two takers. These cases pin the property
 * every newly enrolled mutator now has: a mutator that wakes behind a rename or a delete acts on
 * the state the row names NOW, and never touches the path the row has vacated.
 *
 * Every case observes the durable artifact — the `books` row and the on-disk folder — or the exact
 * filesystem calls made, never merely that a collaborator was invoked.
 */
describe('admission-lock protocol — every folder and identity mutator serializes (#2369)', () => {
  let dir: string;
  let root: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;
  let renameService: RenameService;
  let deletionService: BookDeletionService;

  const settings = () => inject<SettingsService>({
    get: vi.fn().mockResolvedValue({ path: root, folderFormat: '{author}/{title}', fileFormat: '' }),
  });

  /** Overwrite mode with no cover keeps the writer the only filesystem observable retag produces. */
  const taggingSettings = () => inject<SettingsService>({
    get: vi.fn().mockResolvedValue({ enabled: true, mode: 'overwrite', embedCover: false, writeOpf: false }),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    (rename as Mock).mockImplementation(actualFs.rename as never);
    vi.mocked(findOrCreateNarrator).mockImplementation(actualPerson.findOrCreateNarrator);
    vi.mocked(writeTagsWithMutagen).mockResolvedValue({ ok: true } as never);
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'aac', bitrate: 64000, sampleRate: 44100, channels: 2, bitrateMode: 'cbr',
      fileFormat: 'M4B', fileCount: 1, totalSize: 1000, totalDuration: 600, hasCoverArt: false,
    });

    dir = mkdtempSync(join(tmpdir(), 'admission-lock-'));
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
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps libSQL handles open; see windows-hostile-test-primitives.
    }
  });

  const seedBook = async (title: string, folder: string, extra: Partial<typeof books.$inferInsert> = {}): Promise<number> => {
    const path = join(root, folder);
    await actualFs.mkdir(path, { recursive: true });
    await actualFs.writeFile(join(path, `${title}.m4b`), title);
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title, path, status: 'imported', ...extra })
      .returning();
    return row!.id;
  };

  const seedRow = async (title: string, path: string | null): Promise<number> => {
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title, path, status: 'imported' })
      .returning();
    return row!.id;
  };

  const pathOf = async (id: number): Promise<string | null> => {
    const [row] = await db.select({ path: books.path }).from(books).where(eq(books.id, id));
    return row?.path ?? null;
  };

  const exists = async (p: string): Promise<boolean> => actualFs.lstat(p).then(() => true, () => false);

  /** Park the next `fs.rename` so the rename sits inside the section it holds. */
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

  // ── AC1 / AC2: lock order and deadlock freedom ───────────────────────────────────────────────

  describe('lock order and deadlock freedom (AC1, AC2)', () => {
    // Case 1.
    it('completes mirrored renames of two books whose source and target folders swap', async () => {
      const a = await seedBook('Alpha', join('Unknown Author', 'Beta'));
      const b = await seedBook('Beta', join('Unknown Author', 'Alpha'));

      // Both must move; neither target is occupied by the other's row once both have run.
      const first = renameService.renameBook(a).catch((e: unknown) => e);
      const second = renameService.renameBook(b).catch((e: unknown) => e);

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      // The invariant is termination, not success: mirrored targets legitimately conflict.
      // A deadlock would hang the suite instead.
    });

    // Case 2 — the delete waits on ADMISSION, not on the claim key.
    //
    // The observation point matters. Parking the rename inside `fs.rename` proves nothing: the
    // rename holds its source claim key there, so the delete blocks on the CLAIM key and the case
    // stays green with the outer acquisition removed. Park it inside `planApply` instead — the
    // rename holds admission and has taken no path lock at all, so anything that waits here can
    // only be waiting on admission.
    it('makes a delete wait while the rename holds only admission, before it takes any claim key', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const target = join(root, 'Unknown Author', 'Wanderer');

      const gate = deferred();
      const entered = deferred();
      const realGetById = bookService.getById.bind(bookService);
      const getById = vi.spyOn(bookService, 'getById').mockImplementationOnce(async (id: number) => {
        entered.resolve();
        await gate.promise;
        return realGetById(id);
      });

      const renameRun = renameService.renameBook(bookId);
      await entered.promise;

      const deleteRun = deletionService.deleteBook(bookId, { deleteFiles: true });
      await settle();

      // Only the rename's own plan read has happened. Unlocked, the delete would have hydrated its
      // row, taken the old-path claim the rename does not yet hold, swept it and dropped the row.
      expect(getById).toHaveBeenCalledTimes(1);
      expect(norm(await pathOf(bookId))).toBe(norm(join(root, 'Wrong', 'Old')));

      gate.resolve();
      await renameRun;
      const result = await deleteRun;

      expect(result.outcome).toBe('deleted');
      // The delete swept the folder the rename produced, not the vacated one.
      expect(await exists(join(target, 'Wanderer.m4b'))).toBe(false);
      expect(await exists(join(root, 'Wrong', 'Old'))).toBe(false);
      expect(await pathOf(bookId)).toBeNull();
    });

    // Case 3 — structural: shared write primitives must not acquire, or the first locked caller
    // that reaches one deadlocks. Exercised, not asserted from a comment.
    it('lets a lock holder call every shared write primitive named in AC2 without deadlocking', async () => {
      const bookId = await seedBook('Primitive', join('Unknown Author', 'Primitive'));

      const reached = await withBookAdmissionLock(bookId, async () => {
        // Each of these is reached from inside a held section somewhere in production.
        await bookService.update(bookId, { subtitle: 'from inside the lock' });
        await bookService.updateStatus(bookId, 'imported');
        const detail = await bookService.getById(bookId);
        return detail?.subtitle ?? null;
      });

      expect(reached).toBe('from inside the lock');
    });
  });

  // ── AC3: the controlling snapshot is read or revalidated inside the section ──────────────────

  describe('stale controlling snapshots (AC3)', () => {
    // Case 9 — refresh-scan behind a rename.
    it('makes a refresh scan queued behind a rename read the post-rename path, never the vacated one', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const oldPath = join(root, 'Wrong', 'Old');
      const target = join(root, 'Unknown Author', 'Wanderer');

      const { gate, entered } = gateNextRename();
      const renameRun = renameService.renameBook(bookId);
      await entered.promise;

      const scanRun = refreshScanBook(bookId, bookService, settings(), inject<FastifyBaseLogger>(log));
      await settle();
      // It has not even read the row yet.
      expect(vi.mocked(scanAudioDirectory)).not.toHaveBeenCalled();

      gate.resolve();
      await renameRun;
      await scanRun;

      const scanned = vi.mocked(scanAudioDirectory).mock.calls.map((c) => norm(String(c[0])));
      expect(scanned).toEqual([norm(target)]);
      expect(scanned).not.toContain(norm(oldPath));
    });

    // Case 9, delete direction.
    it('makes a refresh scan queued behind a delete take NOT_FOUND rather than scanning a dead path', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));

      const parked = deferred();
      const holder = withBookAdmissionLock(bookId, async () => {
        await parked.promise;
        await deletionService.deleteBookWithinAdmissionLock(bookId, { deleteFiles: true });
      });

      const scanRun = refreshScanBook(bookId, bookService, settings(), inject<FastifyBaseLogger>(log))
        .catch((e: unknown) => e);
      await settle();
      expect(vi.mocked(scanAudioDirectory)).not.toHaveBeenCalled();

      parked.resolve();
      await holder;
      const error = await scanRun;

      expect(error).toBeInstanceOf(RefreshScanError);
      expect((error as RefreshScanError).code).toBe('NOT_FOUND');
      expect(vi.mocked(scanAudioDirectory)).not.toHaveBeenCalled();
    });

    // Case 11 — the OPF `ownsFolder` window is closed, not merely narrowed.
    it('makes an OPF write queued behind a rename skip the vacated folder entirely', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const oldPath = join(root, 'Wrong', 'Old');

      const { gate, entered } = gateNextRename();
      const renameRun = renameService.renameBook(bookId);
      await entered.promise;

      const opfRun = writeOpfSidecar({
        enabled: true, bookService, bookId, bookFolder: oldPath, log: inject<FastifyBaseLogger>(log),
      });
      await settle();
      expect(await exists(join(oldPath, 'metadata.opf'))).toBe(false);

      gate.resolve();
      await renameRun;
      const outcome = await opfRun;

      // The book no longer owns the folder the writer was handed.
      expect(outcome).toBe('skipped');
      expect(await exists(join(oldPath, 'metadata.opf'))).toBe(false);
    });

    /**
     * Case 10 / F13. Retag holds per-audio-FILE keys; rename holds the folder claim key. Different
     * keys exclude nothing, so before the outer acquisition a retag could resolve `book.path`, then
     * write tags into files a rename was in the middle of moving.
     */
    it('makes a retag queued behind a rename tag the post-rename files, never the vacated ones', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const oldPath = join(root, 'Wrong', 'Old');
      const target = join(root, 'Unknown Author', 'Wanderer');
      const taggingService = new TaggingService(db, taggingSettings(), inject<FastifyBaseLogger>(log), bookService);

      const { gate, entered } = gateNextRename();
      const renameRun = renameService.renameBook(bookId);
      await entered.promise;

      const retagRun = taggingService.retagBook(bookId);
      await settle();
      // Queued on admission: it has not resolved its inputs, let alone written a tag.
      expect(vi.mocked(writeTagsWithMutagen)).not.toHaveBeenCalled();

      gate.resolve();
      await renameRun;
      const result = await retagRun;

      expect(result.tagged).toBe(1);
      const tagged = vi.mocked(writeTagsWithMutagen).mock.calls.map((c) => norm(String(c[1]?.path)));
      expect(tagged).toEqual([norm(join(target, 'Wanderer.m4b'))]);
      expect(tagged).not.toContain(norm(join(oldPath, 'Wanderer.m4b')));
    });

    // Case 10, delete direction — the existing error arm, not a write into a swept folder.
    it('makes a retag queued behind a delete take NOT_FOUND rather than tagging a dead path', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const taggingService = new TaggingService(db, taggingSettings(), inject<FastifyBaseLogger>(log), bookService);

      const parked = deferred();
      const holder = withBookAdmissionLock(bookId, async () => {
        await parked.promise;
        await deletionService.deleteBookWithinAdmissionLock(bookId, { deleteFiles: true });
      });

      const retagRun = taggingService.retagBook(bookId).catch((e: unknown) => e);
      await settle();
      expect(vi.mocked(writeTagsWithMutagen)).not.toHaveBeenCalled();

      parked.resolve();
      await holder;
      const error = await retagRun;

      expect(error).toBeInstanceOf(RetagError);
      expect((error as RetagError).code).toBe('NOT_FOUND');
      expect(vi.mocked(writeTagsWithMutagen)).not.toHaveBeenCalled();
    });

    /**
     * F15. The unlocked audio-enrichment entry is the last surface that could have carried a
     * caller's pre-lock folder into the section. Its scan, its embedded-cover write and its scalar
     * commit all key on one snapshot, so a stale one writes an entire enrichment — cover included —
     * into the vacated folder and then commits it to a row that names somewhere else.
     */
    it('makes an unlocked audio enrichment queued behind a rename scan and write the post-rename folder', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const oldPath = join(root, 'Wrong', 'Old');
      const target = join(root, 'Unknown Author', 'Wanderer');
      vi.mocked(scanAudioDirectory).mockResolvedValue({
        codec: 'aac', bitrate: 64000, sampleRate: 44100, channels: 2, bitrateMode: 'cbr',
        fileFormat: 'M4B', fileCount: 1, totalSize: 1000, totalDuration: 600, hasCoverArt: true,
        coverImage: Buffer.from('embedded'), coverMimeType: 'image/jpeg',
      } as never);

      const { gate, entered } = gateNextRename();
      const renameRun = renameService.renameBook(bookId);
      await entered.promise;

      const enrichRun = enrichBookFromAudio(bookId, db, inject<FastifyBaseLogger>(log), bookService);
      await settle();
      // Queued: it has not read the row, so nothing has been scanned against either folder.
      expect(vi.mocked(scanAudioDirectory)).not.toHaveBeenCalled();

      gate.resolve();
      await renameRun;
      const result = await enrichRun;

      expect(result.enriched).toBe(true);
      const scanned = vi.mocked(scanAudioDirectory).mock.calls.map((c) => norm(String(c[0])));
      expect(scanned).toEqual([norm(target)]);
      expect(scanned).not.toContain(norm(oldPath));
      // The embedded cover landed in the folder the row names, and the vacated one is gone.
      expect(await exists(join(target, 'cover.jpg'))).toBe(true);
      expect(await exists(oldPath)).toBe(false);
      // The scan it committed is the one it took against that same folder.
      const [row] = await db.select({ audioFileCount: books.audioFileCount, coverUrl: books.coverUrl })
        .from(books).where(eq(books.id, bookId));
      expect(row?.audioFileCount).toBe(1);
      expect(row?.coverUrl).toBe(`/api/books/${bookId}/cover`);
    });

    // The delete direction: an enrichment with no row left writes nothing and reports nothing.
    it('makes an unlocked audio enrichment queued behind a delete skip instead of scanning a dead path', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));

      const parked = deferred();
      const holder = withBookAdmissionLock(bookId, async () => {
        await parked.promise;
        await deletionService.deleteBookWithinAdmissionLock(bookId, { deleteFiles: true });
      });

      const enrichRun = enrichBookFromAudio(bookId, db, inject<FastifyBaseLogger>(log), bookService);
      await settle();
      expect(vi.mocked(scanAudioDirectory)).not.toHaveBeenCalled();

      parked.resolve();
      await holder;

      expect(await enrichRun).toEqual({ enriched: false });
      expect(vi.mocked(scanAudioDirectory)).not.toHaveBeenCalled();
    });

    /**
     * #2461. The auto-import success tail embeds tags against the pre-release `result.targetPath`
     * while holding only per-audio-FILE keys — the same disjoint-key gap Case 10 closed for retag.
     *
     * Park point: at `fs.rename` the rename holds admission AND the folder claim keys, while the
     * embed takes admission plus file keys. Those two key domains exclude nothing from each other,
     * so admission is the only tier that can order this pair — which is why deleting the embed's
     * acquisition reds this case while every pre-existing one stays green.
     */
    const importEmbed = (bookId: number, targetPath: string, taggingService: TaggingService) =>
      embedTagsForImport({
        taggingService, taggingEnabled: true, taggingMode: 'overwrite', embedCover: false,
        bookId, targetPath,
        book: { title: 'Wanderer', authorName: null, narrator: null, seriesName: null, seriesPosition: null, coverUrl: null },
        bookService, log: inject<FastifyBaseLogger>(log),
      });

    // Case 13 — rename direction: skip, not retarget. Neither folder is written.
    it('makes an import tag embed queued behind a rename write no tags at all — vacated folder or new', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const oldPath = join(root, 'Wrong', 'Old');
      const target = join(root, 'Unknown Author', 'Wanderer');
      const taggingService = new TaggingService(db, taggingSettings(), inject<FastifyBaseLogger>(log), bookService);

      const { gate, entered } = gateNextRename();
      const renameRun = renameService.renameBook(bookId);
      await entered.promise;

      const embedRun = importEmbed(bookId, oldPath, taggingService);
      await settle();
      // Queued on admission, not merely slow: it has not resolved a single audio file.
      expect(vi.mocked(writeTagsWithMutagen)).not.toHaveBeenCalled();

      gate.resolve();
      await renameRun;
      await embedRun;

      expect(vi.mocked(writeTagsWithMutagen)).not.toHaveBeenCalled();
      // The file the rename produced is byte-unchanged; nothing was recreated at the vacated path.
      expect(await actualFs.readFile(join(target, 'Wanderer.m4b'), 'utf8')).toBe('Wanderer');
      expect(await exists(oldPath)).toBe(false);
      expect(log.warn).toHaveBeenCalledWith(
        { bookId, targetPath: oldPath, bookPath: target },
        'Tag embedding skipped during import — the book no longer owns the imported folder',
      );

      await settle();
      expect(hasPendingBookAdmission(bookId)).toBe(false);
    });

    // Case 14, delete direction — a vanished row skips on the null path, recreating nothing.
    it('makes an import tag embed queued behind a delete skip on the vanished row', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const oldPath = join(root, 'Wrong', 'Old');
      const taggingService = new TaggingService(db, taggingSettings(), inject<FastifyBaseLogger>(log), bookService);

      const parked = deferred();
      const holder = withBookAdmissionLock(bookId, async () => {
        await parked.promise;
        await deletionService.deleteBookWithinAdmissionLock(bookId, { deleteFiles: true });
      });

      const embedRun = importEmbed(bookId, oldPath, taggingService);
      await settle();
      expect(vi.mocked(writeTagsWithMutagen)).not.toHaveBeenCalled();

      parked.resolve();
      await holder;
      await embedRun;

      expect(vi.mocked(writeTagsWithMutagen)).not.toHaveBeenCalled();
      expect(await exists(oldPath)).toBe(false);
      expect(log.warn).toHaveBeenCalledWith(
        { bookId, targetPath: oldPath, bookPath: null },
        'Tag embedding skipped during import — the book no longer owns the imported folder',
      );

      await settle();
      expect(hasPendingBookAdmission(bookId)).toBe(false);
    });

    // Case 15 — what keeps the guard from degenerating into "skip whenever anything else ran".
    it('makes an import tag embed queued behind a mutator that leaves the path alone tag normally', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const bookPath = join(root, 'Wrong', 'Old');
      const taggingService = new TaggingService(db, taggingSettings(), inject<FastifyBaseLogger>(log), bookService);

      // The merge shape: it holds the section for a long time but never moves the folder.
      const parked = deferred();
      const holder = withBookAdmissionLock(bookId, () => parked.promise);

      const embedRun = importEmbed(bookId, bookPath, taggingService);
      await settle();
      expect(vi.mocked(writeTagsWithMutagen)).not.toHaveBeenCalled();

      parked.resolve();
      await holder;
      await embedRun;

      const tagged = vi.mocked(writeTagsWithMutagen).mock.calls.map((c) => norm(String(c[1]?.path)));
      expect(tagged).toEqual([norm(join(bookPath, 'Wanderer.m4b'))]);

      await settle();
      expect(hasPendingBookAdmission(bookId)).toBe(false);
    });

    // Case 12 — cover upload behind a rename localizes against the folder the book owns now.
    it('makes a cover upload queued behind a rename write into the post-rename folder', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const oldPath = join(root, 'Wrong', 'Old');
      const target = join(root, 'Unknown Author', 'Wanderer');

      const { gate, entered } = gateNextRename();
      const renameRun = renameService.renameBook(bookId);
      await entered.promise;

      const uploadRun = bookService.uploadCover(bookId, Buffer.from('img'), 'image/jpeg');
      await settle();
      expect(await exists(join(oldPath, 'cover.jpg'))).toBe(false);

      gate.resolve();
      await renameRun;
      await uploadRun;

      expect(await exists(join(target, 'cover.jpg'))).toBe(true);
      expect(await exists(join(oldPath, 'cover.jpg'))).toBe(false);
    });
  });

  // ── AC10 / F12: the enrichment writeback is one already-locked operation ─────────────────────

  describe('enrichment writeback vs owner edits (AC10, F12)', () => {
    /** A resolver that parks on `gate`, standing in for the provider round trip. */
    const gatedMetadata = (gate: Promise<void>, result: Record<string, unknown> | null) =>
      inject<MetadataService>({
        resolveBook: vi.fn().mockImplementation(async () => {
          await gate;
          return result;
        }),
      });

    /**
     * F12. Scheduled enrichment builds its fill-empty update from a row read, then commits. If that
     * read sat outside the section, a same-ASIN owner edit landing during the provider round trip
     * would be silently overwritten by provider data the operator had just replaced.
     */
    it('does not overwrite an owner edit that landed while the provider round trip was in flight', async () => {
      const bookId = await seedRow('Fillable', null);
      await db.update(books).set({ asin: 'B0000001', enrichmentStatus: 'pending', subtitle: null, publisher: null })
        .where(eq(books.id, bookId));

      const gate = deferred();
      const metadata = gatedMetadata(gate.promise, {
        asin: 'B0000001', subtitle: 'Provider Subtitle', publisher: 'Provider Publisher',
      });

      const sweep = runEnrichment(db, metadata, bookService, inject<FastifyBaseLogger>(log));
      await settle();

      // The operator edits the very fields the fill would populate, before the sweep acquires.
      await withBookAdmissionLock(bookId, () =>
        bookService.update(bookId, { subtitle: 'Owner Subtitle' }, { userAsserted: true }));

      gate.resolve();
      await sweep;

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      // Fill-empty semantics: the field the owner filled is no longer empty, so the provider value
      // must not land. The field the owner left alone still fills.
      expect(row?.subtitle).toBe('Owner Subtitle');
      expect(row?.publisher).toBe('Provider Publisher');
    });

    /**
     * The genre half of the same obligation. Genres do not travel with the scalar fill: they are
     * prepared from their own `existing.genres` read and committed through `BookService.update`
     * inside the transaction, so reverting only that read would leave the scalar case above green
     * while an operator's genre edit was overwritten by the provider's list.
     */
    it('does not overwrite an owner genre edit that landed during the provider round trip', async () => {
      const bookId = await seedRow('Genreless', null);
      await db.update(books).set({ asin: 'B0000001', enrichmentStatus: 'pending', genres: [], publisher: null })
        .where(eq(books.id, bookId));

      const gate = deferred();
      const metadata = gatedMetadata(gate.promise, {
        asin: 'B0000001', genres: ['Provider Genre'], publisher: 'Provider Publisher',
      });

      const sweep = runEnrichment(db, metadata, bookService, inject<FastifyBaseLogger>(log));
      await settle();

      await withBookAdmissionLock(bookId, () =>
        bookService.update(bookId, { genres: ['Owner Genre'] }, { userAsserted: true }));

      gate.resolve();
      await sweep;

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      // The genre list is no longer empty, so fill-empty must leave it alone…
      expect(row?.genres).toEqual(['Owner Genre']);
      // …while the field the owner never touched still fills, proving the pass itself ran.
      expect(row?.publisher).toBe('Provider Publisher');
    });

    /**
     * The F4 counterfactual, and the reason the writeback had to become ONE section rather than a
     * check followed by a loop. Fix Match is issued while the writeback is parked between its
     * `isStillSameAsin` check and its first narrator insert. Unlocked, Fix Match lands there: the
     * later scalar guard drops its own write while the stale narrators it cannot see commit anyway,
     * leaving a row that is half one identity and half the other.
     */
    it('does not let Fix Match interleave between the identity check and the narrator inserts', async () => {
      const bookId = await seedRow('Identity', null);
      await db.update(books).set({ asin: 'B0000001', enrichmentStatus: 'pending' }).where(eq(books.id, bookId));

      const metadata = inject<MetadataService>({
        resolveBook: vi.fn().mockResolvedValue({
          asin: 'B0000001', narrators: ['Superseded Narrator'], subtitle: 'Superseded Subtitle',
        }),
      });

      // Park on the first narrator insert — past the guard, before anything has committed.
      const gate = deferred();
      const entered = deferred();
      vi.mocked(findOrCreateNarrator).mockImplementationOnce(async (...args) => {
        entered.resolve();
        await gate.promise;
        return actualPerson.findOrCreateNarrator(...args);
      });

      const sweep = runEnrichment(db, metadata, bookService, inject<FastifyBaseLogger>(log));
      await entered.promise;

      let fixMatchDone = false;
      const fixMatch = bookService.fixMatch(bookId, {
        asin: 'B0000002', title: 'Replaced', authors: [{ name: 'New Author' }], narrators: ['Kept Narrator'],
      }).then((r) => { fixMatchDone = true; return r; });
      await settle();

      // It is queued on the book's section, not running inside the writeback.
      expect(fixMatchDone).toBe(false);

      gate.resolve();
      await sweep;
      await fixMatch;

      const detail = await bookService.getById(bookId);
      expect(detail?.asin).toBe('B0000002');
      expect(detail?.title).toBe('Replaced');
      // Wholly one identity: no narrator from the superseded provider result survived beside it.
      expect(detail?.narrators.map((n) => n.name)).toEqual(['Kept Narrator']);
      expect(detail?.subtitle).not.toBe('Superseded Subtitle');
      // Fix Match's own reset stands.
      expect(detail?.enrichmentStatus).toBe('pending');
    });
  });

  // ── Boundary, null and pointer paths ─────────────────────────────────────────────────────────

  describe('boundary, null and missing paths', () => {
    // Case 25.
    it('takes the existing not-found arm and releases the key when the row vanishes while queued', async () => {
      const bookId = await seedBook('Doomed', join('Wrong', 'Old'));

      const parked = deferred();
      const holder = withBookAdmissionLock(bookId, async () => {
        await parked.promise;
        await db.delete(books).where(eq(books.id, bookId));
      });

      const renameRun = renameService.renameBook(bookId).catch((e: unknown) => e);
      await settle();

      parked.resolve();
      await holder;
      const error = await renameRun;

      expect((error as RenameError).code).toBe('NOT_FOUND');
      await settle();
      expect(hasPendingBookAdmission(bookId)).toBe(false);
    });

    // Case 26 — every enrolled mutator's no-path arm, and none of them wedges the key.
    it('takes each no-path arm for a never-imported book and leaves no key held', async () => {
      const bookId = await seedRow('Never Imported', null);

      const renameError = await renameService.renameBook(bookId).catch((e: unknown) => e);
      expect((renameError as RenameError).code).toBe('NO_PATH');

      const scanError = await refreshScanBook(bookId, bookService, settings(), inject<FastifyBaseLogger>(log))
        .catch((e: unknown) => e);
      expect((scanError as RefreshScanError).code).toBe('NO_PATH');

      const coverError = await bookService.uploadCover(bookId, Buffer.from('img'), 'image/jpeg')
        .catch((e: unknown) => e);
      expect((coverError as CoverUploadError).code).toBe('NO_PATH');

      // Deletion's own `lockedPath === null` arm still deletes the row.
      const deleted = await deletionService.deleteBook(bookId, { deleteFiles: true });
      expect(deleted.outcome).toBe('deleted');

      await settle();
      expect(hasPendingBookAdmission(bookId)).toBe(false);
    });

    // Case 27 — the pointer early-return happens BEFORE any acquisition.
    it('does not acquire the admission lock for a pointer book on the OPF path', async () => {
      const pointer = join(root, 'Loose', 'Pointer.m4b');
      await actualFs.mkdir(join(root, 'Loose'), { recursive: true });
      await actualFs.writeFile(pointer, 'audio');
      const bookId = await seedRow('Pointer', pointer);

      // Hold the book's section for the duration; a writer that acquired would block on it.
      const parked = deferred();
      const holder = withBookAdmissionLock(bookId, () => parked.promise);

      const outcome = await writeOpfSidecar({
        enabled: true, bookService, bookId, bookFolder: pointer, log: inject<FastifyBaseLogger>(log),
      });

      expect(outcome).toBe('skipped');
      parked.resolve();
      await holder;
    });

    // Case 28 — a rejecting section does not poison the next caller, end to end.
    it('lets the next mutator through after a newly wrapped mutator rejects', async () => {
      const bookId = await seedRow('Pathless', null);

      await expect(renameService.renameBook(bookId)).rejects.toBeInstanceOf(RenameError);

      // Give it a path and try again; a poisoned key would hang instead.
      const path = join(root, 'Unknown Author', 'Pathless');
      await actualFs.mkdir(path, { recursive: true });
      await db.update(books).set({ path }).where(eq(books.id, bookId));

      const result = await renameService.renameBook(bookId);
      expect(result.message).toBe('Already organized');
    });

    // Case 29 — the sweep acquires per book and isolates per-book failure.
    it('does not deadlock deleteMissingBooks when one of its books is held by another mutator', async () => {
      const held = await seedRow('Held', null);
      const free = await seedRow('Free', null);
      await db.update(books).set({ status: 'missing' }).where(eq(books.id, held));
      await db.update(books).set({ status: 'missing' }).where(eq(books.id, free));

      const parked = deferred();
      const holder = withBookAdmissionLock(held, () => parked.promise);

      const sweep = deletionService.deleteMissingBooks();
      await settle();
      // The free book cannot be swept ahead of the held one — the loop is sequential — so nothing
      // has completed yet. Releasing the hold must let the whole sweep finish.
      parked.resolve();
      await holder;

      expect(await sweep).toEqual({ deleted: 2, failed: 0 });
    });
  });
});
