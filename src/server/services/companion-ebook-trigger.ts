import type { FastifyBaseLogger } from 'fastify';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * The trigger seams' view of the reconciler (#1960). Structural, not the concrete class, and
 * SPLIT BY METHOD so a seam declares only the one it fires and a test stub needs nothing else —
 * the same narrow-dependency shape this slate already uses for
 * `Pick<LibraryScanService, 'rescanLibrary'>` and `Pick<SettingsService, 'get'>`.
 *
 * No seam uses both: import completion, Refresh & Scan, the two per-book rename callers,
 * wrong-release, and the read-path arms that could not serve a file fire
 * {@link CompanionBookReconcileTrigger};
 * the rescan wrapper, bulk rename, and `PUT /api/settings` fire {@link CompanionSweepTrigger}.
 * `CompanionEbookReconciler` satisfies both, so production wiring is unchanged.
 */
export interface CompanionBookReconcileTrigger {
  /**
   * `force` (#2034) is OPTIONAL, which is what keeps `CompanionEbookReconciler` assignable to
   * this interface and every existing `{ reconcileBook: vi.fn() }` stub valid — a stub that wants
   * to assert force just declares the second parameter.
   */
  reconcileBook(bookId: number, force?: boolean): Promise<void>;
}

export interface CompanionSweepTrigger {
  reconcileAll(): Promise<void>;
}

/**
 * Fire a companion-ebook reconcile from a trigger seam and return IMMEDIATELY. The ONE home
 * for that shape — every seam #1960 wires (import completion, the rescan wrapper, Refresh &
 * Scan, the three rename callers, wrong-release, `PUT /api/settings`, and each read path that
 * could not serve the file) goes through it.
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

/**
 * Refresh the companion observation for ONE book. No-op when no reconciler is wired.
 *
 * `force` (#2034) skips the observer's fingerprint short-circuit, so a stale verdict on an
 * UNCHANGED file gets re-judged. Pass it only where a user pointed at this one book — today that
 * is Refresh & Scan and the companion refresh endpoint, and nothing else. Every other seam
 * (import completion, the three rename callers, wrong-release, and the read paths that could not
 * serve a file) omits it: those read-path arms in particular fire once per REQUEST, so forcing
 * there would put a full `validateEpub` on an unbounded request-rate path.
 */
export function triggerCompanionReconcile(
  reconciler: CompanionBookReconcileTrigger | null | undefined,
  bookId: number,
  log: FastifyBaseLogger,
  context: string,
  force = false,
): void {
  if (!reconciler) return;
  // AC8 — a non-forcing trigger stays a TRUE single-argument call. `reconcileBook(bookId, force)`
  // would read identically at runtime but forwards an explicit `false`/`undefined`, and vitest's
  // `toHaveBeenCalledWith(id)` compares argument ARRAYS — so that one-character convenience would
  // break exact-call assertions in seven suites this issue does not otherwise touch.
  fire(
    () => (force ? reconciler.reconcileBook(bookId, true) : reconciler.reconcileBook(bookId)),
    log,
    context,
  );
}

/**
 * Sweep every eligible book. Unlike {@link triggerCompanionReconcile} this one coalesces:
 * `reconcileAll()` is single-flight with at most one queued follow-up, so N calls collapse to
 * at most one extra run.
 */
export function triggerCompanionSweep(
  reconciler: CompanionSweepTrigger | null | undefined,
  log: FastifyBaseLogger,
  context: string,
): void {
  if (!reconciler) return;
  fire(() => reconciler.reconcileAll(), log, context);
}
