import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../../db/index.js';
import type { ImportJobType, ImportJobPhase } from '../../../shared/schemas/import-job.js';
import { importConfirmItemSchema, importModeSchema } from '../../../shared/schemas/library-scan.js';
import type { BookMetadata } from '../../../core/metadata/index.js';
import type { ImportJobRow } from '../types.js';

/** Row shape returned by querying the import_jobs table. */
export type ImportJob = ImportJobRow;

/** Context passed to every adapter's process() method. */
export interface ImportAdapterContext {
  db: Db;
  log: FastifyBaseLogger;
  /** Update the job's phase column + phaseHistory + emit import_phase_change SSE. */
  setPhase(phase: ImportJobPhase): Promise<void>;
  /** Throttled progress emitter — calls safeEmit with import_progress at ≥250ms intervals. */
  emitProgress(phase: ImportJobPhase, progress: number, byteCounter?: { current: number; total: number }): void;
}

/** Contract every import adapter must implement. */
export interface ImportAdapter {
  readonly type: ImportJobType;
  process(job: ImportJob, ctx: ImportAdapterContext): Promise<void>;
}

/**
 * Persisted payload for manual import jobs.
 * Reuses `importConfirmItemSchema` for runtime shape and overrides the `metadata` field
 * with `z.custom<BookMetadata>().optional()` — a TYPE-only override (no extra runtime
 * validation, identical to z.unknown() at the safeParse boundary) so downstream callers
 * retain typed access to `metadata.narrators` etc. without `as` casts. Tightening
 * runtime validation of `metadata` is intentionally out of scope.
 */
export const manualImportJobPayloadSchema = importConfirmItemSchema.extend({
  metadata: z.custom<BookMetadata>().optional(),
  mode: importModeSchema.optional(),
});

/**
 * Persisted payload for auto import jobs.
 * Stores the download ID — the adapter hydrates the full context from the DB at processing time.
 */
export const autoImportJobPayloadSchema = z.object({
  downloadId: z.number(),
});

export type ManualImportJobPayload = z.infer<typeof manualImportJobPayloadSchema>;
export type AutoImportJobPayload = z.infer<typeof autoImportJobPayloadSchema>;
