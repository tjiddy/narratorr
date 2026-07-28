import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, companionEbooks } from '@db/schema.js';
import { buildEpub } from '@core/__tests__/epub-archive.fixture.js';
import { validateEpub } from '@core/epub/validate.js';
import { upsertCompanionEbook } from './companion-ebook.repository.js';
import { generatePublicId } from '../utils/public-id.js';
import type { SettingsService } from './settings.service.js';
import { CompanionEbookReconciler } from './companion-ebook-reconciler.js';
import { removeDirTolerant } from '../__tests__/windows-fs.js';
import { isCompanionEbookExposed } from '@shared/companion-ebook-exposure.js';

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
 *
 * **Three DELEGATING spies, and nothing else, are intercepted** — every one of them calls the
 * real implementation, so the real validator, the real repository write, the real transaction,
 * and the eight CHECK constraints all still run:
 *
 * - `readdir`, so case 52 can force a genuine non-absence errno on demand rather than depending
 *   on whether the host honours mode bits (F10).
 * - `validateEpub` and `upsertCompanionEbook`, so #1976's repeated-selection case can assert
 *   the work ran TWICE (F24). Those counts are not observable from the returned rows —
 *   `updated_at` stores Unix seconds and legitimately stays equal across two calls in the same
 *   second — so a call count is the only honest evidence that the selector never short-circuits.
 */
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

/** True where mode bits cannot produce EACCES — root defeats them entirely. */
const IS_ROOT = process.getuid?.() === 0;
// chmod 0o000 does not deny the OWNER on Windows, so the readdir keeps
// succeeding and the case-52 premise (listing fails) never holds.
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
    // Restore any mode the permission case dropped, or the cleanup itself fails.
    await chmod(bookDir, 0o755).catch(() => undefined);
    // Tolerant on Windows: the libSQL handle keeps the dir undeletable (EPERM),
    // which would otherwise fail every test in this suite at teardown.
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

  /**
   * The retention behaviour of case 52, driven by a forced errno so it holds in EVERY
   * environment including root-run CI (F10). `EACCES` and `EIO` are the two non-absence shapes
   * a re-mounting share and a failing disk actually produce; both classify as `undetermined`,
   * and `undetermined` must retain the last good observation rather than overwrite it.
   *
   * The errno is injected at the `readdir` boundary, not by a mocked service: the real
   * discovery, eligibility, observer, and repository all still run, so this proves the whole
   * chain preserves the row — which is the claim, and the part a unit test cannot make.
   *
   * **The epub is deleted first, deliberately.** Without that, a sweep whose listing quietly
   * succeeded would hit the fingerprint short-circuit and also write nothing, so the retention
   * assertion would hold for the wrong reason. With the file gone, a successful listing writes
   * `none` (that is case 50), so only a listing that genuinely failed can leave `available`
   * standing — the test cannot pass unless the errno was raised, classified as `undetermined`,
   * and honoured.
   */
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

  // The same contract against a REAL permission wall rather than an injected errno. Skipped —
  // visibly, not silently — where mode bits cannot produce EACCES; the forced-errno cases above
  // carry the behavioural guarantee everywhere.
  it.skipIf(IS_ROOT || !CHMOD_DENIES_OWNER)('leaves the previous observation untouched when the folder is chmod 000 (case 52)', async () => {
    const path = await writeEpub('book.epub');
    await reconciler.reconcileAll();
    const before = await readRow();
    expect(before!.status).toBe('available');

    // Same reasoning as the forced-errno cases: a readable directory would now write `none`.
    await rm(path);
    await chmod(bookDir, 0o000);
    await reconciler.reconcileAll();
    await chmod(bookDir, 0o755);

    expect(await readRow()).toEqual(before);
  });

  // =========================================================================
  // selectCompanionEbook end to end (#1976) — real CHECK constraints
  // =========================================================================

  describe('selectCompanionEbook (#1976)', () => {
    /** An `encryption.xml` naming a content document — the Adobe DRM shape. */
    const ADOBE_DRM =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" ' +
      'xmlns:enc="http://www.w3.org/2001/04/xmlenc#">' +
      '<EncryptedData><EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/>' +
      '<CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData></EncryptedData>' +
      '</encryption>';

    it('writes filename and selected_filename together for the picked candidate (case 53)', async () => {
      await writeEpub('a.epub');
      await writeEpub('b.epub');
      await reconciler.reconcileAll();
      expect((await readRow())!.status).toBe('ambiguous');

      await expect(reconciler.selectCompanionEbook(bookId, 1)).resolves.toMatchObject({ outcome: 'selected' });

      // The pair `ck_companion_ebooks_selection` and
      // `ck_companion_ebooks_multi_candidate_selection` jointly police. A raw DB rejection
      // would surface here as a thrown DrizzleQueryError, not a soft assertion failure — and
      // the selector never rejects, so it would surface as `failed` instead.
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

      // `resolveCandidate`'s first rule — a live prior selection wins — so the sweep does not
      // re-ambiguate the book the owner just resolved.
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

      // An owner may deliberately pick the broken file, and the CHECK admits `invalid` in its
      // status list — the real `EpubValidationCode` round-trips through the real column.
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
      await writeEpub('b.epub', { encryption: ADOBE_DRM });
      await reconciler.reconcileAll();

      await expect(reconciler.selectCompanionEbook(bookId, 1)).resolves.toMatchObject({ outcome: 'selected' });

      expect(await readRow()).toMatchObject({
        status: 'drm_protected',
        filename: 'b.epub',
        selectedFilename: 'b.epub',
        validationCode: null,
      });
    });

    /**
     * AC27 — an explicit owner action ALWAYS revalidates; only the background sweep may skip.
     *
     * The observable invariant is "the work ran again", not "the timestamp moved":
     * `companion_ebooks.updated_at` is `mode: 'timestamp'`, i.e. Unix SECONDS, so two
     * selections completing inside the same second legitimately store an equal `updatedAt`.
     * An advance assertion would fail on correct code; the call counts are what actually prove
     * the selector never short-circuits and that `unchanged` is unreachable here.
     */
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
      // Material columns unchanged. `updatedAt` is deliberately NOT compared in either
      // direction — equal values within the storage resolution are conformant.
      expect({ ...second, updatedAt: null }).toEqual({ ...first, updatedAt: null });
    });

    /**
     * F12 / F23, the SERVICE half of AC34's accepted index drift. The route half — that a valid
     * `PUT` succeeds with no ETag, nonce, or precondition header — lives in the route suite,
     * which is the only layer that mounts Fastify.
     */
    it('honours the index against the CURRENT occupant after the list shifted (case 58)', async () => {
      await writeEpub('b.epub');
      await writeEpub('c.epub');
      await reconciler.reconcileAll();
      // Index 1 was issued against `[b, c]` and meant `c.epub`.
      expect(await readdir(bookDir)).toEqual(expect.arrayContaining(['b.epub', 'c.epub']));

      // A lexically earlier candidate appears, so the live order becomes `[a, b, c]`.
      await writeEpub('a.epub');

      await expect(reconciler.selectCompanionEbook(bookId, 1)).resolves.toMatchObject({ outcome: 'selected' });

      // The CURRENT occupant of index 1 wins, and the stale index is not rejected.
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

      // Legal under the observation schema, whose `superRefine` only REQUIRES a selection at
      // `candidateCount >= 2` — it does not forbid one at 1.
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
      await reconciler.selectCompanionEbook(bookId, 2); // c.epub

      await rm(join(bookDir, 'c.epub'));
      await reconciler.reconcileAll();

      // Two others remain, so the row goes back to `ambiguous` — picking "another one" would
      // silently re-point the owner's choice at a file they never chose.
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
      await reconciler.selectCompanionEbook(bookId, 1); // b.epub

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

      // The second observes the first's row as its prior, so neither aborts on a stale
      // precondition and neither self-deadlocks on the non-reentrant admission lock.
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

  // ==========================================================================
  // #1960 AC25 — what a library-root change does, and what it deliberately does NOT
  // ==========================================================================

  describe('library-root change (#1960 AC25)', () => {
    /**
     * **This test pins an ACCEPTED LIMITATION, not an invalidation.** After the root moves, a
     * book whose absolute path now falls OUTSIDE it keeps its `available` row and keeps being
     * advertised: `isCompanionEbookEligible` fails on containment so `reconcileLocked` returns
     * `skipped` WITHOUT a write, and `isCompanionEbookExposed` takes no path or root input at
     * all (`shared/companion-ebook-exposure.ts:25-31`). The library rescan skips those rows
     * too, so nothing in #1960 clears them.
     *
     * The owner-visible failure is a clean `404 companion_epub_unavailable` at click time.
     * Closing it needs the deferred `exposure_generation` column — explicitly out of scope for
     * both #1959 and #1960. Do not "fix" this test into an invalidation assertion.
     */
    it('does NOT invalidate an observation for a book that falls outside the new root', async () => {
      await writeEpub('book.epub');
      await reconciler.reconcileAll();
      const before = await readRow();
      expect(before).toMatchObject({ status: 'available', filename: 'book.epub' });

      // Save a new root that does not contain `bookDir`.
      const newRoot = join(dir, 'relocated');
      await mkdir(newRoot, { recursive: true });
      libraryRoot = newRoot;

      await reconciler.reconcileAll();

      // No write — not even a zeroing one, and not even an `updated_at` touch.
      expect(await readRow()).toEqual(before);
      // And the row is STILL exposed, because the predicate never sees a path or a root.
      expect(isCompanionEbookExposed({
        enabled: true, bookStatus: 'imported', observationStatus: before!.status,
      })).toBe(true);
    });

    it('DOES observe a book that becomes newly eligible under the new root', async () => {
      // A second book that starts OUTSIDE the current root, so the first sweep ignores it.
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

      // Widen/relocate the root so the previously out-of-root book comes into scope.
      libraryRoot = newRoot;
      await reconciler.reconcileAll();

      const rows = await db.select().from(companionEbooks).where(eq(companionEbooks.bookId, newBookId));
      expect(rows[0]).toMatchObject({ status: 'available', filename: 'other.epub' });
    });
  });

});
