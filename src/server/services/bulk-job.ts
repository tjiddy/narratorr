import type { FastifyBaseLogger } from 'fastify';
import { serializeError } from '../utils/serialize-error.js';
import type { BulkOpType, BulkJobStatus } from './bulk-operation.service.js';

export type WorkFn = (setTotal: (n: number) => void, tick: (isFailure: boolean) => void) => Promise<void>;

/**
 * A single in-flight bulk operation. Runs its `work` callback to completion,
 * tracking total/completed/failure counts that callers poll via `getStatus()`.
 * Extracted from `bulk-operation.service.ts` to keep that file under the line cap.
 */
export class BulkJob {
  private _completed = 0;
  private _failures = 0;
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
        (isFailure) => {
          this._completed++;
          if (isFailure) this._failures++;
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
