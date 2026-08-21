import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Needed only by the completion section below, which drives the queued job through the adapter.
vi.mock('@core/utils/audio-scanner.js', () => ({ scanAudioDirectory: vi.fn() }));
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/utils/audio-processor.js')>()),
  resolveFfmpegPath: () => Promise.resolve('/usr/bin/ffmpeg'),
}));

/**
 * #2478 — three passthrough spies, each existing for a "was NOT called" assertion that no state
 * observation can make: admission is skipped (its own side effect is a filesystem walk), the move
 * cleanup never ran (a surviving source tree is trivially true when the code never ran), and the
 * forced-refusal terminal was not mistaken for the generic one. Behaviour is unchanged everywhere.
 */
const spies = vi.hoisted(() => ({
  admitAttachSource: vi.fn(),
  deleteManagedBookFiles: vi.fn(),
  finalizeForcedImportRefusal: vi.fn(),
}));
vi.mock('../utils/attach-source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/attach-source.js')>();
  spies.admitAttachSource.mockImplementation(actual.admitAttachSource);
  return { ...actual, admitAttachSource: spies.admitAttachSource };
});
vi.mock('../utils/delete-managed-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/delete-managed-files.js')>();
  spies.deleteManagedBookFiles.mockImplementation(actual.deleteManagedBookFiles);
  return { ...actual, deleteManagedBookFiles: spies.deleteManagedBookFiles };
});
vi.mock('../services/import-refused.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/import-refused.js')>();
  spies.finalizeForcedImportRefusal.mockImplementation(actual.finalizeForcedImportRefusal);
  return { ...actual, finalizeForcedImportRefusal: spies.finalizeForcedImportRefusal };
});
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, importJobs } from '@db/schema.js';
import { BOOK_STATUSES } from '@shared/schemas/book.js';
import { createMockLogger, createMockSettingsService, inject, type ZodTestApp } from '../__tests__/helpers.js';
import { CAN_SYMLINK } from '../__tests__/windows-fs.js';
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
import { ImportQueueWorker } from '../services/import-queue-worker.js';
import { clearImportAdapters, registerImportAdapter } from '../services/import-adapters/registry.js';

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

  async function buildApp(libraryPath: string = libraryRoot): Promise<void> {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await bookImportFilesRoute(app, {
      db,
      bookService,
      bookImportService,
      settingsService: createMockSettingsService({ library: { path: libraryPath } }),
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
    /**
     * #2476 AC10 — a validator rejection never reaches the handler, so it keeps Fastify's preserved
     * envelope from `errorHandlerPlugin` and carries NO `code`. That absence is the whole
     * discriminator now that both classes of refusal answer 400: a status assertion alone cannot
     * tell a malformed request from a business refusal, and would stay green if someone routed
     * validation failures through the handler's envelope.
     */
    function expectValidationEnvelope(res: Awaited<ReturnType<typeof post>>): void {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(typeof res.json().message).toBe('string');
      expect(res.json()).not.toHaveProperty('code');
    }

    it.each(['copy', 'move'] as const)('accepts mode=%s', async (mode) => {
      const id = await seedBook();
      const res = await post(id, { path: seedAudioDir(`src-${mode}`), mode });
      expect(res.statusCode).toBe(202);
    });

    it('rejects an OMITTED mode — pointer adoption is not offered on this surface', async () => {
      const id = await seedBook();
      const res = await post(id, { path: seedAudioDir() });
      expectValidationEnvelope(res);
      await expectUntouched(id);
    });

    it('rejects an unknown mode', async () => {
      const id = await seedBook();
      const res = await post(id, { path: seedAudioDir(), mode: 'teleport' });
      expectValidationEnvelope(res);
      await expectUntouched(id);
    });

    it.each([
      ['a missing path', { mode: 'copy' }],
      ['an empty path', { path: '', mode: 'copy' }],
      ['a whitespace path', { path: '   ', mode: 'copy' }],
    ])('rejects %s', async (_label, body) => {
      const id = await seedBook();
      const res = await post(id, body);
      expectValidationEnvelope(res);
      await expectUntouched(id);
    });

    // Params land on the same branch as body: a non-numeric `:id` never reaches the 404 guard, so
    // this 400 must not be mistakable for `book_not_found`'s envelope either.
    it('rejects a non-numeric :id with the validation envelope, not a business refusal', async () => {
      const res = await post('not-a-number', { path: seedAudioDir('bad-id-src'), mode: 'copy' });
      expectValidationEnvelope(res);
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
      expect(res.json().code).toBe('book_has_file');
    });

    it.each(BOOK_STATUSES)('classifies a fileless %s book against the status matrix', async (status) => {
      const id = await seedBook({ status });
      const res = await post(id, { path: seedAudioDir(`src-${status}`), mode: 'copy' });

      if (['wanted', 'searching', 'failed', 'missing'].includes(status)) {
        expect(res.statusCode).toBe(202);
      } else {
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('status_not_attachable');
        // #2476 T3 — the sentence names the status it refused, so a hard-coded generic one reds
        // here for every member of the matrix rather than only for the one status a spot check picks.
        expect(res.json().error).toBe(`A book with status "${status}" cannot receive a manually-obtained file`);
        await expectUntouched(id, status);
      }
    });

    // The exact combination a path-only gate plus a job-only conflict check both wave through.
    it('409 status_not_attachable for a downloading book with NO import job row', async () => {
      const id = await seedBook({ status: 'downloading' });
      const res = await post(id, { path: seedAudioDir(), mode: 'copy' });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('status_not_attachable');
      await expectUntouched(id, 'downloading');
    });

    it('409 already_importing when an active job exists', async () => {
      const id = await seedBook();
      await db.insert(importJobs).values({ bookId: id, type: 'manual', status: 'pending', metadata: '{}' });
      const res = await post(id, { path: seedAudioDir(), mode: 'copy' });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('already_importing');
      const row = await rowOf(id);
      expect(row.status).toBe('wanted');
      expect(row.path).toBeNull();
      expect(nudge).not.toHaveBeenCalled();
    });

    // The cross-surface whitespace case for this gate: a bare `!path` check would read a
    // whitespace-only path as file-holding here and refuse an attachable book.
    it('treats a whitespace-only books.path as fileless and accepts', async () => {
      const id = await seedBook({ path: '   ' });
      const res = await post(id, { path: seedAudioDir('ws-src'), mode: 'copy' });
      expect(res.statusCode).toBe(202);
    });

    it('400 source_inside_library for a path under the library root', async () => {
      const id = await seedBook();
      const inside = join(libraryRoot, 'Some Book');
      mkdirSync(inside, { recursive: true });
      writeFileSync(join(inside, 'book.m4b'), Buffer.alloc(1024));
      const res = await post(id, { path: inside, mode: 'copy' });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('source_inside_library');
      await expectUntouched(id);
    });

    // One case is enough to pin the ORDER: an imported book with a real path trips both.
    it('answers book_has_file, not status_not_attachable, when a book trips both', async () => {
      const id = await seedBook({ path: join(libraryRoot, 'Existing'), status: 'imported' });
      const res = await post(id, { path: seedAudioDir(), mode: 'copy' });
      expect(res.json().code).toBe('book_has_file');
    });
  });

  // ── #2476: the envelope every handler-emitted refusal answers ────────────────────────────────

  /**
   * `ApiError` prefers `body.error` over `body.message`, so the operator only ever reads `error` —
   * the sentence lives there and the machine token in `code`. Every case asserts the WHOLE body with
   * `toEqual`, which is what makes a re-added `message` (the field that used to strand the useful
   * copy) fail rather than pass unnoticed.
   */
  describe('error envelope (#2476)', () => {
    it('404 — unknown book id', async () => {
      const res = await post(999_999, { path: seedAudioDir('env-404'), mode: 'copy' });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Book not found', code: 'book_not_found' });
    });

    it('409 — the book already holds a library folder', async () => {
      const id = await seedBook({ path: join(libraryRoot, 'Existing'), status: 'imported' });

      const res = await post(id, { path: seedAudioDir('env-has-file'), mode: 'copy' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'This book already has a library folder',
        code: 'book_has_file',
      });
    });

    it('409 — a status that cannot receive a file, with the status interpolated', async () => {
      const id = await seedBook({ status: 'importing' });

      const res = await post(id, { path: seedAudioDir('env-status'), mode: 'copy' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'A book with status "importing" cannot receive a manually-obtained file',
        code: 'status_not_attachable',
      });
      await expectUntouched(id, 'importing');
    });

    it('409 — the pre-check active-job arm', async () => {
      const id = await seedBook();
      await db.insert(importJobs).values({ bookId: id, type: 'manual', status: 'pending', metadata: '{}' });

      const res = await post(id, { path: seedAudioDir('env-active'), mode: 'copy' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'An import is already in progress for this book',
        code: 'already_importing',
      });
    });

    // The lost-race arm is a SECOND send site with its own literal, so the pre-check case above
    // cannot speak for it: a migration that missed this one leaves the raced operator on a token.
    it('409 — the lost-race arm reached through AttachGuardMissed', async () => {
      const id = await seedBook();
      vi.spyOn(bookService, 'getById').mockImplementation(async () => {
        const row = await rowOf(id);
        await db.update(books).set({ status: 'downloading' }).where(eq(books.id, id));
        return { ...row, authors: [], narrators: [] } as never;
      });

      const res = await post(id, { path: seedAudioDir('env-race'), mode: 'copy' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'An import is already in progress for this book',
        code: 'already_importing',
      });
    });

    it('400 — a containment refusal forwards the classifier\'s own sentence', async () => {
      const id = await seedBook();
      const inside = join(libraryRoot, 'Managed');
      mkdirSync(inside, { recursive: true });
      writeFileSync(join(inside, 'book.m4b'), Buffer.alloc(1024));

      const res = await post(id, { path: inside, mode: 'copy' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Source path is inside the library root — it is already managed by the library',
        code: 'source_inside_library',
      });
      // T2: `toEqual` treats an explicitly-undefined `message` as equal, so key absence needs its
      // own assertion — this is the field whose loss the operator actually feels.
      expect(res.json()).not.toHaveProperty('message');
    });

    it('400 — an inadmissible source forwards the admission reason', async () => {
      const id = await seedBook();

      const res = await post(id, { path: join(dir, 'env-missing'), mode: 'copy' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Source path does not exist or could not be read',
        code: 'source_invalid',
      });
      expect(res.json()).not.toHaveProperty('message');
    });

    it('leaks neither error nor code onto the accepted response', async () => {
      const id = await seedBook();

      const res = await post(id, { path: seedAudioDir('env-ok'), mode: 'copy' });

      expect(res.statusCode).toBe(202);
      const [job] = await db.select().from(importJobs);
      expect(res.json()).toEqual({ jobId: job!.id });
    });
  });

  // ── #2478: source containment — root, ancestor, and the existing inside-library class ──────────

  describe('source containment (#2478)', () => {
    /** An ancestor source that is genuinely admissible by content: its only audio is the library's. */
    function seedManagedBookInLibrary(): void {
      const managed = join(libraryRoot, 'Managed Book');
      mkdirSync(managed, { recursive: true });
      writeFileSync(join(managed, 'book.m4b'), Buffer.alloc(1024));
    }

    it('400 source_is_filesystem_root for `/`, without ever reaching admission', async () => {
      const id = await seedBook();

      const res = await post(id, { path: '/', mode: 'move' });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('source_is_filesystem_root');
      // The direct observation, not a wall-clock bound: `hasReadableAudio` returns on the first
      // readable audio file it meets, so an admission-first route can finish fast on CI and still
      // walk an operator's whole filesystem.
      expect(spies.admitAttachSource).not.toHaveBeenCalled();
      await expectUntouched(id);
    });

    it('400 source_contains_library for a source that holds the library root', async () => {
      const id = await seedBook();
      seedManagedBookInLibrary();

      const res = await post(id, { path: dir, mode: 'move' });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('source_contains_library');
      await expectUntouched(id);
    });

    // AC3's empty-relative arm: equality is inside-library, never contains-library.
    it('400 source_inside_library for the library root ITSELF', async () => {
      const id = await seedBook();
      writeFileSync(join(libraryRoot, 'book.m4b'), Buffer.alloc(1024));

      const res = await post(id, { path: libraryRoot, mode: 'copy' });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('source_inside_library');
      await expectUntouched(id);
    });

    it('refuses `/` with NO library path configured, while a normal source still lands', async () => {
      await app.close();
      await buildApp('');
      const rooted = await seedBook();

      const rootRes = await post(rooted, { path: '/', mode: 'move' });

      expect(rootRes.statusCode).toBe(400);
      expect(rootRes.json().code).toBe('source_is_filesystem_root');
      await expectUntouched(rooted);

      const normal = await seedBook();
      expect((await post(normal, { path: seedAudioDir('unconfigured-src'), mode: 'copy' })).statusCode).toBe(202);
    });

    /**
     * The messages are operator-visible copy: `useBookActions` renders `getErrorMessage(error)`
     * straight into a toast. Without this, a route answering a bare `{ error }` — or silently
     * rewording the pre-existing contract — passes every other assertion here.
     */
    it('answers every containment class with its own human-readable message', async () => {
      seedManagedBookInLibrary();

      const insideRes = await post(await seedBook(), { path: join(libraryRoot, 'Managed Book'), mode: 'copy' });
      expect(insideRes.json()).toEqual({
        code: 'source_inside_library',
        error: 'Source path is inside the library root — it is already managed by the library',
      });

      const containsRes = await post(await seedBook(), { path: dir, mode: 'copy' });
      expect(containsRes.json().code).toBe('source_contains_library');
      expect(containsRes.json().error).toMatch(/contains the library root/i);

      const rootRes = await post(await seedBook(), { path: '/', mode: 'copy' });
      expect(rootRes.json().code).toBe('source_is_filesystem_root');
      expect(rootRes.json().error).toMatch(/filesystem root/i);
    });

    /**
     * AC12 — each pre-existing guard paired with a source that WOULD trip containment. The suite's
     * other 404/status cases use normal sources and so prove nothing about precedence; the three
     * containment classes carry distinct codes precisely so a deleted guard stays attributable.
     */
    describe('precedence against the pre-existing guards', () => {
      it('404s an unknown book id before any containment refusal', async () => {
        const res = await post(999_999, { path: '/', mode: 'move' });
        expect(res.statusCode).toBe(404);
        expect(await db.select().from(importJobs)).toHaveLength(0);
      });

      it('answers book_has_file, not a containment refusal', async () => {
        const id = await seedBook({ path: join(libraryRoot, 'Existing'), status: 'imported' });
        const res = await post(id, { path: '/', mode: 'move' });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('book_has_file');
      });

      it('answers status_not_attachable, not a containment refusal', async () => {
        const id = await seedBook({ status: 'downloading' });
        const res = await post(id, { path: dir, mode: 'move' });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('status_not_attachable');
        await expectUntouched(id, 'downloading');
      });

      it('answers already_importing, not a containment refusal', async () => {
        const id = await seedBook();
        await db.insert(importJobs).values({ bookId: id, type: 'manual', status: 'pending', metadata: '{}' });
        const res = await post(id, { path: '/', mode: 'move' });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('already_importing');
        expect((await rowOf(id)).status).toBe('wanted');
        expect(nudge).not.toHaveBeenCalled();
      });
    });

    /**
     * #2538 AC6/AC13 — the same route guard, now keyed on what the source RESOLVES to. Real on-disk
     * links throughout: the whole property is that a lexically-innocent path is refused for where it
     * points, which no string fixture can express.
     */
    describe('symlinked sources (#2538)', () => {
      /** Links live outside the library so the LEXICAL rule admits every one of them. */
      function linkTo(target: string, name: string): string {
        const link = join(dir, name);
        symlinkSync(target, link, 'dir');
        return link;
      }

      it.skipIf(!CAN_SYMLINK)('400 source_inside_library for a link pointing at the library root', async () => {
        const id = await seedBook();
        writeFileSync(join(libraryRoot, 'book.m4b'), Buffer.alloc(1024));
        const link = linkTo(libraryRoot, 'link-library');

        const res = await post(id, { path: link, mode: 'copy' });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({
          error: 'Source path is inside the library root — it is already managed by the library',
          code: 'source_inside_library',
        });
        // Still ahead of admission: the refusal must not have cost a filesystem walk.
        expect(spies.admitAttachSource).not.toHaveBeenCalled();
        await expectUntouched(id);
      });

      it.skipIf(!CAN_SYMLINK)('400 source_contains_library for a link pointing at an ancestor of the library root', async () => {
        const id = await seedBook();
        seedManagedBookInLibrary();
        const link = linkTo(dir, 'link-ancestor');

        const res = await post(id, { path: link, mode: 'move' });

        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('source_contains_library');
        expect(res.json().error).toMatch(/contains the library root/i);
        expect(spies.admitAttachSource).not.toHaveBeenCalled();
        await expectUntouched(id);
      });

      /**
       * AC14's false-refusal control. `admitAttachSource` follows links on purpose, so symlinked
       * media layouts stay supported — without this the whole describe would also pass against a
       * route that refused every symlink.
       */
      it.skipIf(!CAN_SYMLINK)('202 for a link pointing at an ordinary outside folder that holds audio', async () => {
        const id = await seedBook();
        const link = linkTo(seedAudioDir('linked-source'), 'link-outside');

        const res = await post(id, { path: link, mode: 'copy' });

        expect(res.statusCode).toBe(202);
        const [job] = await db.select().from(importJobs);
        expect(res.json()).toEqual({ jobId: job!.id });
        expect(job!.bookId).toBe(id);
        expect(nudge).toHaveBeenCalled();
      });

      // #2478 AC12's precedence, re-run against a SYMLINKED refusal rather than a lexical one.
      describe('precedence against the pre-existing guards', () => {
        it.skipIf(!CAN_SYMLINK)('404s an unknown book id before a symlinked containment refusal', async () => {
          const link = linkTo(libraryRoot, 'link-precedence-404');
          const res = await post(999_999, { path: link, mode: 'move' });
          expect(res.statusCode).toBe(404);
          expect(await db.select().from(importJobs)).toHaveLength(0);
        });

        it.skipIf(!CAN_SYMLINK)('answers book_has_file ahead of a symlinked containment refusal', async () => {
          const id = await seedBook({ path: join(libraryRoot, 'Existing'), status: 'imported' });
          const link = linkTo(libraryRoot, 'link-precedence-has-file');
          const res = await post(id, { path: link, mode: 'move' });
          expect(res.statusCode).toBe(409);
          expect(res.json().code).toBe('book_has_file');
        });

        it.skipIf(!CAN_SYMLINK)('answers status_not_attachable ahead of a symlinked containment refusal', async () => {
          const id = await seedBook({ status: 'downloading' });
          const link = linkTo(dir, 'link-precedence-status');
          const res = await post(id, { path: link, mode: 'move' });
          expect(res.statusCode).toBe(409);
          expect(res.json().code).toBe('status_not_attachable');
          await expectUntouched(id, 'downloading');
        });

        it.skipIf(!CAN_SYMLINK)('answers already_importing ahead of a symlinked containment refusal', async () => {
          const id = await seedBook();
          await db.insert(importJobs).values({ bookId: id, type: 'manual', status: 'pending', metadata: '{}' });
          const link = linkTo(libraryRoot, 'link-precedence-active');
          const res = await post(id, { path: link, mode: 'move' });
          expect(res.statusCode).toBe(409);
          expect(res.json().code).toBe('already_importing');
          expect((await rowOf(id)).status).toBe('wanted');
          expect(nudge).not.toHaveBeenCalled();
        });
      });
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

    /**
     * #2476 T5 — `expectedReason`, where given, is `admitAttachSource`'s own sentence for that
     * class. Asserting the DISTINCT text is what catches a route that answers one hard-coded
     * fallback for every inadmissible source; a `typeof === 'string'` check cannot.
     */
    async function expectSourceInvalid(sourcePath: string, expectedReason?: string): Promise<void> {
      const id = await seedBook();
      const res = await post(id, { path: sourcePath, mode: 'copy' });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('source_invalid');
      if (expectedReason !== undefined) {
        expect(res.json().error).toBe(expectedReason);
      } else {
        expect(typeof res.json().error).toBe('string');
      }
      await expectUntouched(id);
    }

    it('refuses a nonexistent path', async () => {
      await expectSourceInvalid(join(dir, 'nope'), 'Source path does not exist or could not be read');
    });

    it('refuses a hidden root', async () => {
      const hidden = join(dir, '.stuff');
      mkdirSync(hidden, { recursive: true });
      writeFileSync(join(hidden, 'book.m4b'), Buffer.alloc(1024));
      await expectSourceInvalid(hidden, 'Source path is hidden (leading dot) and cannot be imported');
    });

    it('refuses a direct file with an unsupported extension', async () => {
      const file = join(dir, 'notes.txt');
      writeFileSync(file, 'hello');
      await expectSourceInvalid(file, 'Source file is not a supported audio format');
    });

    // Load-bearing: assertCopyVerified(0, 0) does not throw, so without this refusal the book
    // reaches `imported` owning a path with no audio.
    it('refuses a readable directory containing no supported audio at any depth', async () => {
      const root = join(dir, 'audio-empty');
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'readme.txt'), 'hello');
      await expectSourceInvalid(root, 'Source directory contains no readable supported audio files');
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
    // The adapter registry is module-global; a leak here reaches sibling suites.
    afterEach(() => clearImportAdapters());

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

    /**
     * #2478 AC14 — the job the route would now refuse, queued straight into the table: the shape of
     * a job enqueued before this fix, or by the staged submission runner. The worker-side guard has
     * to refuse it, and the refusal has to be raised INSIDE the adapter's try, or its two
     * adapter-owned failure signals are silently dropped.
     */
    it('refuses an ancestor-of-library source at the adapter, mutating nothing', async () => {
      setTags();
      const created = await bookService.create({ title: 'Bypass', status: 'wanted', authors: [{ name: 'A' }] } as never);
      await db.update(books).set({ status: 'importing', path: null }).where(eq(books.id, created.id));
      const source = seedAudioDir('bypass-src');
      const emit = vi.fn();
      const adapter = buildAdapter({ emit } as unknown as EventBroadcasterService);
      // `dir` holds BOTH the library root and this source — the "feeds managed content back into
      // its own import" shape, bypassing the route entirely.
      await db.insert(importJobs).values({
        bookId: created.id, type: 'manual', status: 'processing',
        metadata: JSON.stringify({ path: dir, title: 'Bypass', mode: 'move', attach: true }),
      });

      await expect(runQueuedJob(adapter)).rejects.toThrow();

      // "The source files still exist" is trivially true when nothing ran; the spy is the observation.
      expect(spies.deleteManagedBookFiles).not.toHaveBeenCalled();
      expect(existsSync(join(source, 'book.m4b'))).toBe(true);
      expect(readdirSync(libraryRoot)).toEqual([]);
      const row = await rowOf(created.id);
      expect(row.status).not.toBe('imported');
      expect(row.path).toBeNull();

      const statusCalls = emit.mock.calls.filter(([event]) => event === 'book_status_change');
      expect(statusCalls).toHaveLength(1);
      expect(statusCalls[0]![1]).toMatchObject({ book_id: created.id, old_status: 'importing', new_status: 'failed' });
      // Fire-and-forget insert, so poll for the durable row rather than racing it.
      await vi.waitFor(async () => {
        const events = await db.select().from(bookEvents).where(eq(bookEvents.bookId, created.id));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ eventType: 'import_failed', source: 'manual' });
      });
    });

    /**
     * #2478 AC14b — the worker half. `runQueuedJob` awaits `adapter.process` directly, so it cannot
     * see the job/book terminal or the `import_failed` SSE: those are written only by
     * `markJobFailed`. This drives a real worker over the same DB through the established
     * `drainOne` seam and pins that the new error class lands on the GENERIC terminal.
     */
    it('routes the refusal through the worker\'s generic failure terminal, not the forced-refusal one', async () => {
      setTags();
      const created = await bookService.create({ title: 'Queued', status: 'wanted', authors: [{ name: 'A' }] } as never);
      await db.update(books).set({ status: 'importing', path: null }).where(eq(books.id, created.id));
      seedAudioDir('worker-src');
      const emit = vi.fn();
      const broadcaster = { emit } as unknown as EventBroadcasterService;
      registerImportAdapter(buildAdapter(broadcaster));
      const worker = new ImportQueueWorker(db, inject(log), broadcaster);
      const [job] = await db.insert(importJobs).values({
        bookId: created.id, type: 'manual', status: 'pending',
        metadata: JSON.stringify({ path: dir, title: 'Queued', mode: 'move', attach: true }),
      }).returning();

      // Direct calls must pass the production pre-claim running check.
      (worker as unknown as { running: boolean }).running = true;
      await (worker as unknown as { drainOne(): Promise<boolean> }).drainOne();

      const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, job!.id));
      expect(jobRow!.status).toBe('failed');
      expect(jobRow!.phase).toBe('failed');
      // The message discriminates a refusal from an incidental copy crash: without the guard this
      // source copies its own library back into itself and fails verification instead.
      expect(jobRow!.lastError).toMatch(/contains the library root/i);
      expect(spies.deleteManagedBookFiles).not.toHaveBeenCalled();
      expect(readdirSync(libraryRoot)).toEqual([]);
      expect((await rowOf(created.id)).status).toBe('failed');
      expect(emit.mock.calls.filter(([event]) => event === 'import_failed')).toHaveLength(1);
      expect(spies.finalizeForcedImportRefusal).not.toHaveBeenCalled();
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
      expect(res.json().code).toBe('already_importing');
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
      expect(res.json().code).toBe('already_importing');
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
