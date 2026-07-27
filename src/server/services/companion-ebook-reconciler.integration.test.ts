import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, companionEbooks } from '../../db/schema.js';
import { buildEpub } from '../../core/__tests__/epub-archive.fixture.js';
import { generatePublicId } from '../utils/public-id.js';
import type { SettingsService } from './settings.service.js';
import { CompanionEbookReconciler } from './companion-ebook-reconciler.js';

/**
 * The whole stack, unmocked: a real migrated libSQL database, real temp directories, real
 * synthesised EPUB archives, real `readdir`/`lstat`, and the real `core/epub` validator.
 *
 * Every unit in this slate is covered in isolation elsewhere; what only an end-to-end run can
 * prove is that the pieces agree about the SAME bytes — that the fingerprint the observer reads
 * off `fs.Stats` is the one the repository writes and the one the short-circuit later compares,
 * and that a real `EpubValidationCode` round-trips through a real column.
 *
 * Case 48 is the reason this file exists at all: it is the only test in the slate that can
 * produce a genuine ctime-only change, and without it the feature ships a silent hole.
 */
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
    // Restore any mode the permission case dropped, or the cleanup itself fails.
    await chmod(bookDir, 0o755).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
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

    // A second sweep hits the short-circuit: no transaction, so not even an `updated_at` touch.
    await reconciler.reconcileAll();
    expect(await readRow()).toEqual(row);
  });

  it('revalidates when only ctime moved — the cp -p / rsync --times case (case 48)', async () => {
    const path = await writeEpub('book.epub');
    // Pin the timestamps to a whole second BEFORE the first observation. Restoring
    // `stats.mtime` instead would round-trip through a millisecond-resolution `Date` and lose
    // the nanoseconds the filesystem kept, landing one millisecond off — which would make this
    // test pass for the wrong reason (mtime moved too).
    const PINNED_SECONDS = 1_700_000_000;
    await utimes(path, PINNED_SECONDS, PINNED_SECONDS);
    await reconciler.reconcileAll();
    const first = await readRow();

    // Rewrite the bytes, then re-pin. Size is identical (same fixture, same deflate settings)
    // and mtime is identical — only ctime, which no API can set, moves.
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

    // Written without tripping any of the eight CHECK constraints — a raw DB rejection would
    // surface here as a thrown DrizzleQueryError, not as a soft assertion failure.
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

  it('leaves the previous observation untouched when the folder becomes unreadable (case 52)', async () => {
    await writeEpub('book.epub');
    await reconciler.reconcileAll();
    const before = await readRow();
    expect(before!.status).toBe('available');

    // Running as root defeats mode bits entirely, so the errno this case needs is unreachable.
    if (process.getuid?.() === 0) return;

    // A non-absence errno (EACCES on `readdir`) is `undetermined`, and `undetermined` retains.
    await chmod(bookDir, 0o000);
    await reconciler.reconcileAll();
    await chmod(bookDir, 0o755);

    expect(await readRow()).toEqual(before);
  });
});
