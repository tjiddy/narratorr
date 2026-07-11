import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookStatus } from '../../shared/schemas/book.js';
import { deriveDisplayStatus } from '../../shared/download-status-registry.js';
import { guardedRevertBookStatus } from '../utils/book-status.js';
import { emitDownloadStatusChange, emitBookStatusChange, recordDownloadFailedEvent } from '../utils/download-side-effects.js';
import { serializeError } from '../utils/serialize-error.js';
import {
  gatherBookBlockers,
  classifyBlockers,
  hasNonReplaceableBlocker,
  pipelineActiveReason,
  claimReplaceableTargets,
  type ClaimTarget,
} from './download-blockers.js';
import { DuplicateDownloadError, ClaimMissError } from './download-errors.js';
import type { DownloadService, DownloadWithBook } from './download.service.js';
import type { GrabParams, GrabInnerOpts } from './download-orchestrator.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { DownloadRow } from './types.js';

// ============================================================================
// Confirmed cancel-&-replace workflow (#1857)
//
// Runs under the per-book admission mutex (established by the orchestrator). It
// gathers blockers, classifies, and — for the replaceable case — runs the
// claim-first cancellation protocol, then grabs the replacement inheriting the
// deterministic `bookStatusAtGrab` snapshot. Book status is owned SYNCHRONOUSLY
// here: forward via the orchestrator's grab primitive, revert via the guarded
// helper (the single coordination retained beyond a plain revert).
// ============================================================================

export interface ReplaceCtx {
  db: Db;
  log: FastifyBaseLogger;
  downloadService: DownloadService;
  broadcaster?: EventBroadcasterService | undefined;
  eventHistory?: EventHistoryService | undefined;
  blacklistService?: BlacklistService | undefined;
  /** The orchestrator's UNLOCKED grab primitive (already inside the book mutex). */
  grab: (params: GrabParams, opts: GrabInnerOpts) => Promise<DownloadWithBook>;
  /** Guarded side-effect dispatch (sync try/catch). */
  safe: (fn: () => void) => void;
}

/** First non-null `bookStatusAtGrab` over the gathered client-stage cohort
 *  (already ordered `addedAt DESC, id DESC`); null when all are null (F6). */
function selectInheritedSnapshot(targets: DownloadRow[]): BookStatus | null {
  for (const t of targets) {
    if (t.bookStatusAtGrab != null) return t.bookStatusAtGrab;
  }
  return null;
}

function pipelineError(reason: 'processing' | 'awaiting_review'): DuplicateDownloadError {
  return new DuplicateDownloadError('Book has a download in the import pipeline', 'PIPELINE_ACTIVE', { reason });
}

function activeExistsError(active: { title: string; count: number }): DuplicateDownloadError {
  return new DuplicateDownloadError('Book already has an active download', 'ACTIVE_DOWNLOAD_EXISTS', { active });
}

/** Best-effort permanent blacklist of a cancelled (replaced) release. */
async function blacklistReplacedTarget(ctx: ReplaceCtx, t: DownloadRow): Promise<void> {
  if (!ctx.blacklistService) return;
  if (!t.infoHash && !t.guid) {
    ctx.log.info({ id: t.id }, 'Replace: blacklist skipped — no infoHash or guid');
    return;
  }
  try {
    await ctx.blacklistService.create({
      infoHash: t.infoHash,
      guid: t.guid,
      title: t.title,
      bookId: t.bookId ?? undefined,
      reason: 'user_cancelled',
      blacklistType: 'permanent',
    });
  } catch (error: unknown) {
    ctx.log.warn({ error: serializeError(error), id: t.id }, 'Replace: failed to blacklist replaced release');
  }
}

/** Post-commit external cleanup for each claimed row (best-effort, per-row). */
async function cleanupClaimedTargets(ctx: ReplaceCtx, targets: DownloadRow[], reason: string): Promise<void> {
  for (const t of targets) {
    await ctx.downloadService.removeExternalItem(t);
    await blacklistReplacedTarget(ctx, t);
    if (t.bookId) {
      const oldDisplay = deriveDisplayStatus(t.clientStatus, t.pipelineStage);
      ctx.safe(() => emitDownloadStatusChange({ broadcaster: ctx.broadcaster, downloadId: t.id, bookId: t.bookId!, oldStatus: oldDisplay, newStatus: 'failed', log: ctx.log }));
      ctx.safe(() => recordDownloadFailedEvent({ eventHistory: ctx.eventHistory, downloadId: t.id, bookId: t.bookId!, bookTitle: t.title, errorMessage: reason, log: ctx.log }));
    }
  }
}

/**
 * Guarded book-status revert on a no-grab / failed-grab path (F61/F67). Reverts
 * to the in-memory `snapshot` ONLY while the book is still `downloading` (the
 * status a client-stage tracked grab owns). A late `importing` promotion makes
 * the guard miss → revert skipped, `importing` preserved, no SSE.
 */
async function coordinateReplaceRevert(ctx: ReplaceCtx, bookId: number, snapshot: BookStatus | null): Promise<void> {
  const { landed, status } = await guardedRevertBookStatus(ctx.db, { id: bookId }, snapshot, 'downloading');
  if (landed) {
    ctx.safe(() => emitBookStatusChange({ broadcaster: ctx.broadcaster, bookId, oldStatus: 'downloading', newStatus: status, log: ctx.log }));
  }
}

/** Ordinary grab within the mutex (nothing to replace) — gatherAllBlockers mode. */
async function grabAsOrdinary(ctx: ReplaceCtx, params: GrabParams): Promise<number> {
  const dl = await ctx.grab(params, { classificationMode: 'gatherAllBlockers' });
  return dl.id;
}

/**
 * Run the confirmed replace workflow, returning the winner download id. Throws
 * `DuplicateDownloadError` for the `PIPELINE_ACTIVE` / (double-miss)
 * `ACTIVE_DOWNLOAD_EXISTS` dispositions. Bounded single retry on a claim miss.
 */
export async function runReplaceWorkflow(ctx: ReplaceCtx, params: GrabParams, attempt = 0): Promise<number> {
  const bookId = params.bookId!;
  const classification = classifyBlockers(await gatherBookBlockers(ctx.db, bookId));

  if (classification.kind === 'pipeline') throw pipelineError(classification.reason);
  if (classification.kind === 'clear') return grabAsOrdinary(ctx, params);

  const targets = classification.rows;
  const snapshot = selectInheritedSnapshot(targets);
  const reason = `Replaced by "${params.title}"`;
  const claimTargets: ClaimTarget[] = targets.map((t) => ({
    id: t.id,
    expected: { clientStatus: t.clientStatus, pipelineStage: 'idle' },
  }));

  try {
    await claimReplaceableTargets(ctx.db, bookId, claimTargets, reason);
  } catch (error: unknown) {
    if (error instanceof ClaimMissError) return handleClaimMiss(ctx, params, attempt);
    throw error;
  }

  // Claim committed → external cleanup, then residual late-blocker check, then grab.
  await cleanupClaimedTargets(ctx, targets, reason);

  const late = await gatherBookBlockers(ctx.db, bookId);
  if (hasNonReplaceableBlocker(late)) {
    await coordinateReplaceRevert(ctx, bookId, snapshot);
    throw pipelineError(pipelineActiveReason(late));
  }

  try {
    const dl = await ctx.grab(
      { ...params, skipDuplicateCheck: true },
      { bookStatusAtGrabOverride: snapshot, bestEffortBookStatus: true },
    );
    return dl.id;
  } catch (grabError: unknown) {
    // Failed replacement grab — revert from the same in-memory snapshot.
    await coordinateReplaceRevert(ctx, bookId, snapshot);
    throw grabError;
  }
}

/**
 * Guard-miss / in-tx-recheck rollback disposition (F20). Nothing was cancelled
 * (the claim tx rolled back), so no revert is needed. Re-classify against fresh
 * state; a still-replaceable book gets ONE bounded retry of the whole
 * gather→claim, then falls to `ACTIVE_DOWNLOAD_EXISTS` (let the user re-confirm).
 */
async function handleClaimMiss(ctx: ReplaceCtx, params: GrabParams, attempt: number): Promise<number> {
  const bookId = params.bookId!;
  const reclass = classifyBlockers(await gatherBookBlockers(ctx.db, bookId));
  if (reclass.kind === 'pipeline') throw pipelineError(reclass.reason);
  if (reclass.kind === 'clear') return grabAsOrdinary(ctx, params);
  // Still replaceable but the tuple changed — bounded single retry, else surface.
  if (attempt < 1) return runReplaceWorkflow(ctx, params, attempt + 1);
  throw activeExistsError(reclass.active);
}
