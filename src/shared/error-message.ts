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

/**
 * Like `getErrorMessage`, but prefers the underlying `cause` when present.
 * `fetch failed` from undici/Node carries the real diagnostic on `.cause`
 * (`UND_ERR_INVALID_ARG`, `ENOTFOUND`, `ECONNREFUSED`, etc.); surfacing it
 * is what makes the "next undici-shaped regression" debuggable from logs.
 */
export function getErrorMessageWithCause(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause as { message?: string; code?: string } | undefined;
    return cause?.message ?? cause?.code ?? error.message;
  }
  const str = String(error);
  return str || 'Unknown error';
}
