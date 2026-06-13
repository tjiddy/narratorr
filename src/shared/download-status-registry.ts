import { downloadStatusSchema, type DownloadStatus, type ClientStatus, type PipelineStage } from './schemas.js';

export type DownloadStatusCategory = 'inProgress' | 'terminal';

export interface DownloadStatusMetadata {
  category: DownloadStatusCategory;
  label: string;
  icon: string;
  color: string;
  bgColor: string;
  textColor: string;
}

export const DOWNLOAD_STATUS_REGISTRY: Record<DownloadStatus, DownloadStatusMetadata> = {
  queued: {
    category: 'inProgress',
    label: 'Queued',
    icon: 'clock',
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10',
    textColor: 'text-amber-600 dark:text-amber-400',
  },
  downloading: {
    category: 'inProgress',
    label: 'Downloading',
    icon: 'arrow-down',
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    textColor: 'text-blue-600 dark:text-blue-400',
  },
  paused: {
    category: 'inProgress',
    label: 'Paused',
    icon: 'pause',
    color: 'text-muted-foreground',
    bgColor: 'bg-muted',
    textColor: 'text-muted-foreground',
  },
  completed: {
    category: 'terminal',
    label: 'Downloaded',
    icon: 'arrow-down',
    color: 'text-teal-500',
    bgColor: 'bg-teal-500/10',
    textColor: 'text-teal-600 dark:text-teal-400',
  },
  checking: {
    category: 'inProgress',
    label: 'Checking Quality',
    icon: 'shield',
    color: 'text-cyan-500',
    bgColor: 'bg-cyan-500/10',
    textColor: 'text-cyan-600 dark:text-cyan-400',
  },
  pending_review: {
    category: 'inProgress',
    label: 'Pending Review',
    icon: 'alert-triangle',
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10',
    textColor: 'text-amber-600 dark:text-amber-400',
  },
  importing: {
    category: 'inProgress',
    label: 'Importing',
    icon: 'package',
    color: 'text-violet-500',
    bgColor: 'bg-violet-500/10',
    textColor: 'text-violet-600 dark:text-violet-400',
  },
  imported: {
    category: 'terminal',
    label: 'Imported',
    icon: 'check-circle',
    color: 'text-success',
    bgColor: 'bg-success/10',
    textColor: 'text-success',
  },
  failed: {
    category: 'terminal',
    label: 'Failed',
    icon: 'alert-circle',
    color: 'text-destructive',
    bgColor: 'bg-destructive/10',
    textColor: 'text-destructive',
  },
};

/** Check if a status represents an in-progress (non-terminal) download. */
export function isInProgressStatus(status: string): status is DownloadStatus {
  const entry = DOWNLOAD_STATUS_REGISTRY[status as DownloadStatus];
  return entry?.category === 'inProgress';
}

/** Check if a status represents a terminal (finished) download. */
export function isTerminalStatus(status: string): status is DownloadStatus {
  const entry = DOWNLOAD_STATUS_REGISTRY[status as DownloadStatus];
  return entry?.category === 'terminal';
}

/** Get all in-progress status values (for database queries). */
export function getInProgressStatuses(): DownloadStatus[] {
  return downloadStatusSchema.options.filter(
    (s) => DOWNLOAD_STATUS_REGISTRY[s].category === 'inProgress',
  );
}

/** Get all terminal status values (for database queries). */
export function getTerminalStatuses(): DownloadStatus[] {
  return downloadStatusSchema.options.filter(
    (s) => DOWNLOAD_STATUS_REGISTRY[s].category === 'terminal',
  );
}

/** Get terminal statuses excluding `failed` — the "completed" set for count queries. */
export function getCompletedStatuses(): DownloadStatus[] {
  return getTerminalStatuses().filter((s) => s !== 'failed');
}

/**
 * Statuses that can be replaced by a new grab.
 * Excludes the import-pipeline status (importing) which requires a separate
 * cancellation mechanism beyond the download-client cancel path.
 */
const REPLACEABLE_STATUSES: DownloadStatus[] = ['queued', 'downloading', 'paused', 'checking', 'pending_review'];

export function getReplaceableStatuses(): DownloadStatus[] {
  return REPLACEABLE_STATUSES;
}

/**
 * Statuses that should be polled from external download clients.
 * Excludes internal pipeline statuses (checking, pending_review, importing)
 * that are managed by quality-gate/import flows, not download client APIs.
 */
const CLIENT_POLLED_STATUSES: DownloadStatus[] = ['downloading', 'queued', 'paused'];

export function getClientPolledStatuses(): DownloadStatus[] {
  return CLIENT_POLLED_STATUSES;
}

// ============================================================================
// Two-axis derivation (#1445)
//
// `deriveDisplayStatus` is the compatibility seam: it collapses the
// `(clientStatus, pipelineStage)` tuple back into the legacy 9-value display
// enum, preserving the REST/SSE/client contract. `displayStatusToTuple` is its
// exact inverse (and the backfill mapping) — the pair round-trips for every
// legacy `DownloadStatus`.
// ============================================================================

/**
 * Derive the legacy display status from the two-axis tuple.
 * When the pipeline is active (`pipelineStage !== 'idle'`) the pipeline stage
 * wins; otherwise the client status is the display status. Note `imported` is a
 * pipeline stage, so an imported download displays `imported` regardless of its
 * (always `completed`) client status — and the canonical failure tuple
 * `(failed, idle)` resolves to display `failed`.
 */
export function deriveDisplayStatus(clientStatus: ClientStatus, pipelineStage: PipelineStage): DownloadStatus {
  return pipelineStage === 'idle' ? clientStatus : pipelineStage;
}

/**
 * Inverse of `deriveDisplayStatus` — maps a legacy display status to its
 * canonical `(clientStatus, pipelineStage)` tuple. This IS the backfill mapping:
 * the pipeline display values resolve to `clientStatus='completed'` (the client
 * download had finished) with the corresponding stage; the client-only display
 * values resolve to `pipelineStage='idle'`.
 */
export function displayStatusToTuple(status: DownloadStatus): { clientStatus: ClientStatus; pipelineStage: PipelineStage } {
  switch (status) {
    case 'queued':
    case 'downloading':
    case 'paused':
    case 'completed':
    case 'failed':
      return { clientStatus: status, pipelineStage: 'idle' };
    case 'checking':
    case 'pending_review':
    case 'importing':
    case 'imported':
      return { clientStatus: 'completed', pipelineStage: status };
  }
}

/** Tuple predicate: does the download display as in-progress (non-terminal)? */
export function isInProgressState(clientStatus: ClientStatus, pipelineStage: PipelineStage): boolean {
  return isInProgressStatus(deriveDisplayStatus(clientStatus, pipelineStage));
}

/** Tuple predicate: does the download display as terminal (finished)? */
export function isTerminalState(clientStatus: ClientStatus, pipelineStage: PipelineStage): boolean {
  return isTerminalStatus(deriveDisplayStatus(clientStatus, pipelineStage));
}

/**
 * Tuple predicate: can this download be replaced by a new grab?
 * Mirrors `getReplaceableStatuses()` over the tuple — preserves the load-bearing
 * invariant that an `importing` download (`pipelineStage === 'importing'`) is
 * NOT replaceable.
 */
export function isReplaceableState(clientStatus: ClientStatus, pipelineStage: PipelineStage): boolean {
  return REPLACEABLE_STATUSES.includes(deriveDisplayStatus(clientStatus, pipelineStage));
}

/** Tuple predicate: should this download be polled from its external client? */
export function isClientPolledState(clientStatus: ClientStatus, pipelineStage: PipelineStage): boolean {
  return CLIENT_POLLED_STATUSES.includes(deriveDisplayStatus(clientStatus, pipelineStage));
}
