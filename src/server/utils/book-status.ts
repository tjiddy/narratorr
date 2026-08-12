import { and, eq, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@db/index.js';
import { books } from '@db/schema.js';
import type { BookStatus } from '@shared/schemas/book.js';

// Omitted fields never clobber concurrent writers; expected is an atomic lifecycle guard.

export interface BookStatusTransition {
  expected?: { status?: BookStatus };
  status?: BookStatus;
  path?: string | null;
  size?: number;
  lastGrabGuid?: string | null;
  lastGrabInfoHash?: string | null;
}

export async function transitionBookStatus(
  db: DbOrTx,
  id: number,
  t: BookStatusTransition,
): Promise<boolean> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (t.status !== undefined) set.status = t.status;
  if (t.path !== undefined) set.path = t.path;
  if (t.size !== undefined) set.size = t.size;
  if (t.lastGrabGuid !== undefined) set.lastGrabGuid = t.lastGrabGuid;
  if (t.lastGrabInfoHash !== undefined) set.lastGrabInfoHash = t.lastGrabInfoHash;

  // Only guarded transitions need RETURNING to report whether they landed.
  if (t.expected?.status === undefined) {
    await db.update(books).set(set).where(eq(books.id, id));
    return true;
  }

  const conds: SQL[] = [eq(books.id, id), eq(books.status, t.expected.status)];
  const result = await db
    .update(books)
    .set(set)
    .where(and(...conds))
    .returning({ id: books.id });

  return result.length > 0;
}

// Legacy null snapshots revert to imported; never infer lifecycle from path.
export const REVERT_FALLBACK_STATUS: BookStatus = 'imported';

// Restore the captured lifecycle snapshot and return it for a matching SSE.
export async function revertBookStatus(
  db: DbOrTx,
  book: { id: number },
  priorStatus: BookStatus | null,
): Promise<BookStatus> {
  const revertStatus = priorStatus ?? REVERT_FALLBACK_STATUS;
  await transitionBookStatus(db, book.id, { status: revertStatus });
  return revertStatus;
}

// Manual replace must not clobber a late promotion or emit an SSE when its guard misses.
export async function guardedRevertBookStatus(
  db: DbOrTx,
  book: { id: number },
  priorStatus: BookStatus | null,
  expectedStatus: BookStatus,
): Promise<{ landed: boolean; status: BookStatus }> {
  const status = priorStatus ?? REVERT_FALLBACK_STATUS;
  const landed = await transitionBookStatus(db, book.id, { status, expected: { status: expectedStatus } });
  return { landed, status };
}
