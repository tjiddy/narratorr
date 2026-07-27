import type { FastifyBaseLogger } from 'fastify';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * The trigger seam's view of the reconciler (#1960). Structural, not the concrete class, so a
 * seam declares only the method it fires and a test stub needs nothing else.
 */
export interface CompanionReconcileTrigger {
  reconcileBook(bookId: number): Promise<void>;
  reconcileAll(): Promise<void>;
}

/**
 * Fire a companion-ebook reconcile from a trigger seam and return IMMEDIATELY. The ONE home
 * for that shape — every seam #1960 wires (import completion, the rescan wrapper, Refresh &
 * Scan, the three rename callers, wrong-release, `PUT /api/settings`, and each opener's
 * mismatch arm) goes through it.
 *
 * **This function never throws.** `fireAndForget` catches a REJECTION but evaluates its
 * argument eagerly, so a reconciler that throws SYNCHRONOUSLY escapes it entirely
 * (`fire-and-forget-preflight`). Every one of these seams sits on a path where an escaping
 * throw would change user-visible behaviour — failing a completed import, turning a 404 into a
 * 500, masking a settings error — so the `try` here is load-bearing, not defensive noise.
 */
function fire(run: () => Promise<void>, log: FastifyBaseLogger, context: string): void {
  try {
    fireAndForget(run(), log, context);
  } catch (error: unknown) {
    log.warn({ error: serializeError(error) }, context);
  }
}

/** Refresh the companion observation for ONE book. No-op when no reconciler is wired. */
export function triggerCompanionReconcile(
  reconciler: CompanionReconcileTrigger | null | undefined,
  bookId: number,
  log: FastifyBaseLogger,
  context: string,
): void {
  if (!reconciler) return;
  fire(() => reconciler.reconcileBook(bookId), log, context);
}

/**
 * Sweep every eligible book. Unlike {@link triggerCompanionReconcile} this one coalesces:
 * `reconcileAll()` is single-flight with at most one queued follow-up, so N calls collapse to
 * at most one extra run.
 */
export function triggerCompanionSweep(
  reconciler: CompanionReconcileTrigger | null | undefined,
  log: FastifyBaseLogger,
  context: string,
): void {
  if (!reconciler) return;
  fire(() => reconciler.reconcileAll(), log, context);
}
