/**
 * Extract a human-readable message from an unknown error value.
 * Returns error.message for Error instances, String(value) for everything else.
 */
export function getErrorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  const str = String(error);
  return str || (fallback ?? 'Unknown error');
}
