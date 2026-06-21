export class DownloadError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'INVALID_STATUS' | 'NO_BOOK_LINKED' | 'IMPORTED_BOOK_NO_RETRY',
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export class DuplicateDownloadError extends Error {
  constructor(
    message: string,
    public code: 'ACTIVE_DOWNLOAD_EXISTS' | 'PIPELINE_ACTIVE',
  ) {
    super(message);
    this.name = 'DuplicateDownloadError';
  }
}
