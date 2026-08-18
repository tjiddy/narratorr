import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { ImportJobType, ImportJobPhase } from '@shared/schemas/import-job.js';
import { importConfirmItemSchema, importModeSchema } from '@shared/schemas/library-scan.js';
import type { BookMetadata } from '@core/metadata/index.js';
import type { ImportJobRow } from '../types.js';

export type ImportJob = ImportJobRow;

export interface ImportAdapterContext {
  db: Db;
  log: FastifyBaseLogger;
  /** Update the job's phase column + phaseHistory + emit import_phase_change SSE. */
  setPhase(phase: ImportJobPhase): Promise<void>;
  /** Throttled progress emitter — calls safeEmit with import_progress at ≥250ms intervals. */
  emitProgress(phase: ImportJobPhase, progress: number, byteCounter?: { current: number; total: number }): void;
}

export interface ImportAdapter {
  readonly type: ImportJobType;
  process(job: ImportJob, ctx: ImportAdapterContext): Promise<void>;
}

/**
 * Data provenance, not user intent: curated narrators suppress tag fill; unchanged provider or absent
 * narrators permit it.
 */
export const narratorSourceSchema = z.enum(['curated', 'provider', 'none']);
export type NarratorSource = z.infer<typeof narratorSourceSchema>;

/**
 * `metadata` gains TypeScript shape without tighter runtime validation. Declare runner-computed
 * `narratorSource` here so adapter re-parse does not strip it, while public wire schemas and digests
 * remain unchanged.
 */
export const manualImportJobPayloadSchema = importConfirmItemSchema.extend({
  metadata: z.custom<BookMetadata>().optional(),
  mode: importModeSchema.optional(),
  narratorSource: narratorSourceSchema.optional(),
  // #2435: the job targets an EXISTING book. Carried explicitly rather than inferred from the
  // book's status, which races with any other writer between enqueue and processing.
  attach: z.literal(true).optional(),
});

export const autoImportJobPayloadSchema = z.object({
  downloadId: z.number(),
});

export type ManualImportJobPayload = z.infer<typeof manualImportJobPayloadSchema>;
export type AutoImportJobPayload = z.infer<typeof autoImportJobPayloadSchema>;
