import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, companionEbooks } from '@db/schema.js';
import { buildEpub, drmProtectedEpub } from '@core/__tests__/epub-archive.fixture.js';
import { validateEpub } from '@core/epub/validate.js';
import { upsertCompanionEbook } from './companion-ebook.repository.js';
import { generatePublicId } from '../utils/public-id.js';
import type { SettingsService } from './settings.service.js';
import { CompanionEbookReconciler } from './companion-ebook-reconciler.js';
import { removeDirTolerant } from '../__tests__/windows-fs.js';
import { isCompanionEbookExposed } from '@shared/companion-ebook-exposure.js';

// Real DB/filesystem/EPUB stack; delegating spies only inject errno or expose otherwise invisible work.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

vi.mock('@core/epub/validate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/epub/validate.js')>();
  return { ...actual, validateEpub: vi.fn(actual.validateEpub) };
});

vi.mock('./companion-ebook.repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./companion-ebook.repository.js')>();
  return { ...actual, upsertCompanionEbook: vi.fn(actual.upsertCompanionEbook) };
});

const readdirMock = vi.mocked(readdir);
const validateEpubMock = vi.mocked(validateEpub);
const upsertCompanionEbookMock = vi.mocked(upsertCompanionEbook);

// chmod cannot prove EACCES as root or on Windows.
const IS_ROOT = process.getuid?.() === 0;
const CHMOD_DENIES_OWNER = process.platform !== 'win32';

describe('CompanionEbookReconciler end-to-end (#1959)', () => {
  let dir: string;
  let libraryRoot: string;
  let bookDir: string;
  let db: Db;
  let bookId: number;
  let reconciler: CompanionEbookReconciler;

  function createMockLogger(): FastifyBaseLogger {
    return {
      info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
      trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
      level: 'debug', silent: vi.fn(),
    } as unknown as FastifyBaseLogger;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'companion-e2e-'));
    libraryRoot = join(dir, 'library');
    bookDir = join(libraryRoot, 'Author', 'A Book');
    await mkdir(bookDir, { recursive: true });

    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title: 'A Book', status: 'imported', path: bookDir })
      .returning({ id: books.id });
    bookId = row!.id;

    const settings = {
      get: async (key: string) => (key === 'companionEpub' ? { enabled: true } : { path: libraryRoot }),
    } as unknown as SettingsService;
    reconciler = new CompanionEbookReconciler(db, settings, createMockLogger());
  });

  afterEach(async () => {
    await reconciler.stop();
    await chmod(bookDir, 0o755).catch(() => undefined);
    // Windows may retain the libSQL handle and reject immediate directory deletion.
    removeDirTolerant(dir);
  });

  async function writeEpub(name: string, options: Parameters<typeof buildEpub>[0] = {}): Promise<string> {
    const path = join(bookDir, name);
    await writeFile(path, await buildEpub(options));
    return path;
  }

  async function readRow() {
    const rows = await db.select().from(companionEbooks).where(eq(companionEbooks.bookId, bookId));
    return rows[0] ?? null;
  }

  it('writes an available row whose fingerprint matches the real file, then writes nothing on a rerun (case 47)', async () => {
    const path = await writeEpub('book.epub');
    const stats = await stat(path);

    await reconciler.reconcileAll();

    const row = await readRow();
    expect(row).toMatchObject({
      status: 'available',
      filename: 'book.epub',
      sizeBytes: stats.size,
      mtimeMs: Math.trunc(stats.mtimeMs),
      ctimeMs: Math.trunc(stats.ctimeMs),
      candidateCount: 1,
      selectedFilename: null,
      validationCode: null,
    });

    await reconciler.reconcileAll();
    expect(await readRow()).toEqual(row);
  });

  it('revalidates when only ctime moved — the cp -p / rsync --times case (case 48)', async () => {
    const path = await writeEpub('book.epub');
    // Pin whole seconds; round-tripping `stats.mtime` through Date can move mtime by 1 ms.
    const PINNED_SECONDS = 1_700_000_000;
    await utimes(path, PINNED_SECONDS, PINNED_SECONDS);
    await reconciler.reconcileAll();
    const first = await readRow();

    // Re-pin size and mtime after rewriting so only the unsettable ctime moves.
    const original = await stat(path);
    await writeFile(path, await buildEpub());
    await utimes(path, PINNED_SECONDS, PINNED_SECONDS);
    const after = await stat(path);
    expect(after.size).toBe(original.size);
    expect(Math.trunc(after.mtimeMs)).toBe(Math.trunc(original.mtimeMs));
    expect(Math.trunc(after.ctimeMs)).not.toBe(Math.trunc(original.ctimeMs));

    await reconciler.reconcileAll();

    const second = await readRow();
    expect(second!.ctimeMs).toBe(Math.trunc(after.ctimeMs));
    expect(second!.ctimeMs).not.toBe(first!.ctimeMs);
    expect(second!.status).toBe('available');
  });

  it('writes an ambiguous row with NULL file columns for two candidates (case 49)', async () => {
    await writeEpub('a.epub');
    await writeEpub('b.epub');

    await reconciler.reconcileAll();

    expect(await readRow()).toMatchObject({
      status: 'ambiguous',
      candidateCount: 2,
      filename: null,
      sizeBytes: null,
      mtimeMs: null,
      ctimeMs: null,
      validationCode: null,
      selectedFilename: null,
    });
  });

  it('writes `none` with candidateCount 0 once the only epub is deleted (case 50)', async () => {
    const path = await writeEpub('book.epub');
    await reconciler.reconcileAll();
    expect((await readRow())!.status).toBe('available');

    await rm(path);
    await reconciler.reconcileAll();

    expect(await readRow()).toMatchObject({ status: 'none', candidateCount: 0, filename: null });
  });

  it('round-trips a real validation code through the column (case 51)', async () => {
    await writeEpub('book.epub', { packageOptions: { spine: '<spine></spine>' } });

    await reconciler.reconcileAll();

    expect(await readRow()).toMatchObject({
      status: 'invalid',
      validationCode: 'empty_spine',
      filename: 'book.epub',
      candidateCount: 1,
    });
  });

  // Delete the EPUB first so only an undetermined listing—not the fingerprint shortcut—can preserve the row.
  it.each(['EACCES', 'EIO'])(
    'leaves the previous observation untouched when the folder listing fails with %s (case 52)',
    async (code) => {
      const path = await writeEpub('book.epub');
      await reconciler.reconcileAll();
      const before = await readRow();
      expect(before!.status).toBe('available');

      await rm(path);
      readdirMock.mockRejectedValueOnce(Object.assign(new Error(`${code}: forced`), { code }));
      await reconciler.reconcileAll();

      expect(await readRow()).toEqual(before);
    },
  );

  // Also exercise a real permission wall where mode bits can deny the owner.
  it.skipIf(IS_ROOT || !CHMOD_DENIES_OWNER)('leaves the previous observation untouched when the folder is chmod 000 (case 52)', async () => {
    const path = await writeEpub('book.epub');
    await reconciler.reconcileAll();
    const before = await readRow();
    expect(before!.status).toBe('available');

    await rm(path);
    await chmod(bookDir, 0o000);
    await reconciler.reconcileAll();
    await chmod(bookDir, 0o755);

    expect(await readRow()).toEqual(before);
  });

  // Assert the persisted verdict plus an unforced control; route status cannot prove the shortcut was bypassed.
  describe('forced revalidation (#2034)', () => {
    // Use the real repository so the stale matching fingerprint satisfies database constraints.
    async function seedStaleVerdict(path: string): Promise<void> {
      const stats = await stat(path);
      await upsertCompanionEbook(db, bookId, {
        status: 'drm_protected',
        filename: 'book.epub',
        sizeBytes: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs),
        ctimeMs: Math.trunc(stats.ctimeMs),
        candidateCount: 1,
        selected: false,
      });
      expect(await readRow()).toMatchObject({
        status: 'drm_protected',
        sizeBytes: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs),
        ctimeMs: Math.trunc(stats.ctimeMs),
      });
    }

    it('re-judges a stale drm_protected verdict on a byte-identical file, and writes `available`', async () => {
      const path = await writeEpub('book.epub');
      await seedStaleVerdict(path);
      validateEpubMock.mockClear();

      await reconciler.reconcileBook(bookId, true);

      expect(validateEpubMock).toHaveBeenCalledTimes(1);
      expect(await readRow()).toMatchObject({
        status: 'available',
        validationCode: null,
        filename: 'book.epub',
        candidateCount: 1,
      });
    });

    it('leaves the same stale verdict at drm_protected WITHOUT force — the control', async () => {
      const path = await writeEpub('book.epub');
      await seedStaleVerdict(path);
      const before = await readRow();
      validateEpubMock.mockClear();

      await reconciler.reconcileBook(bookId);

      expect(validateEpubMock).not.toHaveBeenCalled();
      expect(await readRow()).toEqual(before);
    });

    it('leaves the stale verdict standing through a full SWEEP too (AC5)', async () => {
      const path = await writeEpub('book.epub');
      await seedStaleVerdict(path);
      const before = await readRow();
      validateEpubMock.mockClear();

      await reconciler.reconcileAll();

      expect(validateEpubMock).not.toHaveBeenCalled();
      expect(await readRow()).toEqual(before);
    });

    it('still writes a real validation code when the forced re-judgement finds a broken file', async () => {
      const path = await writeEpub('book.epub', { packageOptions: { spine: '<spine></spine>' } });
      await seedStaleVerdict(path);

      await reconciler.reconcileBook(bookId, true);

      expect(await readRow()).toMatchObject({ status: 'invalid', validationCode: 'empty_spine' });
    });

    // The shared libSQL connection must serialize both transactions without SQLITE_BUSY or partial state.
    it('serializes two concurrent forced passes instead of raising SQLITE_BUSY', async () => {
      const path = await writeEpub('book.epub');
      await seedStaleVerdict(path);

      await expect(Promise.all([
        reconciler.reconcileBook(bookId, true),
        reconciler.reconcileBook(bookId, true),
      ])).resolves.toEqual([undefined, undefined]);

      expect(await readRow()).toMatchObject({ status: 'available', validationCode: null });
    });
  });

  describe('selectCompanionEbook (#1976)', () => {
    it('writes filename and selected_filename together for the picked candidate (case 53)', async () => {
      await writeEpub('a.epub');
      await writeEpub('b.epub');
      await reconciler.reconcileAll();
      expect((await readRow())!.status).toBe('ambiguous');

      await expect(reconciler.selectCompanionEbook(bookId, 1)).resolves.toMatchObject({ outcome: 'selected' });

      expect(await readRow()).toMatchObject({
        status: 'available',
        filename: 'b.epub',
        selectedFilename: 'b.epub',
        candidateCount: 2,
        validationCode: null,
      });
    });

    it('survives a subsequent full reconcile via the prior-selection rule (case 54)', async () => {
      await writeEpub('a.epub');
      await writeEpub('b.epub');
      await reconciler.reconcileAll();
      await reconciler.selectCompanionEbook(bookId, 1);

      await reconciler.reconcileAll();

      expect(await readRow()).toMatchObject({
        status: 'available',
        filename: 'b.epub',
        selectedFilename: 'b.epub',
      });
    });

    it('persists a deliberately picked BROKEN epub as invalid, with the selection kept (case 55)', async () => {
      await writeEpub('a.epub');
      await writeEpub('b.epub', { packageOptions: { spine: '<spine></spine>' } });
      await reconciler.reconcileAll();

      await expect(reconciler.selectCompanionEbook(bookId, 1)).resolves.toMatchObject({ outcome: 'selected' });

      expect(await readRow()).toMatchObject({
        status: 'invalid',
        validationCode: 'empty_spine',
        filename: 'b.epub',
        selectedFilename: 'b.epub',
        candidateCount: 2,
      });
    });

    it("persists a picked DRM'd candidate as drm_protected, with the selection kept (case 56)", async () => {
      await writeEpub('a.epub');
      await writeEpub('b.epub', drmProtectedEpub());
      await reconciler.reconcileAll();

      await expect(reconciler.selectCompanionEbook(bookId, 1)).resolves.toMatchObject({ outcome: 'selected' });

      expect(await readRow()).toMatchObject({
        status: 'drm_protected',
        filename: 'b.epub',
        selectedFilename: 'b.epub',
        validationCode: null,
      });
    });

    // `updatedAt` has one-second resolution; spy counts, not timestamp movement, prove repeated work.
    it('re-runs validation and the write on a repeated identical selection (case 57)', async () => {
      await writeEpub('a.epub');
      await writeEpub('b.epub');
      await reconciler.reconcileAll();

      validateEpubMock.mockClear();
      upsertCompanionEbookMock.mockClear();

      await expect(reconciler.selectCompanionEbook(bookId, 1)).resolves.toMatchObject({ outcome: 'selected' });
      const first = await readRow();
      await expect(reconciler.selectCompanionEbook(bookId, 1)).resolves.toMatchObject({ outcome: 'selected' });
      const second = await readRow();

      expect(validateEpubMock).toHaveBeenCalledTimes(2);
      expect(upsertCompanionEbookMock).toHaveBeenCalledTimes(2);
      expect({ ...second, updatedAt: null }).toEqual({ ...first, updatedAt: null });
    });

    // Index drift is accepted: selection applies to the current occupant without a precondition token.
    it('honours the index against the CURRENT occupant after the list shifted (case 58)', async () => {
      await writeEpub('b.epub');
      await writeEpub('c.epub');
      await reconciler.reconcileAll();
      expect(await readdir(bookDir)).toEqual(expect.arrayContaining(['b.epub', 'c.epub']));

      await writeEpub('a.epub');

      await expect(reconciler.selectCompanionEbook(bookId, 1)).resolves.toMatchObject({ outcome: 'selected' });

      expect(await readRow()).toMatchObject({
        filename: 'b.epub',
        selectedFilename: 'b.epub',
        candidateCount: 3,
      });
    });

    it('honours index 0 after the list shrank to a single candidate (case 59)', async () => {
      await writeEpub('a.epub');
      await writeEpub('b.epub');
      await reconciler.reconcileAll();
      await rm(join(bookDir, 'b.epub'));

      await expect(reconciler.selectCompanionEbook(bookId, 0)).resolves.toMatchObject({ outcome: 'selected' });

      expect(await readRow()).toMatchObject({
        status: 'available',
        filename: 'a.epub',
        selectedFilename: 'a.epub',
        candidateCount: 1,
      });
    });

    it('clears the selection rather than promoting another candidate when the picked file is deleted (case 60)', async () => {
      await writeEpub('a.epub');
      await writeEpub('b.epub');
      await writeEpub('c.epub');
      await reconciler.reconcileAll();
      await reconciler.selectCompanionEbook(bookId, 2);

      await rm(join(bookDir, 'c.epub'));
      await reconciler.reconcileAll();

      expect(await readRow()).toMatchObject({
        status: 'ambiguous',
        candidateCount: 2,
        filename: null,
        selectedFilename: null,
      });
    });

    it('falls back to an UNSELECTED available row when exactly one candidate remains (case 60b)', async () => {
      await writeEpub('a.epub');
      await writeEpub('b.epub');
      await reconciler.reconcileAll();
      await reconciler.selectCompanionEbook(bookId, 1);

      await rm(join(bookDir, 'b.epub'));
      await reconciler.reconcileAll();

      expect(await readRow()).toMatchObject({
        status: 'available',
        filename: 'a.epub',
        selectedFilename: null,
        candidateCount: 1,
      });
    });

    it('serializes two concurrent selections for the same book without deadlocking (case 61)', async () => {
      await writeEpub('a.epub');
      await writeEpub('b.epub');
      await reconciler.reconcileAll();

      const [first, second] = await Promise.all([
        reconciler.selectCompanionEbook(bookId, 0),
        reconciler.selectCompanionEbook(bookId, 1),
      ]);

      expect([first.outcome, second.outcome]).toEqual(['selected', 'selected']);
      const row = await readRow();
      expect(['a.epub', 'b.epub']).toContain(row!.filename);
      expect(row!.selectedFilename).toBe(row!.filename);
    });

    it('rejects an out-of-range index against the live list without writing (case 62)', async () => {
      await writeEpub('a.epub');
      await writeEpub('b.epub');
      await reconciler.reconcileAll();
      const before = await readRow();

      await expect(reconciler.selectCompanionEbook(bookId, 2)).resolves.toEqual({ outcome: 'out_of_range' });

      expect(await readRow()).toEqual(before);
    });
  });

  describe('library-root change (#1960 AC25)', () => {
    // Accepted limitation: moving the root does not invalidate exposure; fixing it needs `exposure_generation`.
    it('does NOT invalidate an observation for a book that falls outside the new root', async () => {
      await writeEpub('book.epub');
      await reconciler.reconcileAll();
      const before = await readRow();
      expect(before).toMatchObject({ status: 'available', filename: 'book.epub' });

      const newRoot = join(dir, 'relocated');
      await mkdir(newRoot, { recursive: true });
      libraryRoot = newRoot;

      await reconciler.reconcileAll();

      expect(await readRow()).toEqual(before);
      expect(isCompanionEbookExposed({
        enabled: true, bookStatus: 'imported', observationStatus: before!.status,
      })).toBe(true);
    });

    it('DOES observe a book that becomes newly eligible under the new root', async () => {
      const newRoot = join(dir, 'relocated');
      const newBookDir = join(newRoot, 'Author', 'Another Book');
      await mkdir(newBookDir, { recursive: true });
      await writeFile(join(newBookDir, 'other.epub'), await buildEpub());
      const [inserted] = await db
        .insert(books)
        .values({ publicId: generatePublicId('bk'), title: 'Another Book', status: 'imported', path: newBookDir })
        .returning({ id: books.id });
      const newBookId = inserted!.id;

      await reconciler.reconcileAll();
      const untouched = await db.select().from(companionEbooks).where(eq(companionEbooks.bookId, newBookId));
      expect(untouched).toHaveLength(0);

      libraryRoot = newRoot;
      await reconciler.reconcileAll();

      const rows = await db.select().from(companionEbooks).where(eq(companionEbooks.bookId, newBookId));
      expect(rows[0]).toMatchObject({ status: 'available', filename: 'other.epub' });
    });
  });

});
