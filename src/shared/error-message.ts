/**
 * Extract a human-readable message from an unknown error value.
 * Returns error.message for Error instances, String(value) for everything else.
 * Returns 'Unknown error' when String(value) produces an empty string.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const str = String(error);
  return str || 'Unknown error';
}
