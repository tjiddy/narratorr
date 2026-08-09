import { z } from 'zod';

export const DOWNLOAD_STATUSES = [
  'queued',
  'downloading',
  'paused',
  'completed',
  'checking',
  'pending_review',
  'importing',
  'imported',
  'failed',
] as const;

export const downloadStatusSchema = z.enum(DOWNLOAD_STATUSES);
export type DownloadStatus = z.infer<typeof downloadStatusSchema>;

// REST/SSE expose a derived DownloadStatus. Only the poller writes clientStatus;
// only the quality/import pipeline writes pipelineStage.
// Pipeline failures use { clientStatus: 'failed', pipelineStage: 'idle' }.

export const CLIENT_STATUSES = [
  'queued',
  'downloading',
  'paused',
  'completed',
  'failed',
] as const;

export const clientStatusSchema = z.enum(CLIENT_STATUSES);
export type ClientStatus = z.infer<typeof clientStatusSchema>;

export const PIPELINE_STAGES = [
  'idle',
  'checking',
  'pending_review',
  'importing',
  'imported',
] as const;

export const pipelineStageSchema = z.enum(PIPELINE_STAGES);
export type PipelineStage = z.infer<typeof pipelineStageSchema>;
