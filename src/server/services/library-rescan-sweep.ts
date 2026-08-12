import type { FastifyBaseLogger } from 'fastify';
import { ScanInProgressError, type LibraryScanService, type RescanResult } from './library-scan.service.js';
import { triggerCompanionSweep, type CompanionSweepTrigger } from './companion-ebook-trigger.js';

export interface RescanWithCompanionSweepDeps {
  libraryScan: Pick<LibraryScanService, 'rescanLibrary'>;
  /** Optional for suites that do not exercise companion reconciliation. */
  companionEbook?: CompanionSweepTrigger | null | undefined;
  log: FastifyBaseLogger;
}

/**
 * The shared rescan entry point. Reconcile only after this scan releases its scanning flag;
 * per-book locks, not a global pause, handle overlap with later work. ScanInProgress skips the
 * sweep; every other outcome sweeps after partial work, then rethrows the original error.
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
