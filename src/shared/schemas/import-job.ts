import { z } from 'zod';

// ============================================================================
// Import job schemas
// ============================================================================

export const IMPORT_JOB_TYPES = ['manual', 'auto'] as const;
export const importJobTypeSchema = z.enum(IMPORT_JOB_TYPES);
export type ImportJobType = z.infer<typeof importJobTypeSchema>;

export const IMPORT_JOB_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export const importJobStatusSchema = z.enum(IMPORT_JOB_STATUSES);
export type ImportJobStatus = z.infer<typeof importJobStatusSchema>;

export const IMPORT_JOB_PHASES = [
  'queued',
  'analyzing',
  'renaming',
  'copying',
  'fetching_metadata',
  'done',
  'failed',
] as const;
export const importJobPhaseSchema = z.enum(IMPORT_JOB_PHASES);
export type ImportJobPhase = z.infer<typeof importJobPhaseSchema>;

export interface PhaseHistoryEntry {
  phase: ImportJobPhase;
  startedAt: number;
  completedAt?: number;
}
