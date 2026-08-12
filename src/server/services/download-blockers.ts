import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { Db, DbOrTx } from '@db/index.js';
import { downloads, importJobs } from '@db/schema.js';
import { deriveDisplayStatus } from '@shared/download-status-registry.js';
import {
  inProgressDownloadCondition,
  qualityGateEligibleDownloadCondition,
  isQualityGateEligibleRow,
  transitionDownloadState,
} from '../utils/download-state.js';
import { ClaimMissError, type PipelineActiveReason } from './download-errors.js';
import type { ClientStatus, PipelineStage } from '@shared/schemas/activity.js';
import type { DownloadRow } from './types.js';

// Gather and transactional recheck must share these predicates or the claim race reopens.

type BlockerFields = Pick<DownloadRow, 'clientStatus' | 'pipelineStage' | 'externalId'>;

// Only idle client-stage states are replaceable; import and quality-gate ownership is not.
export function isClientStageReplaceable(d: Pick<DownloadRow, 'clientStatus' | 'pipelineStage'>): boolean {
  return d.pipelineStage === 'idle'
    && (d.clientStatus === 'queued' || d.clientStatus === 'downloading' || d.clientStatus === 'paused');
}

// Non-idle and tracked completed QG-eligible rows block; terminal Blackhole handoffs do not.
export function isPipelineBlocker(d: BlockerFields): boolean {
  if (d.pipelineStage === 'checking' || d.pipelineStage === 'pending_review' || d.pipelineStage === 'importing') {
    return true;
  }
  return isQualityGateEligibleRow(d);
}

export interface BookBlockers {
  /** Client-stage replaceable rows, ordered `addedAt DESC, id DESC` (F10). */
  replaceable: DownloadRow[];
  pipelineDownloads: DownloadRow[];
  hasPendingAutoJob: boolean;
}

function bookBlockerRowsCondition(bookId: number) {
  return and(
    eq(downloads.bookId, bookId),
    or(
      inProgressDownloadCondition(),
      qualityGateEligibleDownloadCondition(),
    ),
  );
}

// Accept DbOrTx so the claim transaction reruns this exact query.
export async function gatherBookBlockers(db: DbOrTx, bookId: number): Promise<BookBlockers> {
  const rows = (await db
    .select()
    .from(downloads)
    .where(bookBlockerRowsCondition(bookId))
    .orderBy(desc(downloads.addedAt), desc(downloads.id))) as DownloadRow[];

  const replaceable = rows.filter(isClientStageReplaceable);
  const pipelineDownloads = rows.filter(isPipelineBlocker);

  const pendingAutoJobs = await db
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(and(
      eq(importJobs.bookId, bookId),
      eq(importJobs.type, 'auto'),
      inArray(importJobs.status, ['pending', 'processing']),
    ))
    .limit(1);

  return { replaceable, pipelineDownloads, hasPendingAutoJob: pendingAutoJobs.length > 0 };
}

export function hasNonReplaceableBlocker(b: BookBlockers): boolean {
  return b.pipelineDownloads.length > 0 || b.hasPendingAutoJob;
}

/** Row id plus the exact state observed at gather time. */
export interface ClaimTarget {
  id: number;
  expected: { clientStatus: ClientStatus; pipelineStage: PipelineStage };
}

/**
 * Atomically claim every target with its observed tuple, then recheck blockers.
 * Any miss throws inside the transaction, rolling back before external side effects.
 */
export async function claimReplaceableTargets(db: Db, bookId: number, targets: ClaimTarget[], reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    for (const t of targets) {
      const landed = await transitionDownloadState(tx, t.id, {
        expected: t.expected,
        clientStatus: 'failed',
        pipelineStage: 'idle',
        errorMessage: reason,
      });
      if (!landed) throw new ClaimMissError();
    }
    const recheck = await gatherBookBlockers(tx, bookId);
    if (hasNonReplaceableBlocker(recheck)) throw new ClaimMissError();
  });
}

// Any pending-review blocker wins; otherwise report processing, independent of row order.
export function pipelineActiveReason(b: BookBlockers): PipelineActiveReason {
  const anyPendingReview = b.pipelineDownloads.some(
    (d) => deriveDisplayStatus(d.clientStatus, d.pipelineStage) === 'pending_review',
  );
  return anyPendingReview ? 'awaiting_review' : 'processing';
}

export type BlockerClassification =
  | { kind: 'clear' }
  | { kind: 'pipeline'; reason: PipelineActiveReason }
  | { kind: 'replaceable'; active: { title: string; count: number }; rows: DownloadRow[] };

// Pipeline blockers outrank replaceable rows in mixed sets.
export function classifyBlockers(b: BookBlockers): BlockerClassification {
  if (hasNonReplaceableBlocker(b)) {
    return { kind: 'pipeline', reason: pipelineActiveReason(b) };
  }
  if (b.replaceable.length > 0) {
    // Gather ordering makes [0] newest, with ID as the deterministic tie-break.
    return { kind: 'replaceable', active: { title: b.replaceable[0]!.title, count: b.replaceable.length }, rows: b.replaceable };
  }
  return { kind: 'clear' };
}
