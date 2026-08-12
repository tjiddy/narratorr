import { eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '@db/client.js';
import { companionEbooks } from '@db/schema.js';
import { chunkArray } from '../utils/batch.js';
import {
  companionEbookObservationSchema,
  type CompanionEbookObservation,
} from './companion-ebook-observation.js';
import type { CompanionEbookRow } from './types.js';

/**
 * Accept `DbOrTx` so snapshot preconditions and observation writes can remain in one atomic
 * transaction.
 */

// Leave headroom below SQLite's 998-bind convention ceiling.
const BOOK_ID_CHUNK_SIZE = 480;

/**
 * Fill omitted columns with null and derive `selectedFilename`. Keep schema dereferences inside
 * the function because partial `db/schema` mocks cannot survive top-level access.
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

/** Missing ids are omitted; empty input performs no query. */
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

/** Validate programmer-owned observations; preserve `createdAt` while refreshing `updatedAt`. */
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
