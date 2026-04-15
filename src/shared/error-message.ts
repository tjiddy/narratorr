/**
 * Extract a human-readable message from an unknown error value.
 * Returns error.message for Error instances, String(value) for everything else.
 * The fallback (default: 'Unknown error') is only used when String(value) produces
 * an empty string — non-Error values that stringify to a non-empty string are returned as-is.
 */
export function getErrorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  const str = String(error);
  return str || (fallback ?? 'Unknown error');
}
