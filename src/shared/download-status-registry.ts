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

export function isInProgressStatus(status: string): status is DownloadStatus {
  const entry = DOWNLOAD_STATUS_REGISTRY[status as DownloadStatus];
  return entry?.category === 'inProgress';
}

export function isTerminalStatus(status: string): status is DownloadStatus {
  const entry = DOWNLOAD_STATUS_REGISTRY[status as DownloadStatus];
  return entry?.category === 'terminal';
}

export function getInProgressStatuses(): DownloadStatus[] {
  return downloadStatusSchema.options.filter(
    (s) => DOWNLOAD_STATUS_REGISTRY[s].category === 'inProgress',
  );
}

export function getTerminalStatuses(): DownloadStatus[] {
  return downloadStatusSchema.options.filter(
    (s) => DOWNLOAD_STATUS_REGISTRY[s].category === 'terminal',
  );
}

export function getCompletedStatuses(): DownloadStatus[] {
  return getTerminalStatuses().filter((s) => s !== 'failed');
}

// Internal pipeline states are never polled from download clients.
const CLIENT_POLLED_STATUSES: DownloadStatus[] = ['downloading', 'queued', 'paused'];

export function getClientPolledStatuses(): DownloadStatus[] {
  return CLIENT_POLLED_STATUSES;
}

// Active pipeline stages override client status to preserve the legacy display contract.
export function deriveDisplayStatus(clientStatus: ClientStatus, pipelineStage: PipelineStage): DownloadStatus {
  return pipelineStage === 'idle' ? clientStatus : pipelineStage;
}

export function isTerminalState(clientStatus: ClientStatus, pipelineStage: PipelineStage): boolean {
  return isTerminalStatus(deriveDisplayStatus(clientStatus, pipelineStage));
}
