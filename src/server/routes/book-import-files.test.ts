import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Needed only by the completion section below, which drives the queued job through the adapter.
vi.mock('@core/utils/audio-scanner.js', () => ({ scanAudioDirectory: vi.fn() }));
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/utils/audio-processor.js')>()),
  resolveFfmpegPath: () => Promise.resolve('/usr/bin/ffmpeg'),
}));
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, importJobs } from '@db/schema.js';
import { BOOK_STATUSES } from '@shared/schemas/book.js';
import { createMockLogger, createMockSettingsService, inject, type ZodTestApp } from '../__tests__/helpers.js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { errorHandlerPlugin } from '../plugins/error-handler.js';
import { BookService } from '../services/book.service.js';
import { BookImportService } from '../services/book-import.service.js';
import { bookImportFilesRoute } from './book-import-files.js';
import { manualImportJobPayloadSchema, type ImportAdapterContext, type ImportJob } from '../services/import-adapters/types.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { ManualImportAdapter } from '../services/import-adapters/manual.js';
import { EventHistoryService } from '../services/event-history.service.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { MetadataService } from '../services/metadata.service.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { bookEvents } from '@db/schema.js';

const isWin = process.platform === 'win32';

/**
 * #2435 AC15–AC18. DB-backed with a real temp filesystem throughout: every property here is about
 * what SURVIVED a refusal or a rollback, and about how real filesystem nodes classify.
 */
describe('POST /api/books/:id/import-files (#2435)', () => {
  let dir: string;
  let libraryRoot: string;
  let db: Db;
  let app: ZodTestApp;
  let bookService: BookService;
  let bookImportService: BookImportService;
  let nudge: ReturnType<typeof vi.fn>;
  const log = createMockLogger();

  async function buildApp(): Promise<void> {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await bookImportFilesRoute(app, {
      db,
      bookService,
      bookImportService,
      settingsService: createMockSettingsService({ library: { path: libraryRoot } }),
      nudgeImportWorker: nudge as unknown as () => void,
    });
    await app.ready();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'attach-route-'));
    libraryRoot = join(dir, 'library');
    mkdirSync(libraryRoot, { recursive: true });
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    bookService = new BookService(db, inject(log));
    bookImportService = new BookImportService(db, inject(log));
    nudge = vi.fn();
    await buildApp();
  });

  afterEach(async () => {
    await app.close();
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps libSQL handles open */ }
  });

  async function seedBook(overrides: Record<string, unknown> = {}): Promise<number> {
    const [row] = await db.insert(books).values({
      publicId: `bk_${Math.random().toString(36).slice(2, 12).padEnd(18, '0')}`,
      title: 'Wanted Book', status: 'wanted', path: null, ...overrides,
    }).returning();
    return row!.id;
  }

  function seedAudioDir(name = 'source'): string {
    const folder = join(dir, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'book.m4b'), Buffer.alloc(1024));
    return folder;
  }

  const post = (id: number | string, body: unknown) =>
    app.inject({ method: 'POST', url: `/api/books/${id}/import-files`, payload: body as never });

  const rowOf = async (id: number) => (await db.select().from(books).where(eq(books.id, id)))[0]!;

  /** No refusal may move the book or its path; asserted after every negative case. */
  async function expectUntouched(id: number, status = 'wanted'): Promise<void> {
    const row = await rowOf(id);
    expect(row.status).toBe(status);
    expect(row.path).toBeNull();
    expect(await db.select().from(importJobs)).toHaveLength(0);
    expect(nudge).not.toHaveBeenCalled();
  }

  // ── AC15: schema ──────────────────────────────────────────────────────────────────────────────

  describe('schema validation', () => {
    it.each(['copy', 'move'] as const)('accepts mode=%s', async (mode) => {
      const id = await seedBook();
      const res = await post(id, { path: seedAudioDir(`src-${mode}`), mode });
      expect(res.statusCode).toBe(202);
    });

    it('rejects an OMITTED mode — pointer adoption is not offered on this surface', async () => {
      const id = await seedBook();
      const res = await post(id, { path: seedAudioDir() });
      expect(res.statusCode).toBe(400);
      await expectUntouched(id);
    });

    it('rejects an unknown mode', async () => {
      const id = await seedBook();
      const res = await post(id, { path: seedAudioDir(), mode: 'teleport' });
      expect(res.statusCode).toBe(400);
      await expectUntouched(id);
    });

    it.each([
      ['a missing path', { mode: 'copy' }],
      ['an empty path', { path: '', mode: 'copy' }],
      ['a whitespace path', { path: '   ', mode: 'copy' }],
    ])('rejects %s', async (_label, body) => {
      const id = await seedBook();
      const res = await post(id, body);
      expect(res.statusCode).toBe(400);
      await expectUntouched(id);
    });
  });

  // ── AC16: the refusal matrix, in order ────────────────────────────────────────────────────────

  describe('refusal matrix', () => {
    it('404s an unknown book id', async () => {
      const res = await post(999_999, { path: seedAudioDir(), mode: 'copy' });
      expect(res.statusCode).toBe(404);
      expect(await db.select().from(importJobs)).toHaveLength(0);
    });

    it('409 book_has_file when the book already holds one', async () => {
      const id = await seedBook({ path: join(libraryRoot, 'Existing'), status: 'imported' });
      const res = await post(id, { path: seedAudioDir(), mode: 'copy' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('book_has_file');
    });

    it.each(BOOK_STATUSES)('classifies a fileless %s book against the status matrix', async (status) => {
      const id = await seedBook({ status });
      const res = await post(id, { path: seedAudioDir(`src-${status}`), mode: 'copy' });

      if (['wanted', 'searching', 'failed', 'missing'].includes(status)) {
        expect(res.statusCode).toBe(202);
      } else {
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe('status_not_attachable');
        await expectUntouched(id, status);
      }
    });

    // The exact combination a path-only gate plus a job-only conflict check both wave through.
    it('409 status_not_attachable for a downloading book with NO import job row', async () => {
      const id = await seedBook({ status: 'downloading' });
      const res = await post(id, { path: seedAudioDir(), mode: 'copy' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('status_not_attachable');
      await expectUntouched(id, 'downloading');
    });

    it('409 already_importing when an active job exists', async () => {
      const id = await seedBook();
      await db.insert(importJobs).values({ bookId: id, type: 'manual', status: 'pending', metadata: '{}' });
      const res = await post(id, { path: seedAudioDir(), mode: 'copy' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('already_importing');
      const row = await rowOf(id);
      expect(row.status).toBe('wanted');
      expect(row.path).toBeNull();
      expect(nudge).not.toHaveBeenCalled();
    });

    it('400 source_inside_library for a path under the library root', async () => {
      const id = await seedBook();
      const inside = join(libraryRoot, 'Some Book');
      mkdirSync(inside, { recursive: true });
      writeFileSync(join(inside, 'book.m4b'), Buffer.alloc(1024));
      const res = await post(id, { path: inside, mode: 'copy' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('source_inside_library');
      await expectUntouched(id);
    });

    // One case is enough to pin the ORDER: an imported book with a real path trips both.
    it('answers book_has_file, not status_not_attachable, when a book trips both', async () => {
      const id = await seedBook({ path: join(libraryRoot, 'Existing'), status: 'imported' });
      const res = await post(id, { path: seedAudioDir(), mode: 'copy' });
      expect(res.json().error).toBe('book_has_file');
    });
  });

  // ── AC16: admissibility ───────────────────────────────────────────────────────────────────────

  describe('source admissibility', () => {
    // Positive controls first: without them every refusal below would pass against a validator
    // that rejects everything.
    it('admits a readable audio file passed directly', async () => {
      const id = await seedBook();
      const file = join(dir, 'direct.m4b');
      writeFileSync(file, Buffer.alloc(1024));
      const res = await post(id, { path: file, mode: 'copy' });
      expect(res.statusCode).toBe(202);
    });

    it('admits a directory whose only audio sits in a subdirectory', async () => {
      const id = await seedBook();
      const root = join(dir, 'nested');
      mkdirSync(join(root, 'CD1'), { recursive: true });
      writeFileSync(join(root, 'CD1', 'track.mp3'), Buffer.alloc(1024));
      const res = await post(id, { path: root, mode: 'copy' });
      expect(res.statusCode).toBe(202);
    });

    async function expectSourceInvalid(sourcePath: string): Promise<void> {
      const id = await seedBook();
      const res = await post(id, { path: sourcePath, mode: 'copy' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('source_invalid');
      expect(typeof res.json().message).toBe('string');
      await expectUntouched(id);
    }

    it('refuses a nonexistent path', async () => {
      await expectSourceInvalid(join(dir, 'nope'));
    });

    it('refuses a hidden root', async () => {
      const hidden = join(dir, '.stuff');
      mkdirSync(hidden, { recursive: true });
      writeFileSync(join(hidden, 'book.m4b'), Buffer.alloc(1024));
      await expectSourceInvalid(hidden);
    });

    it('refuses a direct file with an unsupported extension', async () => {
      const file = join(dir, 'notes.txt');
      writeFileSync(file, 'hello');
      await expectSourceInvalid(file);
    });

    // Load-bearing: assertCopyVerified(0, 0) does not throw, so without this refusal the book
    // reaches `imported` owning a path with no audio.
    it('refuses a readable directory containing no supported audio at any depth', async () => {
      const root = join(dir, 'audio-empty');
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'readme.txt'), 'hello');
      await expectSourceInvalid(root);
    });

    // Neither a regular file nor a directory. The real fixture is Linux-only; the stubbed case
    // below pins the same branch everywhere.
    it.runIf(!isWin)('refuses a FIFO named like an audio file', async () => {
      const fifo = join(dir, 'book.m4b');
      execFileSync('mkfifo', [fifo]);
      await expectSourceInvalid(fifo);
    });

    // chmod 000 does not deny the owner on Windows, so the permission branch would silently
    // exercise the success path and fail on the outcome rather than erroring.
    describe.skipIf(isWin)('unreadable sources', () => {
      it('refuses an unreadable supported direct file', async () => {
        const file = join(dir, 'locked.m4b');
        writeFileSync(file, Buffer.alloc(1024));
        chmodSync(file, 0o000);
        try {
          await expectSourceInvalid(file);
        } finally {
          chmodSync(file, 0o644);
        }
      });

      it('refuses an unreadable root directory without leaking a raw EACCES', async () => {
        const root = join(dir, 'locked-root');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'book.m4b'), Buffer.alloc(1024));
        chmodSync(root, 0o000);
        try {
          await expectSourceInvalid(root);
        } finally {
          chmodSync(root, 0o755);
        }
      });

      // The recursion is what escapes here; a root-only test cannot catch it.
      it('refuses a readable root whose only audio sits under an unreadable subdirectory', async () => {
        const root = join(dir, 'readable-root');
        const sub = join(root, 'locked-sub');
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, 'book.m4b'), Buffer.alloc(1024));
        chmodSync(sub, 0o000);
        try {
          await expectSourceInvalid(root);
        } finally {
          chmodSync(sub, 0o755);
        }
      });
    });
  });

  // ── AC18 / AC28: the route's job, driven through the adapter ─────────────────────────────────

  /**
   * AC28 is asserted on BOTH attach entry points on purpose: the route builds its own payload, so
   * a guard that only the staged runner's payload happens to satisfy would pass there and fail here.
   */
  describe('completion through the adapter', () => {
    const settings = () => createMockSettingsService({
      tagging: { writeOpf: false },
      library: { path: libraryRoot, folderFormat: '{author}/{title}', fileFormat: '' },
    });

    function buildAdapter(broadcaster?: EventBroadcasterService): ManualImportAdapter {
      const settingsService = settings();
      return new ManualImportAdapter({
        db,
        log: inject(log),
        bookService,
        bookImportService,
        settingsService,
        eventHistory: new EventHistoryService(db, inject(log), inject<BlacklistService>({}), bookService),
        ...(broadcaster ? { broadcaster } : {}),
        enrichmentDeps: {
          db, log: inject(log), settingsService, bookService,
          metadataService: { enrichBook: vi.fn().mockResolvedValue(null), resolveBook: vi.fn().mockResolvedValue(null) } as unknown as MetadataService,
        },
      });
    }

    function setTags(overrides: Record<string, unknown> = {}): void {
      vi.mocked(scanAudioDirectory).mockResolvedValue({
        codec: 'aac', bitrate: 64000, sampleRate: 44100, channels: 2, bitrateMode: 'cbr',
        fileFormat: 'm4b', fileCount: 1, totalSize: 1024, totalDuration: 3600, hasCoverArt: false,
        ...overrides,
      } as never);
    }

    const context = (): ImportAdapterContext =>
      ({ db, log: inject(log), setPhase: vi.fn().mockResolvedValue(undefined), emitProgress: vi.fn() });

    async function runQueuedJob(adapter: ManualImportAdapter): Promise<void> {
      const [job] = await db.select().from(importJobs);
      await adapter.process(job as ImportJob, context());
    }

    it('lands the book inside the library root as imported, with the SSE and the imported event', async () => {
      setTags();
      const created = await bookService.create({ title: 'Route Title', status: 'wanted', authors: [{ name: 'Route Author' }] } as never);
      await db.update(books).set({ status: 'wanted', path: null }).where(eq(books.id, created.id));
      const emit = vi.fn();
      const adapter = buildAdapter({ emit } as unknown as EventBroadcasterService);

      expect((await post(created.id, { path: seedAudioDir('route-src'), mode: 'copy' })).statusCode).toBe(202);
      await runQueuedJob(adapter);

      const row = await rowOf(created.id);
      expect(row.status).toBe('imported');
      expect(row.path!.split('\\').join('/')).toContain(libraryRoot.split('\\').join('/'));
      // The SSE reports the transition truthfully because the ROUTE set `importing` first.
      expect(emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({
        book_id: created.id, old_status: 'importing', new_status: 'imported',
      }));
      const [event] = await db.select().from(bookEvents).where(eq(bookEvents.bookId, created.id));
      expect(event).toMatchObject({ eventType: 'imported', source: 'manual' });
    });

    it('renders the folder from the incumbent, not from the request', async () => {
      setTags();
      const created = await bookService.create({ title: 'Incumbent Title', status: 'wanted', authors: [{ name: 'Incumbent Author' }] } as never);
      await db.update(books).set({ status: 'wanted', path: null }).where(eq(books.id, created.id));
      const adapter = buildAdapter();

      await post(created.id, { path: seedAudioDir('route-naming'), mode: 'copy' });
      await runQueuedJob(adapter);

      expect((await rowOf(created.id)).path!.split('\\').join('/'))
        .toContain('Incumbent Author/Incumbent Title');
    });

    it('does not let enrichment replace a populated incumbent narrator list or duration', async () => {
      setTags({ tagNarrator: 'Tag Narrator', totalDuration: 7200 });
      const created = await bookService.create({
        title: 'Curated', status: 'wanted', authors: [{ name: 'A' }], narrators: ['Curated Narrator'], duration: 600,
      } as never);
      await db.update(books).set({ status: 'wanted', path: null, duration: 600 }).where(eq(books.id, created.id));
      const adapter = buildAdapter();

      await post(created.id, { path: seedAudioDir('route-enrich'), mode: 'copy' });
      await runQueuedJob(adapter);

      const detail = await bookService.getById(created.id);
      expect(detail!.narrators.map((n) => n.name)).toEqual(['Curated Narrator']);
      expect((await rowOf(created.id)).duration).toBe(600);
    });

    it('acquires no cover on the route entry point either', async () => {
      setTags({ coverImage: Buffer.from('EMBEDDED'), coverMimeType: 'image/jpeg' });
      const created = await bookService.create({ title: 'Coverless', status: 'wanted', authors: [{ name: 'A' }] } as never);
      await db.update(books).set({ status: 'wanted', path: null, coverUrl: null }).where(eq(books.id, created.id));
      const adapter = buildAdapter();

      await post(created.id, { path: seedAudioDir('route-cover'), mode: 'copy' });
      await runQueuedJob(adapter);

      expect((await rowOf(created.id)).coverUrl).toBeNull();
    });
  });

  // ── AC17 / AC26: the accepting path ───────────────────────────────────────────────────────────

  describe('acceptance', () => {
    it('transitions to importing, enqueues a manual attach job, and returns the job id', async () => {
      const id = await seedBook();
      const source = seedAudioDir();

      const res = await post(id, { path: source, mode: 'move' });

      expect(res.statusCode).toBe(202);
      const jobs = await db.select().from(importJobs);
      expect(jobs).toHaveLength(1);
      expect(res.json().jobId).toBe(jobs[0]!.id);
      expect(jobs[0]!.bookId).toBe(id);
      expect(jobs[0]!.type).toBe('manual');
      expect((await rowOf(id)).status).toBe('importing');
    });

    it('carries mode, the attach marker and the supplied source path on the payload', async () => {
      const id = await seedBook();
      const source = seedAudioDir();

      await post(id, { path: source, mode: 'copy' });

      const [job] = await db.select().from(importJobs);
      const payload = manualImportJobPayloadSchema.parse(JSON.parse(job!.metadata!));
      expect(payload).toMatchObject({ attach: true, mode: 'copy', path: source });
      // Naming does NOT travel through the payload — a payload-shape assertion is exactly the
      // check that passed while editionLabel and productionType were missing. It is pinned
      // end-to-end on the rendered path, in the adapter suite.
      expect(payload).not.toHaveProperty('metadata');
      expect(payload).not.toHaveProperty('narrators');
    });

    it('nudges the import worker exactly once on success', async () => {
      const id = await seedBook();
      await post(id, { path: seedAudioDir(), mode: 'copy' });
      expect(nudge).toHaveBeenCalledTimes(1);
    });

    it('409s and leaves the concurrent writer\'s status in place when the guard misses', async () => {
      const id = await seedBook();
      const source = seedAudioDir();
      // A concurrent writer moves the book after the route read it, before the transaction.
      vi.spyOn(bookService, 'getById').mockImplementation(async () => {
        const row = await rowOf(id);
        await db.update(books).set({ status: 'downloading' }).where(eq(books.id, id));
        return { ...row, authors: [], narrators: [] } as never;
      });

      const res = await post(id, { path: source, mode: 'copy' });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('already_importing');
      expect((await rowOf(id)).status).toBe('downloading');
      expect(await db.select().from(importJobs)).toHaveLength(0);
      expect(nudge).not.toHaveBeenCalled();
    });

    /**
     * The case two separate transactions cannot pass: `transitionBookStatus` commits immediately
     * on whatever executor it receives, so a split implementation would already have written
     * `importing` before the insert failed.
     */
    it('rolls the status write back when the enqueue fails for a non-conflict reason', async () => {
      const id = await seedBook();
      const source = seedAudioDir();
      const txSpy = vi.spyOn(db, 'transaction');
      vi.spyOn(bookImportService, 'enqueue').mockRejectedValue(new Error('insert exploded'));

      const res = await post(id, { path: source, mode: 'copy' });

      expect(res.statusCode).toBe(500);
      const row = await rowOf(id);
      expect(row.status).toBe('wanted');
      expect(row.path).toBeNull();
      expect(await db.select().from(importJobs)).toHaveLength(0);
      expect(txSpy).toHaveBeenCalledTimes(1);
      expect(nudge).not.toHaveBeenCalled();
    });

    it('maps the RAW active-job unique violation to 409 already_importing, not a 500', async () => {
      const id = await seedBook();
      const source = seedAudioDir();
      // A competing pass claims the book between our precheck and our insert; supplying a
      // transaction routes past the wrapper that would otherwise map this.
      vi.spyOn(bookImportService, 'enqueue').mockImplementation(async (input, tx) => {
        await tx!.insert(importJobs).values({ bookId: input.bookId, type: 'manual', status: 'pending', metadata: '{}' });
        await tx!.insert(importJobs).values({ bookId: input.bookId, type: 'manual', status: 'pending', metadata: input.metadata });
        return { jobId: -1 };
      });

      const res = await post(id, { path: source, mode: 'copy' });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('already_importing');
      expect((await rowOf(id)).status).toBe('wanted');
      expect(nudge).not.toHaveBeenCalled();
    });

    it('does NOT mislabel an unrelated unique violation as already_importing', async () => {
      const id = await seedBook();
      const source = seedAudioDir();
      vi.spyOn(bookImportService, 'enqueue').mockImplementation(async (_input, tx) => {
        await tx!.insert(books).values({ publicId: 'clash-dup', title: 'X', status: 'wanted' });
        await tx!.insert(books).values({ publicId: 'clash-dup', title: 'Y', status: 'wanted' });
        return { jobId: -1 };
      });

      const res = await post(id, { path: source, mode: 'copy' });

      expect(res.statusCode).toBe(500);
      expect((await rowOf(id)).status).toBe('wanted');
    });
  });
});
