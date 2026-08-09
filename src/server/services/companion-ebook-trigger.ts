import type { FastifyBaseLogger } from 'fastify';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { serializeError } from '../utils/serialize-error.js';

export interface CompanionBookReconcileTrigger {
  reconcileBook(bookId: number, force?: boolean): Promise<void>;
}

export interface CompanionSweepTrigger {
  reconcileAll(): Promise<void>;
}

/** Never throw: catch synchronous failures before `fireAndForget` handles rejections. */
function fire(run: () => Promise<void>, log: FastifyBaseLogger, context: string): void {
  try {
    fireAndForget(run(), log, context);
  } catch (error: unknown) {
    log.warn({ error: serializeError(error) }, context);
  }
}

/** Force bypasses fingerprint reuse; reserve it for explicit user actions, never read paths. */
export function triggerCompanionReconcile(
  reconciler: CompanionBookReconcileTrigger | null | undefined,
  bookId: number,
  log: FastifyBaseLogger,
  context: string,
  force = false,
): void {
  if (!reconciler) return;
  // Preserve the one-argument contract for non-forced callers.
  fire(
    () => (force ? reconciler.reconcileBook(bookId, true) : reconciler.reconcileBook(bookId)),
    log,
    context,
  );
}

/** Reconciler coalescing collapses concurrent sweeps to at most one queued follow-up. */
export function triggerCompanionSweep(
  reconciler: CompanionSweepTrigger | null | undefined,
  log: FastifyBaseLogger,
  context: string,
): void {
  if (!reconciler) return;
  fire(() => reconciler.reconcileAll(), log, context);
}
