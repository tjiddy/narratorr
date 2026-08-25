export class DownloadError extends Error {
  constructor(
    message: string,
    public code:
      | 'NOT_FOUND'
      | 'INVALID_STATUS'
      | 'NO_BOOK_LINKED'
      | 'IMPORTED_BOOK_NO_RETRY'
      | 'BOOK_NOT_FOUND',
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** One sentence for the refusal, so the route envelopes cannot word it differently (#2604 AC8). */
export const BOOK_NOT_FOUND_MESSAGE =
  'This book no longer exists — it may have been deleted or merged. Refresh and search again.';

/**
 * A grab whose `bookId` no longer resolves. Thrown above every side effect so the dead id never
 * reaches an insert — at HEAD it did, and the resulting FK failure published the bound params
 * (including the passkey-bearing download URL) to the client and the logs (#2604 AC1).
 */
export function bookNotFoundError(): DownloadError {
  return new DownloadError(BOOK_NOT_FOUND_MESSAGE, 'BOOK_NOT_FOUND');
}

/** The non-interactive paths treat this as a skip, not a grab error (#2604 AC10). */
export function isBookMissingRefusal(error: unknown): error is DownloadError {
  return error instanceof DownloadError && error.code === 'BOOK_NOT_FOUND';
}

export type PipelineActiveReason = 'processing' | 'awaiting_review';

/** Public conflict detail deliberately excludes download ids. */
export interface ActiveDownloadDetails {
  active: { title: string; count: number };
}

export interface PipelineActiveDetails {
  reason: PipelineActiveReason;
}

/** Required classified details let routes build 409 responses without re-querying. */
export type DuplicateDownloadDetails = ActiveDownloadDetails | PipelineActiveDetails;

/**
 * Throw inside the replace-claim transaction so a guard miss rolls back every target. The workflow
 * then reclassifies against fresh state before any external side effects.
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

  // Correlate each code with its required detail shape.
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
