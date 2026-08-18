import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, downloadClients, downloads } from '@db/schema.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { generatePublicId } from '../utils/public-id.js';
import type { DownloadClientService } from './download-client.service.js';
import type { BookImportService } from './book-import.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import type { ImportAdapterContext, ImportJob } from './import-adapters/types.js';

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

// Real fs semantics; only `rename` is re-armed so a rename can be parked inside the section it holds.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  rename: vi.fn(),
}));

/**
 * Counts every acquisition. Both import homes reach enrolled mutators from inside their own section
 * — auto import reaches the enrichment writeback, manual import reaches it and the OPF writer — so
 * AC14's "exactly one acquisition per book" is measured across a whole real import here rather than
 * around a stubbed inner call (this is the half of test 4 the nesting suite cannot drive cheaply).
 */
const acquisitions: number[] = [];
vi.mock('../utils/book-admission-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/book-admission-lock.js')>();
  return {
    ...actual,
    withBookAdmissionLock: vi.fn(<T>(bookId: number, fn: () => Promise<T>) => {
      acquisitions.push(bookId);
      return actual.withBookAdmissionLock(bookId, fn);
    }),
  };
});

// The audio scan and ffmpeg resolution are the only leaves stubbed; the enrichment writeback the
// import reaches is the real one, so a regression to its public wrapper would show up in the count.
vi.mock('@core/utils/audio-scanner.js', () => ({ scanAudioDirectory: vi.fn().mockResolvedValue(null) }));
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  resolveFfmpegPath: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./enrichment-orchestration.helpers.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  orchestrateBookEnrichment: vi.fn().mockResolvedValue({ audioEnriched: false }),
}));

// Passthrough spies: real behavior, plus visibility of the arguments the root snapshot decides.
vi.mock('../utils/import-steps.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, checkDiskSpace: vi.fn().mockImplementation(actual.checkDiskSpace as (...a: unknown[]) => unknown) };
});

import { rename } from 'node:fs/promises';
import { checkDiskSpace } from '../utils/import-steps.js';
import { ImportService } from './import.service.js';
import { ManualImportAdapter } from './import-adapters/manual.js';
import { BookService } from './book.service.js';
import { RenameService } from './rename.service.js';
import { BookDeletionService } from './book-deletion.service.js';
import { SettingsService } from './settings.service.js';
import { withBookAdmissionLock } from './book-admission.js';
import type { DownloadService } from './download.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 14; i++) await tick(); };
const norm = (value: string | null | undefined) => value?.split('\\').join('/') ?? null;
const exists = (p: string): Promise<boolean> => actualFs.lstat(p).then(() => true, () => false);

/**
 * #2369 AC6 / F10 / F11. Both import homes hold the admission lock across their row read, their
 * root registration, the target derivation and the commit. The existing import suites are
 * uncontended mocks — they pass with the outer acquisition deleted — so these cases queue a real
 * import behind a real rename or delete and assert the durable row, the durable folder, and that
 * the import had not begun mutating anything while it waited.
 */
describe('both import homes serialize behind other mutators (#2369 AC6)', () => {
  let dir: string;
  let root: string;
  let source: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let settingsService: SettingsService;
  let bookService: BookService;
  let renameService: RenameService;
  let deletionService: BookDeletionService;

  const setRoot = async (path: string, folderFormat = '{author}/{title}'): Promise<void> => {
    await settingsService.update({ library: { path, folderFormat, fileFormat: '{title}' } });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    acquisitions.length = 0;
    (rename as Mock).mockImplementation(actualFs.rename as never);

    dir = mkdtempSync(join(tmpdir(), 'import-admission-'));
    root = join(dir, 'library');
    source = join(dir, 'downloads', 'Wanderer');
    await actualFs.mkdir(root, { recursive: true });
    await actualFs.mkdir(source, { recursive: true });
    await actualFs.writeFile(join(source, 'wanderer.m4b'), 'audio-bytes');

    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    const logger = inject<FastifyBaseLogger>(log);

    settingsService = new SettingsService(db, logger);
    await setRoot(root);
    bookService = new BookService(db, logger);
    renameService = new RenameService(db, bookService, settingsService, logger);
    deletionService = new BookDeletionService(
      db,
      bookService,
      inject<DownloadService>({ getActiveByBookId: vi.fn().mockResolvedValue([]) }),
      inject<DownloadOrchestrator>({ cancel: vi.fn() }),
      settingsService,
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

  const seedBook = async (title: string, folder: string | null): Promise<number> => {
    const path = folder === null ? null : join(root, folder);
    if (path) {
      await actualFs.mkdir(path, { recursive: true });
      await actualFs.writeFile(join(path, `${title}.m4b`), title);
    }
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title, path, status: 'imported' })
      .returning();
    return row!.id;
  };

  const seedDownload = async (bookId: number): Promise<number> => {
    const [client] = await db
      .insert(downloadClients)
      .values({ name: 'qbit', type: 'qbittorrent', settings: {} })
      .returning();
    const [row] = await db
      .insert(downloads)
      .values({
        publicId: generatePublicId('dl'),
        bookId, indexerId: null, downloadClientId: client!.id, externalId: 'abc',
        title: 'Wanderer', clientStatus: 'completed', pipelineStage: 'idle',
        completedAt: new Date(),
      })
      .returning();
    return row!.id;
  };

  const bookRow = async (id: number) => {
    const [row] = await db.select({ path: books.path, status: books.status, title: books.title })
      .from(books).where(eq(books.id, id));
    return row;
  };

  const downloadStage = async (id: number): Promise<string | null> => {
    const [row] = await db.select({ pipelineStage: downloads.pipelineStage }).from(downloads).where(eq(downloads.id, id));
    return row?.pipelineStage ?? null;
  };

  const importService = (): ImportService => new ImportService(
    db,
    inject<DownloadClientService>({
      getAdapter: vi.fn().mockResolvedValue({
        getDownload: vi.fn().mockResolvedValue({ savePath: join(dir, 'downloads'), name: 'Wanderer' }),
      }),
    }),
    settingsService,
    inject<FastifyBaseLogger>(log),
    undefined,
    bookService,
  );

  const manualAdapter = (): { adapter: ManualImportAdapter; ctx: ImportAdapterContext } => {
    const enrichmentDeps = inject<EnrichmentDeps>({ db, log, settingsService, bookService, metadataService: inject({}) });
    const adapter = new ManualImportAdapter({
      db, log: inject<FastifyBaseLogger>(log), bookService,
      bookImportService: inject<BookImportService>({}),
      settingsService,
      eventHistory: inject<EventHistoryService>({ create: vi.fn().mockResolvedValue(undefined) }),
      enrichmentDeps,
    });
    return {
      adapter,
      ctx: { db, log: inject<FastifyBaseLogger>(log), setPhase: vi.fn().mockResolvedValue(undefined), emitProgress: vi.fn() },
    };
  };

  const manualJob = (bookId: number, title: string): ImportJob => inject<ImportJob>({
    id: 1,
    bookId,
    metadata: JSON.stringify({ path: source, title, authorName: 'Unknown Author', mode: 'copy' as const }),
  });

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

  describe('auto import (F10)', () => {
    it('starts no part of its commit until a rename ahead of it finishes, then commits the fresh target', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const downloadId = await seedDownload(bookId);
      const target = join(root, 'Unknown Author', 'Wanderer');

      const { gate, entered } = gateNextRename();
      const renameRun = renameService.renameBook(bookId);
      await entered.promise;

      const importRun = importService().importDownload(downloadId);
      await settle();

      // Queued on admission: the import has not even claimed the pipeline, let alone staged bytes.
      expect(await downloadStage(downloadId)).toBe('idle');
      expect(await exists(`${target}.import-staging`)).toBe(false);
      expect(norm((await bookRow(bookId))?.path)).toBe(norm(join(root, 'Wrong', 'Old')));

      gate.resolve();
      await renameRun;
      const result = await importRun;

      // The commit landed on the folder the row named after the rename, and nothing was left behind.
      expect(norm(result.targetPath)).toBe(norm(target));
      const row = await bookRow(bookId);
      expect(norm(row?.path)).toBe(norm(target));
      expect(row?.status).toBe('imported');
      // The template renames the copied file, so assert the folder holds exactly one audio file.
      expect((await actualFs.readdir(target)).filter((f) => f.endsWith('.m4b'))).toHaveLength(1);
      expect(await exists(join(root, 'Wrong', 'Old'))).toBe(false);
      expect(await actualFs.readdir(join(root, 'Wrong')).catch(() => [])).toEqual([]);
      // AC14: one acquisition for the whole import, including the enrichment writeback inside it.
      expect(acquisitions.filter((id) => id === bookId)).toHaveLength(2); // rename + import
    });

    it('takes its existing not-found arm behind a delete instead of committing a zero-row update', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const downloadId = await seedDownload(bookId);

      const parked = deferred();
      const holder = withBookAdmissionLock(bookId, async () => {
        await parked.promise;
        await deletionService.deleteBookWithinAdmissionLock(bookId, { deleteFiles: true });
      });

      const importRun = importService().importDownload(downloadId).catch((e: unknown) => e);
      await settle();
      expect(await downloadStage(downloadId)).toBe('idle');

      parked.resolve();
      await holder;
      const error = await importRun;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`Book ${bookId} not found`);
      // No library folder was built for a book that no longer exists.
      expect(await exists(join(root, 'Unknown Author', 'Wanderer'))).toBe(false);
      expect(await bookRow(bookId)).toBeUndefined();
    });

    /**
     * F9's import arm, and test 21's `/library-a` → `/library-b` case: the waiting import must
     * derive its target AND prove its free space against the post-write root. Proving capacity for
     * a root the copy will not use is exactly the failure the gate's returned snapshot removes.
     */
    it('waits for an in-flight library write and derives target and disk-space check from the new root', async () => {
      const rootB = join(dir, 'library-b');
      await actualFs.mkdir(rootB, { recursive: true });
      const bookId = await seedBook('Wanderer', null);
      const downloadId = await seedDownload(bookId);

      const parked = deferred();
      const entered = deferred();
      const realSet = settingsService.set.bind(settingsService);
      vi.spyOn(settingsService, 'set').mockImplementationOnce(async (key, value) => {
        entered.resolve();
        await parked.promise;
        return realSet(key, value);
      });

      const write = setRoot(rootB);
      await entered.promise;

      const importRun = importService().importDownload(downloadId);
      await settle();
      // Waiting, not refused, and it has derived nothing: no target exists under either root.
      expect(vi.mocked(checkDiskSpace)).not.toHaveBeenCalled();

      parked.resolve();
      await write;
      const result = await importRun;

      expect(norm(result.targetPath)).toBe(norm(join(rootB, 'Unknown Author', 'Wanderer')));
      expect(norm(String(vi.mocked(checkDiskSpace).mock.calls[0]![0]!.libraryPath))).toBe(norm(rootB));
      expect((await actualFs.readdir(join(rootB, 'Unknown Author', 'Wanderer'))).filter((f) => f.endsWith('.m4b'))).toHaveLength(1);
      expect(await actualFs.readdir(root)).toEqual([]);
    });
  });

  describe('manual import (F11)', () => {
    it('copies nothing until a rename ahead of it finishes, then commits path and status together', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      await db.update(books).set({ status: 'importing' }).where(eq(books.id, bookId));
      // The copy lands beside the rename's own target rather than on it: importing a second
      // recording into a folder the book already owns is refused for unrelated reasons.
      const target = join(root, 'Unknown Author', 'Wanderer Redux');
      const { adapter, ctx } = manualAdapter();

      const { gate, entered } = gateNextRename();
      const renameRun = renameService.renameBook(bookId);
      await entered.promise;

      const importRun = adapter.process(manualJob(bookId, 'Wanderer Redux'), ctx);
      await settle();

      // Nothing copied and the row still names the pre-rename folder: it never read it.
      expect(await exists(join(target, 'wanderer.m4b'))).toBe(false);
      expect(norm((await bookRow(bookId))?.path)).toBe(norm(join(root, 'Wrong', 'Old')));

      gate.resolve();
      await renameRun;
      await importRun;

      const row = await bookRow(bookId);
      // Durable end state: the copy target committed with `imported`, never `path=new,
      // status=importing`, which is what the section makes unobservable.
      expect(norm(row?.path)).toBe(norm(target));
      expect(row?.status).toBe('imported');
      expect((await actualFs.readdir(target)).filter((f) => f.endsWith('.m4b'))).toHaveLength(1);
      // AC14: the OPF writer and the enrichment writeback both run inside this one acquisition.
      expect(acquisitions.filter((id) => id === bookId)).toHaveLength(2); // rename + manual import
    });

    it('takes its existing not-found arm behind a delete and copies nothing', async () => {
      const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
      const { adapter, ctx } = manualAdapter();

      const parked = deferred();
      const holder = withBookAdmissionLock(bookId, async () => {
        await parked.promise;
        await deletionService.deleteBookWithinAdmissionLock(bookId, { deleteFiles: true });
      });

      const importRun = adapter.process(manualJob(bookId, 'Wanderer'), ctx).catch((e: unknown) => e);
      await settle();

      parked.resolve();
      await holder;
      const error = await importRun;

      expect((error as Error).message).toContain('may have been deleted after import was queued');
      expect(await exists(join(root, 'Unknown Author', 'Wanderer'))).toBe(false);
    });

    /**
     * The identity direction: an owner edit that lands while the copy is queued must survive it.
     * The import's own commit touches `path`/`size`/`status`, and its file naming comes from a row
     * read taken inside the section, so the two never produce a half-and-half row.
     */
    it('preserves an identity edit that landed while the copy was queued', async () => {
      const bookId = await seedBook('Wanderer', null);
      await db.update(books).set({ status: 'importing' }).where(eq(books.id, bookId));
      const { adapter, ctx } = manualAdapter();

      const parked = deferred();
      const holder = withBookAdmissionLock(bookId, async () => {
        await parked.promise;
        await bookService.update(bookId, { title: 'Renamed By Operator' }, { userAsserted: true });
      });

      const importRun = adapter.process(manualJob(bookId, 'Wanderer'), ctx);
      await settle();
      expect(await exists(join(root, 'Unknown Author', 'Wanderer'))).toBe(false);

      parked.resolve();
      await holder;
      await importRun;

      const row = await bookRow(bookId);
      expect(row?.title).toBe('Renamed By Operator');
      expect(row?.status).toBe('imported');
      expect(norm(row?.path)).toBe(norm(join(root, 'Unknown Author', 'Wanderer')));
      // The file template ran against the post-edit identity, not the queued payload's title.
      expect(await actualFs.readdir(join(root, 'Unknown Author', 'Wanderer'))).toEqual(['Renamed By Operator.m4b']);
    });
  });
});
