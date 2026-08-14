export interface RenameErrorDetails {
  conflictingBook: { id: number; title: string };
}

/**
 * Lives in utils/ rather than beside the service because the ownership fence and the occupancy
 * classifier are utils and must throw it. Re-exported from `rename.service.ts`, which stays the
 * import site for every existing caller.
 *
 * Every code here must also appear in the `RenameError` entry of `plugins/error-handler.ts`: an
 * unregistered code falls through the coded registry and becomes a generic 500.
 */
export class RenameError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'NO_PATH' | 'CONFLICT' | 'TARGET_OCCUPIED' | 'STALE_PATH',
    public details?: RenameErrorDetails,
  ) {
    super(message);
    this.name = 'RenameError';
  }
}
