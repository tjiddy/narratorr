export type BulkOpType = 'rename' | 'retag' | 'write_metadata_sidecars';

// error is URL-redacted, length-bounded operator text; full details remain in logs.
export interface BulkJobFailure {
  bookId: number;
  title: string;
  error: string;
}

export interface BulkJobStatus {
  jobId: string;
  type: BulkOpType;
  status: 'running' | 'completed';
  completed: number;
  total: number;
  // Uncapped; clients derive “and N more” from failures - failureDetails.length.
  failures: number;
  // First MAX_JOB_FAILURE_DETAILS items; always [] when clean.
  failureDetails: BulkJobFailure[];
}
