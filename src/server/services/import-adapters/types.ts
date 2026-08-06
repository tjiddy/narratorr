import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { ImportJobType, ImportJobPhase } from '@shared/schemas/import-job.js';
import { importConfirmItemSchema, importModeSchema } from '@shared/schemas/library-scan.js';
import type { BookMetadata } from '@core/metadata/index.js';
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
 * Where a staged item's narrators came from, as of the moment the submission runner processed it
 * (#2158 D8). Deliberately a statement about the DATA, not about the author: the wire cannot express
 * intent (`buildEditedFromBestMatch` copies the provider's narrators into `edited.narrators` while
 * `metadata` carries the same array, so an auto-matched row and an explicitly edited row are
 * structurally identical), so the runner answers the one factual question it can — does the row still
 * carry the provider's own proposal?
 *
 * - `curated` — the OPF sidecar yielded narrators, OR the item's narrators differ from the matched
 *   metadata's. The tag fill is suppressed.
 * - `provider` — the item's narrators are non-empty and equal the matched metadata's. The tag fill
 *   fires (an untouched provider proposal is not a curation worth protecting from the files).
 * - `none` — the item carries no narrators. The tag fill fires, as it always has.
 */
export const narratorSourceSchema = z.enum(['curated', 'provider', 'none']);
export type NarratorSource = z.infer<typeof narratorSourceSchema>;

/**
 * Persisted payload for manual import jobs.
 * Reuses `importConfirmItemSchema` for runtime shape and overrides the `metadata` field
 * with `z.custom<BookMetadata>().optional()` — a TYPE-only override (no extra runtime
 * validation, identical to z.unknown() at the safeParse boundary) so downstream callers
 * retain typed access to `metadata.narrators` etc. without `as` casts. Tightening
 * runtime validation of `metadata` is intentionally out of scope.
 *
 * `narratorSource` is a RUNNER-COMPUTED field and is declared here ONLY, exactly as `mode` already
 * is — Zod's default strip means a key the runner invents but never declares is silently dropped
 * when the adapter re-parses the persisted payload. It is deliberately absent from
 * `importConfirmItemSchema`/`stagedImportItemSchema`, so the client wire contract, the strict staged
 * bounds, and the finalize payload digest are all unaffected.
 */
export const manualImportJobPayloadSchema = importConfirmItemSchema.extend({
  metadata: z.custom<BookMetadata>().optional(),
  mode: importModeSchema.optional(),
  narratorSource: narratorSourceSchema.optional(),
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
