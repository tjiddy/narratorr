import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../../db/index.js';
import type { ImportJobType, ImportJobPhase } from '../../../shared/schemas/import-job.js';
import type { ImportConfirmItem, ImportMode } from '../library-scan.service.js';
import type { importJobs } from '../../../db/schema.js';

/** Row shape returned by querying the import_jobs table. */
export type ImportJob = typeof importJobs.$inferSelect;

/** Context passed to every adapter's process() method. */
export interface ImportAdapterContext {
  db: Db;
  log: FastifyBaseLogger;
  /** Update the job's phase column (adapter calls this as it progresses). */
  setPhase(phase: ImportJobPhase): Promise<void>;
}

/** Contract every import adapter must implement. */
export interface ImportAdapter {
  readonly type: ImportJobType;
  process(job: ImportJob, ctx: ImportAdapterContext): Promise<void>;
}

/**
 * Persisted payload for manual import jobs.
 * Superset of ImportConfirmItem — adds the optional mode so the worker
 * can replay the import with the correct filesystem behavior.
 * When mode is omitted from the JSON, the adapter treats it as pointer mode.
 */
export interface ManualImportJobPayload extends ImportConfirmItem {
  mode?: ImportMode;
}

/**
 * Persisted payload for auto import jobs.
 * Stores the download ID — the adapter hydrates the full context from the DB at processing time.
 */
export interface AutoImportJobPayload {
  downloadId: number;
}
