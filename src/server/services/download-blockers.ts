import { and, desc, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { downloads, importJobs } from '../../db/schema.js';
import { deriveDisplayStatus } from '../../shared/download-status-registry.js';
import {
  inProgressDownloadCondition,
  completedDisplayDownloadCondition,
} from '../utils/download-state.js';
import type { DownloadRow } from './types.js';

// ============================================================================
// Book-scoped grab blockers (#1857)
//
// One shared home for the two blocker predicates + the queries that back them,
// so the route shaping, the replace gather, and the in-transaction recheck all
// agree on exactly which rows are "safely replaceable" vs. "non-replaceable
// pipeline blocker". Keeping this in ONE place is load-bearing: divergence
// between the gather and the recheck would reopen the gather→claim race.
// ============================================================================

/** Reason discriminator carried on a `PIPELINE_ACTIVE` conflict (F60/F64). */
export type PipelineActiveReason = 'processing' | 'awaiting_review';

type BlockerFields = Pick<DownloadRow, 'clientStatus' | 'pipelineStage' | 'externalId'>;

/**
 * A download is **safely replaceable** ONLY when it is purely at the client
 * stage: `pipelineStage === 'idle' && clientStatus ∈ {queued, downloading,
 * paused}`. Anything that has entered the import pipeline is NOT replaceable
 * (see {@link isPipelineBlocker}). Narrower than the legacy `isReplaceableState`
 * (which also treats `checking`/`pending_review` as replaceable) — the narrowing
 * is what guarantees replace never cancels a row the quality gate owns.
 */
export function isClientStageReplaceable(d: Pick<DownloadRow, 'clientStatus' | 'pipelineStage'>): boolean {
  return d.pipelineStage === 'idle'
    && (d.clientStatus === 'queued' || d.clientStatus === 'downloading' || d.clientStatus === 'paused');
}

/**
 * A download that has entered (or the quality gate is about to pick up) the
 * import pipeline — a **non-replaceable** blocker. Enumerated by an exact
 * predicate (F59):
 *   - any non-idle pipeline stage (`checking`/`pending_review`/`importing`), OR
 *   - a *tracked* `completed`-display download with a non-null `externalId`
 *     (QG-eligible). This mirrors the quality gate's own batch query exactly
 *     (`quality-gate.service.ts:39` — `... AND isNotNull(downloads.externalId)`),
 *     so a row counts as a "will-be-imported" blocker iff the QG will actually
 *     pick it up.
 *
 * A **Blackhole handoff** `(completed, idle, externalId = null)` is deliberately
 * NOT a blocker: not QG-eligible, terminal, and the accepted post-settlement
 * re-grab must proceed.
 */
export function isPipelineBlocker(d: BlockerFields): boolean {
  if (d.pipelineStage === 'checking' || d.pipelineStage === 'pending_review' || d.pipelineStage === 'importing') {
    return true;
  }
  const display = deriveDisplayStatus(d.clientStatus, d.pipelineStage);
  return display === 'completed' && d.externalId !== null;
}

export interface BookBlockers {
  /** Client-stage replaceable rows, ordered `addedAt DESC, id DESC` (F10). */
  replaceable: DownloadRow[];
  /** Non-replaceable pipeline-stage download blockers. */
  pipelineDownloads: DownloadRow[];
  /** Whether a pending/processing **auto** import job exists for the book. */
  hasPendingAutoJob: boolean;
}

/** SQL selecting the rows relevant to blocker classification for one book:
 *  in-progress rows PLUS tracked (`externalId != null`) completed rows. A
 *  Blackhole handoff (completed, externalId null) is excluded by construction. */
function bookBlockerRowsCondition(bookId: number) {
  return and(
    eq(downloads.bookId, bookId),
    or(
      inProgressDownloadCondition(),
      and(completedDisplayDownloadCondition(), isNotNull(downloads.externalId)),
    ),
  );
}

/**
 * Gather every blocker for a book: the client-stage replaceable rows, the
 * non-replaceable pipeline-stage rows, and whether a pending/processing auto
 * import job exists. Runs against the supplied executor so the in-transaction
 * recheck (inside the claim tx) can re-run the exact same query.
 */
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

/** True when the book has any non-replaceable blocker (download or auto job). */
export function hasNonReplaceableBlocker(b: BookBlockers): boolean {
  return b.pipelineDownloads.length > 0 || b.hasPendingAutoJob;
}

/**
 * Deterministic `PIPELINE_ACTIVE` reason aggregate over the WHOLE blocker set
 * (F60/F64): `'awaiting_review'` iff ANY blocker download is `pending_review`
 * (a held state the user must approve/reject on Activity), else `'processing'`.
 * Order-independent — never first-row-dependent.
 */
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

/**
 * Classify a gathered blocker set, giving `PIPELINE_ACTIVE` precedence over
 * `ACTIVE_DOWNLOAD_EXISTS` (the mixed-blocker case — e.g. `queued + importing` —
 * must NOT report replaceable). `clear` means nothing blocks; proceed as an
 * ordinary grab.
 */
export function classifyBlockers(b: BookBlockers): BlockerClassification {
  if (hasNonReplaceableBlocker(b)) {
    return { kind: 'pipeline', reason: pipelineActiveReason(b) };
  }
  if (b.replaceable.length > 0) {
    // `replaceable` is already ordered addedAt DESC, id DESC → [0] is the
    // most-recent (deterministic tie-break on id, F10).
    return { kind: 'replaceable', active: { title: b.replaceable[0]!.title, count: b.replaceable.length }, rows: b.replaceable };
  }
  return { kind: 'clear' };
}
