import { and, eq, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { books } from '../../db/schema.js';
import type { BookStatus } from '../../shared/schemas/book.js';

// ============================================================================
// Authoritative book-status transitions (#1446, epic #1441 / S2c)
//
// `transitionBookStatus` is the SOLE guarded writer of `books.status` for the
// writers S2c owns. It mirrors S2b's `transitionDownloadState`
// (`download-state.ts`) so the two lifecycle axes (downloads / books) stay
// symmetric:
//   * Only the fields explicitly set on the transition land in the SQL SET
//     clause — an omitted field is never written, so a single-axis writer can
//     never clobber an unrelated column.
//   * The optional `expected` guard compiles to a WHERE predicate, so a
//     transition only lands when the row is in the expected state (lets a
//     library-scan reconciliation skip a row an in-flight import already moved).
//   * Accepts either the base `Db` or a transaction executor (`tx`) so writers
//     that run inside an `import_jobs` + `books` transaction (#1448) preserve
//     single-transaction atomicity.
// ============================================================================

export interface BookStatusTransition {
  /** Optional precondition — the UPDATE only lands when the row matches. */
  expected?: { status?: BookStatus };
  status?: BookStatus;
  // Side fields written atomically with the transition (all optional, all
  // omitted-when-undefined so they never clobber a concurrent writer).
  path?: string | null;
  size?: number;
  lastGrabGuid?: string | null;
  lastGrabInfoHash?: string | null;
}

/**
 * Atomically transition a book's status (and any co-written side fields).
 * Returns `true` if a row was updated (i.e. the `expected` guard, if any,
 * matched), `false` otherwise. Always stamps `updatedAt`.
 */
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

  // Unconditional write (no precondition) always lands → skip the RETURNING
  // round-trip and report success. Only a guarded transition needs RETURNING to
  // learn whether the `expected` predicate matched a row.
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

/**
 * Conservative fallback when no explicit prior lifecycle is available (legacy /
 * orphan download rows with a null `bookStatusAtGrab` snapshot). Matches the
 * quality gate's `download.bookStatusAtGrab ?? 'imported'` policy
 * (`quality-gate.service.ts`) — a single named constant so the fallback can
 * never drift between revert paths or reintroduce path inference.
 */
export const REVERT_FALLBACK_STATUS: BookStatus = 'imported';

/**
 * Revert a book to its explicit prior lifecycle state after a grab/import is
 * cancelled, rejected, or fails. The prior state is supplied by the caller
 * (the `bookStatusAtGrab` snapshot captured at grab, or an equivalently
 * explicit value) — it is NEVER inferred from `path` presence, which collapses
 * `failed`/`missing`/`searching` into `imported`/`wanted` and corrupts the
 * authoritative `books.status` (the headline bug this replaces).
 *
 * A `null` prior state (legacy rows) falls back to the conservative
 * `REVERT_FALLBACK_STATUS`, not to path inference. Returns the resolved status
 * so callers can emit a matching `book_status_change` SSE.
 */
export async function revertBookStatus(
  db: DbOrTx,
  book: { id: number },
  priorStatus: BookStatus | null,
): Promise<BookStatus> {
  const revertStatus = priorStatus ?? REVERT_FALLBACK_STATUS;
  await transitionBookStatus(db, book.id, { status: revertStatus });
  return revertStatus;
}
