import { and, eq, or, type SQL } from 'drizzle-orm';
import { downloads } from '../../db/schema.js';
import type { DbOrTx } from '../../db/index.js';
import type { ClientStatus, DownloadStatus, PipelineStage } from '../../shared/schemas/activity.js';
import {
  getInProgressStatuses,
  getTerminalStatuses,
  getCompletedStatuses,
  getClientPolledStatuses,
} from '../../shared/download-status-registry.js';

// ============================================================================
// Two-axis download state transitions (#1445)
//
// `transitionDownloadState` is the SOLE writer of either status column. It
// guarantees the invariants the split depends on:
//   * An omitted axis is NEVER included in the SQL SET clause — so a writer that
//     touches only one axis can never clobber a concurrent writer's axis.
//   * The optional `expected` guard compiles to a WHERE predicate, so a
//     transition only lands when the row is in the expected state (preserves the
//     conditional `completed → checking` claim semantics).
//   * A legitimately combined transition (the sanctioned failure tuple) sets
//     both axes in ONE guarded UPDATE — never two writes.
//
// Ownership: the client poller passes ONLY `clientStatus`; the quality-gate /
// import pipeline passes ONLY `pipelineStage`, except the single sanctioned
// failure cross-write `{ clientStatus: 'failed', pipelineStage: 'idle' }`.
// ============================================================================

export interface DownloadStateTransition {
  /** Optional precondition — the UPDATE only lands when these axes match the current row. */
  expected?: { clientStatus?: ClientStatus; pipelineStage?: PipelineStage };
  clientStatus?: ClientStatus;
  pipelineStage?: PipelineStage;
  // Side fields written atomically with the transition (all optional, all
  // omitted-when-undefined so they never clobber).
  errorMessage?: string | null;
  completedAt?: Date | null;
  progress?: number;
  progressUpdatedAt?: Date | null;
  outputPath?: string;
  pendingCleanup?: Date | null;
}

/**
 * Atomically transition a download's state. Returns `true` if a row was updated
 * (i.e. the `expected` guard, if any, matched), `false` otherwise.
 */
export async function transitionDownloadState(
  db: DbOrTx,
  id: number,
  t: DownloadStateTransition,
): Promise<boolean> {
  const set: Record<string, unknown> = {};
  if (t.clientStatus !== undefined) set.clientStatus = t.clientStatus;
  if (t.pipelineStage !== undefined) set.pipelineStage = t.pipelineStage;
  if (t.errorMessage !== undefined) set.errorMessage = t.errorMessage;
  if (t.completedAt !== undefined) set.completedAt = t.completedAt;
  if (t.progress !== undefined) set.progress = t.progress;
  if (t.progressUpdatedAt !== undefined) set.progressUpdatedAt = t.progressUpdatedAt;
  if (t.outputPath !== undefined) set.outputPath = t.outputPath;
  if (t.pendingCleanup !== undefined) set.pendingCleanup = t.pendingCleanup;

  const conds: SQL[] = [eq(downloads.id, id)];
  if (t.expected?.clientStatus !== undefined) conds.push(eq(downloads.clientStatus, t.expected.clientStatus));
  if (t.expected?.pipelineStage !== undefined) conds.push(eq(downloads.pipelineStage, t.expected.pipelineStage));

  const result = await db
    .update(downloads)
    .set(set)
    .where(and(...conds))
    .returning({ id: downloads.id });

  return result.length > 0;
}

// ============================================================================
// Display-status query conditions
//
// The category/predicate helpers in the shared registry speak the legacy
// display enum. These builders translate a display-status set into a WHERE
// predicate over the two axis columns — the SQL equivalent of running each row
// through `deriveDisplayStatus` and matching. They are the read-side counterpart
// to `transitionDownloadState`.
// ============================================================================

const PIPELINE_DISPLAY_VALUES = new Set<DownloadStatus>(['checking', 'pending_review', 'importing', 'imported']);

/** WHERE predicate selecting rows whose derived display status equals `status`. */
export function displayStatusCondition(status: DownloadStatus): SQL {
  // A pipeline display value (checking/pending_review/importing/imported) is
  // shown iff the pipeline stage matches — regardless of clientStatus.
  if (PIPELINE_DISPLAY_VALUES.has(status)) {
    return eq(downloads.pipelineStage, status as PipelineStage);
  }
  // A client-only display value (queued/downloading/paused/completed/failed) is
  // shown only when the pipeline is idle.
  return and(eq(downloads.pipelineStage, 'idle'), eq(downloads.clientStatus, status as ClientStatus))!;
}

/** WHERE predicate selecting rows whose derived display status is in `statuses`. */
export function displayStatusInCondition(statuses: DownloadStatus[]): SQL {
  return or(...statuses.map(displayStatusCondition))!;
}

/** Rows that display as in-progress (queue section, active polling, etc.). */
export function inProgressDownloadCondition(): SQL {
  return displayStatusInCondition(getInProgressStatuses());
}

/** Rows that display as terminal (history section). */
export function terminalDownloadCondition(): SQL {
  return displayStatusInCondition(getTerminalStatuses());
}

/** Terminal rows excluding `failed` — the "completed" set for count queries. */
export function completedCountDownloadCondition(): SQL {
  return displayStatusInCondition(getCompletedStatuses());
}

/** Rows that display as `completed` — the canonical pipeline entry point `(completed, idle)`. */
export function completedDisplayDownloadCondition(): SQL {
  return displayStatusCondition('completed');
}

/** Rows that should be polled from their external download client. */
export function clientPolledDownloadCondition(): SQL {
  return displayStatusInCondition(getClientPolledStatuses());
}
