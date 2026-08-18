import type { DbOrTx } from '@db/index.js';
import type { BookStatus } from '@shared/schemas/book.js';
import { isUniqueViolation } from '@shared/error-message.js';
import { transitionBookStatus } from '../utils/book-status.js';
import { ACTIVE_JOB_UNIQUE_VIOLATION, type BookImportService } from './book-import.service.js';

/** Rollback signal: the book's status moved between observation and the transaction. */
export class AttachGuardMissed extends Error {}

/** Rollback signal: `enqueue`'s precheck found an active job for the book. */
export class AttachActiveJobConflict extends Error {}

export interface AttachEnqueueParams {
  bookId: number;
  /** The status observed at classification / precheck time; the transition guards on it. */
  expectedStatus: BookStatus;
  metadata: string;
}

/**
 * #2435 AC26 — the guarded status write and the enqueue are ONE atomic unit.
 *
 * Both are issued on the caller's transaction handle, and both failure modes throw so the caller's
 * transaction rolls back. Split into two self-managed calls this cannot hold: `transitionBookStatus`
 * commits immediately on whatever executor it receives and `enqueue` opens its own transaction when
 * handed none, so a failed insert would strand the book in `importing` with no job.
 */
export async function attachTransitionAndEnqueue(
  tx: DbOrTx,
  bookImportService: Pick<BookImportService, 'enqueue'>,
  params: AttachEnqueueParams,
): Promise<number> {
  const landed = await transitionBookStatus(tx, params.bookId, {
    status: 'importing',
    expected: { status: params.expectedStatus },
  });
  if (!landed) throw new AttachGuardMissed();

  const enqueued = await bookImportService.enqueue(
    { bookId: params.bookId, type: 'manual', metadata: params.metadata },
    tx,
  );
  if ('error' in enqueued) throw new AttachActiveJobConflict();
  return enqueued.jobId;
}

/**
 * Does this error mean "an active job already owns the book"?
 *
 * Two shapes reach the caller for one condition. `enqueue`'s precheck raises the typed conflict;
 * the insert race raises a RAW unique violation, because supplying a transaction routes past the
 * wrapper in `BookImportService.enqueue` that would otherwise map it. Only violations naming the
 * active-job index count — labelling an unrelated conflict `already-importing` would hide it.
 */
export function isAttachActiveJobConflict(error: unknown): boolean {
  return error instanceof AttachActiveJobConflict
    || isUniqueViolation(error, ACTIVE_JOB_UNIQUE_VIOLATION);
}
