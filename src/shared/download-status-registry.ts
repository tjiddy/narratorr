import { downloadStatusSchema, type DownloadStatus } from './schemas.js';

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
  processing_queued: {
    category: 'inProgress',
    label: 'Processing Queued',
    icon: 'clock',
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
 * Excludes import-pipeline statuses (processing_queued, importing) which require
 * a separate cancellation mechanism beyond the download-client cancel path.
 */
const REPLACEABLE_STATUSES: DownloadStatus[] = ['queued', 'downloading', 'paused', 'checking', 'pending_review'];

export function getReplaceableStatuses(): DownloadStatus[] {
  return REPLACEABLE_STATUSES;
}

/**
 * Statuses that should be polled from external download clients.
 * Excludes internal pipeline statuses (checking, pending_review, processing_queued, importing)
 * that are managed by quality-gate/import flows, not download client APIs.
 */
const CLIENT_POLLED_STATUSES: DownloadStatus[] = ['downloading', 'queued', 'paused'];

export function getClientPolledStatuses(): DownloadStatus[] {
  return CLIENT_POLLED_STATUSES;
}
