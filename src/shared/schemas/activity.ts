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
  'importing',
  'imported',
  'failed',
] as const;

export const downloadStatusSchema = z.enum(DOWNLOAD_STATUSES);
export type DownloadStatus = z.infer<typeof downloadStatusSchema>;

// ============================================================================
// Two-axis download state (#1445)
//
// The legacy single `DownloadStatus` enum conflated pure download-client truth
// with narratorr's internal processing overlay. It is split into two clean axes:
//
//  - `clientStatus`  — what the download client reports (queued → downloading →
//                      completed/paused/failed). Written ONLY by the client poller.
//  - `pipelineStage` — narratorr's processing overlay on a completed download
//                      (idle → checking → pending_review → importing → imported).
//                      Written ONLY by the quality-gate / import pipeline.
//
// `DownloadStatus` is RETAINED as the derived display status (see
// `deriveDisplayStatus` in download-status-registry.ts): the REST/SSE/client
// contract continues to speak the 9-value display enum, computed from the tuple.
//
// NOTE there is deliberately NO `pipelineStage='failed'` — pipeline failure is
// expressed on the `clientStatus` axis as the canonical failure tuple
// (`clientStatus='failed'`, `pipelineStage='idle'`).
// ============================================================================

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
