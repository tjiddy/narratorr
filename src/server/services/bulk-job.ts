import type { FastifyBaseLogger } from 'fastify';
import { serializeError } from '../utils/serialize-error.js';
import type { BulkOpType, BulkJobStatus } from './bulk-operation.service.js';

import type { BulkJobFailure } from '@shared/bulk-operation-types.js';

export type { BulkJobFailure } from '@shared/bulk-operation-types.js';

/**
 * Retain the first failures so the list stays stable while polled. The uncapped total drives the
 * omitted-count summary.
 */
export const MAX_JOB_FAILURE_DETAILS = 50;

export type WorkFn = (
  setTotal: (n: number) => void,
  tick: (isFailure: boolean, detail?: BulkJobFailure) => void,
) => Promise<void>;

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
      // Copy, never alias, so earlier poll responses cannot grow with later failures.
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
          // A successful tick can never add failure details.
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
