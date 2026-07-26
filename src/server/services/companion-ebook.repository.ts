import { eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { companionEbooks } from '../../db/schema.js';
import { chunkArray } from '../utils/batch.js';
import {
  companionEbookObservationSchema,
  type CompanionEbookObservation,
} from './companion-ebook-observation.js';
import type { CompanionEbookRow } from './types.js';

/**
 * Observation repository over `companion_ebooks` (#1958, plan §2). Module-level functions
 * taking the executor first — the `book-create.ts` / `download-record.ts` convention, not a
 * class. No DI wiring and no `services/index.ts` export: 1.2b has no runtime consumer yet
 * (1.2c wires it).
 *
 * **The executor is `DbOrTx`, not `Db`, and that is a downstream requirement.** #1959's
 * conditional writes are keyed on a `(bookId, path, status, fingerprint)` snapshot, so the
 * precondition read and the companion upsert must land in ONE transaction to be atomic. A
 * `Db`-typed parameter rejects the handle `db.transaction(async (tx) => ...)` supplies,
 * leaving #1959 to either duplicate this SQL or write outside its own precondition. Same
 * distinction the project already draws for `transitionBookStatus` and `replaceSeriesLink`.
 */

// The `IN (...)` list is the only bound-parameter set in the batch statement, so 480 leaves
// ample headroom under the in-repo 998 convention ceiling (sqlite-in-clause-bind-limit).
const BOOK_ID_CHUNK_SIZE = 480;

/**
 * Map a validated observation onto the eleven columns. Every column the variant does not
 * carry is written as `null` HERE — the caller has no way to half-set a row. `selectedFilename`
 * is derived from `selected`, so the DB's `selected_filename = filename` equality is
 * structurally unfalsifiable.
 *
 * Built inside a function body, never as a module-level constant: a top-level dereference of
 * `companionEbooks.*` is evaluated at import time and crashes any suite that partial-mocks
 * `db/schema` (drizzle-schema-toplevel-deref-breaks-partial-mocks).
 */
function toColumnValues(bookId: number, observation: CompanionEbookObservation) {
  const base = {
    bookId,
    filename: null,
    sizeBytes: null,
    mtimeMs: null,
    ctimeMs: null,
    validationCode: null,
    selectedFilename: null,
    updatedAt: new Date(),
  };

  if (observation.status === 'none') {
    // `none` carries no candidateCount — it is always zero.
    return { ...base, status: 'none' as const, candidateCount: 0 };
  }
  if (observation.status === 'ambiguous') {
    return { ...base, status: 'ambiguous' as const, candidateCount: observation.candidateCount };
  }

  return {
    ...base,
    status: observation.status,
    filename: observation.filename,
    sizeBytes: observation.sizeBytes,
    mtimeMs: observation.mtimeMs,
    ctimeMs: observation.ctimeMs,
    validationCode: observation.status === 'invalid' ? observation.validationCode : null,
    candidateCount: observation.candidateCount,
    selectedFilename: observation.selected ? observation.filename : null,
  };
}

export async function findCompanionEbook(x: DbOrTx, bookId: number): Promise<CompanionEbookRow | null> {
  const rows = await x.select().from(companionEbooks).where(eq(companionEbooks.bookId, bookId)).limit(1);
  return (rows[0] as CompanionEbookRow | undefined) ?? null;
}

/**
 * Batch lookup: one query per chunk, never one per book. An empty input returns an empty
 * `Map` **without** issuing a query (`chunkArray([])` yields no chunks). Absent book ids are
 * simply missing keys, never `null` values.
 */
export async function findCompanionEbooksByBookIds(
  x: DbOrTx,
  bookIds: number[],
): Promise<Map<number, CompanionEbookRow>> {
  const byBookId = new Map<number, CompanionEbookRow>();
  for (const chunk of chunkArray(bookIds, BOOK_ID_CHUNK_SIZE)) {
    const rows = await x.select().from(companionEbooks).where(inArray(companionEbooks.bookId, chunk));
    for (const row of rows as CompanionEbookRow[]) {
      byBookId.set(row.bookId, row);
    }
  }
  return byBookId;
}

/**
 * Insert-or-update the single observation row for a book. Parses unconditionally, so no
 * invalid value can be driven through this function to reach a DB CHECK — the eight
 * constraints stay the last backstop and are covered from raw SQL in #1957's suite.
 *
 * Invalid observations originate from the reconciler (#1959), never from a request body, so
 * the `ZodError` is the correct programmer-error signal and needs no domain error class or
 * route mapping.
 *
 * `updatedAt` is always written; `createdAt` is written on insert only and never rewritten.
 */
export async function upsertCompanionEbook(
  x: DbOrTx,
  bookId: number,
  observation: CompanionEbookObservation,
): Promise<CompanionEbookRow> {
  const parsed = companionEbookObservationSchema.parse(observation);
  const values = toColumnValues(bookId, parsed);
  const { bookId: _bookId, ...updateSet } = values;

  const rows = await x
    .insert(companionEbooks)
    .values({ ...values, createdAt: new Date() })
    .onConflictDoUpdate({ target: companionEbooks.bookId, set: updateSet })
    .returning();

  return rows[0] as CompanionEbookRow;
}

export async function deleteCompanionEbook(x: DbOrTx, bookId: number): Promise<boolean> {
  const rows = await x
    .delete(companionEbooks)
    .where(eq(companionEbooks.bookId, bookId))
    .returning({ bookId: companionEbooks.bookId });
  return rows.length > 0;
}
