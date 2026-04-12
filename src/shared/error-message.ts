/**
 * Extract a human-readable message from an unknown error value.
 * Falls back to the provided string (or 'Unknown error') for non-Error values.
 */
export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) return error.message;
  return fallback;
}
