import type { FastifyBaseLogger } from 'fastify';
import { serializeError } from '../utils/serialize-error.js';
import type { BulkOpType, BulkJobStatus } from './bulk-operation.service.js';

// `BulkJobFailure` is declared ONCE in `src/shared` (#2063) — the client carried a byte-identical
// copy until then. Re-exported here so `bulk-operation.service.ts`, `bulk-sidecar-reconcile.ts`
// and the suites keep importing it from this module.
import type { BulkJobFailure } from '@shared/bulk-operation-types.js';

export type { BulkJobFailure } from '@shared/bulk-operation-types.js';

/**
 * How many failure rows a job record retains. The FIRST N are kept (not the last): a full-library
 * run that goes systematically wrong produces its most diagnostic rows at the start, and a stable
 * head means the list does not churn while the operator is reading it. The `_failures` COUNT is
 * uncapped, so `failures >= failureDetails.length` always holds — that gap is what the
 * "…and N more" row is derived from.
 */
export const MAX_JOB_FAILURE_DETAILS = 50;

export type WorkFn = (
  setTotal: (n: number) => void,
  tick: (isFailure: boolean, detail?: BulkJobFailure) => void,
) => Promise<void>;

/**
 * A single in-flight bulk operation. Runs its `work` callback to completion,
 * tracking total/completed/failure counts that callers poll via `getStatus()`.
 * Extracted from `bulk-operation.service.ts` to keep that file under the line cap.
 */
export class BulkJob {
  private _completed = 0;
  private _failures = 0;
  private _failureDetails: BulkJobFailure[] = [];
  private _total = 0;
  private _status: 'running' | 'completed' = 'running';
  private startMs = Date.now();

  constructor(
    private id: string,
    private type: BulkOpType,
    private log: FastifyBaseLogger,
    private work: WorkFn,
    private onComplete: () => void,
  ) {}

  getStatus(): BulkJobStatus {
    return {
      jobId: this.id,
      type: this.type,
      status: this._status,
      completed: this._completed,
      total: this._total,
      failures: this._failures,
      // Copied, never aliased: a status object handed to a poll response must not keep growing
      // underneath the caller as later books fail. Always an array — `[]` when clean.
      failureDetails: [...this._failureDetails],
    };
  }

  start(): void {
    this.run().catch(err => {
      this.log.error({ error: serializeError(err), jobId: this.id }, 'Bulk job failed unexpectedly');
      this._status = 'completed';
      this.onComplete();
    });
  }

  private async run(): Promise<void> {
    try {
      await this.work(
        (n) => { this._total = n; },
        (isFailure, detail) => {
          this._completed++;
          // A detail on a success tick is ignored outright — the seam is shared by three ops and
          // "not a failure" must never be able to put a row on the operator's failure list.
          if (!isFailure) return;
          this._failures++;
          if (detail && this._failureDetails.length < MAX_JOB_FAILURE_DETAILS) {
            this._failureDetails.push(detail);
          }
        },
      );
    } finally {
      this._status = 'completed';
      this.log.info(
        { jobId: this.id, type: this.type, total: this._total, failures: this._failures, elapsedMs: Date.now() - this.startMs },
        'Bulk job completed',
      );
      this.onComplete();
    }
  }
}
