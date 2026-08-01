import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, sql } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from './index.js';
import { books, companionEbooks } from './schema.js';
import { COMPANION_EBOOK_STATUSES } from '@shared/schemas/companion-ebook.js';
import { generatePublicId } from '../server/utils/public-id.js';

// Real-DB coverage for the #1957 companion_ebooks table. The eight CHECK constraints
// only exist in the generated migration, so nothing short of migrating a real libSQL
// file proves they are there (the #1131 failure mode: a constraint that silently never
// reached the built DB while unit tests stayed green). libSQL enables PRAGMA
// foreign_keys by default (libsql-foreign-keys-on-by-default), so the FK clause is live
// without any pragma.
//
// Every rejection case below is constructed to violate EXACTLY ONE constraint: SQLite
// evaluates CHECKs in declaration order and reports only the first failure, so a row
// that breaks two would assert a name that depends on declaration order. The two cases
// that cannot be made single-violation assert rejection without a name, and say so.

const CONSTRAINT_NAMES = [
  'ck_companion_ebooks_status_domain',
  'ck_companion_ebooks_file_present',
  'ck_companion_ebooks_file_absent',
  'ck_companion_ebooks_validation_code',
  'ck_companion_ebooks_candidate_count',
  'ck_companion_ebooks_selection',
  'ck_companion_ebooks_multi_candidate_selection',
  'ck_companion_ebooks_fingerprint',
] as const;

/** A full single-file fingerprint — the shape `available`/`invalid`/`drm_protected` require. */
const FINGERPRINT = {
  filename: 'companion.epub',
  sizeBytes: 4096,
  mtimeMs: 1_700_000_000_000,
  ctimeMs: 1_700_000_000_000,
} as const;

type RawRow = {
  bookId: number | null;
  status: string;
  filename: string | null;
  sizeBytes: number | null;
  mtimeMs: number | null;
  ctimeMs: number | null;
  validationCode: string | null;
  candidateCount: number;
  selectedFilename: string | null;
};

const EMPTY_ROW: Omit<RawRow, 'bookId' | 'status'> = {
  filename: null,
  sizeBytes: null,
  mtimeMs: null,
  ctimeMs: null,
  validationCode: null,
  candidateCount: 0,
  selectedFilename: null,
};

/** A rejection case: a row spec (minus `book_id`) and the constraint it must trip. */
type RejectionCase = {
  name: string;
  row: Partial<Omit<RawRow, 'bookId'>> & { status: string };
  constraint: string;
};

const CHECK_FAILURE_RE = /CHECK constraint failed: (\S+)/;

/**
 * Pull the constraint name out of a SQLite CHECK failure. `\S+` captures the whole
 * name, and callers compare it with `toBe`, so a name that is a prefix of another
 * cannot satisfy the wrong assertion the way a substring match would.
 */
function checkConstraintName(message: string): string {
  const match = CHECK_FAILURE_RE.exec(message);
  if (!match) throw new Error(`not a CHECK-constraint failure: ${message}`);
  return match[1]!;
}

describe('companion_ebooks schema — constraints in the built DB (#1957)', () => {
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'companion-schema-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  async function seedBook(title = 'Companion Host'): Promise<number> {
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title, status: 'imported' })
      .returning();
    return row!.id;
  }

  /**
   * Raw insert. Rows carrying an out-of-domain status, a fractional number, or a
   * deliberately mismatched shape cannot be expressed through Drizzle's narrowed insert
   * types, so every rejection case goes through SQL directly.
   */
  async function insertRaw(spec: Partial<RawRow> & { status: string }): Promise<void> {
    const r: RawRow = { bookId: null, ...EMPTY_ROW, ...spec };
    await db.run(sql`
      INSERT INTO companion_ebooks
        (book_id, status, filename, size_bytes, mtime_ms, ctime_ms, validation_code, candidate_count, selected_filename)
      VALUES
        (${r.bookId}, ${r.status}, ${r.filename}, ${r.sizeBytes}, ${r.mtimeMs}, ${r.ctimeMs}, ${r.validationCode}, ${r.candidateCount}, ${r.selectedFilename})
    `);
  }

  /**
   * Runs `fn`, requires it to reject, and returns the flattened error chain. Drizzle
   * wraps driver failures in a `DrizzleQueryError` whose own message is just the failed
   * query — the SQLite message (`CHECK constraint failed: …`) lives under `.cause`.
   */
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

  async function expectViolates(spec: Partial<RawRow> & { status: string }, constraint: string): Promise<void> {
    const bookId = await seedBook();
    const message = await rejectionMessage(() => insertRaw({ ...spec, bookId }));
    expect(checkConstraintName(message)).toBe(constraint);
  }

  async function tableDdl(): Promise<string> {
    const res = await db.run(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='companion_ebooks'`);
    return res.rows[0]![0] as string;
  }

  // ---------------------------------------------------------------------------
  // Structure — the non-vacuity anchor for every rejection test below
  // ---------------------------------------------------------------------------

  describe('the migrated table actually carries the constraints', () => {
    it('declares all eight named CHECK constraints', async () => {
      const ddl = await tableDdl();
      for (const name of CONSTRAINT_NAMES) {
        expect(ddl).toContain(`CONSTRAINT "${name}"`);
      }
    });

    it('inlines the five status literals with no bound-parameter placeholder', async () => {
      const ddl = await tableDdl();
      const domainClause = ddl.split('\n').find((line) => line.includes('ck_companion_ebooks_status_domain'));
      expect(domainClause).toBeDefined();
      for (const status of COMPANION_EBOOK_STATUSES) {
        expect(domainClause).toContain(`'${status}'`);
      }
      // A `?` here means the sql.raw derivation emitted a bound parameter instead of
      // literal DDL, which would make the migration invalid.
      expect(domainClause).not.toContain('?');
    });

    it('creates companion_ebooks_book_id_unique as a unique index on book_id', async () => {
      const idx = await db.run(
        sql`SELECT sql FROM sqlite_master WHERE type='index' AND name='companion_ebooks_book_id_unique'`,
      );
      expect(idx.rows).toHaveLength(1);
      expect((idx.rows[0]![0] as string).toUpperCase()).toContain('UNIQUE INDEX');

      const cols = await db.run(sql`SELECT name FROM pragma_index_info('companion_ebooks_book_id_unique') ORDER BY seqno`);
      expect(cols.rows.map((r) => r[0] as string)).toEqual(['book_id']);
    });

    it('carries the FK to books with ON DELETE cascade', async () => {
      const fks = await db.run(sql`SELECT "table", "from", "on_delete" FROM pragma_foreign_key_list('companion_ebooks')`);
      expect(fks.rows.map((r) => [r[0], r[1], r[2]])).toEqual([['books', 'book_id', 'CASCADE']]);
    });
  });

  // ---------------------------------------------------------------------------
  // book_id identity (Decision 8 / F4)
  // ---------------------------------------------------------------------------

  describe('book_id is NOT NULL UNIQUE, not a rowid alias', () => {
    it('rejects an insert that omits book_id', async () => {
      // The regression that matters most: under the previous `.primaryKey()` shape
      // SQLite generated a rowid here and the row silently attached to a real book.
      const message = await rejectionMessage(() =>
        db.run(sql`INSERT INTO companion_ebooks (status, candidate_count) VALUES ('none', 0)`),
      );
      expect(message).toContain('NOT NULL constraint failed: companion_ebooks.book_id');
    });

    it('rejects an explicit NULL book_id', async () => {
      const message = await rejectionMessage(() => insertRaw({ bookId: null, status: 'none' }));
      expect(message).toContain('NOT NULL constraint failed: companion_ebooks.book_id');
    });

    it('types bookId as required in $inferInsert', () => {
      // @ts-expect-error — bookId must be REQUIRED. Under `.primaryKey()` Drizzle marks
      // the column primaryKeyHasDefault and this omission would type-check, so a revert
      // of the column shape fails here at compile time.
      const missingBookId: typeof companionEbooks.$inferInsert = { status: 'none' };
      void missingBookId;
      expect(companionEbooks.bookId.hasDefault).toBe(false);
    });

    it('rejects a second companion row for the same book', async () => {
      const bookId = await seedBook();
      await insertRaw({ bookId, status: 'none' });
      const message = await rejectionMessage(() => insertRaw({ bookId, status: 'none' }));
      expect(message).toContain('UNIQUE constraint failed: companion_ebooks.book_id');
    });
  });

  // ---------------------------------------------------------------------------
  // The NOT NULL / DEFAULT premises the CHECK predicates are built on
  // ---------------------------------------------------------------------------

  describe('status is NOT NULL — the premise that keeps every other CHECK total', () => {
    // Rule 1 of the never-NULL policy. If `.notNull()` were dropped from the column and
    // the migration, a NULL status would make `status <> 'x'` / `status NOT IN (...)`
    // evaluate to NULL in six of the eight predicates — and SQLite treats a NULL CHECK
    // result as SATISFIED, so the row would be accepted. Testing unknown *strings* does
    // not cover that: an unknown string is a value the domain CHECK can see and reject,
    // a NULL is not.

    it('rejects an insert that omits status', async () => {
      const bookId = await seedBook();
      const message = await rejectionMessage(() =>
        db.run(sql`INSERT INTO companion_ebooks (book_id, candidate_count) VALUES (${bookId}, 0)`),
      );
      expect(message).toContain('NOT NULL constraint failed: companion_ebooks.status');
    });

    it('rejects an explicit NULL status', async () => {
      const bookId = await seedBook();
      const message = await rejectionMessage(() =>
        db.run(sql`INSERT INTO companion_ebooks (book_id, status, candidate_count) VALUES (${bookId}, NULL, 0)`),
      );
      expect(message).toContain('NOT NULL constraint failed: companion_ebooks.status');
    });

    it('rejects an explicit NULL candidate_count', async () => {
      // The other half of rule 1: `typeof(candidate_count) = 'integer'` is total, but the
      // per-status arms (`candidate_count = 0`, `>= 2`, `>= 1`) are not.
      const bookId = await seedBook();
      const message = await rejectionMessage(() =>
        db.run(sql`INSERT INTO companion_ebooks (book_id, status, candidate_count) VALUES (${bookId}, 'none', NULL)`),
      );
      expect(message).toContain('NOT NULL constraint failed: companion_ebooks.candidate_count');
    });

    it('types status as required and candidateCount as optional in $inferInsert', () => {
      // @ts-expect-error — status must be REQUIRED. It has no default, so every write
      // states it; a `.default(...)` added here would silently make it omissible.
      const missingStatus: typeof companionEbooks.$inferInsert = { bookId: 1 };
      void missingStatus;

      // ...while candidateCount must stay omissible, because the DB supplies the default.
      const omittedCount: typeof companionEbooks.$inferInsert = { bookId: 1, status: 'none' };
      void omittedCount;

      expect(companionEbooks.status.notNull).toBe(true);
      expect(companionEbooks.status.hasDefault).toBe(false);
      expect(companionEbooks.candidateCount.notNull).toBe(true);
      expect(companionEbooks.candidateCount.hasDefault).toBe(true);
    });

    it('defaults candidate_count to 0 in the migrated DB when the column is omitted', async () => {
      // Pins the DDL default independently of Drizzle: this INSERT names no
      // candidate_count column at all, so only the migration's `DEFAULT 0` can supply it.
      const bookId = await seedBook();
      await db.run(sql`INSERT INTO companion_ebooks (book_id, status) VALUES (${bookId}, 'none')`);

      const res = await db.run(sql`SELECT candidate_count FROM companion_ebooks WHERE book_id = ${bookId}`);
      expect(res.rows[0]![0]).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Status domain (F1)
  // ---------------------------------------------------------------------------

  describe('status domain', () => {
    it('rejects an unrecognised status on an otherwise-valid none shape', async () => {
      await expectViolates({ status: 'bogus' }, 'ck_companion_ebooks_status_domain');
    });

    it('rejects the never-NULL regression row the pre-fix selection predicate accepted', async () => {
      // status='ambiguous' + NULL filename + a selection evaluated to NULL under the old
      // bare-equality form, and SQLite treats a NULL CHECK as satisfied.
      await expectViolates(
        { status: 'ambiguous', selectedFilename: 'b.epub', candidateCount: 2 },
        'ck_companion_ebooks_selection',
      );
    });

    it('rejects an unrecognised status carrying a selection with a NULL filename', async () => {
      // Name deliberately not asserted: this row violates both the status-domain and the
      // selection constraint, so which one fires depends on declaration order.
      const bookId = await seedBook();
      await expect(insertRaw({ bookId, status: 'bogus', selectedFilename: 'b.epub' })).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Integer storage (F2)
  // ---------------------------------------------------------------------------

  describe('integer storage is enforced by CHECK, not by the column type', () => {
    const fractionalCases: RejectionCase[] = [
      {
        name: 'size_bytes=1.5',
        row: { status: 'available', ...FINGERPRINT, sizeBytes: 1.5, candidateCount: 1 },
        constraint: 'ck_companion_ebooks_fingerprint',
      },
      {
        name: 'mtime_ms=123.5',
        row: { status: 'available', ...FINGERPRINT, mtimeMs: 123.5, candidateCount: 1 },
        constraint: 'ck_companion_ebooks_fingerprint',
      },
      {
        name: 'ctime_ms=456.5',
        row: { status: 'available', ...FINGERPRINT, ctimeMs: 456.5, candidateCount: 1 },
        constraint: 'ck_companion_ebooks_fingerprint',
      },
      {
        name: 'candidate_count=1.5',
        row: { status: 'available', ...FINGERPRINT, candidateCount: 1.5 },
        constraint: 'ck_companion_ebooks_candidate_count',
      },
    ];

    it.each(fractionalCases)('rejects $name with $constraint', async ({ row, constraint }) => {
      await expectViolates(row, constraint);
    });

    it('accepts a whole-valued float and stores it as an integer', async () => {
      // Pins that the CHECK rejects only genuinely fractional values — SQLite's INTEGER
      // affinity converts a REAL losslessly — so it cannot be satisfied vacuously.
      const bookId = await seedBook();
      await insertRaw({ bookId, status: 'available', ...FINGERPRINT, mtimeMs: 456.0, candidateCount: 1 });

      const res = await db.run(sql`SELECT typeof(mtime_ms), mtime_ms FROM companion_ebooks WHERE book_id = ${bookId}`);
      expect(res.rows[0]![0]).toBe('integer');
      expect(res.rows[0]![1]).toBe(456);
    });
  });

  // ---------------------------------------------------------------------------
  // Half-set rejection — one case per conjunct, each asserting its constraint name (F3)
  // ---------------------------------------------------------------------------

  describe('half-set rows are rejected by the constraint that owns the invariant', () => {
    const cases: RejectionCase[] = [
      // ck_companion_ebooks_file_present — a single-file status missing any fingerprint part
      {
        name: 'available with NULL filename',
        row: { status: 'available', ...FINGERPRINT, filename: null, candidateCount: 1 },
        constraint: 'ck_companion_ebooks_file_present',
      },
      {
        name: 'available with NULL size_bytes',
        row: { status: 'available', ...FINGERPRINT, sizeBytes: null, candidateCount: 1 },
        constraint: 'ck_companion_ebooks_file_present',
      },
      {
        name: 'available with NULL mtime_ms',
        row: { status: 'available', ...FINGERPRINT, mtimeMs: null, candidateCount: 1 },
        constraint: 'ck_companion_ebooks_file_present',
      },
      {
        name: 'available with NULL ctime_ms',
        row: { status: 'available', ...FINGERPRINT, ctimeMs: null, candidateCount: 1 },
        constraint: 'ck_companion_ebooks_file_present',
      },
      {
        name: 'invalid with NULL filename',
        row: { status: 'invalid', ...FINGERPRINT, filename: null, validationCode: 'not-a-zip', candidateCount: 1 },
        constraint: 'ck_companion_ebooks_file_present',
      },
      {
        name: 'drm_protected with NULL filename',
        row: { status: 'drm_protected', ...FINGERPRINT, filename: null, candidateCount: 1 },
        constraint: 'ck_companion_ebooks_file_present',
      },

      // ck_companion_ebooks_file_absent — a no-single-file status carrying fingerprint data
      {
        name: 'ambiguous with a filename',
        row: { status: 'ambiguous', filename: 'a.epub', candidateCount: 2 },
        constraint: 'ck_companion_ebooks_file_absent',
      },
      {
        name: 'ambiguous with size_bytes',
        row: { status: 'ambiguous', sizeBytes: 4096, candidateCount: 2 },
        constraint: 'ck_companion_ebooks_file_absent',
      },
      {
        name: 'ambiguous with mtime_ms',
        row: { status: 'ambiguous', mtimeMs: 1_700_000_000_000, candidateCount: 2 },
        constraint: 'ck_companion_ebooks_file_absent',
      },
      {
        name: 'ambiguous with ctime_ms',
        row: { status: 'ambiguous', ctimeMs: 1_700_000_000_000, candidateCount: 2 },
        constraint: 'ck_companion_ebooks_file_absent',
      },
      {
        name: 'none with a filename',
        row: { status: 'none', filename: 'a.epub' },
        constraint: 'ck_companion_ebooks_file_absent',
      },

      // ck_companion_ebooks_validation_code — set for exactly `invalid`, never otherwise
      {
        name: 'invalid without a validation_code',
        row: { status: 'invalid', ...FINGERPRINT, candidateCount: 1 },
        constraint: 'ck_companion_ebooks_validation_code',
      },
      {
        name: 'available with a validation_code',
        row: { status: 'available', ...FINGERPRINT, validationCode: 'not-a-zip', candidateCount: 1 },
        constraint: 'ck_companion_ebooks_validation_code',
      },
      {
        name: 'drm_protected with a validation_code',
        row: { status: 'drm_protected', ...FINGERPRINT, validationCode: 'not-a-zip', candidateCount: 1 },
        constraint: 'ck_companion_ebooks_validation_code',
      },
      {
        name: 'none with a validation_code',
        row: { status: 'none', validationCode: 'not-a-zip' },
        constraint: 'ck_companion_ebooks_validation_code',
      },

      // ck_companion_ebooks_candidate_count — per-status counts, and the >= 0 floor
      {
        name: 'none with candidate_count=1',
        row: { status: 'none', candidateCount: 1 },
        constraint: 'ck_companion_ebooks_candidate_count',
      },
      {
        name: 'ambiguous with candidate_count=1 (the exact >= 2 boundary)',
        row: { status: 'ambiguous', candidateCount: 1 },
        constraint: 'ck_companion_ebooks_candidate_count',
      },
      {
        name: 'available with candidate_count=0',
        row: { status: 'available', ...FINGERPRINT, candidateCount: 0 },
        constraint: 'ck_companion_ebooks_candidate_count',
      },
      {
        name: 'available with candidate_count=-1',
        row: { status: 'available', ...FINGERPRINT, candidateCount: -1 },
        constraint: 'ck_companion_ebooks_candidate_count',
      },

      // ck_companion_ebooks_selection — the forward implication
      {
        name: 'none with a selection',
        row: { status: 'none', selectedFilename: 'a.epub' },
        constraint: 'ck_companion_ebooks_selection',
      },
      {
        name: 'available with a selection that differs from filename',
        row: { status: 'available', ...FINGERPRINT, selectedFilename: 'other.epub', candidateCount: 1 },
        constraint: 'ck_companion_ebooks_selection',
      },

      // ck_companion_ebooks_multi_candidate_selection (F5) — the reverse implication.
      // Without it a reconciler that guessed between two candidates would satisfy the DB.
      {
        name: 'available at candidate_count=2 with no selection',
        row: { status: 'available', ...FINGERPRINT, candidateCount: 2 },
        constraint: 'ck_companion_ebooks_multi_candidate_selection',
      },
      {
        name: 'invalid at candidate_count=2 with no selection',
        row: { status: 'invalid', ...FINGERPRINT, validationCode: 'not-a-zip', candidateCount: 2 },
        constraint: 'ck_companion_ebooks_multi_candidate_selection',
      },
      {
        name: 'drm_protected at candidate_count=2 with no selection',
        row: { status: 'drm_protected', ...FINGERPRINT, candidateCount: 2 },
        constraint: 'ck_companion_ebooks_multi_candidate_selection',
      },

      // ck_companion_ebooks_fingerprint — size is unsigned; timestamps deliberately are not
      {
        name: 'available with size_bytes=-1',
        row: { status: 'available', ...FINGERPRINT, sizeBytes: -1, candidateCount: 1 },
        constraint: 'ck_companion_ebooks_fingerprint',
      },
    ];

    it.each(cases)('rejects $name with $constraint', async ({ row, constraint }) => {
      await expectViolates(row, constraint);
    });
  });

  // ---------------------------------------------------------------------------
  // Accepted rows — every status has at least one legal shape
  // ---------------------------------------------------------------------------

  describe('legal shapes the reconciler must be able to write', () => {
    const accepted: Array<{ name: string; row: Partial<Omit<RawRow, 'bookId'>> & { status: string } }> = [
      { name: 'none with everything NULL', row: { status: 'none' } },
      { name: 'ambiguous at candidate_count=2 (the boundary)', row: { status: 'ambiguous', candidateCount: 2 } },
      { name: 'ambiguous at candidate_count=3', row: { status: 'ambiguous', candidateCount: 3 } },
      {
        name: 'available with a full fingerprint and no selection',
        row: { status: 'available', ...FINGERPRINT, candidateCount: 1 },
      },
      {
        name: 'available resolved from ambiguous (count=2, selection matches filename)',
        row: { status: 'available', ...FINGERPRINT, candidateCount: 2, selectedFilename: FINGERPRINT.filename },
      },
      {
        // The case a `candidate_count >= 2` selection constraint would wrongly reject:
        // the unselected sibling was deleted, so the count dropped while the pick stands.
        name: 'available with a live selection whose sibling was deleted (count=1)',
        row: { status: 'available', ...FINGERPRINT, candidateCount: 1, selectedFilename: FINGERPRINT.filename },
      },
      {
        name: 'invalid with a validation_code',
        row: { status: 'invalid', ...FINGERPRINT, validationCode: 'not-a-zip', candidateCount: 1 },
      },
      {
        name: 'invalid resolved from ambiguous — the owner picked a file that fails validation',
        row: {
          status: 'invalid',
          ...FINGERPRINT,
          validationCode: 'not-a-zip',
          candidateCount: 2,
          selectedFilename: FINGERPRINT.filename,
        },
      },
      { name: 'drm_protected with a full fingerprint', row: { status: 'drm_protected', ...FINGERPRINT, candidateCount: 1 } },
      {
        name: 'drm_protected resolved from ambiguous',
        row: { status: 'drm_protected', ...FINGERPRINT, candidateCount: 2, selectedFilename: FINGERPRINT.filename },
      },
      {
        // The `size_bytes >= 0` boundary — a `> 0` misread fails here.
        name: 'zero-valued fingerprint fields',
        row: { status: 'available', filename: 'z.epub', sizeBytes: 0, mtimeMs: 0, ctimeMs: 0, candidateCount: 1 },
      },
    ];

    it.each(accepted)('accepts $name', async ({ row }) => {
      const bookId = await seedBook();
      await insertRaw({ ...row, bookId });

      const [stored] = await db.select().from(companionEbooks).where(eq(companionEbooks.bookId, bookId));
      expect(stored!.status).toBe(row.status);
    });

    it('round-trips a pre-epoch mtime/ctime exactly, as integers (F6)', async () => {
      // Filesystem times are signed — ext4 represents dates back to 1901 — so a
      // user-preserved pre-1970 mtime must stay persistable. Negative size_bytes is
      // rejected in the same suite, pinning the asymmetry rather than leaving it
      // incidental.
      const preEpochMs = -2_208_988_800_000; // 1900-01-01
      const bookId = await seedBook();
      await insertRaw({
        bookId,
        status: 'available',
        ...FINGERPRINT,
        mtimeMs: preEpochMs,
        ctimeMs: preEpochMs,
        candidateCount: 1,
      });

      const res = await db.run(
        sql`SELECT mtime_ms, ctime_ms, typeof(mtime_ms), typeof(ctime_ms) FROM companion_ebooks WHERE book_id = ${bookId}`,
      );
      expect(res.rows[0]![0]).toBe(preEpochMs);
      expect(res.rows[0]![1]).toBe(preEpochMs);
      expect(res.rows[0]![2]).toBe('integer');
      expect(res.rows[0]![3]).toBe('integer');
    });

    it('accepts a typed Drizzle insert that omits candidateCount and applies every default', async () => {
      // Deliberately omits candidateCount: this is the shape a real writer uses for a
      // `none` observation, and it pins the Drizzle half of `.default(0)` — both that the
      // column stays omissible in `$inferInsert` and that the value lands as 0.
      //
      // It does NOT cover the DB half: Drizzle INLINES its schema-level default into the
      // INSERT rather than omitting the column, so this row is written with an explicit
      // `candidate_count = 0` and survives even if the migration's `DEFAULT 0` is
      // deleted (measured). The migrated DDL default is pinned separately by the raw
      // insert in the NOT NULL / DEFAULT block above.
      const bookId = await seedBook();
      await db.insert(companionEbooks).values({ bookId, status: 'none' });

      const [stored] = await db.select().from(companionEbooks).where(eq(companionEbooks.bookId, bookId));
      expect(stored!.candidateCount).toBe(0);
      expect(stored!.createdAt).toBeInstanceOf(Date);
      expect(stored!.updatedAt).toBeInstanceOf(Date);
    });
  });

  // ---------------------------------------------------------------------------
  // FK behaviour
  // ---------------------------------------------------------------------------

  describe('foreign key to books', () => {
    it('cascade-deletes the companion row when the book is deleted', async () => {
      // Rationale is orphan-row accumulation and regression protection against a future
      // src/db/client.ts change — not "FKs might be off" (they are on by default) and not
      // rowid reuse (books.id is AUTOINCREMENT).
      const bookId = await seedBook();
      await insertRaw({ bookId, status: 'none' });

      await db.delete(books).where(eq(books.id, bookId));

      const remaining = await db.select().from(companionEbooks);
      expect(remaining).toHaveLength(0);
    });

    it('rejects a companion row for a non-existent book', async () => {
      const message = await rejectionMessage(() => insertRaw({ bookId: 999_999, status: 'none' }));
      expect(message).toContain('FOREIGN KEY constraint failed');
    });

    it('rejects a fractional book_id via the FK', async () => {
      // book_id carries no `typeof` CHECK of its own: books.id is an INTEGER PRIMARY KEY,
      // so no non-integer value can ever match a parent rowid and the FK rejects it
      // (Decision 4). Under the pre-Decision-8 rowid-alias shape this failed with
      // SQLITE_MISMATCH instead.
      await seedBook();
      const message = await rejectionMessage(() => insertRaw({ bookId: 1.5, status: 'none' }));
      expect(message).toContain('FOREIGN KEY constraint failed');
    });
  });
});
