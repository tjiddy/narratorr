export class DownloadError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'INVALID_STATUS' | 'NO_BOOK_LINKED' | 'IMPORTED_BOOK_NO_RETRY',
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** Reason discriminator on a `PIPELINE_ACTIVE` conflict (#1857 F60/F64). The
 *  single server-side home — `download-blockers.ts` imports this (#1861). */
export type PipelineActiveReason = 'processing' | 'awaiting_review';

/** `ACTIVE_DOWNLOAD_EXISTS` details — most-recent replaceable download's `title`
 *  + total `count` (no ids, informational only). */
export interface ActiveDownloadDetails {
  active: { title: string; count: number };
}

/** `PIPELINE_ACTIVE` details — deterministic reason aggregate over the whole
 *  blocker set. */
export interface PipelineActiveDetails {
  reason: PipelineActiveReason;
}

/**
 * Structured conflict details the grab routes shape into their 409 bodies
 * WITHOUT re-querying (#1857/#1861). Now REQUIRED and code-discriminated — every
 * production throw supplies the shape matching its `code`, so a route can read
 * `details` without a fallback:
 *   - `ACTIVE_DOWNLOAD_EXISTS ⇒ { active }`
 *   - `PIPELINE_ACTIVE ⇒ { reason }`
 */
export type DuplicateDownloadDetails = ActiveDownloadDetails | PipelineActiveDetails;

/**
 * Typed sentinel thrown INSIDE the replace claim transaction (#1857) when a
 * guarded claim guard-misses or the in-transaction blocker recheck trips. Throwing
 * (rather than returning `false`) rolls the whole claim set back, so every
 * target's original tuple is preserved and zero external/adapter/blacklist/event/
 * book-status side effects have run. The replace workflow catches it and
 * re-classifies against the fresh state (F17, F20).
 */
export class ClaimMissError extends Error {
  constructor(message = 'Replace claim guard missed') {
    super(message);
    this.name = 'ClaimMissError';
  }
}

export class DuplicateDownloadError extends Error {
  public code: 'ACTIVE_DOWNLOAD_EXISTS' | 'PIPELINE_ACTIVE';
  public details: DuplicateDownloadDetails;

  // Overloads correlate `code` with `details` at construction: an
  // `ACTIVE_DOWNLOAD_EXISTS` MUST carry `{ active }`, a `PIPELINE_ACTIVE` MUST
  // carry `{ reason }`. `details` is required — routes read it without a fallback.
  constructor(message: string, code: 'ACTIVE_DOWNLOAD_EXISTS', details: ActiveDownloadDetails);
  constructor(message: string, code: 'PIPELINE_ACTIVE', details: PipelineActiveDetails);
  constructor(
    message: string,
    code: 'ACTIVE_DOWNLOAD_EXISTS' | 'PIPELINE_ACTIVE',
    details: DuplicateDownloadDetails,
  ) {
    super(message);
    this.name = 'DuplicateDownloadError';
    this.code = code;
    this.details = details;
  }
}
