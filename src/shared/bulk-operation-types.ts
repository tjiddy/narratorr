/**
 * The bulk-operation wire contract — THE single declaration of the three types the client and
 * server both speak (#2063). Previously each side declared its own byte-identical copy:
 * `BulkOpType` and `BulkJobStatus` in `src/server/services/bulk-operation.service.ts`,
 * `BulkJobFailure` in `src/server/services/bulk-job.ts`, and all three again in
 * `src/client/lib/api/bulk-operations.ts` — which meant #2159's failure-detail addition had to be
 * written twice and kept in step by hand.
 *
 * Lives in `src/shared` (flat, alongside `hardcover-list-types.ts` and `registry-types.ts`) rather
 * than `src/shared/schemas/` because these are plain structural types with no Zod validator: the
 * three bulk endpoints are separate routes, so `type` is a RESPONSE field and never arrives as
 * untrusted request input. Both boundary files re-export from here, so every existing consumer
 * import — `@/lib/api` on the client, the two service modules on the server — keeps working.
 */

/** Which bulk operation a job is running. One value per `POST /api/books/bulk/*` route. */
export type BulkOpType = 'rename' | 'retag' | 'write_metadata_sidecars';

/**
 * One named per-book failure on a bulk job's record (#2159). `error` is always the output of
 * `toShortErrorText` — a short, URL-redacted, length-bounded line, NOT a serialized stack. The
 * full serialized error still goes to the log line at the failure site; this is the operator-facing
 * half, so "1 failure" can read "Captain's Fury (book 226): ENOENT…" instead.
 */
export interface BulkJobFailure {
  bookId: number;
  title: string;
  error: string;
}

/** A bulk job's polled record. Served by `GET /api/books/bulk/:jobId` and `/bulk/active`. */
export interface BulkJobStatus {
  jobId: string;
  type: BulkOpType;
  status: 'running' | 'completed';
  completed: number;
  total: number;
  /**
   * Uncapped failure count. Always `>= failureDetails.length` (see `MAX_JOB_FAILURE_DETAILS` in
   * `src/server/services/bulk-job.ts`) — that gap is what the "…and N more" row is derived from.
   */
  failures: number;
  /**
   * Named failures, capped server-side at the first `MAX_JOB_FAILURE_DETAILS`. Always an array —
   * `[]` when the job is clean — so no client needs an optional-chaining fallback (#2159).
   */
  failureDetails: BulkJobFailure[];
}
