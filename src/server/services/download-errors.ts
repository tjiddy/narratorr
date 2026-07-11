export class DownloadError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'INVALID_STATUS' | 'NO_BOOK_LINKED' | 'IMPORTED_BOOK_NO_RETRY',
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** Reason discriminator on a `PIPELINE_ACTIVE` conflict (#1857 F60/F64). */
export type PipelineActiveReason = 'processing' | 'awaiting_review';

/**
 * Structured conflict details the internal `POST /api/search/grab` route shapes
 * into its 409 bodies WITHOUT re-querying (#1857). Only populated by the
 * `gatherAllBlockers` classification mode; the `legacy` mode (v1 + auto callers)
 * leaves it undefined, so those paths' error bytes stay byte-identical.
 *   - `active` — most-recent replaceable download's `title` + total `count`
 *     (ACTIVE_DOWNLOAD_EXISTS). No ids — informational only.
 *   - `reason` — deterministic aggregate over the whole blocker set
 *     (PIPELINE_ACTIVE).
 */
export interface DuplicateDownloadDetails {
  active?: { title: string; count: number };
  reason?: PipelineActiveReason;
}

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
  constructor(
    message: string,
    public code: 'ACTIVE_DOWNLOAD_EXISTS' | 'PIPELINE_ACTIVE',
    public details?: DuplicateDownloadDetails,
  ) {
    super(message);
    this.name = 'DuplicateDownloadError';
  }
}
