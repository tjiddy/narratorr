import { z } from 'zod';

// ============================================================================
// Activity schemas
// ============================================================================

export const DOWNLOAD_STATUSES = [
  'queued',
  'downloading',
  'paused',
  'completed',
  'checking',
  'pending_review',
  'processing_queued',
  'importing',
  'imported',
  'failed',
] as const;

export const downloadStatusSchema = z.enum(DOWNLOAD_STATUSES);
export type DownloadStatus = z.infer<typeof downloadStatusSchema>;
