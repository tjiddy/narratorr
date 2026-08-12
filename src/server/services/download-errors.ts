export class DownloadError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'INVALID_STATUS' | 'NO_BOOK_LINKED' | 'IMPORTED_BOOK_NO_RETRY',
  ) {
    super(message);
    this.name = 'DownloadError';
  }
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
