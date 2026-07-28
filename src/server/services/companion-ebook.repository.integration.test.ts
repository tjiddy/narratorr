import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, companionEbooks } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import { chunkArray } from '../utils/batch.js';
import {
  deleteCompanionEbook,
  findCompanionEbook,
  findCompanionEbooksByBookIds,
  upsertCompanionEbook,
} from './companion-ebook.repository.js';
import type { CompanionEbookObservation } from './companion-ebook-observation.js';

// Real migrated libSQL, not mocks: the point of this suite is that the repository's Zod
// boundary rejects BEFORE any SQL runs, and only a real DB can distinguish "Zod refused"
// from "SQLite's CHECK refused" — both throw and both leave the table empty. Every rejection
// case therefore asserts the error is a `ZodError`; a `DrizzleQueryError` is a FAILURE, not
// an alternative pass. The eight CHECKs themselves are covered from raw SQL in #1957's
// `companion-ebooks-schema.integration.test.ts` and are deliberately not re-tested here.

const FILE_FIELDS = {
  filename: 'companion.epub',
  sizeBytes: 4096,
  mtimeMs: 1_700_000_000_000,
  ctimeMs: 1_700_000_000_000,
} as const;

function available(overrides: Record<string, unknown> = {}): CompanionEbookObservation {
  return { status: 'available', ...FILE_FIELDS, candidateCount: 1, selected: false, ...overrides } as CompanionEbookObservation;
}

describe('companion-ebook repository (real migrated DB, #1958)', () => {
  let dir: string;
  let db: Db;
  let selectCalls: number;
  /** `db` with every `.select()` counted — the only way to prove chunking and the no-query empty path. */
  let countingDb: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'companion-repo-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    selectCalls = 0;
    countingDb = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop === 'select' && typeof value === 'function') {
          return (...args: unknown[]) => {
            selectCalls++;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as Db;
  });

  afterEach(() => {
    vi.useRealTimers();
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep handles on Windows — best effort
    }
  });

  async function seedBook(title = 'Companion Host'): Promise<number> {
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title, status: 'imported' })
      .returning();
    return row!.id;
  }

  async function rowCount(): Promise<number> {
    const rows = await db.select().from(companionEbooks);
    return rows.length;
  }

  /** Flattened `.cause` chain — Drizzle wraps driver errors, so the SQLite text is not on the top message (#1969). */
  async function rejectionMessage(fn: () => Promise<unknown>): Promise<string> {
    let caught: unknown;
    let rejected = false;
    try {
      await fn();
    } catch (err) {
      caught = err;
      rejected = true;
    }
    if (!rejected) throw new Error('expected the statement to be rejected, but it succeeded');
    const parts: string[] = [];
    let current: unknown = caught;
    while (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    }
    return parts.length > 0 ? parts.join(' | ') : String(caught);
  }

  /**
   * The shape EVERY rejection case uses: the throw must be a `ZodError` (proving the public
   * Zod boundary refused, not SQLite), and no row may have been written.
   */
  async function expectZodRejection(bookId: number, observation: unknown): Promise<void> {
    await expect(
      upsertCompanionEbook(db, bookId, observation as CompanionEbookObservation),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await rowCount()).toBe(0);
  }

  // ---------------------------------------------------------------------------
  // Round-trips
  // ---------------------------------------------------------------------------

  describe('round-trips', () => {
    it('stores and reads back an available observation with its file fields intact', async () => {
      const bookId = await seedBook();
      const written = await upsertCompanionEbook(db, bookId, available({ candidateCount: 2, selected: true }));
      expect(written).toMatchObject({
        bookId,
        status: 'available',
        filename: 'companion.epub',
        sizeBytes: 4096,
        mtimeMs: 1_700_000_000_000,
        ctimeMs: 1_700_000_000_000,
        candidateCount: 2,
        selectedFilename: 'companion.epub',
        validationCode: null,
      });
      expect(await findCompanionEbook(db, bookId)).toMatchObject({ status: 'available', filename: 'companion.epub' });
    });

    it('stores and reads back a none observation with a zero candidate count the caller never supplied', async () => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, { status: 'none' });
      expect(row).toMatchObject({
        status: 'none',
        candidateCount: 0,
        filename: null,
        sizeBytes: null,
        mtimeMs: null,
        ctimeMs: null,
        validationCode: null,
        selectedFilename: null,
      });
    });

    it('stores and reads back an ambiguous observation', async () => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, { status: 'ambiguous', candidateCount: 3 });
      expect(row).toMatchObject({ status: 'ambiguous', candidateCount: 3, filename: null, selectedFilename: null });
    });

    it('stores and reads back a drm_protected observation', async () => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, { ...available(), status: 'drm_protected' } as CompanionEbookObservation);
      expect(row).toMatchObject({ status: 'drm_protected', filename: 'companion.epub', validationCode: null });
    });

    it('stores and reads back an invalid observation with its validation code', async () => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, {
        ...available(),
        status: 'invalid',
        validationCode: 'missing_container',
      } as CompanionEbookObservation);
      expect(row).toMatchObject({ status: 'invalid', validationCode: 'missing_container' });
    });

    it('returns null for a book with no observation', async () => {
      const bookId = await seedBook();
      expect(await findCompanionEbook(db, bookId)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Upsert semantics
  // ---------------------------------------------------------------------------

  describe('upsert semantics', () => {
    it('upserting twice for the same book leaves exactly one row, with createdAt unchanged and updatedAt advanced', async () => {
      const bookId = await seedBook();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const first = await upsertCompanionEbook(db, bookId, { status: 'none' });
      vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
      const second = await upsertCompanionEbook(db, bookId, { status: 'ambiguous', candidateCount: 2 });
      vi.useRealTimers();

      expect(await rowCount()).toBe(1);
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
      expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    });

    it('an available → ambiguous → available sequence has the repository null the file columns itself', async () => {
      const bookId = await seedBook();
      await upsertCompanionEbook(db, bookId, available({ candidateCount: 2, selected: true }));

      // The caller's `ambiguous` variant cannot carry file fields at all — these columns are
      // cleared by the repository, not by the caller passing nulls.
      const cleared = await upsertCompanionEbook(db, bookId, { status: 'ambiguous', candidateCount: 2 });
      expect(cleared).toMatchObject({
        status: 'ambiguous',
        filename: null,
        sizeBytes: null,
        mtimeMs: null,
        ctimeMs: null,
        selectedFilename: null,
      });

      const restored = await upsertCompanionEbook(db, bookId, available({ candidateCount: 2, selected: true }));
      expect(restored).toMatchObject({ status: 'available', filename: 'companion.epub', selectedFilename: 'companion.epub' });
      expect(await rowCount()).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Batch reads
  // ---------------------------------------------------------------------------

  describe('findCompanionEbooksByBookIds', () => {
    it('returns an empty Map for an empty id list without issuing a query', async () => {
      const map = await findCompanionEbooksByBookIds(countingDb, []);
      expect(map.size).toBe(0);
      expect(selectCalls).toBe(0);
    });

    it('omits absent ids as missing keys rather than null values', async () => {
      const present = await seedBook('Present');
      const absent = await seedBook('Absent');
      await upsertCompanionEbook(db, present, { status: 'none' });

      const map = await findCompanionEbooksByBookIds(db, [present, absent, 999_999]);
      expect(map.size).toBe(1);
      expect(map.get(present)).toMatchObject({ status: 'none' });
      expect(map.has(absent)).toBe(false);
      expect(map.has(999_999)).toBe(false);
    });

    it('returns every row across more ids than one chunk holds, with one query per chunk', async () => {
      // 481 ids: one more than the repository's chunk size, so the read must span two
      // statements — and must NOT degrade to one query per book.
      const total = 481;
      const bookIds: number[] = [];
      for (const chunk of chunkArray([...Array(total).keys()], 100)) {
        const rows = await db
          .insert(books)
          .values(chunk.map((i) => ({ publicId: generatePublicId('bk'), title: `Book ${i}`, status: 'imported' as const })))
          .returning({ id: books.id });
        bookIds.push(...rows.map((r) => r.id));
      }
      for (const chunk of chunkArray(bookIds, 100)) {
        await db.insert(companionEbooks).values(chunk.map((bookId) => ({ bookId, status: 'none' as const })));
      }

      selectCalls = 0;
      const map = await findCompanionEbooksByBookIds(countingDb, bookIds);
      expect(map.size).toBe(total);
      expect(selectCalls).toBe(2);
      expect(selectCalls).toBeLessThan(total);
    });
  });

  // ---------------------------------------------------------------------------
  // Delete / FK behaviour
  // ---------------------------------------------------------------------------

  describe('deleteCompanionEbook and referential integrity', () => {
    it('returns true for an existing row and false for an absent one', async () => {
      const bookId = await seedBook();
      await upsertCompanionEbook(db, bookId, { status: 'none' });
      expect(await deleteCompanionEbook(db, bookId)).toBe(true);
      expect(await deleteCompanionEbook(db, bookId)).toBe(false);
    });

    // Regression guard against a src/db/client.ts change: libSQL enables PRAGMA
    // foreign_keys by default (libsql-foreign-keys-on-by-default), so the cascade is live.
    it('cascade-deletes the observation when the books row is deleted', async () => {
      const bookId = await seedBook();
      await upsertCompanionEbook(db, bookId, { status: 'none' });
      await db.delete(books).where(eq(books.id, bookId));
      expect(await rowCount()).toBe(0);
    });

    it('rejects an observation for a non-existent bookId with a FOREIGN KEY violation', async () => {
      const message = await rejectionMessage(() => upsertCompanionEbook(db, 999_999, { status: 'none' }));
      expect(message).toMatch(/FOREIGN KEY/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Transaction composition — the test that pins DbOrTx
  // ---------------------------------------------------------------------------

  describe('transaction composition (DbOrTx)', () => {
    it('sees its own pending write inside the transaction', async () => {
      const bookId = await seedBook();
      await db.transaction(async (tx) => {
        await upsertCompanionEbook(tx, bookId, available());
        // A `Db`-typed executor would not even typecheck here — that is the point.
        expect(await findCompanionEbook(tx, bookId)).toMatchObject({ status: 'available' });
      });
      expect(await rowCount()).toBe(1);
    });

    it('rolls the write back when the transaction callback throws', async () => {
      const bookId = await seedBook();
      await expect(
        db.transaction(async (tx) => {
          await upsertCompanionEbook(tx, bookId, available());
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await rowCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // The write boundary — Layer 2 value rules, each refused before any SQL
  // ---------------------------------------------------------------------------

  describe('write boundary — value rules rejected as ZodError before SQL', () => {
    it.each([1, 0])('ambiguous with candidateCount %i', async (candidateCount) => {
      await expectZodRejection(await seedBook(), { status: 'ambiguous', candidateCount });
    });

    it('a file status with candidateCount 0', async () => {
      await expectZodRejection(await seedBook(), available({ candidateCount: 0 }));
    });

    it.each([1.5, 2.5])('fractional candidateCount %f', async (candidateCount) => {
      await expectZodRejection(await seedBook(), { status: 'ambiguous', candidateCount });
    });

    it('negative sizeBytes', async () => {
      await expectZodRejection(await seedBook(), available({ sizeBytes: -1 }));
    });

    it.each(['sizeBytes', 'mtimeMs', 'ctimeMs'])('non-finite %s', async (field) => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const bookId = await seedBook();
        await expectZodRejection(bookId, available({ [field]: value }));
      }
    });

    it.each(['', '   '])('invalid with a blank validationCode %j', async (validationCode) => {
      await expectZodRejection(await seedBook(), {
        ...available(),
        status: 'invalid',
        validationCode,
      });
    });

    it('a file status with candidateCount 2 and selected false (the multi-candidate rule)', async () => {
      await expectZodRejection(await seedBook(), available({ candidateCount: 2, selected: false }));
    });

    // Both bands are also caught by `ck_companion_ebooks_fingerprint`, so the ZodError type
    // assertion is what proves the safe-integer guard exists. `2**53` is the dangerous one:
    // it writes successfully as INTEGER and then poisons every later read of the row.
    it.each(['sizeBytes', 'mtimeMs', 'ctimeMs'])('oversized finite %s (1e20 and 2**53)', async (field) => {
      for (const value of [1e20, 2 ** 53]) {
        const bookId = await seedBook();
        await expectZodRejection(bookId, available({ [field]: value }));
      }
    });
  });

  describe('write boundary — accepted where the DB accepts', () => {
    it('a pre-1970 (negative) mtime/ctime round-trips', async () => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, available({ mtimeMs: -86_400_000, ctimeMs: -86_400_000 }));
      expect(row.mtimeMs).toBe(-86_400_000);
      expect(row.ctimeMs).toBe(-86_400_000);
    });

    it('sizeBytes 0 round-trips', async () => {
      const bookId = await seedBook();
      expect((await upsertCompanionEbook(db, bookId, available({ sizeBytes: 0 }))).sizeBytes).toBe(0);
    });

    it('candidateCount 1 with selected false round-trips with a NULL selected_filename', async () => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, available({ candidateCount: 1, selected: false }));
      expect(row.selectedFilename).toBeNull();
    });

    it('candidateCount 1 with selected true round-trips (the surviving-sibling case the CHECK permits)', async () => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, available({ candidateCount: 1, selected: true }));
      expect(row.selectedFilename).toBe('companion.epub');
    });
  });

  describe('write boundary — normalisation vs rejection', () => {
    it('a fractional mtimeMs is ACCEPTED and normalised (real fs.Stats values are fractional)', async () => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, available({ mtimeMs: 1_700_000_000_123.456 }));
      expect(row.mtimeMs).toBe(1_700_000_000_123);
    });

    // `sizeBytes` has its OWN nonnegative → Math.trunc → safe-integer pipeline, separate from
    // the shared time schema, so the mtimeMs case above does not pin it: deleting its
    // transform leaves every other test green and turns an accepted fractional size into a
    // rejection. Same reason ctimeMs is asserted here rather than inferred from mtimeMs — each
    // field's wiring to a normalising schema is pinned at the field, not at the schema.
    it('a fractional sizeBytes is ACCEPTED and normalised (4096.75 → 4096)', async () => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, available({ sizeBytes: 4096.75 }));
      expect(row.sizeBytes).toBe(4096);
    });

    it('a fractional ctimeMs is ACCEPTED and normalised', async () => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, available({ ctimeMs: 1_700_000_000_987.654 }));
      expect(row.ctimeMs).toBe(1_700_000_000_987);
    });

    it('a normalised fractional sizeBytes reaches SQLite with integer storage class', async () => {
      const bookId = await seedBook();
      await upsertCompanionEbook(db, bookId, available({ sizeBytes: 4096.75 }));
      const res = await db.run(
        sql`SELECT typeof(size_bytes), size_bytes FROM companion_ebooks WHERE book_id = ${bookId}`,
      );
      expect(Array.from(res.rows[0] as unknown as unknown[])).toEqual(['integer', 4096]);
    });

    it('a fractional candidateCount is REJECTED (the asymmetry is deliberate)', async () => {
      await expectZodRejection(await seedBook(), available({ candidateCount: 1.5 }));
    });

    it('stores fingerprints with SQLite integer storage class (a JS read would coerce)', async () => {
      const bookId = await seedBook();
      await upsertCompanionEbook(db, bookId, available({ mtimeMs: 1_700_000_000_123.456 }));
      const res = await db.run(
        sql`SELECT typeof(size_bytes), typeof(mtime_ms), typeof(ctime_ms) FROM companion_ebooks WHERE book_id = ${bookId}`,
      );
      expect(Array.from(res.rows[0] as unknown as unknown[])).toEqual(['integer', 'integer', 'integer']);
    });

    // The ONE case in this suite that fails a Math.floor implementation: positive fractional
    // values cannot distinguish trunc from floor, and 1.2c's fingerprint short-circuit
    // compares against rows written here.
    it('a signed fractional mtimeMs truncates toward zero (-123.75 → -123, not -124)', async () => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, available({ mtimeMs: -123.75 }));
      expect(row.mtimeMs).toBe(-123);
    });
  });

  describe('write boundary — the filename basename invariant', () => {
    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
      ['padded (rejected, not trimmed)', ' book.epub '],
      ['parent traversal', '../other/book.epub'],
      ['nested posix path', 'nested/book.epub'],
      ['windows separator (rejected on a POSIX host too)', 'sub\\book.epub'],
      ['dot', '.'],
      ['dot-dot', '..'],
    ])('rejects %s', async (_label, filename) => {
      await expectZodRejection(await seedBook(), available({ filename }));
    });

    it.each([
      ['an ordinary name', 'Book Title - Author.epub'],
      ['a name with interior dots', 'Book.Title.Vol.2.epub'],
      ['a ~96-character name', `${'a'.repeat(91)}.epub`],
      ['a unicode name', 'Böök — Título 日本語.epub'],
    ])('accepts %s and round-trips it byte-identical', async (_label, filename) => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, available({ filename }));
      expect(row.filename).toBe(filename);
    });
  });

  describe('write boundary — structural impossibility (type-level)', () => {
    it('selectedFilename is not a member of the input type', async () => {
      const bookId = await seedBook();
      await expect(
        upsertCompanionEbook(db, bookId, {
          status: 'available',
          ...FILE_FIELDS,
          candidateCount: 1,
          selected: true,
          // @ts-expect-error — selectedFilename is derived by the repository, never supplied.
          selectedFilename: 'other.epub',
        }),
      ).rejects.toBeInstanceOf(ZodError);
    });

    it('derives selectedFilename from `selected`, so the DB equality holds structurally', async () => {
      const bookId = await seedBook();
      const row = await upsertCompanionEbook(db, bookId, available({ selected: true }));
      expect(row.selectedFilename).toBe(row.filename);
    });

    it('the none variant carries no file fields', async () => {
      const bookId = await seedBook();
      await expect(
        upsertCompanionEbook(db, bookId, {
          status: 'none',
          // @ts-expect-error — `none` has no filename field.
          filename: 'companion.epub',
        }),
      ).rejects.toBeInstanceOf(ZodError);
    });

    it('the ambiguous variant carries no file fields', async () => {
      const bookId = await seedBook();
      await expect(
        upsertCompanionEbook(db, bookId, {
          status: 'ambiguous',
          candidateCount: 2,
          // @ts-expect-error — `ambiguous` has no filename field.
          filename: 'companion.epub',
        }),
      ).rejects.toBeInstanceOf(ZodError);
    });
  });
});
