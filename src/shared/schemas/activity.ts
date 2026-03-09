import { z } from 'zod';

// ============================================================================
// Activity schemas
// ============================================================================

export const downloadStatusSchema = z.enum([
  'queued',
  'downloading',
  'paused',
  'completed',
  'checking',
  'pending_review',
  'importing',
  'imported',
  'failed',
]);

export type DownloadStatus = z.infer<typeof downloadStatusSchema>;
