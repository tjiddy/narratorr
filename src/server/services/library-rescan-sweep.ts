import type { FastifyBaseLogger } from 'fastify';
import { ScanInProgressError, type LibraryScanService, type RescanResult } from './library-scan.service.js';
import { triggerCompanionSweep, type CompanionReconcileTrigger } from './companion-ebook-trigger.js';

export interface RescanWithCompanionSweepDeps {
  libraryScan: Pick<LibraryScanService, 'rescanLibrary'>;
  /** Optional so a suite that does not exercise the sweep can omit it entirely. */
  companionEbook?: CompanionReconcileTrigger | null | undefined;
  log: FastifyBaseLogger;
}

/**
 * The ONE way the server rescans the library (#1960 AC9). Both production callers — the
 * `POST /api/library/rescan` route and the 6h `library-rescan` cron — go through here; neither
 * calls `LibraryScanService.rescanLibrary()` directly any more.
 *
 * **Why a wrapper and not a hook inside the scan (AC11).** `rescanLibrary` holds a private
 * `scanning` flag for its whole body and 409s any concurrent caller. Per-book companion
 * filesystem work inside that section — especially inside the row loop — would make the
 * operator's Refresh Library button fail while a sweep reads EPUBs. Awaiting the scan first
 * lets its own `finally` release `scanning` before a single companion `stat` is issued (AC10).
 *
 * **Ordering contract, scoped to this wrapper (AC13).** The sweep THIS call causes is not
 * started until THIS `rescanLibrary()` has settled. That is the whole guarantee. It is
 * deliberately NOT a global "no companion filesystem I/O while `scanning` is true" invariant:
 * `scanning` is private, the reconciler has no coordination with it, and two overlaps are
 * accepted by design — (a) a later rescan running concurrently with an earlier rescan's sweep
 * (AC14: that second `POST` gets a 200, not a 409, because the sweep does not hold `scanning`),
 * and (b) any direct `reconcileBook()` trigger running during a scan. Per-book safety comes
 * from `withBookAdmissionLock`, not from the scan flag. Do not "fix" this into a cross-service
 * pause protocol — §6's "use the primitives that already exist" rules that out.
 *
 * **Which outcomes sweep (AC12).** `ScanInProgressError` means nothing was scanned and the
 * in-flight scan's own wrapper already owns the post-scan sweep, so it triggers NOTHING. Every
 * other outcome — success, `LibraryPathError`, or an unexpected throw — sweeps, because a
 * partial scan can still have moved books. The error is then rethrown UNCHANGED, so the
 * route's 409/400/500 mapping and the cron's warn-and-swallow behave exactly as before.
 */
export async function rescanLibraryWithCompanionSweep(
  deps: RescanWithCompanionSweepDeps,
): Promise<RescanResult> {
  const sweep = (): void => triggerCompanionSweep(
    deps.companionEbook,
    deps.log,
    'Companion ebook sweep failed after library rescan',
  );

  let result: RescanResult;
  try {
    result = await deps.libraryScan.rescanLibrary();
  } catch (error: unknown) {
    if (!(error instanceof ScanInProgressError)) sweep();
    throw error;
  }
  sweep();
  return result;
}
