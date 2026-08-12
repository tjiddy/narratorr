import { and, eq, isNotNull, ne, or, type SQL } from 'drizzle-orm';
import { downloads } from '@db/schema.js';
import type { DbOrTx } from '@db/index.js';
import type { ClientStatus, DownloadStatus, PipelineStage } from '@shared/schemas/activity.js';
import {
  getInProgressStatuses,
  getTerminalStatuses,
  getCompletedStatuses,
  getClientPolledStatuses,
  deriveDisplayStatus,
} from '@shared/download-status-registry.js';

// Omitted axes never clobber concurrent writers; expected guards the captured tuple.
// Pollers own clientStatus, pipelines own pipelineStage; failed/idle is the sole cross-write.

export interface DownloadStateTransition {
  expected?: { clientStatus?: ClientStatus; pipelineStage?: PipelineStage };
  clientStatus?: ClientStatus;
  pipelineStage?: PipelineStage;
  errorMessage?: string | null;
  completedAt?: Date | null;
  progress?: number;
  progressUpdatedAt?: Date | null;
  outputPath?: string;
  pendingCleanup?: Date | null;
}

// Returns whether the guarded transition landed.
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

// Translate derived display states into predicates over the two stored axes.

const PIPELINE_DISPLAY_VALUES = new Set<DownloadStatus>(['checking', 'pending_review', 'importing', 'imported']);

export function displayStatusCondition(status: DownloadStatus): SQL {
  // A non-idle pipeline display value overrides clientStatus.
  if (PIPELINE_DISPLAY_VALUES.has(status)) {
    return eq(downloads.pipelineStage, status as PipelineStage);
  }
  // Client status is visible only while the pipeline is idle.
  return and(eq(downloads.pipelineStage, 'idle'), eq(downloads.clientStatus, status as ClientStatus))!;
}

export function displayStatusInCondition(statuses: DownloadStatus[]): SQL {
  return or(...statuses.map(displayStatusCondition))!;
}

export function inProgressDownloadCondition(): SQL {
  return displayStatusInCondition(getInProgressStatuses());
}

export function terminalDownloadCondition(): SQL {
  return displayStatusInCondition(getTerminalStatuses());
}

export function completedCountDownloadCondition(): SQL {
  return displayStatusInCondition(getCompletedStatuses());
}

export function completedDisplayDownloadCondition(): SQL {
  return displayStatusCondition('completed');
}

/**
 * QG queries, replace blockers, and import eligibility share this rule: completed display
 * plus a non-empty externalId. Null and empty ids are handoffs and must not block. Keep the
 * SQL and in-memory forms together so their consistency test can prevent drift.
 */
export function qualityGateEligibleDownloadCondition(): SQL {
  return and(completedDisplayDownloadCondition(), isNotNull(downloads.externalId), ne(downloads.externalId, ''))!;
}

export function isQualityGateEligibleRow(row: { clientStatus: ClientStatus; pipelineStage: PipelineStage; externalId: string | null }): boolean {
  return deriveDisplayStatus(row.clientStatus, row.pipelineStage) === 'completed' && !!row.externalId;
}

export function clientPolledDownloadCondition(): SQL {
  return displayStatusInCondition(getClientPolledStatuses());
}
