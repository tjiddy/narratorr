/**
 * Exact, pinned user-facing copy for the staged-import lifecycle (#1902). Centralized
 * so the hooks and their tests reference ONE source — the spec pins these strings and
 * the test plan asserts them verbatim, so drift here is a behavior change.
 */
export const STAGED_COPY = {
  /** Create exhaustion / lost response, and by-client lookup exhaustion — recoverable on reload. */
  createUnreachable: 'Couldn’t reach the server — reload to retry',
  /** Create digest-conflict (409): a durable header with this id and a DIFFERENT digest exists. */
  digestConflict: 'An unexpected earlier submission with this id exists — reopen to check status, or retry to start fresh',
  /** Processing-poll transport exhaustion — the run continues server-side. */
  pollLostContact: 'Import continues on the server — lost contact; reopen to check status',
  /** Terminal-detail fetch exhaustion — the import is DONE, only its results failed to load. */
  detailLoadFailed: 'Import finished, but its results couldn’t be loaded — reopen to try again',
  /** Finalize 422 item-invalid — a persisted-row invariant/corruption failure. */
  finalizeInvariant: 'Import couldn’t be finalized — please re-run',
  /** Finalized (processing/complete) 404 — invariant/data-loss, surfaced once then the hint evicts. */
  finalizedMissing: 'Import records are missing — the server may have lost this run',
} as const;

export type StagedBannerKey = keyof typeof STAGED_COPY;
