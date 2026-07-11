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
